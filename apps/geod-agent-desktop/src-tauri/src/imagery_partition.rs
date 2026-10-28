//! Account/workspace-scoped, resumable partition proposals. The complete
//! integer layout is frozen before child plans are persisted, so a changing
//! free-space reading cannot duplicate or resize children after interruption.
use crate::{
    export_crs, open_store, read_workspace, services, source_auth, workspace_error, AppError,
    AppState, TaskSpec,
};
use chrono::Utc;
use geod_task_engine::partition::Partition;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tauri::{AppHandle, State};

fn storage(_: impl std::fmt::Display) -> AppError {
    workspace_error(
        "PARTITION_RECEIPT_UNAVAILABLE",
        "分片回执暂不可读，请恢复原任务记录后继续，避免重复创建计划",
    )
}
fn schema(db: &Connection) -> Result<(), AppError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS imagery_partition_receipts(operation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,workspace TEXT NOT NULL,request_hash TEXT NOT NULL,body TEXT NOT NULL)").map_err(storage)
}
fn load(
    db: &Connection,
    key: &str,
    owner: &str,
    conversation: &str,
    workspace: &str,
    request: &str,
) -> Result<Option<Partition>, AppError> {
    let row:Option<(String,String,String,String,String)>=db.query_row("SELECT owner_id,conversation_id,workspace,request_hash,body FROM imagery_partition_receipts WHERE operation_id=?1",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(storage)?;
    match row {
        None => Ok(None),
        Some((o, c, w, h, body)) => {
            if (o.as_str(), c.as_str(), w.as_str(), h.as_str())
                != (owner, conversation, workspace, request)
            {
                return Err(workspace_error(
                    "PARTITION_OPERATION_CHANGED",
                    "分片操作归属或参数已变化；请保留旧回执并为已确认的新请求创建独立计划",
                ));
            }
            serde_json::from_str(&body).map(Some).map_err(storage)
        }
    }
}
fn freeze(
    db: &Connection,
    key: &str,
    owner: &str,
    conversation: &str,
    workspace: &str,
    request: &str,
    candidate: &Partition,
) -> Result<Partition, AppError> {
    db.execute(
        "INSERT OR IGNORE INTO imagery_partition_receipts VALUES(?1,?2,?3,?4,?5,?6)",
        params![
            key,
            owner,
            conversation,
            workspace,
            request,
            serde_json::to_string(candidate).map_err(storage)?
        ],
    )
    .map_err(storage)?;
    load(db, key, owner, conversation, workspace, request)?
        .ok_or_else(|| storage("missing receipt"))
}
fn disk_tile_budget(spec: &TaskSpec, tile_size: u16, available: u64) -> Result<u64, AppError> {
    let mut low = 0;
    let mut high = spec.limits.max_tiles;
    while low < high {
        let mid = low + (high - low + 1) / 2;
        let required = geod_core::imagery::required_free_disk_bytes_for_outputs(
            mid,
            tile_size,
            spec.output_formats.len(),
            false,
        )?;
        if required <= available {
            low = mid
        } else {
            high = mid - 1
        }
    }
    Ok(low)
}
fn direct_children(
    proposal: &mut Partition,
    workspace: &Path,
    group: &str,
    source: &geod_task_engine::SourceDescriptor,
) -> Result<(), AppError> {
    for child in &mut proposal.plans {
        let leaf = Path::new(&child.spec.output_directory)
            .file_name()
            .ok_or_else(|| storage("invalid partition leaf"))?
            .to_string_lossy();
        let mut spec = child.spec.clone();
        spec.output_directory = workspace
            .join(format!("imagery-{group}-{leaf}"))
            .to_string_lossy()
            .into_owned();
        *child = geod_task_engine::plan(spec, source, Utc::now())
            .map_err(|e| workspace_error(e.code, e.message))?;
    }
    Ok(())
}
fn reusable_child(
    state: &AppState,
    owner: &str,
    conversation: &str,
    workspace: &str,
    spec: &TaskSpec,
) -> Result<Option<geod_task_engine::ledger::StoredPlan>, AppError> {
    let db = crate::imagery_recovery::db(state)?;
    let workspace = Path::new(workspace)
        .canonicalize()
        .map_err(storage)?
        .to_string_lossy()
        .into_owned();
    let id:Option<String>=db.query_row("SELECT p.plan_id FROM plans p JOIN imagery_plan_owners o ON o.plan_id=p.plan_id WHERE o.owner_id=?1 AND o.conversation_id=?2 AND o.workspace=?3 AND json_extract(p.body,'$.spec.outputDirectory')=?4 ORDER BY p.rowid DESC LIMIT 1",params![owner,conversation,workspace,spec.output_directory],|r|r.get(0)).optional().map_err(storage)?;
    let Some(id) = id else { return Ok(None) };
    let store = open_store(state)?;
    if store.plan_visibility(&id)?.is_some() {
        return Err(workspace_error(
            "PARTITION_RECORD_HIDDEN",
            "分片记录已被清理或丢弃，请先恢复原记录再继续，未新建重复任务",
        ));
    }
    let Some(saved) = store.get_plan(&id)? else {
        return Err(storage("missing child"));
    };
    // A started job belongs to the original immutable plan, even after its
    // approval deadline. Never create a second download for that child.
    if store.job_for_plan(&id)?.is_some() || saved.plan.expires_at > Utc::now() {
        return Ok(Some(saved));
    }
    Ok(None)
}
pub(crate) fn create(
    app: AppHandle,
    state: State<'_, AppState>,
    service: State<'_, services::ServiceState>,
    conversation: String,
    mut spec: TaskSpec,
    _key: String,
) -> Result<Value, AppError> {
    let workspace = read_workspace(&app, &state, &service, &conversation)?;
    let owner =
        services::current_user_id(&service).map_err(|e| workspace_error(e.code, e.message))?;
    // A new model call ID must not resize a pending group or duplicate it.
    // Normalize the suggested output name out of the semantic request.
    spec.output_directory = workspace.directory.clone();
    spec.output_formats.sort_unstable();
    spec.output_formats.dedup();
    spec.zoom_levels.sort_unstable();
    spec.zoom_levels.dedup();
    let source = open_store(&state)?
        .get_registered_source(&spec.source_id)?
        .ok_or_else(|| workspace_error("SOURCE_NOT_FOUND", "图源不存在"))?;
    source_auth::assert_ready(&state, &source.endpoint)?;
    let options = spec.export_options.get_or_insert_with(Default::default);
    let crs = options
        .target_crs
        .as_ref()
        .or(workspace.output_crs.as_ref())
        .ok_or_else(|| workspace_error("OUTPUT_CRS_REQUIRED", "请先确认成果坐标系"))?;
    options.target_crs = Some(export_crs::imagery_target(crs, &spec.output_formats)?);
    let request = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(&spec, &source.descriptor)).map_err(storage)?)
    );
    let group = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(&owner, &conversation, &workspace.directory, &request))
                .map_err(storage)?
        )
    );
    let key = format!("partition:{group}");
    let available = geod_core::imagery::available_disk_bytes(Path::new(&workspace.directory))?;
    let db = Connection::open(&state.db_path).map_err(storage)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(storage)?;
    schema(&db)?;
    let partition = if let Some(saved) = load(
        &db,
        &key,
        &owner,
        &conversation,
        &workspace.directory,
        &request,
    )? {
        saved
    } else {
        let budget = disk_tile_budget(&spec, source.descriptor.tile_size, available)?;
        if budget == 0 {
            return Err(workspace_error(
                "DISK_INSUFFICIENT",
                "当前磁盘连一个瓦片的安全预检预算都不足，请选择有可用空间的工作区后继续",
            ));
        }
        spec.limits.max_tiles = budget;
        let mut proposal =
            geod_task_engine::partition::partition(spec, &source.descriptor, Utc::now())
                .map_err(|e| workspace_error(e.code, e.message))?;
        direct_children(
            &mut proposal,
            Path::new(&workspace.directory),
            &group[..16],
            &source.descriptor,
        )?;
        freeze(
            &db,
            &key,
            &owner,
            &conversation,
            &workspace.directory,
            &request,
            &proposal,
        )?
    };
    let total = partition.total_tiles;
    let required = partition.required_free_disk_bytes;
    let bounds = partition.requested_bounds;
    let largest = partition
        .plans
        .iter()
        .map(|p| p.required_free_disk_bytes)
        .max()
        .unwrap_or(0);
    let chosen = partition
        .plans
        .iter()
        .map(|p| p.spec.limits.max_tiles)
        .max()
        .unwrap_or(0);
    let mut plans = Vec::new();
    let mut renewed_expired = 0;
    for (index, plan) in partition.plans.into_iter().enumerate() {
        if let Some(saved) = reusable_child(
            &state,
            &owner,
            &conversation,
            &workspace.directory,
            &plan.spec,
        )? {
            plans.push(saved);
            continue;
        }
        let expired = plan.expires_at <= Utc::now();
        if expired {
            renewed_expired += 1;
        }
        plans.push(crate::plans_create(
            app.clone(),
            state.clone(),
            service.clone(),
            conversation.clone(),
            plan.spec,
            if expired {
                format!("{key}:partition:{index}:renew:{}", uuid::Uuid::new_v4())
            } else {
                format!("{key}:partition:{index}")
            },
        )?);
    }
    Ok(
        json!({"plans":plans,"partition":{"requestedBounds":bounds,"totalTiles":total,"partCount":plans.len(),"renewedExpiredUnstartedPlans":renewed_expired,"renewalPolicy":"Only expired, unstarted plans receive fresh approvals; existing jobs and exact partition geometry remain unchanged","exactGridCoverage":true,"overlappingTiles":0,"missingTiles":0,"downloadStartedByThisCall":false,"chosenTilesPerPart":chosen,"requiredFreeDiskBytes":required,"largestPartFreeDiskBytes":largest,"availableDiskBytes":available,"canStoreAllParts":available>=required,"canStoreLargestPart":available>=largest,"estimateKind":"conservative-native-free-space-budget-not-transfer-size","next":if available>=required{"每个分片仍需原生任务确认；规划不授予执行权限"}else{"整体空间预检预算超过当前可用容量。保留完整分片，选择更大工作区或明确采用分批下载并迁出成果；以实际任务记录核对已执行的分片"}}}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_unstarted_child_can_renew_but_started_child_is_never_duplicated() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState {
            db_path: dir.path().join("test.sqlite"),
            workspace_dir: dir.path().into(),
            running_jobs: std::sync::Arc::new(std::sync::Mutex::new(
                std::collections::HashMap::new(),
            )),
            schedule_gate: std::sync::Mutex::new(()),
        };
        let mut store = open_store(&state).unwrap();
        let old = Utc::now() - chrono::Duration::hours(2);
        let endpoint=serde_json::from_value(json!({"id":"source","name":"Source","attribution":"","license":"","urlTemplate":"https://tiles.example.org/{z}/{x}/{y}.png","scheme":"XYZ","tileSize":256,"networkPolicy":"PublicHttps","minIntervalMs":0})).unwrap();
        let source = store.save_source(endpoint, 0, 22, false, old).unwrap();
        let spec:TaskSpec=serde_json::from_value(json!({"schemaVersion":"0.1","kind":"imagery","sourceId":"source","bounds":[-1.,1.,1.,2.],"zoomLevels":[1],"outputFormats":["tiles"],"outputDirectory":dir.path().join("part"),"limits":{"maxTiles":100,"maxDecodedRgbaBytes":10000000}})).unwrap();
        let saved = store.create_plan(spec.clone(), &source, old).unwrap();
        crate::imagery_recovery::bind_created_plan(
            &state,
            "owner",
            "chat",
            dir.path(),
            &saved.plan_id,
        )
        .unwrap();
        let workspace = dir.path().to_string_lossy();
        assert!(reusable_child(&state, "owner", "chat", &workspace, &spec)
            .unwrap()
            .is_none());
        let approval = store
            .grant_approval(&saved.plan_id, &saved.plan.plan_hash, "owner", "test", old)
            .unwrap();
        store
            .start_job(
                &saved.plan_id,
                &saved.plan.plan_hash,
                &approval.approval_id,
                "start-once",
                &source,
                old,
            )
            .unwrap();
        assert_eq!(
            reusable_child(&state, "owner", "chat", &workspace, &spec)
                .unwrap()
                .unwrap()
                .plan_id,
            saved.plan_id
        );
        assert!(
            reusable_child(&state, "different-owner", "chat", &workspace, &spec)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn partitions_are_new_direct_workspace_children_without_creating_any_output() {
        let workspace = tempfile::tempdir().unwrap();
        let spec:TaskSpec=serde_json::from_value(json!({"schemaVersion":"0.1","kind":"imagery","sourceId":"source","bounds":[-180.,-85.05112878,180.,85.05112878],"zoomLevels":[12],"outputFormats":["tiles"],"exportOptions":{"targetCrs":"EPSG:3857"},"outputDirectory":workspace.path(),"limits":{"maxTiles":1000000,"maxDecodedRgbaBytes":1099511627776u64}})).unwrap();
        let source:geod_task_engine::SourceDescriptor=serde_json::from_value(json!({"schemaVersion":"0.1","id":"source","displayName":"Source","attribution":"Provider","license":"","bulkDownloadAllowed":true,"scheme":"XYZ","tileSize":256,"minZoom":0,"maxZoom":22,"configRevision":"revision","credentialRefVersion":null})).unwrap();
        let mut proposal =
            geod_task_engine::partition::partition(spec, &source, Utc::now()).unwrap();
        direct_children(&mut proposal, workspace.path(), "stable-group", &source).unwrap();
        assert_eq!(proposal.total_tiles, 16777216);
        for p in proposal.plans {
            crate::validate_auto_destination(workspace.path(), Path::new(&p.spec.output_directory))
                .unwrap();
        }
        assert_eq!(std::fs::read_dir(workspace.path()).unwrap().count(), 0);
    }
    #[test]
    fn frozen_partition_is_stable_after_space_changes_and_rejects_another_owner_or_request() {
        let db = Connection::open_in_memory().unwrap();
        schema(&db).unwrap();
        let proposal = Partition {
            requested_bounds: [-1.0, 1.0, 1.0, 2.0],
            total_tiles: 42,
            required_free_disk_bytes: 100,
            plans: vec![],
        };
        freeze(
            &db,
            "op",
            "owner",
            "chat",
            "workspace",
            "request",
            &proposal,
        )
        .unwrap();
        let changed = Partition {
            total_tiles: 99,
            ..proposal
        };
        let adopted = freeze(&db, "op", "owner", "chat", "workspace", "request", &changed).unwrap();
        assert_eq!(adopted.total_tiles, 42);
        assert_eq!(
            load(&db, "op", "other", "chat", "workspace", "request")
                .unwrap_err()
                .code,
            "PARTITION_OPERATION_CHANGED"
        );
        assert!(load(&db, "op", "owner", "chat", "workspace", "changed").is_err());
    }
}

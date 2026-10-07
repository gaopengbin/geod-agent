//! Persisted background vector and 3D downloads. This ledger is deliberately
//! separate from imagery TaskSpec; both kinds still use the current account,
//! conversation workspace, explicit UI approval or full-access permission.
use crate::{
    network, read_workspace, services, validate_auto_destination, workspace_error, AppError,
    AppState, WorkspacePermission,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, State};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Tiles3dSpec {
    #[serde(default)]
    pub tileset_url: String,
    #[serde(default)]
    pub bounds: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<geod_core::boundary::BoundaryGeometry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_revision: Option<String>,
}
impl Tiles3dSpec {
    fn fingerprint(&self) -> Result<String, AppError> {
        if let (Some(id), Some(revision)) = (&self.connection_id, &self.connection_revision) {
            Ok(format!(
                "{:x}",
                Sha256::digest(format!("tiles3d:{id}:{revision}"))
            ))
        } else {
            let url = reqwest::Url::parse(&self.tileset_url).map_err(storage_error)?;
            Ok(format!("{:x}", Sha256::digest(url.as_str().as_bytes())))
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    content = "spec",
    rename_all = "lowercase",
    deny_unknown_fields
)]
pub(crate) enum DataRequest {
    Vector(geod_vector::Request),
    Tiles3d(Tiles3dSpec),
    Online(crate::online_exports::OnlineSpec),
}
impl DataRequest {
    fn kind(&self) -> &'static str {
        match self {
            Self::Vector(_) => "vector",
            Self::Tiles3d(_) => "tiles3d",
            Self::Online(_) => "online",
        }
    }
    fn url(&self) -> &str {
        match self {
            Self::Vector(r) => r.source.url(),
            Self::Tiles3d(r) => &r.tileset_url,
            Self::Online(r) => r.source_url.as_deref().unwrap_or(""),
        }
    }
    fn bounds(&self) -> Option<[f64; 4]> {
        match self {
            Self::Vector(r) => Some(r.bounds),
            Self::Tiles3d(r) => r.bounds,
            Self::Online(r) => r.bounds,
        }
    }
    fn validate(&self) -> Result<(Self, u64), AppError> {
        match self {
            Self::Online(r) => Ok((Self::Online(r.validate()?),0)),
            Self::Vector(r) => {
                let plan = geod_vector::plan(r.clone()).map_err(vector_error)?;
                Ok((Self::Vector(plan.request), plan.tile_count))
            }
            Self::Tiles3d(r) => {
                let url = reqwest::Url::parse(&r.tileset_url)
                    .map_err(|_| workspace_error("DATA_PLAN_INVALID", "3D Tiles 地址无效"))?;
                if url.scheme() != "https"
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.fragment().is_some()
                {
                    return Err(workspace_error(
                        "DATA_PLAN_INVALID",
                        "3D Tiles 需要不含账号密码的 HTTPS 地址",
                    ));
                }
                if url.query_pairs().any(|(k, _)| {
                    matches!(
                        k.to_ascii_lowercase().as_str(),
                        "key"
                            | "tk"
                            | "token"
                            | "access_token"
                            | "api_key"
                            | "apikey"
                            | "password"
                            | "authorization"
                    )
                }) {
                    return Err(workspace_error(
                        "DATA_CREDENTIAL_REQUIRED",
                        "请在三维数据连接中填写凭证，并使用连接创建任务",
                    ));
                }
                if let Some(b) = r.bounds {
                    geod_tiles3d::spatial::validate_bounds(b)
                        .map_err(|e| workspace_error("DATA_PLAN_INVALID", e))?;
                }
                let mut spec = r.clone();
                if let Some(boundary) = &mut spec.boundary {
                    let bounds = boundary
                        .normalize()
                        .map_err(|e| workspace_error("DATA_PLAN_INVALID", e.0))?;
                    if spec.bounds.is_some_and(|b| {
                        b.iter().zip(bounds).any(|(a, b)| (a - b).abs() > 0.000001)
                    }) {
                        return Err(workspace_error(
                            "DATA_PLAN_INVALID",
                            "三维下载范围与多边形边界不匹配",
                        ));
                    }
                    spec.bounds = Some(bounds);
                }
                if spec.connection_id.is_some() != spec.connection_revision.is_some() {
                    return Err(workspace_error("DATA_PLAN_INVALID", "三维连接与版本不匹配"));
                }
                Ok((Self::Tiles3d(spec), 0))
            }
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataProgress {
    pub phase: String,
    pub completed: u64,
    pub total: u64,
    pub bytes: u64,
    pub cache_hits: u64,
    pub failures: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataTask {
    pub id: String,
    pub conversation_id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub plan_hash: String,
    pub request: DataRequest,
    pub output_dir: String,
    pub progress: DataProgress,
    pub manifest: Option<Value>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataPreview {
    pub kind: String,
    pub resource_path: String,
    pub token: String,
    pub bounds: Option<[f64; 4]>,
    pub feature_count: Option<u64>,
    pub truncated: bool,
}

struct Control {
    vector: Arc<AtomicBool>,
    tiles3d: geod_tiles3d::CancellationToken,
}
impl Control {
    fn new() -> Self {
        Self {
            vector: Arc::new(AtomicBool::new(false)),
            tiles3d: geod_tiles3d::CancellationToken::new(),
        }
    }
    fn cancel(&self) {
        self.vector.store(true, Ordering::Relaxed);
        self.tiles3d.cancel();
    }
    fn cancelled(&self) -> bool {
        self.vector.load(Ordering::Relaxed)
    }
}
static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<Control>>>> = OnceLock::new();
static INITIALIZED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
pub(crate) fn active_count() -> usize { active().lock().map(|entries| entries.len()).unwrap_or(usize::MAX) }

pub(crate) fn cancel_all() {
    if let Ok(running) = active().lock() {
        for control in running.values() {
            control.cancel();
        }
    }
}
fn active() -> &'static Mutex<HashMap<String, Arc<Control>>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}
fn storage_error(e: impl std::fmt::Display) -> AppError {
    workspace_error("DATA_STORAGE_ERROR", e.to_string())
}
fn vector_error(e: geod_vector::Error) -> AppError {
    workspace_error("VECTOR_DATA_ERROR", e.to_string())
}
fn owner(services: &services::ServiceState) -> Result<String, AppError> {
    services::current_user_id(services).map_err(|e| workspace_error(e.code, e.message))
}

fn open_data_db(path: &Path) -> Result<Connection, AppError> {
    let db = Connection::open(path).map_err(storage_error)?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(storage_error)?;
    let mut initialized = INITIALIZED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .map_err(|_| storage_error("Data ledger lock unavailable"))?;
    if !initialized.contains(path) {
        db.execute_batch("CREATE TABLE IF NOT EXISTS data_download_tasks(
          id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,
          kind TEXT NOT NULL,title TEXT NOT NULL,plan_hash TEXT NOT NULL,request_json TEXT NOT NULL,
          output_dir TEXT NOT NULL,workspace_root TEXT NOT NULL,status TEXT NOT NULL,progress_json TEXT NOT NULL,
          manifest_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,approved_by TEXT,approval_mode TEXT,
          UNIQUE(owner_id,conversation_id,idempotency_key));
          CREATE INDEX IF NOT EXISTS data_download_tasks_conversation ON data_download_tasks(owner_id,conversation_id,created_at);
          UPDATE data_download_tasks SET status='interrupted',error='应用已关闭，任务可重新启动',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status IN ('queued','downloading','verifying','cancelling');").map_err(storage_error)?;
        initialized.insert(path.to_path_buf());
    }
    Ok(db)
}
const SELECT:&str="SELECT id,conversation_id,kind,title,status,plan_hash,request_json,output_dir,progress_json,manifest_json,error,created_at,updated_at FROM data_download_tasks";
fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DataTask> {
    fn decode<T: serde::de::DeserializeOwned>(
        row: &rusqlite::Row<'_>,
        index: usize,
    ) -> rusqlite::Result<T> {
        let s: String = row.get(index)?;
        serde_json::from_str(&s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(e),
            )
        })
    }
    let manifest: Option<String> = row.get(9)?;
    Ok(DataTask {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        status: row.get(4)?,
        plan_hash: row.get(5)?,
        request: decode(row, 6)?,
        output_dir: row.get(7)?,
        progress: decode(row, 8)?,
        manifest: manifest
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    9,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?,
        error: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}
fn get(db: &Connection, owner: &str, conversation: &str, id: &str) -> Result<DataTask, AppError> {
    db.query_row(
        &format!("{SELECT} WHERE id=?1 AND owner_id=?2 AND conversation_id=?3"),
        params![id, owner, conversation],
        row,
    )
    .optional()
    .map_err(storage_error)?
    .ok_or_else(|| workspace_error("DATA_TASK_NOT_FOUND", "当前对话没有此数据任务"))
}
fn check_binding(db: &Connection, task: &DataTask, root: &str) -> Result<(), AppError> {
    let saved: String = db
        .query_row(
            "SELECT workspace_root FROM data_download_tasks WHERE id=?1",
            [&task.id],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    let saved_root = fs::canonicalize(saved).map_err(storage_error)?;
    let current_root = fs::canonicalize(root).map_err(storage_error)?;
    if saved_root != current_root {
        return Err(workspace_error("WORKSPACE_DENIED", "任务属于另一个工作区"));
    }
    if Path::new(&task.output_dir).exists() {
        let output = fs::canonicalize(&task.output_dir).map_err(storage_error)?;
        if output.parent() != Some(current_root.as_path()) {
            return Err(workspace_error(
                "WORKSPACE_DENIED",
                "成果文件夹已移出当前工作区",
            ));
        }
    }
    Ok(())
}
fn task_hash(
    owner: &str,
    conversation: &str,
    title: &str,
    request: &DataRequest,
    output: &str,
    root: &str,
) -> Result<String, AppError> {
    Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(&json!({"owner":owner,"conversation":conversation,"title":title,"request":request,"outputDir":output,"workspace":root})).map_err(storage_error)?)))
}

#[tauri::command]
pub(crate) fn data_download_plan(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    title: String,
    idempotency_key: String,
    mut request: DataRequest,
) -> Result<DataTask, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    let owner = owner(&services)?;
    if title.trim().is_empty() || title.len() > 240 || title.chars().any(char::is_control) {
        return Err(workspace_error(
            "DATA_PLAN_INVALID",
            "请输入明确的数据任务名称",
        ));
    }
    if idempotency_key.is_empty() || idempotency_key.len() > 160 {
        return Err(workspace_error("DATA_PLAN_INVALID", "任务幂等标识无效"));
    }
    match &mut request {
        DataRequest::Vector(spec)=>{let crs=spec.target_crs.as_ref().or(workspace.output_crs.as_ref()).ok_or_else(||workspace_error("OUTPUT_CRS_REQUIRED","请通过选项卡确认成果坐标系"))?;spec.target_crs=Some(crate::export_crs::validate(crs,false)?);},
        DataRequest::Online(spec)=>{let crs=spec.target_crs.as_ref().or(workspace.output_crs.as_ref()).ok_or_else(||workspace_error("OUTPUT_CRS_REQUIRED","请通过选项卡确认成果坐标系"))?;spec.target_crs=Some(crate::export_crs::validate(crs,false)?);},
        _=>{}
    }
    if let DataRequest::Tiles3d(spec) = &mut request {
        if let Some(id) = &spec.connection_id {
            let connection = crate::data_credentials::bind(&state, &owner, id)?;
            if spec
                .connection_revision
                .as_ref()
                .is_some_and(|revision| revision != &connection.revision)
            {
                return Err(workspace_error(
                    "DATA_CONNECTION_CHANGED",
                    "三维连接已更新，请重新创建任务或定时模板",
                ));
            }
            spec.tileset_url = connection.source_url();
            spec.connection_revision = Some(connection.revision);
        }
    }
    if let DataRequest::Online(spec)=&mut request{spec.bind(&app,&owner)?;}
    let (request, total) = request.validate()?;
    let mut connection = open_data_db(&state.db_path)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let db = &transaction;
    if let Some(existing) = db
        .query_row(
            &format!("{SELECT} WHERE owner_id=?1 AND conversation_id=?2 AND idempotency_key=?3"),
            params![owner, conversation_id, idempotency_key],
            row,
        )
        .optional()
        .map_err(storage_error)?
    {
        if serde_json::to_string(&existing.request).map_err(storage_error)?
            != serde_json::to_string(&request).map_err(storage_error)?
            || existing.title != title.trim()
        {
            return Err(workspace_error(
                "IDEMPOTENCY_CONFLICT",
                "同一个任务标识对应了不同的请求",
            ));
        }
        check_binding(&db, &existing, &workspace.directory)?;
        return Ok(existing);
    }
    let id = Uuid::new_v4().to_string();
    let directory = Path::new(&workspace.directory).join(format!(
        "{}-{}-{}",
        request.kind(),
        Utc::now().format("%Y%m%d-%H%M%S"),
        &id[..8]
    ));
    validate_auto_destination(Path::new(&workspace.directory), &directory)?;
    let output = directory.to_string_lossy().into_owned();
    let hash = task_hash(
        &owner,
        &conversation_id,
        title.trim(),
        &request,
        &output,
        &workspace.directory,
    )?;
    let now = Utc::now().to_rfc3339();
    let progress = DataProgress {
        phase: "pending".into(),
        completed: 0,
        total,
        bytes: 0,
        cache_hits: 0,
        failures: 0,
    };
    db.execute("INSERT INTO data_download_tasks(id,owner_id,conversation_id,idempotency_key,kind,title,plan_hash,request_json,output_dir,workspace_root,status,progress_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'pending',?11,?12,?12)",params![id,owner,conversation_id,idempotency_key,request.kind(),title.trim(),hash,serde_json::to_string(&request).map_err(storage_error)?,output,workspace.directory,serde_json::to_string(&progress).map_err(storage_error)?,now]).map_err(storage_error)?;
    let task = get(&db, &owner, &conversation_id, &id)?;
    transaction.commit().map_err(storage_error)?;
    Ok(task)
}

#[tauri::command]
pub(crate) fn data_download_list(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<Vec<DataTask>, AppError> {
    read_workspace(&app, &state, &services, &conversation_id)?;
    let owner = owner(&services)?;
    let db = open_data_db(&state.db_path)?;
    let mut stmt=db.prepare(&format!("{SELECT} WHERE owner_id=?1 AND conversation_id=?2 AND status!='discarded' ORDER BY created_at DESC")).map_err(storage_error)?;
    let rows = stmt
        .query_map(params![owner, conversation_id], row)
        .map_err(storage_error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(storage_error)
}
#[tauri::command]
pub(crate) fn data_download_get(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    task_id: String,
) -> Result<DataTask, AppError> {
    read_workspace(&app, &state, &services, &conversation_id)?;
    get(
        &open_data_db(&state.db_path)?,
        &owner(&services)?,
        &conversation_id,
        &task_id,
    )
}

#[tauri::command]
pub(crate) fn data_download_start(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    task_id: String,
    plan_hash: String,
    confirmed: bool,
) -> Result<DataTask, AppError> {
    if !confirmed {
        return Err(workspace_error(
            "APPROVAL_REQUIRED",
            "请在任务卡片确认下载计划",
        ));
    }
    start(
        &app,
        &state,
        &services,
        &conversation_id,
        &task_id,
        &plan_hash,
        false,
    )
}
#[tauri::command]
pub(crate) fn data_download_start_auto(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    task_id: String,
    plan_hash: String,
) -> Result<DataTask, AppError> {
    start(
        &app,
        &state,
        &services,
        &conversation_id,
        &task_id,
        &plan_hash,
        true,
    )
}

fn start(
    app: &AppHandle,
    state: &AppState,
    services: &services::ServiceState,
    conversation: &str,
    id: &str,
    plan_hash: &str,
    automatic: bool,
) -> Result<DataTask, AppError> {
    let workspace = read_workspace(app, state, services, conversation)?;
    let owner = owner(services)?;
    if automatic && workspace.permission != WorkspacePermission::FullAccess {
        return Err(workspace_error(
            "APPROVAL_REQUIRED",
            "当前工作区要求在任务卡片确认下载计划",
        ));
    }
    let db = open_data_db(&state.db_path)?;
    let task = get(&db, &owner, conversation, id)?;
    check_binding(&db, &task, &workspace.directory)?;
    if task.plan_hash != plan_hash
        || task_hash(
            &owner,
            conversation,
            &task.title,
            &task.request,
            &task.output_dir,
            &workspace.directory,
        )? != plan_hash
    {
        return Err(workspace_error(
            "PLAN_CHANGED",
            "下载计划已变更，请重新检查",
        ));
    }
    let mut running = active()
        .lock()
        .map_err(|_| storage_error("Data worker lock unavailable"))?;
    if running.contains_key(id) || matches!(task.status.as_str(), "completed" | "partial") {
        return Ok(task);
    }
    if !matches!(
        task.status.as_str(),
        "pending" | "failed" | "cancelled" | "interrupted"
    ) {
        return Err(workspace_error("DATA_TASK_STATE", "当前任务不能启动"));
    }
    task.request.validate()?;
    if let DataRequest::Online(spec)=&task.request{spec.clone().bind(app,&owner)?;}
    if task.status != "pending" && Path::new(&task.output_dir).exists() {
        // The directory commit and SQLite completion are separate operations.
        // If the app exited between them, recover only a fully checked bundle
        // matching this exact request; never overwrite an existing directory.
        let manifest = verified_files(&task)?;
        db.execute("UPDATE data_download_tasks SET status=?4,manifest_json=?2,error=NULL,updated_at=?3 WHERE id=?1",params![id,manifest.to_string(),Utc::now().to_rfc3339(),finished_state(&manifest)]).map_err(storage_error)?;
        return get(&db, &owner, conversation, id);
    }
    validate_auto_destination(Path::new(&workspace.directory), Path::new(&task.output_dir))?;
    let credential = match &task.request {
        DataRequest::Tiles3d(spec) => match (&spec.connection_id, &spec.connection_revision) {
            (Some(id), Some(revision)) => Some(crate::data_credentials::resolve(
                state, &owner, id, revision,
            )?),
            _ => None,
        },
        _ => None,
    };
    let proxy = if matches!(task.request,DataRequest::Online(_)){None}else{network::proxy_for(task.request.url())
        .map_err(|e| workspace_error("NETWORK_SETTINGS_ERROR", e))?};
    let key: String = db
        .query_row(
            "SELECT idempotency_key FROM data_download_tasks WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    let control = Arc::new(Control::new());
    db.execute("UPDATE data_download_tasks SET status='queued',error=NULL,manifest_json=NULL,approved_by=?2,approval_mode=?3,updated_at=?4 WHERE id=?1",params![id,owner,if automatic{"workspace-full-access"}else{"user-confirmed"},Utc::now().to_rfc3339()]).map_err(storage_error)?;
    running.insert(id.into(), control.clone());
    drop(running);
    let path = state.db_path.clone();
    // A recurring download is a new snapshot. Its own retries may reuse cache,
    // but a new occurrence must not silently reuse last week's MVT snapshot.
    let mut cache = state.workspace_dir.join("data-download-cache");
    if key.starts_with("data-schedule:") {
        cache = cache.join("scheduled").join(id);
    }
    let task_to_run = task.clone();
    let worker_app=app.clone();let worker_owner=owner.clone();
    tauri::async_runtime::spawn(async move {
        let result = execute(
            worker_app,
            worker_owner,
            &path,
            &cache,
            &task_to_run,
            proxy,
            credential,
            control.clone(),
        )
        .await;
        let finished = Utc::now().to_rfc3339();
        if let Ok(db) = open_data_db(&path) {
            match result {
                Ok(manifest) => {
                    let _=db.execute("UPDATE data_download_tasks SET status=?4,manifest_json=?2,error=NULL,updated_at=?3 WHERE id=?1",params![task_to_run.id,manifest.to_string(),finished,finished_state(&manifest)]);
                }
                Err(error) => {
                    let status = if control.cancelled() {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    let _=db.execute("UPDATE data_download_tasks SET status=?2,error=?3,updated_at=?4 WHERE id=?1",params![task_to_run.id,status,error,finished]);
                }
            }
        }
        if let Ok(mut running) = active().lock() {
            running.remove(&task_to_run.id);
        }
    });
    get(&db, &owner, conversation, id)
}

fn finished_state(manifest: &Value) -> &'static str {
    if manifest
        .get("failures")
        .and_then(Value::as_array)
        .is_some_and(|failures| !failures.is_empty())
    {
        "partial"
    } else {
        "completed"
    }
}

fn persist_progress(path: &Path, id: &str, p: DataProgress) {
    if let Ok(db) = open_data_db(path) {
        let status = if matches!(p.phase.as_str(), "packaging" | "verifying" | "reprojecting") {
            "verifying"
        } else {
            "downloading"
        };
        if let Ok(json) = serde_json::to_string(&p) {
            let _=db.execute("UPDATE data_download_tasks SET status=?2,progress_json=?3,updated_at=?4 WHERE id=?1 AND status IN ('queued','downloading','verifying')",params![id,status,json,Utc::now().to_rfc3339()]);
        }
    }
}
async fn execute(
    app:AppHandle,
    owner:String,
    path: &Path,
    cache: &Path,
    task: &DataTask,
    proxy: Option<String>,
    credential: Option<crate::data_credentials::ResolvedCredential>,
    control: Arc<Control>,
) -> Result<Value, String> {
    let last = Mutex::new(Instant::now() - Duration::from_secs(1));
    let report = |p: DataProgress| {
        if let Ok(mut last) = last.lock() {
            if last.elapsed() >= Duration::from_millis(200)
                || matches!(p.phase.as_str(), "completed" | "verifying" | "packaging" | "reprojecting")
            {
                persist_progress(path, &task.id, p);
                *last = Instant::now();
            }
        }
    };
    match &task.request {
        DataRequest::Online(spec)=>crate::online_exports::run(app,owner,spec,Path::new(&task.output_dir),&task.plan_hash,control.vector.clone(),|phase,completed,total,bytes|report(DataProgress{phase:phase.into(),completed,total,bytes,cache_hits:0,failures:0})).await,
        DataRequest::Vector(request) => {
            let plan = geod_vector::plan(request.clone()).map_err(|e| e.to_string())?;
            let mut options =
                geod_vector::RunOptions::new(PathBuf::from(&task.output_dir), cache.to_path_buf());
            options.projector = Some(Arc::new(crate::export_crs::Projector));
            options.network.proxy = proxy;
            options.cancel = control.vector.clone();
            let manifest = geod_vector::run(&plan, options, |p| {
                report(DataProgress {
                    phase: p.phase,
                    completed: p.completed,
                    total: p.total,
                    bytes: p.bytes,
                    cache_hits: p.cache_hits,
                    failures: p.failures,
                })
            })
            .await
            .map_err(|e| e.to_string())?;
            geod_vector::inspect(Path::new(&task.output_dir)).map_err(|e| e.to_string())?;
            serde_json::to_value(manifest).map_err(|e| e.to_string())
        }
        DataRequest::Tiles3d(spec) => {
            let mut request =
                geod_tiles3d::DownloadRequest::new(&spec.tileset_url, &task.output_dir);
            request.bounds = spec.bounds;
            request.boundary = spec.boundary.clone();
            if let Some(credential) = credential {
                let endpoint = credential.resolve(proxy.as_deref()).await?;
                request.tileset_url = endpoint.tileset_url;
                request.headers = endpoint.headers;
                request.inherit_query = endpoint.inherit_query;
                request.source_fingerprint = Some(spec.fingerprint().map_err(|e| e.message)?);
            }
            request.proxy = proxy;
            let manifest = geod_tiles3d::download(request, control.tiles3d.clone(), |p| {
                report(DataProgress {
                    phase: p.stage,
                    completed: p.completed as u64,
                    total: p.discovered as u64,
                    bytes: p.bytes,
                    cache_hits: 0,
                    failures: 0,
                })
            })
            .await?;
            serde_json::to_value(manifest).map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
pub(crate) fn data_download_cancel(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    task_id: String,
) -> Result<DataTask, AppError> {
    read_workspace(&app, &state, &services, &conversation_id)?;
    let owner = owner(&services)?;
    let db = open_data_db(&state.db_path)?;
    let task = get(&db, &owner, &conversation_id, &task_id)?;
    if matches!(task.status.as_str(), "completed" | "partial" | "discarded") {
        return Err(workspace_error("DATA_TASK_STATE", "任务已经结束"));
    }
    let running = active()
        .lock()
        .map_err(|_| storage_error("Data worker lock unavailable"))?;
    if let Some(control) = running.get(&task_id) {
        control.cancel();
        db.execute(
            "UPDATE data_download_tasks SET status='cancelling',updated_at=?2 WHERE id=?1",
            params![task_id, Utc::now().to_rfc3339()],
        )
        .map_err(storage_error)?;
    } else {
        db.execute("UPDATE data_download_tasks SET status='cancelled',error=NULL,updated_at=?2 WHERE id=?1",params![task_id,Utc::now().to_rfc3339()]).map_err(storage_error)?;
    }
    get(&db, &owner, &conversation_id, &task_id)
}
#[tauri::command]
pub(crate) fn data_download_discard(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    task_id: String,
) -> Result<DataTask, AppError> {
    read_workspace(&app, &state, &services, &conversation_id)?;
    let owner = owner(&services)?;
    let db = open_data_db(&state.db_path)?;
    let task = get(&db, &owner, &conversation_id, &task_id)?;
    if matches!(
        task.status.as_str(),
        "queued" | "downloading" | "verifying" | "cancelling"
    ) || active()
        .lock()
        .map_err(|_| storage_error("Data worker lock unavailable"))?
        .contains_key(&task_id)
    {
        return Err(workspace_error("DATA_TASK_STATE", "请先取消正在运行的任务"));
    }
    db.execute(
        "UPDATE data_download_tasks SET status='discarded',updated_at=?2 WHERE id=?1",
        params![task_id, Utc::now().to_rfc3339()],
    )
    .map_err(storage_error)?;
    get(&db, &owner, &conversation_id, &task_id)
}

fn verified(task: &DataTask) -> Result<Value, AppError> {
    if !matches!(task.status.as_str(), "completed" | "partial") {
        return Err(workspace_error(
            "DATA_TASK_STATE",
            "任务尚未完成，暂时没有可用成果",
        ));
    }
    verified_files(task)
}
fn verified_files(task: &DataTask) -> Result<Value, AppError> {
    match &task.request {
        DataRequest::Online(spec)=>crate::online_exports::inspect(Path::new(&task.output_dir),spec,&task.plan_hash).map_err(|e|workspace_error("DATA_INSPECTION_FAILED",e)),
        DataRequest::Vector(request) => {
            let manifest =
                geod_vector::inspect(Path::new(&task.output_dir)).map_err(vector_error)?;
            let plan = geod_vector::plan(request.clone()).map_err(vector_error)?;
            let has_outputs = plan.request.outputs.iter().all(|format| {
                let kind = match format {
                    geod_vector::OutputFormat::Pbf => "pbf-index",
                    geod_vector::OutputFormat::Mbtiles => "mbtiles",
                    geod_vector::OutputFormat::Geojson => "geojson",
                    geod_vector::OutputFormat::Gpkg => "gpkg",
                };
                manifest.assets.iter().any(|asset| asset.kind == kind)
            });
            if manifest.plan_hash != plan.plan_hash
                || manifest.output_crs != plan.request.target_crs.as_deref().unwrap_or("EPSG:4326")
                || manifest.bounds != plan.request.bounds
                || !has_outputs
            {
                return Err(workspace_error(
                    "DATA_INSPECTION_FAILED",
                    "矢量成果与此下载计划不匹配",
                ));
            }
            serde_json::to_value(manifest).map_err(storage_error)
        }
        DataRequest::Tiles3d(spec) => {
            let manifest = geod_tiles3d::inspect(Path::new(&task.output_dir))
                .map_err(|e| workspace_error("DATA_INSPECTION_FAILED", e))?;
            if manifest.source_fingerprint != spec.fingerprint()?
                || manifest.bounds != spec.bounds
                || manifest.boundary != spec.boundary
            {
                return Err(workspace_error(
                    "DATA_INSPECTION_FAILED",
                    "三维成果与此下载计划不匹配",
                ));
            }
            serde_json::to_value(manifest).map_err(storage_error)
        }
    }
}
#[tauri::command]
pub(crate) fn data_download_inspect(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    task_id: String,
) -> Result<DataTask, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    let owner = owner(&services)?;
    let db = open_data_db(&state.db_path)?;
    let mut task = get(&db, &owner, &conversation_id, &task_id)?;
    check_binding(&db, &task, &workspace.directory)?;
    task.manifest = Some(verified(&task)?);
    Ok(task)
}
#[tauri::command]
pub(crate) fn data_download_open_directory(
    app: AppHandle, state: State<'_, AppState>, services: State<'_, services::ServiceState>,
    conversation_id: String, task_id: String,
) -> Result<(), AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    let db = open_data_db(&state.db_path)?;
    let task = get(&db, &owner(&services)?, &conversation_id, &task_id)?;
    check_binding(&db, &task, &workspace.directory)?;
    if !matches!(task.status.as_str(), "completed" | "partial") {
        return Err(workspace_error("OUTPUT_NOT_READY", "成果尚未生成"));
    }
    crate::open_output_directory(&app, &workspace.directory, &task.output_dir)
}

#[tauri::command]
pub(crate) fn data_download_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    assets: State<'_, crate::data_asset_protocol::DataAssets>,
    conversation_id: String,
    task_id: String,
) -> Result<DataPreview, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    let owner = owner(&services)?;
    let db = open_data_db(&state.db_path)?;
    let task = get(&db, &owner, &conversation_id, &task_id)?;
    check_binding(&db, &task, &workspace.directory)?;
    let manifest = verified(&task)?;
    let (entrypoint, resources, feature_count, truncated) = match &task.request {
        DataRequest::Online(_)=>{
            let preview=manifest["assets"].as_array().and_then(|a|a.iter().find(|a|a["kind"]=="preview")).ok_or_else(||workspace_error("DATA_PREVIEW_MISSING","在线矢量成果缺少预览"))?;
            let path=preview["path"].as_str().ok_or_else(||workspace_error("DATA_PREVIEW_MISSING","在线预览记录无效"))?.to_owned();
            (path.clone(),vec![crate::data_asset_protocol::DataResource{path,bytes:preview["size"].as_u64().unwrap_or(0),sha256:preview["sha256"].as_str().unwrap_or("").into(),kind:"geojson".into()}],manifest["previewFeatureCount"].as_u64(),manifest["previewTruncated"]==true)
        },
        DataRequest::Vector(_) => {
            let m: geod_vector::Manifest =
                serde_json::from_value(manifest).map_err(storage_error)?;
            let preview = m
                .assets
                .iter()
                .find(|a| a.kind == "preview")
                .ok_or_else(|| workspace_error("DATA_PREVIEW_MISSING", "矢量成果缺少预览"))?;
            (
                preview.path.clone(),
                vec![crate::data_asset_protocol::DataResource {
                    path: preview.path.clone(),
                    bytes: preview.size,
                    sha256: preview.sha256.clone(),
                    kind: "geojson".into(),
                }],
                Some(m.preview_feature_count),
                m.preview_truncated,
            )
        }
        DataRequest::Tiles3d(_) => {
            let m: geod_tiles3d::Bundle =
                serde_json::from_value(manifest).map_err(storage_error)?;
            (
                m.entrypoint,
                m.resources
                    .into_iter()
                    .map(|a| crate::data_asset_protocol::DataResource {
                        path: a.path,
                        bytes: a.bytes,
                        sha256: a.sha256,
                        kind: a.kind,
                    })
                    .collect(),
                None,
                false,
            )
        }
    };
    let registered = assets
        .register_verified(Path::new(&task.output_dir), &entrypoint, &resources)
        .map_err(|e| workspace_error("DATA_PREVIEW_FAILED", e))?;
    Ok(DataPreview {
        kind: if task.kind=="online"{"vector".into()}else{task.kind},
        resource_path: registered.resource_path,
        token: registered.token,
        bounds: task.request.bounds(),
        feature_count,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistent_ledger_binds_owner_and_conversation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ledger.db");
        let db = open_data_db(&path).unwrap();
        let request = DataRequest::Tiles3d(Tiles3dSpec {
            tileset_url: "https://example.test/tileset.json".into(),
            bounds: None,
            boundary: None,
            connection_id: None,
            connection_revision: None,
        });
        let p = DataProgress {
            phase: "pending".into(),
            completed: 0,
            total: 0,
            bytes: 0,
            cache_hits: 0,
            failures: 0,
        };
        db.execute("INSERT INTO data_download_tasks(id,owner_id,conversation_id,idempotency_key,kind,title,plan_hash,request_json,output_dir,workspace_root,status,progress_json,created_at,updated_at) VALUES('task','owner','conversation','key','tiles3d','区域模型','hash',?1,'out','root','pending',?2,'now','now')",params![serde_json::to_string(&request).unwrap(),serde_json::to_string(&p).unwrap()]).unwrap();
        assert!(get(&db, "other", "conversation", "task").is_err());
        assert!(get(&db, "owner", "another", "task").is_err());
        assert_eq!(
            get(&db, "owner", "conversation", "task").unwrap().title,
            "区域模型"
        );
        db.execute(
            "UPDATE data_download_tasks SET status='downloading' WHERE id='task'",
            [],
        )
        .unwrap();
        drop(db);
        INITIALIZED.get().unwrap().lock().unwrap().remove(&path);
        let reopened = open_data_db(&path).unwrap();
        let recovered = get(&reopened, "owner", "conversation", "task").unwrap();
        assert_eq!(recovered.status, "interrupted");
        assert!(recovered.error.unwrap().contains("应用已关闭"));
    }
    #[test]
    fn rejects_credentials_and_detects_destination_changes() {
        assert!(DataRequest::Tiles3d(Tiles3dSpec {
            tileset_url: "https://example.test/tileset.json?token=secret".into(),
            bounds: None,
            boundary: None,
            connection_id: None,
            connection_revision: None,
        })
        .validate()
        .is_err());
        let request = DataRequest::Tiles3d(Tiles3dSpec {
            tileset_url: "https://example.test/tileset.json".into(),
            bounds: None,
            boundary: None,
            connection_id: None,
            connection_revision: None,
        });
        assert_ne!(
            task_hash("u", "c", "name", &request, "a", "r").unwrap(),
            task_hash("u", "c", "name", &request, "b", "r").unwrap()
        );
    }
}

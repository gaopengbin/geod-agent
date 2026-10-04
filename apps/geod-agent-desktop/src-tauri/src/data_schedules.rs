//! Persistent schedules for vector and 3D downloads. Each occurrence gets its own
//! data task and destination; this loop never holds a model turn open.
use crate::{
    data_jobs, read_workspace, services, workspace_error, AppError, AppState, WorkspacePermission,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

pub(crate) static GATE: Mutex<()> = Mutex::new(());
const LIVE: &str = "'queued','waiting_confirmation','running','cancelling'";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataSchedule {
    pub id: String,
    pub conversation_id: String,
    pub template_task_id: String,
    pub name: String,
    pub enabled: bool,
    pub next_run_at: DateTime<Utc>,
    pub repeat_seconds: Option<u32>,
    pub app_must_be_running: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DataScheduleRun {
    pub id: String,
    pub schedule_id: String,
    pub conversation_id: String,
    pub scheduled_at: DateTime<Utc>,
    pub state: String,
    pub task_id: Option<String>,
    pub error: Option<String>,
    pub updated_at: DateTime<Utc>,
}
fn storage(e: impl std::fmt::Display) -> AppError {
    workspace_error("DATA_SCHEDULE_STORAGE", e.to_string())
}
fn owner(services: &services::ServiceState) -> Result<String, AppError> {
    services::current_user_id(services).map_err(|e| workspace_error(e.code, e.message))
}
fn db(path: &Path) -> Result<Connection, AppError> {
    let db = Connection::open(path).map_err(storage)?;
    db.busy_timeout(Duration::from_secs(5)).map_err(storage)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS data_schedules(
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        execution_id TEXT NOT NULL, template_task_id TEXT NOT NULL, name TEXT NOT NULL,
        request_json TEXT NOT NULL, workspace_root TEXT NOT NULL, enabled INTEGER NOT NULL,
        next_run_at INTEGER NOT NULL, repeat_seconds INTEGER, created_at INTEGER NOT NULL,
        UNIQUE(owner_id,conversation_id,execution_id));
        CREATE TABLE IF NOT EXISTS data_schedule_runs(
        id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL, state TEXT NOT NULL,
        task_id TEXT, error TEXT, updated_at INTEGER NOT NULL,
        UNIQUE(schedule_id,scheduled_at));
        CREATE INDEX IF NOT EXISTS data_schedule_due ON data_schedules(owner_id,enabled,next_run_at);
        CREATE INDEX IF NOT EXISTS data_schedule_live ON data_schedule_runs(owner_id,state);").map_err(storage)?;
    Ok(db)
}
fn timestamp(value: i64) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::from_timestamp(value, 0).ok_or(rusqlite::Error::InvalidQuery)
}
const SELECT: &str = "SELECT id,conversation_id,template_task_id,name,enabled,next_run_at,repeat_seconds FROM data_schedules";
fn schedule_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DataSchedule> {
    Ok(DataSchedule {
        id: r.get(0)?,
        conversation_id: r.get(1)?,
        template_task_id: r.get(2)?,
        name: r.get(3)?,
        enabled: r.get(4)?,
        next_run_at: timestamp(r.get(5)?)?,
        repeat_seconds: r.get(6)?,
        app_must_be_running: !crate::background_runtime::is_daemon(),
    })
}
const RUN_SELECT: &str = "SELECT id,schedule_id,conversation_id,scheduled_at,state,task_id,error,updated_at FROM data_schedule_runs";
fn run_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DataScheduleRun> {
    Ok(DataScheduleRun {
        id: r.get(0)?,
        schedule_id: r.get(1)?,
        conversation_id: r.get(2)?,
        scheduled_at: timestamp(r.get(3)?)?,
        state: r.get(4)?,
        task_id: r.get(5)?,
        error: r.get(6)?,
        updated_at: timestamp(r.get(7)?)?,
    })
}
fn get(db: &Connection, user: &str, id: &str) -> Result<DataSchedule, AppError> {
    db.query_row(
        &format!("{SELECT} WHERE id=?1 AND owner_id=?2"),
        params![id, user],
        schedule_row,
    )
    .optional()
    .map_err(storage)?
    .ok_or_else(|| workspace_error("DATA_SCHEDULE_NOT_FOUND", "当前账号没有此定时任务"))
}
fn get_run(db: &Connection, user: &str, id: &str) -> Result<DataScheduleRun, AppError> {
    db.query_row(
        &format!("{RUN_SELECT} WHERE id=?1 AND owner_id=?2"),
        params![id, user],
        run_row,
    )
    .optional()
    .map_err(storage)?
    .ok_or_else(|| workspace_error("DATA_SCHEDULE_NOT_FOUND", "当前账号没有此运行记录"))
}
fn bound_root(db: &Connection, schedule: &DataSchedule, current: &str) -> Result<(), AppError> {
    let saved: String = db
        .query_row(
            "SELECT workspace_root FROM data_schedules WHERE id=?1",
            [&schedule.id],
            |r| r.get(0),
        )
        .map_err(storage)?;
    if fs::canonicalize(saved).map_err(storage)? != fs::canonicalize(current).map_err(storage)? {
        return Err(workspace_error(
            "WORKSPACE_DENIED",
            "定时任务属于另一个工作区，请在当前工作区重新创建",
        ));
    }
    Ok(())
}
fn validate_time(
    next: DateTime<Utc>,
    repeat: Option<u32>,
    now: DateTime<Utc>,
) -> Result<(), AppError> {
    if next < now - chrono::Duration::seconds(60) || next > now + chrono::Duration::days(3660) {
        return Err(workspace_error(
            "DATA_SCHEDULE_INVALID",
            "请选择当前或未来的执行时间",
        ));
    }
    if repeat.is_some_and(|v| !(60..=31_536_000).contains(&v)) {
        return Err(workspace_error(
            "DATA_SCHEDULE_INVALID",
            "重复间隔应为 1 分钟至 365 天",
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn data_schedules_create(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    task_id: String,
    name: String,
    next_run_at: DateTime<Utc>,
    repeat_seconds: Option<u32>,
    execution_id: String,
) -> Result<DataSchedule, AppError> {
    let _gate = GATE
        .lock()
        .map_err(|_| storage("Schedule lock unavailable"))?;
    let user = owner(&services)?;
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    let task = data_jobs::data_download_get(
        app.clone(),
        state.clone(),
        services.clone(),
        conversation_id.clone(),
        task_id.clone(),
    )?;
    if task.status == "discarded" {
        return Err(workspace_error(
            "DATA_TASK_STATE",
            "已丢弃任务不能用作定时模板",
        ));
    }
    if fs::canonicalize(
        Path::new(&task.output_dir)
            .parent()
            .ok_or_else(|| storage("Invalid task path"))?,
    )
    .map_err(storage)?
        != fs::canonicalize(&workspace.directory).map_err(storage)?
    {
        return Err(workspace_error("WORKSPACE_DENIED", "模板不属于当前工作区"));
    }
    if name.trim().is_empty()
        || name.len() > 240
        || name.chars().any(char::is_control)
        || execution_id.is_empty()
        || execution_id.len() > 160
    {
        return Err(workspace_error(
            "DATA_SCHEDULE_INVALID",
            "定时任务名称或幂等标识无效",
        ));
    }
    let mut db = db(&state.db_path)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage)?;
    if let Some(existing) = tx
        .query_row(
            &format!("{SELECT} WHERE owner_id=?1 AND conversation_id=?2 AND execution_id=?3"),
            params![user, conversation_id, execution_id],
            schedule_row,
        )
        .optional()
        .map_err(storage)?
    {
        if existing.template_task_id != task_id
            || existing.name != name.trim()
            || existing.repeat_seconds != repeat_seconds
        {
            return Err(workspace_error(
                "IDEMPOTENCY_CONFLICT",
                "同一标识对应了不同的定时任务",
            ));
        }
        // next_run_at advances after firing, so compare the immutable creation value.
        let original: i64 = tx
            .query_row(
                "SELECT created_at FROM data_schedules WHERE id=?1",
                [&existing.id],
                |r| r.get(0),
            )
            .map_err(storage)?;
        if original != next_run_at.timestamp() {
            return Err(workspace_error(
                "IDEMPOTENCY_CONFLICT",
                "同一标识对应了不同的执行时间",
            ));
        }
        bound_root(&tx, &existing, &workspace.directory)?;
        return Ok(existing);
    }
    validate_time(next_run_at, repeat_seconds, Utc::now())?;
    let id = Uuid::new_v4().to_string();
    tx.execute("INSERT INTO data_schedules(id,owner_id,conversation_id,execution_id,template_task_id,name,request_json,workspace_root,enabled,next_run_at,repeat_seconds,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,?10,?9)",params![id,user,conversation_id,execution_id,task_id,name.trim(),serde_json::to_string(&task.request).map_err(storage)?,workspace.directory,next_run_at.timestamp(),repeat_seconds]).map_err(storage)?;
    let result = get(&tx, &user, &id)?;
    tx.commit().map_err(storage)?;
    Ok(result)
}
#[tauri::command]
pub(crate) fn data_schedules_list(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<Vec<DataSchedule>, AppError> {
    read_workspace(&app, &state, &services, &conversation_id)?;
    let db = db(&state.db_path)?;
    let mut stmt = db
        .prepare(&format!(
            "{SELECT} WHERE owner_id=?1 AND conversation_id=?2 ORDER BY next_run_at DESC"
        ))
        .map_err(storage)?;
    let rows = stmt
        .query_map(params![owner(&services)?, conversation_id], schedule_row)
        .map_err(storage)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)
}
#[tauri::command]
pub(crate) fn data_schedules_set_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    schedule_id: String,
    enabled: bool,
    next_run_at: Option<DateTime<Utc>>,
) -> Result<DataSchedule, AppError> {
    let _gate = GATE
        .lock()
        .map_err(|_| storage("Schedule lock unavailable"))?;
    let db = db(&state.db_path)?;
    let user = owner(&services)?;
    let schedule = get(&db, &user, &schedule_id)?;
    let workspace = read_workspace(&app, &state, &services, &schedule.conversation_id)?;
    bound_root(&db, &schedule, &workspace.directory)?;
    let next = next_run_at.unwrap_or_else(|| schedule.next_run_at.max(Utc::now()));
    if enabled {
        validate_time(next, schedule.repeat_seconds, Utc::now())?;
    }
    db.execute(
        "UPDATE data_schedules SET enabled=?2,next_run_at=?3 WHERE id=?1",
        params![schedule_id, enabled, next.timestamp()],
    )
    .map_err(storage)?;
    // Pausing stops future occurrences. Already-created tasks have their own cancel action.
    get(&db, &user, &schedule_id)
}
#[tauri::command]
pub(crate) fn data_schedules_runs(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<Vec<DataScheduleRun>, AppError> {
    read_workspace(&app, &state, &services, &conversation_id)?;
    let db = db(&state.db_path)?;
    let mut stmt=db.prepare(&format!("{RUN_SELECT} WHERE owner_id=?1 AND conversation_id=?2 ORDER BY scheduled_at DESC LIMIT 200")).map_err(storage)?;
    let rows = stmt
        .query_map(params![owner(&services)?, conversation_id], run_row)
        .map_err(storage)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)
}
#[tauri::command]
pub(crate) fn data_schedules_cancel_run(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    run_id: String,
) -> Result<DataScheduleRun, AppError> {
    let _gate = GATE
        .lock()
        .map_err(|_| storage("Schedule lock unavailable"))?;
    let db = db(&state.db_path)?;
    let user = owner(&services)?;
    let run = get_run(&db, &user, &run_id)?;
    read_workspace(&app, &state, &services, &run.conversation_id)?;
    if !matches!(
        run.state.as_str(),
        "queued" | "waiting_confirmation" | "running" | "cancelling"
    ) {
        return Err(workspace_error("DATA_TASK_STATE", "此次运行已经结束"));
    }
    if let Some(id) = &run.task_id {
        let task = data_jobs::data_download_get(
            app.clone(),
            state.clone(),
            services.clone(),
            run.conversation_id.clone(),
            id.clone(),
        )?;
        if !matches!(
            task.status.as_str(),
            "completed" | "partial" | "discarded" | "cancelled"
        ) {
            let cancelled = data_jobs::data_download_cancel(
                app,
                state,
                services,
                run.conversation_id.clone(),
                id.clone(),
            )?;
            if cancelled.status == "cancelling" {
                save_state(&db, &run.id, "cancelling", None, Utc::now())?;
                return get_run(&db, &user, &run_id);
            }
        }
        // Do not report cancellation if the job crossed its commit boundary first.
        if task.status == "completed" {
            save_state(&db, &run.id, "succeeded", None, Utc::now())?;
            return get_run(&db, &user, &run_id);
        }
        if task.status == "partial" {
            save_state(&db, &run.id, "partial", None, Utc::now())?;
            return get_run(&db, &user, &run_id);
        }
    }
    save_state(&db, &run.id, "cancelled", None, Utc::now())?;
    get_run(&db, &user, &run_id)
}
fn save_state(
    db: &Connection,
    id: &str,
    state: &str,
    error: Option<&str>,
    now: DateTime<Utc>,
) -> Result<(), AppError> {
    db.execute(
        "UPDATE data_schedule_runs SET state=?2,error=?3,updated_at=?4 WHERE id=?1",
        params![id, state, error, now.timestamp()],
    )
    .map_err(storage)?;
    Ok(())
}
// Claim and advance are one SQLite transaction: a crash cannot duplicate a due
// occurrence. Missed intervals coalesce to one occurrence, anchored to its cadence.
fn claim_due(db: &mut Connection, user: &str, now: DateTime<Utc>) -> Result<(), AppError> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage)?;
    let due = {
        let mut stmt = tx
            .prepare(&format!(
                "{SELECT} WHERE owner_id=?1 AND enabled=1 AND next_run_at<=?2"
            ))
            .map_err(storage)?;
        let rows = stmt
            .query_map(params![user, now.timestamp()], schedule_row)
            .map_err(storage)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage)?
    };
    for schedule in due {
        let live:bool=tx.query_row(&format!("SELECT EXISTS(SELECT 1 FROM data_schedule_runs WHERE schedule_id=?1 AND state IN ({LIVE}))"),[&schedule.id],|r|r.get(0)).map_err(storage)?;
        if !live {
            tx.execute("INSERT OR IGNORE INTO data_schedule_runs(id,schedule_id,owner_id,conversation_id,scheduled_at,state,updated_at) VALUES(?1,?2,?3,?4,?5,'queued',?6)",params![Uuid::new_v4().to_string(),schedule.id,user,schedule.conversation_id,schedule.next_run_at.timestamp(),now.timestamp()]).map_err(storage)?;
        }
        if let Some(seconds) = schedule.repeat_seconds {
            let cadence = i64::from(seconds);
            let previous = schedule.next_run_at.timestamp();
            let next = previous + ((now.timestamp() - previous) / cadence + 1) * cadence;
            tx.execute(
                "UPDATE data_schedules SET next_run_at=?2 WHERE id=?1",
                params![schedule.id, next],
            )
            .map_err(storage)?;
        } else if !live {
            tx.execute(
                "UPDATE data_schedules SET enabled=0 WHERE id=?1",
                [&schedule.id],
            )
            .map_err(storage)?;
        }
    }
    tx.commit().map_err(storage)
}
fn pending_state(status: &str, permission: WorkspacePermission) -> &'static str {
    match status {
        "pending" if permission == WorkspacePermission::ConfirmEach => "waiting_confirmation",
        "pending" => "start",
        "queued" | "downloading" | "verifying" | "cancelling" => "running",
        "completed" => "succeeded",
        "partial" => "partial",
        "cancelled" | "discarded" => "cancelled",
        // An interrupted occurrence is visible and recoverable from its task;
        // an app restart does not silently re-authorize a failed download.
        _ => "failed",
    }
}
fn advance(
    app: &AppHandle,
    db: &Connection,
    user: &str,
    run: &DataScheduleRun,
) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let services = app.state::<services::ServiceState>();
    if owner(&services)? != user {
        return Err(workspace_error("ACCOUNT_CHANGED", "账号已变更"));
    }
    let schedule = get(db, user, &run.schedule_id)?;
    let workspace = read_workspace(app, &state, &services, &run.conversation_id)?;
    bound_root(db, &schedule, &workspace.directory)?;
    let task = if let Some(id) = &run.task_id {
        data_jobs::data_download_get(
            app.clone(),
            state.clone(),
            services.clone(),
            run.conversation_id.clone(),
            id.clone(),
        )?
    } else {
        let request: String = db
            .query_row(
                "SELECT request_json FROM data_schedules WHERE id=?1",
                [&schedule.id],
                |r| r.get(0),
            )
            .map_err(storage)?;
        let task = data_jobs::data_download_plan(
            app.clone(),
            state.clone(),
            services.clone(),
            run.conversation_id.clone(),
            schedule.name.clone(),
            format!("data-schedule:{}", run.id),
            serde_json::from_str(&request).map_err(storage)?,
        )?;
        db.execute(
            "UPDATE data_schedule_runs SET task_id=?2,updated_at=?3 WHERE id=?1",
            params![run.id, task.id, Utc::now().timestamp()],
        )
        .map_err(storage)?;
        task
    };
    let decision = pending_state(&task.status, workspace.permission);
    if decision == "start" {
        // Native start re-reads account, root and full-access permission at dispatch.
        data_jobs::data_download_start_auto(
            app.clone(),
            state,
            services,
            run.conversation_id.clone(),
            task.id,
            task.plan_hash,
        )?;
        save_state(db, &run.id, "running", None, Utc::now())
    } else {
        save_state(
            db,
            &run.id,
            if run.state == "cancelling" && decision == "running" {
                "cancelling"
            } else {
                decision
            },
            task.error.as_deref(),
            Utc::now(),
        )
    }
}
pub(crate) fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let app = app.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || tick(&app)).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}
fn tick(app: &AppHandle) -> Result<(), AppError> {
    let _gate = GATE
        .lock()
        .map_err(|_| storage("Schedule lock unavailable"))?;
    if crate::background_runtime::STOPPING.load(std::sync::atomic::Ordering::Acquire) { return Ok(()); }
    let state = app.state::<AppState>();
    let services = app.state::<services::ServiceState>();
    let Ok(user) = owner(&services) else {
        return Ok(());
    };
    let mut db = db(&state.db_path)?;
    claim_due(&mut db, &user, Utc::now())?;
    let runs = {
        let mut stmt = db
            .prepare(&format!(
                "{RUN_SELECT} WHERE owner_id=?1 AND state IN ({LIVE}) ORDER BY scheduled_at"
            ))
            .map_err(storage)?;
        let rows = stmt.query_map([&user], run_row).map_err(storage)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage)?
    };
    for run in runs {
        if let Err(error) = advance(app, &db, &user, &run) {
            save_state(&db, &run.id, "failed", Some(&error.message), Utc::now())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn insert(db: &Connection, id: &str, owner: &str, time: i64, repeat: Option<u32>) {
        db.execute("INSERT INTO data_schedules VALUES(?1,?2,'conversation',?1,'template','区域数据','{}','workspace',1,?3,?4,?3)",params![id,owner,time,repeat]).unwrap();
    }
    #[test]
    fn due_claim_is_persistent_idempotent_and_owner_bound() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("test.db");
        let mut db = db(&path).unwrap();
        let now = Utc::now();
        insert(&db, "ours", "owner", now.timestamp() - 180, Some(60));
        insert(&db, "other", "other", now.timestamp() - 180, None);
        claim_due(&mut db, "owner", now).unwrap();
        claim_due(&mut db, "owner", now).unwrap();
        assert_eq!(
            db.query_row::<i64, _, _>("SELECT COUNT(*) FROM data_schedule_runs", [], |r| r.get(0))
                .unwrap(),
            1
        );
        assert_eq!(
            get(&db, "owner", "ours").unwrap().next_run_at.timestamp(),
            now.timestamp() + 60
        );
        assert!(get(&db, "other", "ours").is_err());
        drop(db);
        let mut db = super::db(&path).unwrap();
        claim_due(&mut db, "owner", now + chrono::Duration::seconds(120)).unwrap();
        assert_eq!(
            db.query_row::<i64, _, _>("SELECT COUNT(*) FROM data_schedule_runs", [], |r| r.get(0))
                .unwrap(),
            1,
            "active occurrence must not overlap after reopen"
        );
        db.execute("UPDATE data_schedule_runs SET state='succeeded'", [])
            .unwrap();
        claim_due(&mut db, "owner", now + chrono::Duration::seconds(180)).unwrap();
        assert_eq!(
            db.query_row::<i64, _, _>("SELECT COUNT(*) FROM data_schedule_runs", [], |r| r.get(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn once_pause_cancel_and_permission_decisions() {
        let temp = tempfile::tempdir().unwrap();
        let mut db = db(&temp.path().join("test.db")).unwrap();
        let now = Utc::now();
        insert(&db, "once", "u", now.timestamp(), None);
        insert(&db, "paused", "u", now.timestamp(), Some(60));
        db.execute("UPDATE data_schedules SET enabled=0 WHERE id='paused'", [])
            .unwrap();
        claim_due(&mut db, "u", now).unwrap();
        assert!(!get(&db, "u", "once").unwrap().enabled);
        let id: String = db
            .query_row("SELECT id FROM data_schedule_runs", [], |r| r.get(0))
            .unwrap();
        save_state(&db, &id, "cancelled", None, now).unwrap();
        claim_due(&mut db, "u", now + chrono::Duration::days(1)).unwrap();
        assert_eq!(get_run(&db, "u", &id).unwrap().state, "cancelled");
        assert_eq!(
            db.query_row::<i64, _, _>("SELECT COUNT(*) FROM data_schedule_runs", [], |r| r.get(0))
                .unwrap(),
            1
        );
        assert_eq!(
            pending_state("pending", WorkspacePermission::ConfirmEach),
            "waiting_confirmation"
        );
        assert_eq!(
            pending_state("pending", WorkspacePermission::FullAccess),
            "start"
        );
        assert_eq!(
            pending_state("interrupted", WorkspacePermission::FullAccess),
            "failed"
        );
        assert_eq!(
            pending_state("completed", WorkspacePermission::ConfirmEach),
            "succeeded"
        );
        assert!(validate_time(now, Some(59), now).is_err());
        assert!(validate_time(now, Some(60), now).is_ok());
    }
}

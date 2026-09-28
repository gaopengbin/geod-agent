mod services;

use chrono::Utc;
use geod_core::imagery::{self, CoreError, HttpSource, Manifest};
use geod_task_engine::{
    ledger::{Approval, Job, JobEvent, LedgerError, StoredPlan, TaskStore},
    SourceDescriptor, TaskSpec,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, State};

struct AppState {
    db_path: PathBuf,
    running_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppError {
    code: &'static str,
    message: String,
}

impl From<LedgerError> for AppError {
    fn from(error: LedgerError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

impl From<CoreError> for AppError {
    fn from(error: CoreError) -> Self {
        Self {
            code: error.code,
            message: error.message,
        }
    }
}

fn open_store(state: &AppState) -> Result<TaskStore, AppError> {
    TaskStore::open(&state.db_path).map_err(Into::into)
}

#[tauri::command]
fn sources_list(state: State<'_, AppState>) -> Result<Vec<SourceDescriptor>, AppError> {
    open_store(&state)?.list_sources().map_err(Into::into)
}

/// This command belongs only to the user-facing source registration form.
#[tauri::command]
fn sources_save(
    state: State<'_, AppState>,
    endpoint: HttpSource,
    min_zoom: u8,
    max_zoom: u8,
    permission_acknowledged: bool,
) -> Result<SourceDescriptor, AppError> {
    open_store(&state)?
        .save_source(
            endpoint,
            min_zoom,
            max_zoom,
            permission_acknowledged,
            Utc::now(),
        )
        .map_err(Into::into)
}

#[tauri::command]
fn plans_create(state: State<'_, AppState>, spec: TaskSpec) -> Result<StoredPlan, AppError> {
    let mut store = open_store(&state)?;
    let source = store
        .get_registered_source(&spec.source_id)?
        .ok_or_else(|| AppError {
            code: "SOURCE_UNAUTHORIZED",
            message: "请先登记有权批量下载的图源".into(),
        })?;
    store
        .create_plan(spec, &source.descriptor, Utc::now())
        .map_err(Into::into)
}

#[tauri::command]
fn plans_get(state: State<'_, AppState>, plan_id: String) -> Result<Option<StoredPlan>, AppError> {
    open_store(&state)?.get_plan(&plan_id).map_err(Into::into)
}

/// Kept separate from all model-facing tools. The UI asks for confirmation.
#[tauri::command]
fn approvals_grant(
    state: State<'_, AppState>,
    plan_id: String,
    plan_hash: String,
) -> Result<Approval, AppError> {
    let actor = std::env::var("USERNAME").unwrap_or_else(|_| "local-user".into());
    open_store(&state)?
        .grant_approval(&plan_id, &plan_hash, &actor, "desktop-0.1", Utc::now())
        .map_err(Into::into)
}

#[tauri::command]
fn jobs_start(
    state: State<'_, AppState>,
    plan_id: String,
    plan_hash: String,
    approval_id: String,
    idempotency_key: String,
) -> Result<Job, AppError> {
    let mut store = open_store(&state)?;
    let stored = store.get_plan(&plan_id)?.ok_or_else(|| AppError {
        code: "PLAN_NOT_FOUND",
        message: "计划不存在".into(),
    })?;
    let source = store
        .get_registered_source(&stored.plan.spec.source_id)?
        .ok_or_else(|| AppError {
            code: "SOURCE_UNAUTHORIZED",
            message: "图源已移除".into(),
        })?;
    let job = store.start_job(
        &plan_id,
        &plan_hash,
        &approval_id,
        &idempotency_key,
        &source.descriptor,
        Utc::now(),
    )?;
    drop(store);

    let mut active = state
        .running_jobs
        .lock()
        .expect("running-job mutex poisoned");
    let should_spawn = !active.contains_key(&job.job_id)
        && job.state == geod_task_engine::ledger::JobState::Queued;
    if should_spawn {
        let cancelled = Arc::new(AtomicBool::new(false));
        active.insert(job.job_id.clone(), Arc::clone(&cancelled));
        drop(active);
        let db_path = state.db_path.clone();
        let running_jobs = Arc::clone(&state.running_jobs);
        let job_id = job.job_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(mut store) = TaskStore::open(&db_path) {
                let _ = store
                    .run_job_with_cancel(
                        &job_id,
                        &source.descriptor,
                        &source.endpoint,
                        Utc::now(),
                        &cancelled,
                    )
                    .await;
            }
            running_jobs
                .lock()
                .expect("running-job mutex poisoned")
                .remove(&job_id);
        });
    }
    Ok(job)
}

#[tauri::command]
fn jobs_cancel(state: State<'_, AppState>, job_id: String) -> Result<Job, AppError> {
    let job = open_store(&state)?
        .get_job(&job_id)?
        .ok_or_else(|| AppError {
            code: "JOB_NOT_FOUND",
            message: "任务不存在".into(),
        })?;
    if !matches!(
        job.state,
        geod_task_engine::ledger::JobState::Queued
            | geod_task_engine::ledger::JobState::Downloading
    ) {
        return Err(AppError {
            code: "JOB_STATE_CONFLICT",
            message: "当前阶段无法取消".into(),
        });
    }
    if let Some(flag) = state
        .running_jobs
        .lock()
        .expect("running-job mutex poisoned")
        .get(&job_id)
    {
        flag.store(true, Ordering::Relaxed);
        return Ok(job);
    }
    open_store(&state)?
        .cancel_inactive_job(&job_id)
        .map_err(Into::into)
}

#[tauri::command]
fn jobs_resume(state: State<'_, AppState>, job_id: String) -> Result<Job, AppError> {
    let mut store = open_store(&state)?;
    let mut job = store.get_job(&job_id)?.ok_or_else(|| AppError {
        code: "JOB_NOT_FOUND",
        message: "任务不存在".into(),
    })?;
    if job.state == geod_task_engine::ledger::JobState::Failed {
        job = store.retry_failed_job(&job_id)?;
    }
    if !matches!(
        job.state,
        geod_task_engine::ledger::JobState::Queued
            | geod_task_engine::ledger::JobState::Downloading
    ) {
        return Err(AppError {
            code: "JOB_STATE_CONFLICT",
            message: "此任务无法恢复".into(),
        });
    }
    let plan = store.get_plan(&job.plan_id)?.ok_or_else(|| AppError {
        code: "PLAN_NOT_FOUND",
        message: "计划不存在".into(),
    })?;
    let source = store
        .get_registered_source(&plan.plan.spec.source_id)?
        .ok_or_else(|| AppError {
            code: "SOURCE_UNAUTHORIZED",
            message: "图源已移除".into(),
        })?;
    drop(store);
    let mut active = state
        .running_jobs
        .lock()
        .expect("running-job mutex poisoned");
    if active.contains_key(&job_id) {
        return Ok(job);
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    active.insert(job_id.clone(), Arc::clone(&cancelled));
    drop(active);
    let db_path = state.db_path.clone();
    let running_jobs = Arc::clone(&state.running_jobs);
    tauri::async_runtime::spawn(async move {
        if let Ok(mut store) = TaskStore::open(&db_path) {
            let _ = store
                .run_job_with_cancel(
                    &job_id,
                    &source.descriptor,
                    &source.endpoint,
                    Utc::now(),
                    &cancelled,
                )
                .await;
        }
        running_jobs
            .lock()
            .expect("running-job mutex poisoned")
            .remove(&job_id);
    });
    Ok(job)
}

#[tauri::command]
fn jobs_get(state: State<'_, AppState>, job_id: String) -> Result<Option<Job>, AppError> {
    open_store(&state)?.get_job(&job_id).map_err(Into::into)
}

#[tauri::command]
fn jobs_list(state: State<'_, AppState>) -> Result<Vec<Job>, AppError> {
    open_store(&state)?.list_jobs(100).map_err(Into::into)
}

#[tauri::command]
fn jobs_active(state: State<'_, AppState>) -> Vec<String> {
    state
        .running_jobs
        .lock()
        .expect("running-job mutex poisoned")
        .keys()
        .cloned()
        .collect()
}

#[tauri::command]
fn jobs_events(
    state: State<'_, AppState>,
    job_id: String,
    after_seq: u64,
) -> Result<Vec<JobEvent>, AppError> {
    open_store(&state)?
        .events_after(&job_id, after_seq, 500)
        .map_err(Into::into)
}

#[tauri::command]
fn artifacts_inspect(state: State<'_, AppState>, job_id: String) -> Result<Manifest, AppError> {
    let store = open_store(&state)?;
    let job = store.get_job(&job_id)?.ok_or_else(|| AppError {
        code: "JOB_NOT_FOUND",
        message: "任务不存在".into(),
    })?;
    let plan = store.get_plan(&job.plan_id)?.ok_or_else(|| AppError {
        code: "PLAN_NOT_FOUND",
        message: "计划不存在".into(),
    })?;
    imagery::inspect_bundle(&PathBuf::from(plan.plan.spec.output_directory)).map_err(Into::into)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("agent-tasks.sqlite");
            TaskStore::open(&db_path).map_err(|error| {
                std::io::Error::other(format!("{}: {}", error.code, error.message))
            })?;
            app.manage(AppState {
                db_path,
                running_jobs: Arc::new(Mutex::new(HashMap::new())),
            });
            app.manage(services::ServiceState::new(
                data_dir.join("agent-services.json"),
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sources_list,
            sources_save,
            plans_create,
            plans_get,
            approvals_grant,
            jobs_start,
            jobs_cancel,
            jobs_resume,
            jobs_get,
            jobs_list,
            jobs_active,
            jobs_events,
            artifacts_inspect,
            services::service_config_get,
            services::service_config_set,
            services::auth_status,
            services::auth_begin,
            services::auth_logout,
            services::agent_generate,
            services::agent_usage,
            services::agent_generation_get,
        ])
        .run(tauri::generate_context!())
        .expect("GeoD Agent desktop failed to start");
}

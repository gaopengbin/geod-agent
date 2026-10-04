//! Local imagery scheduler, independent of the model turn and WebView lifecycle.
use super::*;
use chrono::DateTime;
use geod_task_engine::{
    ledger::JobState,
    schedule_store::{Schedule, ScheduleRun},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    pub template_plan_id: Option<String>,
    pub schedule_id: String,
    pub conversation_id: String,
    pub name: String,
    pub enabled: bool,
    pub next_run_at: DateTime<Utc>,
    pub repeat_seconds: Option<u32>,
    pub max_retries: u8,
    pub source_id: String,
    pub zoom_levels: Vec<u8>,
    pub app_must_be_running: bool,
}
impl From<Schedule> for ScheduleView {
    fn from(s: Schedule) -> Self {
        Self {
            template_plan_id: s.template_plan_id,
            schedule_id: s.schedule_id,
            conversation_id: s.conversation_id,
            name: s.name,
            enabled: s.enabled,
            next_run_at: s.next_run_at,
            repeat_seconds: s.repeat_seconds,
            max_retries: s.max_retries,
            source_id: s.template.source_id,
            zoom_levels: s.template.zoom_levels,
            app_must_be_running: !crate::background_runtime::is_daemon(),
        }
    }
}
fn owner(services: &services::ServiceState) -> Result<String, AppError> {
    services::current_user_id(services).map_err(|e| workspace_error(e.code, e.message))
}

#[tauri::command]
pub fn schedules_create(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    plan_id: String,
    name: String,
    next_run_at: DateTime<Utc>,
    repeat_seconds: Option<u32>,
    max_retries: Option<u8>,
    execution_id: String,
) -> Result<ScheduleView, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    let mut store = open_store(&state)?;
    let plan = store
        .get_plan(&plan_id)?
        .ok_or_else(|| workspace_error("PLAN_NOT_FOUND", "计划不存在"))?;
    // The schedule snapshots an existing technical plan, and creates a fresh output folder at each occurrence.
    let parent = Path::new(&plan.plan.spec.output_directory)
        .parent()
        .ok_or_else(|| workspace_error("WORKSPACE_DENIED", "计划输出路径无效"))?;
    if fs::canonicalize(parent).ok() != fs::canonicalize(&workspace.directory).ok() {
        return Err(workspace_error(
            "WORKSPACE_DENIED",
            "只能定时执行当前工作区的计划",
        ));
    }
    Ok(store
        .create_schedule(
            &owner(&services)?,
            &conversation_id,
            &execution_id,
            &name,
            Some(&plan_id),
            plan.plan.spec,
            next_run_at,
            repeat_seconds,
            max_retries.unwrap_or(2),
            Utc::now(),
        )?
        .into())
}
#[tauri::command]
pub fn schedules_list(
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<Vec<ScheduleView>, AppError> {
    Ok(open_store(&state)?
        .list_schedules(&owner(&services)?, &conversation_id)?
        .into_iter()
        .map(Into::into)
        .collect())
}
#[tauri::command]
pub fn schedules_set_enabled(
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    schedule_id: String,
    enabled: bool,
    next_run_at: Option<DateTime<Utc>>,
) -> Result<ScheduleView, AppError> {
    Ok(open_store(&state)?
        .set_schedule_enabled(
            &owner(&services)?,
            &schedule_id,
            enabled,
            next_run_at,
            Utc::now(),
        )?
        .into())
}
#[tauri::command]
pub fn schedules_runs(
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<Vec<ScheduleRun>, AppError> {
    Ok(
        open_store(&state)?.list_schedule_runs(
            &owner(&services)?,
            Some(&conversation_id),
            false,
        )?,
    )
}
#[tauri::command]
pub fn schedules_cancel_run(
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    run_id: String,
) -> Result<ScheduleRun, AppError> {
    let _guard = state.schedule_gate.lock().expect("schedule lock");
    let mut store = open_store(&state)?;
    let mut run = store
        .list_schedule_runs(&owner(&services)?, None, true)?
        .into_iter()
        .find(|run| run.run_id == run_id)
        .ok_or_else(|| workspace_error("SCHEDULE_NOT_FOUND", "运行记录不存在或已经结束"))?;
    if let Some(job_id) = &run.job_id {
        jobs_cancel(state.clone(), job_id.clone())?;
    }
    run.state = "cancelled".into();
    run.finished_at = Some(Utc::now());
    store.save_schedule_run(&run)?;
    Ok(run)
}

pub fn start(app: AppHandle) {
    let worker = Uuid::new_v4().to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            let app = app.clone();
            let worker = worker.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || tick(&app, &worker)).await;
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}
fn tick(app: &AppHandle, worker: &str) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let services = app.state::<services::ServiceState>();
    let _guard = state.schedule_gate.lock().expect("schedule lock");
    if crate::background_runtime::STOPPING.load(Ordering::Acquire) { return Ok(()); }
    let Ok(user) = owner(&services) else {
        return Ok(());
    };
    let mut store = open_store(&state)?;
    store.claim_due_schedules(&user, Utc::now())?;
    for pending in store.list_schedule_runs(&user, None, true)? {
        let Some(mut run) = store.lease_schedule_run(&pending.run_id, worker, Utc::now())? else {
            continue;
        };
        let Some(schedule) = store.get_schedule(&user, &run.schedule_id)? else {
            continue;
        };
        let result = advance(app, &state, &services, &schedule, &mut run);
        if let Err(error) = result {
            if run.attempt == pending.attempt {
                run.attempt = run.attempt.saturating_add(1);
            }
            run.error_code = Some(error.code.into());
            let transient = matches!(
                error.code,
                "SOURCE_NETWORK"
                    | "SOURCE_RATE_LIMITED"
                    | "SOURCE_TEMPORARY"
                    | "TIMEOUT"
                    | "NETWORK_SETTINGS_ERROR"
            );
            if transient && run.attempt <= schedule.max_retries {
                run.state = "retrying".into();
                run.next_attempt_at = Utc::now()
                    + chrono::Duration::seconds(15_i64 * 2_i64.pow(u32::from(run.attempt.min(3))));
            } else {
                run.state = "failed".into();
                run.finished_at = Some(Utc::now());
            }
        }
        store.save_schedule_run(&run)?;
    }
    Ok(())
}
fn advance(
    app: &AppHandle,
    state: &AppState,
    services: &services::ServiceState,
    schedule: &Schedule,
    run: &mut ScheduleRun,
) -> Result<(), AppError> {
    let workspace = read_workspace(app, state, services, &schedule.conversation_id)?;
    let mut store = open_store(state)?;
    if run.plan_id.is_none() {
        run.attempt += 1;
        let mut spec = schedule.template.clone();
        let folder = format!(
            "imagery-{}-{}",
            run.scheduled_at.format("%Y%m%d-%H%M%S"),
            &run.run_id[..8]
        );
        spec.output_directory = Path::new(&workspace.directory)
            .join(folder)
            .to_string_lossy()
            .into_owned();
        let key = format!("schedule:{}", run.run_id);
        let source = store
            .get_registered_source(&spec.source_id)?
            .ok_or_else(|| workspace_error("SOURCE_UNAUTHORIZED", "定时任务的图源已移除"))?;
        let plan =
            store.create_plan_for_tool_execution(&key, spec, &source.descriptor, Utc::now())?;
        crate::imagery_recovery::bind_created_plan(
            state, &owner(services)?, &schedule.conversation_id,
            Path::new(&workspace.directory), &plan.plan_id,
        )?;
        run.plan_id = Some(plan.plan_id);
        store.save_schedule_run(run)?;
    }
    let plan_id = run.plan_id.as_ref().unwrap();
    // Existing scheduled runs are already tied to a native account + conversation
    // record, so they can safely migrate to the same immutable ownership ledger.
    crate::imagery_recovery::bind_created_plan(
        state, &owner(services)?, &schedule.conversation_id,
        Path::new(&workspace.directory), plan_id,
    )?;
    if let Some(job) = store.job_for_plan(plan_id)? {
        run.job_id = Some(job.job_id.clone());
        match job.state {
            JobState::Completed => {
                run.state = "succeeded".into();
                run.finished_at = Some(Utc::now());
                run.error_code = None;
            }
            JobState::Cancelled => {
                run.state = "cancelled".into();
                run.finished_at = Some(Utc::now());
            }
            JobState::Partial => {
                run.state = "failed".into();
                run.error_code = Some("ARTIFACT_PARTIAL".into());
                run.finished_at = Some(Utc::now());
            }
            JobState::Paused => {
                run.state = "paused".into();
            }
            JobState::Failed => {
                let event = store
                    .events_after(&job.job_id, job.version.saturating_sub(1), 1)?
                    .pop();
                let code = event
                    .and_then(|event| event.error_code)
                    .unwrap_or_else(|| "JOB_FAILED".into());
                if matches!(
                    code.as_str(),
                    "SOURCE_NETWORK" | "SOURCE_RATE_LIMITED" | "SOURCE_TEMPORARY" | "TIMEOUT"
                ) && run.attempt <= schedule.max_retries
                {
                    if workspace.permission != WorkspacePermission::FullAccess {
                        run.state = "waiting_confirmation".into();
                        run.error_code = Some("APPROVAL_REQUIRED".into());
                        return Ok(());
                    }
                    if run.state != "retrying" {
                        run.state = "retrying".into();
                        run.error_code = Some(code);
                        run.next_attempt_at = Utc::now()
                            + chrono::Duration::seconds(
                                15_i64 * 2_i64.pow(u32::from(run.attempt.min(3))),
                            );
                        return Ok(());
                    }
                    run.attempt += 1;
                    drop(store);
                    jobs_resume(app.state(), job.job_id)?;
                    run.state = "running".into();
                } else {
                    run.state = "failed".into();
                    run.error_code = Some(code);
                    run.finished_at = Some(Utc::now());
                }
            }
            JobState::Queued | JobState::Downloading => {
                if !state
                    .running_jobs
                    .lock()
                    .expect("worker lock")
                    .contains_key(&job.job_id)
                {
                    if workspace.permission != WorkspacePermission::FullAccess {
                        run.state = "waiting_confirmation".into();
                        run.error_code = Some("APPROVAL_REQUIRED".into());
                        return Ok(());
                    }
                    drop(store);
                    jobs_resume(app.state(), job.job_id)?;
                }
                run.state = "running".into();
            }
            JobState::Processing | JobState::Verifying => {
                run.state = "running".into();
            }
        }
        return Ok(());
    }
    if workspace.permission != WorkspacePermission::FullAccess {
        run.state = "waiting_confirmation".into();
        return Ok(());
    }
    if run.state == "retrying" {
        run.attempt += 1;
    }
    drop(store);
    let job = jobs_start_auto(
        app.clone(),
        app.state(),
        app.state(),
        plan_id.clone(),
        schedule.conversation_id.clone(),
        format!("schedule:{}", run.run_id),
    )?;
    run.job_id = Some(job.job_id);
    run.state = "running".into();
    run.error_code = None;
    Ok(())
}

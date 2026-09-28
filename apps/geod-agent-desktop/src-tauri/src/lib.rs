mod services;

use base64::Engine;
use chrono::Utc;
use geod_core::boundary::BoundaryGeometry;
use geod_core::imagery::{CoreError, HttpSource, Manifest};
use geod_task_engine::{
    ledger::{Approval, Job, JobEvent, LedgerError, StoredPlan, TaskStore},
    SourceDescriptor, TaskSpec,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

struct AppState {
    db_path: PathBuf,
    running_jobs: Arc<Mutex<HashMap<String, Arc<WorkerControl>>>>,
}

#[derive(Default)]
struct WorkerControl {
    cancelled: AtomicBool,
    paused: AtomicBool,
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
fn output_directory_suggest(app: AppHandle) -> Result<String, AppError> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|error| AppError {
            code: "STORAGE_ERROR",
            message: error.to_string(),
        })?;
    let name = format!(
        "imagery-{}-{}",
        Utc::now().format("%Y%m%d-%H%M%S"),
        &Uuid::new_v4().simple().to_string()[..8]
    );
    Ok(base
        .join("GeoD Agent")
        .join(name)
        .to_string_lossy()
        .into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundaryImport {
    name: String,
    bounds: [f64; 4],
    polygon_count: usize,
    geometry: BoundaryGeometry,
}

/// The model sees only a bounded extent and count. Geometry remains in the
/// desktop plan and is never sent in an Agent tool result.
#[tauri::command]
fn boundary_inspect(name: String, text: String) -> Result<BoundaryImport, AppError> {
    let file_name = PathBuf::from(name);
    if text.len() > 1024 * 1024
        || !matches!(
            file_name
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("geojson" | "json")
        )
    {
        return Err(AppError {
            code: "INVALID_BOUNDARY",
            message: "请选择本机 GeoJSON 文件".into(),
        });
    }
    let mut geometry =
        BoundaryGeometry::from_geojson(text.as_bytes()).map_err(|cause| AppError {
            code: "INVALID_BOUNDARY",
            message: cause.0.into(),
        })?;
    let bounds = geometry.normalize().map_err(|cause| AppError {
        code: "INVALID_BOUNDARY",
        message: cause.0.into(),
    })?;
    let name = file_name
        .file_name()
        .map(|value| value.to_string_lossy().chars().take(120).collect())
        .unwrap_or_else(|| "boundary.geojson".into());
    Ok(BoundaryImport {
        name,
        bounds,
        polygon_count: geometry.polygons.len(),
        geometry,
    })
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
        let control = Arc::new(WorkerControl::default());
        active.insert(job.job_id.clone(), Arc::clone(&control));
        drop(active);
        let db_path = state.db_path.clone();
        let running_jobs = Arc::clone(&state.running_jobs);
        let job_id = job.job_id.clone();
        tauri::async_runtime::spawn(async move {
            if let Ok(mut store) = TaskStore::open(&db_path) {
                let _ = store
                    .run_job_with_control(
                        &job_id,
                        &source.descriptor,
                        &source.endpoint,
                        Utc::now(),
                        &control.cancelled,
                        &control.paused,
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
            | geod_task_engine::ledger::JobState::Paused
    ) {
        return Err(AppError {
            code: "JOB_STATE_CONFLICT",
            message: "当前阶段无法取消".into(),
        });
    }
    if job.state == geod_task_engine::ledger::JobState::Paused {
        return open_store(&state)?
            .cancel_inactive_job(&job_id)
            .map_err(Into::into);
    }
    if let Some(control) = state
        .running_jobs
        .lock()
        .expect("running-job mutex poisoned")
        .get(&job_id)
    {
        control.cancelled.store(true, Ordering::Relaxed);
        return Ok(job);
    }
    open_store(&state)?
        .cancel_inactive_job(&job_id)
        .map_err(Into::into)
}

#[tauri::command]
fn jobs_pause(state: State<'_, AppState>, job_id: String) -> Result<Job, AppError> {
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
            message: "当前阶段无法暂停".into(),
        });
    }
    if let Some(control) = state
        .running_jobs
        .lock()
        .expect("running-job mutex poisoned")
        .get(&job_id)
    {
        control.paused.store(true, Ordering::Relaxed);
        return Ok(job);
    }
    open_store(&state)?
        .pause_inactive_job(&job_id)
        .map_err(Into::into)
}

#[tauri::command]
fn jobs_resume(state: State<'_, AppState>, job_id: String) -> Result<Job, AppError> {
    let mut store = open_store(&state)?;
    let mut job = store.get_job(&job_id)?.ok_or_else(|| AppError {
        code: "JOB_NOT_FOUND",
        message: "任务不存在".into(),
    })?;
    if state
        .running_jobs
        .lock()
        .expect("running-job mutex poisoned")
        .contains_key(&job_id)
    {
        return Err(AppError {
            code: "JOB_STATE_CONFLICT",
            message: "作业仍在停止中，请稍后继续".into(),
        });
    }
    if job.state == geod_task_engine::ledger::JobState::Failed {
        job = store.retry_failed_job(&job_id)?;
    } else if job.state == geod_task_engine::ledger::JobState::Paused {
        job = store.resume_paused_job(&job_id)?;
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
    let control = Arc::new(WorkerControl::default());
    active.insert(job_id.clone(), Arc::clone(&control));
    drop(active);
    let db_path = state.db_path.clone();
    let running_jobs = Arc::clone(&state.running_jobs);
    tauri::async_runtime::spawn(async move {
        if let Ok(mut store) = TaskStore::open(&db_path) {
            let _ = store
                .run_job_with_control(
                    &job_id,
                    &source.descriptor,
                    &source.endpoint,
                    Utc::now(),
                    &control.cancelled,
                    &control.paused,
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
fn jobs_for_plan(state: State<'_, AppState>, plan_id: String) -> Result<Option<Job>, AppError> {
    open_store(&state)?
        .job_for_plan(&plan_id)
        .map_err(Into::into)
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
    open_store(&state)?
        .inspect_job_artifact(&job_id)
        .map_err(Into::into)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactPreview {
    data_url: String,
    bounds: [f64; 4],
    attribution: String,
}

#[tauri::command]
fn artifact_preview(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<Option<ArtifactPreview>, AppError> {
    let store = open_store(&state)?;
    let manifest = store.inspect_job_artifact(&job_id)?;
    let preview = match manifest
        .assets
        .iter()
        .find(|asset| asset.role == "preview" && asset.mime_type == "image/png")
    {
        Some(asset) => asset,
        None => return Ok(None),
    };
    if preview.path != "preview.png" || preview.bytes > 8 * 1024 * 1024 {
        return Err(AppError {
            code: "PREVIEW_INVALID",
            message: "Preview asset is unsafe or too large".into(),
        });
    }
    let job = store.get_job(&job_id)?.ok_or_else(|| AppError {
        code: "JOB_NOT_FOUND",
        message: "Job was not found".into(),
    })?;
    let plan = store.get_plan(&job.plan_id)?.ok_or_else(|| AppError {
        code: "PLAN_NOT_FOUND",
        message: "Plan was not found".into(),
    })?;
    let bytes = fs::read(PathBuf::from(&plan.plan.spec.output_directory).join(&preview.path))
        .map_err(|error| AppError {
            code: "PREVIEW_INVALID",
            message: error.to_string(),
        })?;
    if bytes.len() as u64 != preview.bytes
        || format!("{:x}", Sha256::digest(&bytes)) != preview.sha256
    {
        return Err(AppError {
            code: "PREVIEW_INVALID",
            message: "Preview checksum changed after artifact inspection".into(),
        });
    }
    Ok(Some(ArtifactPreview {
        data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ),
        bounds: preview.bounds,
        attribution: manifest
            .provenance
            .first()
            .map(|source| source.attribution.clone())
            .unwrap_or(plan.plan.attribution),
    }))
}

#[cfg(windows)]
fn windows_user_proxy() -> Option<reqwest::Proxy> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    let enabled: u32 = settings.get_value("ProxyEnable").ok()?;
    if enabled == 0 {
        return None;
    }
    let configured: String = settings.get_value("ProxyServer").ok()?;
    let server = configured
        .split(';')
        .find_map(|entry| entry.strip_prefix("https="))
        .or_else(|| configured.split(';').find(|entry| !entry.contains('=')))?;
    let address = if server.contains("://") {
        server.to_string()
    } else {
        format!("http://{server}")
    };
    reqwest::Proxy::all(address).ok()
}

/// Interactive viewport tiles only. OSM imagery is never included in GeoD exports.
#[tauri::command]
async fn osm_basemap_tile(app: AppHandle, z: u8, x: u32, y: u32) -> Result<String, AppError> {
    if z > 15 || x >= (1u32 << z) || y >= (1u32 << z) {
        return Err(AppError {
            code: "MAP_TILE_INVALID",
            message: "Map tile coordinate is outside the supported range".into(),
        });
    }
    let root = app.path().app_cache_dir().map_err(|error| AppError {
        code: "MAP_CACHE_ERROR",
        message: error.to_string(),
    })?;
    let tile_path = root
        .join("osm-basemap")
        .join(z.to_string())
        .join(x.to_string())
        .join(format!("{y}.png"));
    let cached = fs::metadata(&tile_path).ok();
    let fresh = cached
        .as_ref()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age < Duration::from_secs(7 * 24 * 60 * 60));
    if fresh {
        let bytes = fs::read(&tile_path).map_err(|error| AppError {
            code: "MAP_CACHE_ERROR",
            message: error.to_string(),
        })?;
        if bytes.len() <= 1024 * 1024 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Ok(base64::engine::general_purpose::STANDARD.encode(bytes));
        }
    }
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        let builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("GeoD-Agent/0.1 (desktop interactive basemap)");
        #[cfg(windows)]
        let builder = if let Some(proxy) = windows_user_proxy() {
            builder.proxy(proxy)
        } else {
            builder
        };
        builder.build().expect("valid GeoD HTTP client")
    });
    let response = client
        .get(format!("https://tile.openstreetmap.org/{z}/{x}/{y}.png"))
        .send()
        .await;
    let bytes = match response {
        Ok(response) if response.status().is_success() => response
            .bytes()
            .await
            .map_err(|error| AppError {
                code: "MAP_TILE_NETWORK",
                message: error.to_string(),
            })?
            .to_vec(),
        Ok(response) => {
            return Err(AppError {
                code: "MAP_TILE_NETWORK",
                message: format!("OpenStreetMap returned HTTP {}", response.status()),
            })
        }
        Err(error) => {
            if cached.is_some() {
                return fs::read(&tile_path)
                    .map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
                    .map_err(|io_error| AppError {
                        code: "MAP_CACHE_ERROR",
                        message: io_error.to_string(),
                    });
            }
            return Err(AppError {
                code: "MAP_TILE_NETWORK",
                message: error.to_string(),
            });
        }
    };
    if bytes.len() > 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err(AppError {
            code: "MAP_TILE_INVALID",
            message: "OpenStreetMap response is not a valid PNG tile".into(),
        });
    }
    let parent = tile_path.parent().ok_or_else(|| AppError {
        code: "MAP_CACHE_ERROR",
        message: "Map cache path is invalid".into(),
    })?;
    fs::create_dir_all(parent).map_err(|error| AppError {
        code: "MAP_CACHE_ERROR",
        message: error.to_string(),
    })?;
    let temporary = tile_path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    fs::write(&temporary, &bytes).map_err(|error| AppError {
        code: "MAP_CACHE_ERROR",
        message: error.to_string(),
    })?;
    if cached.is_some() {
        let _ = fs::remove_file(&tile_path);
    }
    if fs::rename(&temporary, &tile_path).is_err() {
        // Another in-flight request may have filled the same tile on Windows.
        let _ = fs::remove_file(&temporary);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
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
            output_directory_suggest,
            boundary_inspect,
            sources_list,
            sources_save,
            plans_create,
            plans_get,
            approvals_grant,
            jobs_start,
            jobs_cancel,
            jobs_pause,
            jobs_resume,
            jobs_get,
            jobs_for_plan,
            jobs_list,
            jobs_active,
            jobs_events,
            artifacts_inspect,
            artifact_preview,
            osm_basemap_tile,
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

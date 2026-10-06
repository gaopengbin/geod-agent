mod network;
mod services;
mod extensions;
mod mcp_credentials;
mod mcp_runtime_config;
mod mcp_process;
mod mcp_oauth;
mod mcp_interaction;
mod image_inputs;
mod attachment_inputs;
mod audio_inputs;
mod ocr_runtime;
mod legacy_office_runtime;
mod sql_mcp;
mod sql_connections;
mod sql_tls;
mod ai_schedules;
mod headless_tools;
mod source_creator;
mod source_auth;
mod online_boundary;
mod boundary_inputs;
mod schedules;
mod codex_runtime;
mod ai_channels;
mod sponsored_channels;
mod raster_protocol;
mod data_inputs;
mod postgis_mcp;
mod data_jobs;
mod data_schedules;
mod data_credentials;
mod imagery_recovery;
mod cache_management;
mod data_asset_protocol;
mod background_runtime;
mod online_inputs;
mod online_exports;
mod wfs_inputs;
mod connection_registry;
mod database_query;
mod database_tls;
mod background_commands;
mod agent_memory;
mod terrain_protocol;
mod execution_receipts;
mod python_runtime;
mod agent_tasks;
mod conversation_files;
mod desktop_settings;
mod desktop_backups;

use base64::Engine;
use chrono::Utc;
use geod_core::boundary::{BoundaryGeometry, MAX_GEOJSON_BYTES};
use geod_core::imagery::{CoreError, HttpSource, Manifest};
use geod_task_engine::{
    ledger::{Approval, Job, JobEvent, LedgerError, StoredPlan, TaskStore},
    SourceDescriptor, TaskSpec,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

struct AppState {
    db_path: PathBuf,
    workspace_dir: PathBuf,
    running_jobs: Arc<Mutex<HashMap<String, Arc<WorkerControl>>>>,
    schedule_gate: Mutex<()>,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSettings {
    directory: String,
    permission: WorkspacePermission,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum WorkspacePermission {
    ConfirmEach,
    FullAccess,
}

fn workspace_error(code: &'static str, message: impl Into<String>) -> AppError {
    AppError {
        code,
        message: message.into(),
    }
}

fn workspace_file(
    state: &AppState,
    services: &services::ServiceState,
    conversation_id: &str,
) -> Result<PathBuf, AppError> {
    if conversation_id.len() < 8
        || conversation_id.len() > 80
        || !conversation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(workspace_error("WORKSPACE_INVALID", "对话标识无效"));
    }
    let user_id = services::current_user_id(services)
        .map_err(|cause| workspace_error(cause.code, cause.message))?;
    Ok(state.workspace_dir.join(format!(
        "workspace-{:x}.json",
        Sha256::digest(format!("{user_id}:{conversation_id}").as_bytes())
    )))
}

fn read_workspace(
    app: &AppHandle,
    state: &AppState,
    services: &services::ServiceState,
    conversation_id: &str,
) -> Result<WorkspaceSettings, AppError> {
    let file = workspace_file(state, services, conversation_id)?;
    if file.exists() {
        let bytes =
            fs::read(file).map_err(|cause| workspace_error("STORAGE_ERROR", cause.to_string()))?;
        return serde_json::from_slice(&bytes)
            .map_err(|cause| workspace_error("STORAGE_ERROR", cause.to_string()));
    }
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|cause| workspace_error("STORAGE_ERROR", cause.to_string()))?
        .join("GeoD Agent");
    fs::create_dir_all(&base)
        .map_err(|cause| workspace_error("STORAGE_ERROR", cause.to_string()))?;
    Ok(WorkspaceSettings {
        directory: fs::canonicalize(base)
            .map_err(|cause| workspace_error("STORAGE_ERROR", cause.to_string()))?
            .to_string_lossy()
            .into_owned(),
        permission: WorkspacePermission::ConfirmEach,
    })
}

fn validate_auto_destination(workspace_root: &Path, destination: &Path) -> Result<(), AppError> {
    let parent = destination
        .parent()
        .ok_or_else(|| workspace_error("WORKSPACE_DENIED", "无效的输出路径"))?;
    let actual_parent = fs::canonicalize(parent)
        .map_err(|cause| workspace_error("WORKSPACE_DENIED", cause.to_string()))?;
    let approved_root = fs::canonicalize(workspace_root)
        .map_err(|cause| workspace_error("WORKSPACE_DENIED", cause.to_string()))?;
    if actual_parent != approved_root || destination.exists() || destination.file_name().is_none() {
        return Err(workspace_error(
            "WORKSPACE_DENIED",
            "计划输出必须是所选工作区内新的直属文件夹",
        ));
    }
    Ok(())
}

fn ensure_workspace_binding(file: &Path, path: &Path) -> Result<(), AppError> {
    if !file.exists() {
        return Ok(());
    }
    let saved: WorkspaceSettings = serde_json::from_slice(
        &fs::read(file).map_err(|cause| workspace_error("STORAGE_ERROR", cause.to_string()))?,
    )
    .map_err(|cause| workspace_error("STORAGE_ERROR", cause.to_string()))?;
    if fs::canonicalize(&saved.directory).ok().as_deref() != Some(path) {
        return Err(workspace_error(
            "WORKSPACE_IMMUTABLE",
            "此对话已绑定工作区。请在目标工作区新建对话。",
        ));
    }
    Ok(())
}

#[tauri::command]
fn workspace_get(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<WorkspaceSettings, AppError> {
    read_workspace(&app, &state, &services, &conversation_id)
}

#[tauri::command]
fn workspace_default(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
) -> Result<WorkspaceSettings, AppError> {
    read_workspace(&app, &state, &services, "geod-agent-default-workspace")
}

#[tauri::command]
fn workspace_set(
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    directory: String,
    permission: WorkspacePermission,
) -> Result<WorkspaceSettings, AppError> {
    let path = fs::canonicalize(&directory)
        .map_err(|cause| workspace_error("WORKSPACE_INVALID", cause.to_string()))?;
    if !path.is_dir() {
        return Err(workspace_error("WORKSPACE_INVALID", "请选择本机文件夹"));
    }
    let settings = WorkspaceSettings {
        directory: path.to_string_lossy().into_owned(),
        permission,
    };
    let file = workspace_file(&state, &services, &conversation_id)?;
    ensure_workspace_binding(&file, &path)?;
    fs::write(
        file,
        serde_json::to_vec(&settings)
            .map_err(|cause| workspace_error("STORAGE_ERROR", cause.to_string()))?,
    )
    .map_err(|cause| workspace_error("STORAGE_ERROR", cause.to_string()))?;
    Ok(settings)
}

#[tauri::command]
fn workspace_open_directory(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<(), AppError> {
    let settings = read_workspace(&app, &state, &services, &conversation_id)?;
    let directory = fs::canonicalize(&settings.directory)
        .map_err(|cause| workspace_error("WORKSPACE_INVALID", cause.to_string()))?;
    if !directory.is_dir() {
        return Err(workspace_error("WORKSPACE_INVALID", "工作区文件夹不存在"));
    }
    app.opener()
        .open_path(directory.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|cause| workspace_error("WORKSPACE_OPEN_FAILED", cause.to_string()))
}

#[tauri::command]
fn output_directory_suggest(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<String, AppError> {
    let base = read_workspace(&app, &state, &services, &conversation_id)?;
    let name = format!(
        "imagery-{}-{}",
        Utc::now().format("%Y%m%d-%H%M%S"),
        &Uuid::new_v4().simple().to_string()[..8]
    );
    Ok(Path::new(&base.directory)
        .join(name)
        .to_string_lossy()
        .into_owned())
}

fn is_boundary_file(path: &Path) -> bool {
    matches!(path.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("geojson" | "json"))
}

fn list_workspace_gis_files(root: &Path) -> Result<Vec<String>, AppError> {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut names = Vec::new();
    while let Some((folder, depth)) = pending.pop() {
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(_) if depth > 0 => continue,
            Err(cause) => return Err(workspace_error("WORKSPACE_READ_FAILED", cause.to_string())),
        };
        for entry in entries {
            let entry = entry.map_err(|cause| workspace_error("WORKSPACE_READ_FAILED", cause.to_string()))?;
            let kind = entry.file_type().map_err(|cause| workspace_error("WORKSPACE_READ_FAILED", cause.to_string()))?;
            if kind.is_symlink() { continue; }
            if kind.is_dir() && depth < 2 { pending.push((entry.path(), depth + 1)); }
            if !kind.is_file() { continue; }
            let supported = matches!(entry.path().extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase).as_deref(),
                Some("geojson" | "json" | "gpkg" | "shp" | "kml" | "gml" | "fgb" | "tif" | "tiff" | "vrt" | "img" | "jp2" | "png" | "jpg" | "jpeg" | "nc" | "h5" | "hdf"));
            if !supported { continue; }
            if let Ok(relative) = entry.path().strip_prefix(root) {
                let name = relative.to_string_lossy().into_owned();
                if name.len() > 240 { continue; }
                names.push(name);
                if names.len() >= 100 { names.sort(); return Ok(names); }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn workspace_gis_files_list(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<Vec<String>, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    let root = fs::canonicalize(workspace.directory)
        .map_err(|_| workspace_error("WORKSPACE_INVALID", "当前对话工作区不可用"))?;
    list_workspace_gis_files(&root)
}

#[tauri::command]
fn workspace_boundaries_list(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<Vec<String>, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    let root = PathBuf::from(workspace.directory);
    let mut pending = vec![(root.clone(), 0usize)];
    let mut names = Vec::new();
    while let Some((folder, depth)) = pending.pop() {
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(_) if depth > 0 => continue,
            Err(cause) => return Err(workspace_error("WORKSPACE_READ_FAILED", cause.to_string())),
        };
        for entry in entries {
            let entry = entry.map_err(|cause| workspace_error("WORKSPACE_READ_FAILED", cause.to_string()))?;
            let kind = entry.file_type().map_err(|cause| workspace_error("WORKSPACE_READ_FAILED", cause.to_string()))?;
            if kind.is_symlink() { continue; }
            if kind.is_dir() && depth < 2 { pending.push((entry.path(), depth + 1)); }
            if kind.is_file() && is_boundary_file(&entry.path()) && entry.metadata().map(|metadata| metadata.len() <= MAX_GEOJSON_BYTES as u64).unwrap_or(false) {
                if let Ok(relative) = entry.path().strip_prefix(&root) {
                    let name = relative.to_string_lossy().into_owned();
                    if name.len() > 240 { continue; }
                    names.push(name);
                    if names.len() >= 100 { names.sort(); return Ok(names); }
                }
            }
        }
    }
    names.sort();
    Ok(names)
}

#[tauri::command]
fn workspace_skills_list(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
) -> Result<Vec<extensions::WorkspaceSkillCandidate>, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    extensions::workspace_skills(Path::new(&workspace.directory))
}

#[tauri::command]
fn workspace_skill_import(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    extensions: State<'_, extensions::ExtensionState>,
    conversation_id: String,
    relative_path: String,
) -> Result<extensions::ExtensionOverview, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    let owner=services::current_user_id(&services).map_err(|e|workspace_error(e.code,e.message))?;
    extensions::import_workspace_skill_owned(&extensions, Path::new(&workspace.directory), &relative_path,Some(&owner))
}

fn inspect_workspace_boundary(root: &Path, relative_path: String) -> Result<BoundaryImport, AppError> {
    let relative = Path::new(&relative_path);
    if relative_path.len() > 240 || !relative.components().all(|component| matches!(component, Component::Normal(_))) || !is_boundary_file(relative) {
        return Err(workspace_error("WORKSPACE_DENIED", "请选择工作区内的 GeoJSON 文件"));
    }
    let root = fs::canonicalize(root).map_err(|cause| workspace_error("WORKSPACE_READ_FAILED", cause.to_string()))?;
    let target = fs::canonicalize(root.join(relative)).map_err(|cause| workspace_error("WORKSPACE_READ_FAILED", cause.to_string()))?;
    if !target.starts_with(&root) || !target.is_file() || !is_boundary_file(&target) || fs::metadata(&target).map(|metadata| metadata.len() > MAX_GEOJSON_BYTES as u64).unwrap_or(true) {
        return Err(workspace_error("WORKSPACE_DENIED", "边界文件超出工作区或大小限制"));
    }
    let text = fs::read_to_string(&target).map_err(|cause| workspace_error("WORKSPACE_READ_FAILED", cause.to_string()))?;
    boundary_inspect(relative_path, text)
}

#[tauri::command]
fn workspace_boundary_use(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    relative_path: String,
) -> Result<BoundaryImport, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    inspect_workspace_boundary(Path::new(&workspace.directory), relative_path)
}

#[derive(Clone, Deserialize, Serialize)]
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
    if text.len() > MAX_GEOJSON_BYTES
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
async fn us_county_boundary(
    state_fips: String,
    county_name: String,
) -> Result<BoundaryImport, AppError> {
    if state_fips.len() != 2
        || !state_fips.bytes().all(|byte| byte.is_ascii_digit())
        || county_name.is_empty()
        || county_name.len() > 80
        || !county_name
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b' ' || byte == b'-')
    {
        return Err(workspace_error(
            "INVALID_BOUNDARY_QUERY",
            "请输入美国州的两位 FIPS 编码和县名",
        ));
    }
    let county = if state_fips == "36" && county_name.eq_ignore_ascii_case("Manhattan") {
        "New York".to_string()
    } else {
        county_name.trim().to_string()
    };
    let query = format!("STATE='{}' AND BASENAME='{}'", state_fips, county);
    let target = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/11/query";
    let proxy = network::proxy_for(target)
        .map_err(|cause| workspace_error("NETWORK_SETTINGS_ERROR", cause))?;
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(18))
        .user_agent("GeoD-Agent/0.1 (desktop boundary lookup; Census TIGERweb)");
    let response = network::apply(builder, proxy.as_deref())
        .map_err(|cause| workspace_error("NETWORK_SETTINGS_ERROR", cause))?
        .build()
        .map_err(|cause| workspace_error("BOUNDARY_UNAVAILABLE", cause.to_string()))?
        .get(target)
        .query(&[
            ("where", query.as_str()),
            ("outFields", "GEOID,NAME,BASENAME,STATE"),
            ("returnGeometry", "true"),
            ("outSR", "4326"),
            ("f", "geojson"),
        ])
        .send()
        .await
        .map_err(|cause| workspace_error("BOUNDARY_UNAVAILABLE", cause.to_string()))?;
    if !response.status().is_success() {
        return Err(workspace_error(
            "BOUNDARY_UNAVAILABLE",
            format!("Census TIGERweb HTTP {}", response.status()),
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|cause| workspace_error("BOUNDARY_UNAVAILABLE", cause.to_string()))?;
    if bytes.len() > MAX_GEOJSON_BYTES {
        return Err(workspace_error(
            "BOUNDARY_TOO_LARGE",
            "行政边界超过本机 8 MiB 读取容量",
        ));
    }
    let geojson: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| workspace_error("BOUNDARY_UNAVAILABLE", "Census TIGERweb 未返回 GeoJSON"))?;
    if geojson
        .get("features")
        .and_then(|value| value.as_array())
        .map(|items| items.len())
        != Some(1)
    {
        return Err(workspace_error(
            "BOUNDARY_NOT_FOUND",
            "未找到唯一的美国县级边界，请核对州编码与县名",
        ));
    }
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| workspace_error("BOUNDARY_UNAVAILABLE", "GeoJSON 编码无效"))?;
    let mut imported = boundary_inspect(
        format!("{}-{}.geojson", state_fips, county.replace(' ', "-")),
        text,
    )?;
    imported.name = format!(
        "{}, 州 FIPS {} · 美国人口普查局 TIGERweb 2026",
        county, state_fips
    );
    Ok(imported)
}

#[tauri::command]
fn sources_list(state: State<'_, AppState>) -> Result<Vec<SourceDescriptor>, AppError> {
    open_store(&state)?.list_sources().map_err(Into::into)
}

/// Local settings read; never exposed as a model tool.
#[tauri::command]
fn sources_get(
    state: State<'_, AppState>,
    source_id: String,
) -> Result<Option<geod_task_engine::ledger::RegisteredSource>, AppError> {
    open_store(&state)?.get_registered_source(&source_id).map_err(Into::into)
}

/// Save source parameters for the source form or an explicit Agent configuration request.
#[tauri::command]
fn sources_save(
    state: State<'_, AppState>,
    endpoint: HttpSource,
    min_zoom: u8,
    max_zoom: u8,
    replace_existing: Option<bool>,
    credential: Option<source_auth::CredentialInput>,
) -> Result<SourceDescriptor, AppError> {
    source_auth::save(&state, endpoint, min_zoom, max_zoom, replace_existing.unwrap_or(false), credential)
}

#[tauri::command]
fn plans_create(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    conversation_id: String,
    spec: TaskSpec,
    tool_execution_id: String,
) -> Result<StoredPlan, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    let owner = services::current_user_id(&services)
        .map_err(|cause| workspace_error(cause.code, cause.message))?;
    validate_auto_destination(Path::new(&workspace.directory), Path::new(&spec.output_directory))?;
    let mut store = open_store(&state)?;
    if let Some(existing) = store.get_plan_for_tool_execution(&tool_execution_id)? {
        imagery_recovery::assert_plan_owner(&state, &owner, &conversation_id, Path::new(&workspace.directory), &existing.plan_id)?;
        return Ok(existing);
    }
    let source = store
        .get_registered_source(&spec.source_id)?
        .ok_or_else(|| AppError {
            code: "SOURCE_UNAUTHORIZED",
            message: "请先配置图源".into(),
        })?;
    let stored = store.create_plan_for_tool_execution(&tool_execution_id, spec, &source.descriptor, Utc::now())?;
    imagery_recovery::bind_created_plan(&state, &owner, &conversation_id, Path::new(&workspace.directory), &stored.plan_id)?;
    Ok(stored)
}

#[tauri::command]
fn plans_for_tool_execution(
    state: State<'_, AppState>,
    tool_execution_id: String,
) -> Result<Option<StoredPlan>, AppError> {
    open_store(&state)?
        .get_plan_for_tool_execution(&tool_execution_id)
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
    let mut store = open_store(&state)?;
    let stored = store.get_plan(&plan_id)?
        .ok_or_else(|| workspace_error("PLAN_NOT_FOUND", "计划不存在"))?;
    let source = store.get_registered_source(&stored.plan.spec.source_id)?
        .ok_or_else(|| workspace_error("SOURCE_UNAUTHORIZED", "图源已移除，请重新配置图源"))?;
    store.revalidate_plan(&plan_id, &plan_hash, &source.descriptor, Utc::now())?;
    store.grant_approval(&plan_id, &plan_hash, &actor, "desktop-0.1", Utc::now())
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
    start_job_with_approval(&state, plan_id, plan_hash, approval_id, idempotency_key)
}

#[tauri::command]
fn jobs_start_auto(
    app: AppHandle,
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    plan_id: String,
    conversation_id: String,
    idempotency_key: String,
) -> Result<Job, AppError> {
    let workspace = read_workspace(&app, &state, &services, &conversation_id)?;
    if workspace.permission != WorkspacePermission::FullAccess {
        return Err(workspace_error(
            "APPROVAL_REQUIRED",
            "当前工作区要求逐次确认下载计划",
        ));
    }
    let mut store = open_store(&state)?;
    let stored = store
        .get_plan(&plan_id)?
        .ok_or_else(|| workspace_error("PLAN_NOT_FOUND", "计划不存在"))?;
    validate_auto_destination(
        Path::new(&workspace.directory),
        Path::new(&stored.plan.spec.output_directory),
    )?;
    let source = store.get_registered_source(&stored.plan.spec.source_id)?
        .ok_or_else(|| workspace_error("SOURCE_UNAUTHORIZED", "图源已移除，请重新配置图源"))?;
    store.revalidate_plan(&plan_id, &stored.plan.plan_hash, &source.descriptor, Utc::now())?;
    let actor = services::current_user_id(&services)
        .map_err(|cause| workspace_error(cause.code, cause.message))?;
    imagery_recovery::assert_plan_owner(&state, &actor, &conversation_id, Path::new(&workspace.directory), &plan_id)?;
    let approval = store.grant_approval(
        &plan_id,
        &stored.plan.plan_hash,
        &actor,
        "workspace-full-access-0.1",
        Utc::now(),
    )?;
    drop(store);
    start_job_with_approval(
        &state,
        plan_id,
        stored.plan.plan_hash,
        approval.approval_id,
        idempotency_key,
    )
}

fn start_job_with_approval(
    state: &AppState,
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
    let mut source = store
        .get_registered_source(&stored.plan.spec.source_id)?
        .ok_or_else(|| AppError {
            code: "SOURCE_UNAUTHORIZED",
            message: "图源已移除".into(),
        })?;
    source_auth::resolve(state, &mut source.endpoint)?;
    let mut overlays = store.plan_overlays(&stored.plan.spec, &source.descriptor)?;
    for overlay in &mut overlays { source_auth::resolve(state, overlay)?; }
    let proxy =
        network::proxy_for(&source.endpoint.url_template).map_err(network_settings_error)?;
    let mut active = state
        .running_jobs
        .lock()
        .expect("running-job mutex poisoned");
    cache_management::ensure_idle()?;
    let job = store.start_job(
        &plan_id,
        &plan_hash,
        &approval_id,
        &idempotency_key,
        &source.descriptor,
        Utc::now(),
    )?;
    drop(store);

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
                    .run_job_with_control_proxy_and_overlays(
                        &job_id,
                        &source.descriptor,
                        &source.endpoint,
                        &overlays,
                        Utc::now(),
                        &control.cancelled,
                        &control.paused,
                        proxy
                            .as_deref()
                            .map(geod_core::imagery::ProxyRoute::Http)
                            .unwrap_or(geod_core::imagery::ProxyRoute::Direct),
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
    let mut active = state
        .running_jobs
        .lock()
        .expect("running-job mutex poisoned");
    cache_management::ensure_idle()?;
    if active.contains_key(&job_id)
    {
        return Err(AppError {
            code: "JOB_STATE_CONFLICT",
            message: "作业仍在停止中，请稍后继续".into(),
        });
    }
    if job.state == geod_task_engine::ledger::JobState::Verifying {
        let recovered = store.recover_verifying_job(&job_id);
        let current = store.get_job(&job_id)?.ok_or_else(|| AppError {
            code: "JOB_NOT_FOUND",
            message: "任务不存在".into(),
        });
        return match (recovered, current) {
            (Ok(_), Ok(current)) => Ok(current),
            (Err(_), Ok(current))
                if matches!(
                    current.state,
                    geod_task_engine::ledger::JobState::Completed
                        | geod_task_engine::ledger::JobState::Partial
                        | geod_task_engine::ledger::JobState::Failed
                ) =>
            {
                Ok(current)
            }
            (Err(error), _) => Err(error.into()),
            (_, Err(error)) => Err(error),
        };
    }
    let plan = store.get_plan(&job.plan_id)?.ok_or_else(|| AppError {
        code: "PLAN_NOT_FOUND", message: "计划不存在".into(),
    })?;
    let mut source = store.get_registered_source(&plan.plan.spec.source_id)?.ok_or_else(|| AppError {
        code: "SOURCE_UNAUTHORIZED", message: "图源已移除".into(),
    })?;
    source_auth::resolve(&state, &mut source.endpoint)?;
    let mut overlays = store.plan_overlays(&plan.plan.spec, &source.descriptor)?;
    for overlay in &mut overlays { source_auth::resolve(&state, overlay)?; }
    let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&source.descriptor).map_err(|_| workspace_error("INVALID_SOURCE", "图源配置无效"))?));
    if fingerprint != plan.plan.source_fingerprint { return Err(workspace_error("PLAN_STALE", "图源连接已更改，请重新生成计划")); }
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
    let proxy =
        network::proxy_for(&source.endpoint.url_template).map_err(network_settings_error)?;
    drop(store);
    let control = Arc::new(WorkerControl::default());
    active.insert(job_id.clone(), Arc::clone(&control));
    drop(active);
    let db_path = state.db_path.clone();
    let running_jobs = Arc::clone(&state.running_jobs);
    tauri::async_runtime::spawn(async move {
        if let Ok(mut store) = TaskStore::open(&db_path) {
            let _ = store
                .run_job_with_control_proxy_and_overlays(
                    &job_id,
                    &source.descriptor,
                    &source.endpoint,
                    &overlays,
                    Utc::now(),
                    &control.cancelled,
                    &control.paused,
                    proxy
                        .as_deref()
                        .map(geod_core::imagery::ProxyRoute::Http)
                        .unwrap_or(geod_core::imagery::ProxyRoute::Direct),
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

fn network_settings_error(message: String) -> AppError {
    workspace_error("NETWORK_SETTINGS_ERROR", message)
}

#[tauri::command]
fn network_get() -> Result<network::NetworkStatus, AppError> {
    network::status().map_err(network_settings_error)
}

#[tauri::command]
fn network_set(settings: network::NetworkSettings) -> Result<network::NetworkStatus, AppError> {
    network::save(settings).map_err(network_settings_error)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkProbe {
    source: &'static str,
    effective_proxy: Option<String>,
    elapsed_ms: u128,
}

#[tauri::command]
async fn network_test(settings: network::NetworkSettings) -> Result<NetworkProbe, AppError> {
    let status = network::status_for(settings).map_err(network_settings_error)?;
    let client = network::apply(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent("GeoD-Agent/0.1 (network settings test)"),
        status.effective_proxy.as_deref(),
    )
    .map_err(network_settings_error)?
    .build()
    .map_err(|error| workspace_error("NETWORK_TEST_FAILED", error.to_string()))?;
    let started = std::time::Instant::now();
    let response = client.get("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/11?f=json")
        .send().await.map_err(|error| workspace_error("NETWORK_TEST_FAILED", error.to_string()))?;
    if !response.status().is_success() {
        return Err(workspace_error(
            "NETWORK_TEST_FAILED",
            format!("边界服务返回 HTTP {}", response.status()),
        ));
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| workspace_error("NETWORK_TEST_FAILED", "边界服务未返回有效 JSON"))?;
    if body.get("id").and_then(serde_json::Value::as_i64) != Some(11) {
        return Err(workspace_error(
            "NETWORK_TEST_FAILED",
            "边界服务返回内容不符合预期",
        ));
    }
    Ok(NetworkProbe {
        source: status.source,
        effective_proxy: status.effective_proxy,
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn osm_client(proxy: Option<&str>) -> Result<reqwest::Client, AppError> {
    network::apply(
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("GeoD-Agent/0.1 (desktop interactive basemap)"),
        proxy,
    )
    .map_err(network_settings_error)?
    .build()
    .map_err(|error| workspace_error("MAP_TILE_NETWORK", error.to_string()))
}

#[tauri::command]
async fn map_preview_tile(state: State<'_, AppState>, source_id: Option<String>, url: Option<String>, endpoint: Option<geod_core::imagery::HttpSource>, credential: Option<source_auth::CredentialInput>, z: u8, x: u32, y: u32) -> Result<String, AppError> {
    let source = if let Some(id) = source_id {
        let registered = open_store(&state)?.get_registered_source(&id)?.ok_or_else(|| workspace_error("SOURCE_NOT_FOUND", "图源不存在"))?;
        if z < registered.descriptor.min_zoom || z > registered.descriptor.max_zoom { return Err(workspace_error("MAP_TILE_INVALID", "缩放超出图源范围")); }
        Some(registered.endpoint)
    } else if let Some(endpoint) = endpoint {
        Some(endpoint)
    } else { None };
    if let Some(mut source) = source {
        source_auth::preview(&state, &mut source, credential)?;
        let proxy = network::proxy_for(&source.url_template).map_err(network_settings_error)?;
        let route = proxy.as_deref().map(geod_core::imagery::ProxyRoute::Http).unwrap_or(geod_core::imagery::ProxyRoute::Direct);
        let bytes = geod_core::imagery::fetch_preview_tile(&source, z, x, y, route).await?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    } else {
        if z > 22 || x >= (1u32 << z) || y >= (1u32 << z) { return Err(workspace_error("MAP_TILE_INVALID", "瓦片坐标无效")); }
        let target = source_creator::viewport_url(&url.ok_or_else(|| workspace_error("MAP_TILE_URL_INVALID", "缺少瓦片地址"))?)?;
        source_creator::viewport_tile(target).await
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactRaster {
    resource_id: String,
    job_id: String,
    asset_id: String,
    name: String,
    path: String,
    bounds: [f64; 4],
    crs: String,
    width: u32,
    height: u32,
    sha256: String,
    elevation_encoding: Option<geod_core::imagery::ElevationEncoding>,
}

// Resolve a completed job's own verified raster; never accept a file path from
// the model. Only this exact file is registered with the local range protocol.
fn verified_artifact_raster(db_path: &Path, job_id: &str, asset_id: Option<&str>) -> Result<ArtifactRaster, AppError> {
    let store = TaskStore::open(db_path)?;
    let manifest = store.inspect_job_artifact(job_id)?;
    let asset = manifest.assets.iter().find(|asset| {
        asset.role == "analysis" && asset.mime_type == "image/tiff"
            && asset_id.is_none_or(|id| id == asset.id)
    }).ok_or_else(|| workspace_error("RASTER_NOT_FOUND", "这个任务没有可加载的 GeoTIFF 成果"))?;
    let job = store.get_job(job_id)?.ok_or_else(|| workspace_error("JOB_NOT_FOUND", "任务不存在"))?;
    let plan = store.get_plan(&job.plan_id)?.ok_or_else(|| workspace_error("PLAN_NOT_FOUND", "任务计划不存在"))?;
    let file = PathBuf::from(&plan.plan.spec.output_directory).join(&asset.path);
    if asset.path.is_empty() || Path::new(&asset.path).components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(workspace_error("ARTIFACT_INVALID", "成果清单中的文件路径无效"));
    }
    let path = fs::canonicalize(file).map_err(|cause| workspace_error("ARTIFACT_INVALID", cause.to_string()))?;
    Ok(ArtifactRaster {
        resource_id: String::new(),
        job_id: job_id.into(), asset_id: asset.id.clone(), name: manifest.name,
        path: path.to_string_lossy().into_owned(), bounds: asset.bounds, crs: asset.crs.clone(),
        width: asset.width.unwrap_or_default(), height: asset.height.unwrap_or_default(), sha256: asset.sha256.clone(),
        elevation_encoding: plan.plan.spec.export_options.as_ref().and_then(|o|o.elevation_encoding),
    })
}

#[tauri::command]
async fn artifact_raster(state: State<'_, AppState>, files: State<'_, raster_protocol::RasterFiles>, job_id: String, asset_id: Option<String>) -> Result<ArtifactRaster, AppError> {
    let db_path = state.db_path.clone();
    let mut raster = tauri::async_runtime::spawn_blocking(move || verified_artifact_raster(&db_path, &job_id, asset_id.as_deref()))
        .await.map_err(|cause| workspace_error("ARTIFACT_INVALID", cause.to_string()))??;
    raster.resource_id = Uuid::new_v4().to_string();
    files.register(raster.resource_id.clone(), PathBuf::from(&raster.path));
    Ok(raster)
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
    static CLIENT: OnceLock<Mutex<Option<(Option<String>, reqwest::Client)>>> = OnceLock::new();
    let url = format!("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    let proxy = network::proxy_for(&url).map_err(network_settings_error)?;
    let client = {
        let mut cached = CLIENT
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("OSM client mutex poisoned");
        if let Some((cached_proxy, client)) = cached.as_ref() {
            if *cached_proxy == proxy {
                client.clone()
            } else {
                let replacement = osm_client(proxy.as_deref())?;
                *cached = Some((proxy.clone(), replacement.clone()));
                replacement
            }
        } else {
            let created = osm_client(proxy.as_deref())?;
            *cached = Some((proxy.clone(), created.clone()));
            created
        }
    };
    let response = client.get(url).send().await;
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
    let daemon = background_runtime::is_daemon();
    let mut context = tauri::generate_context!();
    if daemon { context.config_mut().app.windows.clear(); }
    let handlers: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        background_runtime::background_status,
        background_runtime::background_stop,
        background_runtime::background_start,
    ];
    let mut builder = tauri::Builder::default();
    builder=builder.plugin(tauri_plugin_autostart::Builder::new().app_name(if cfg!(debug_assertions){"GeoD Agent (development)"}else{"GeoD Agent"}).arg("--background-runtime").build());
    context.config_mut().plugins.0.insert("updater".into(),serde_json::json!({"pubkey":"","requireSignedVersion":true,"dangerousInsecureTransportProtocol":cfg!(debug_assertions)}));
    builder=builder.plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(windows)]
    {
        // Register first: a second launch must not create another OAuth flow or worker.
        if !daemon { builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        })); }
    }
    builder
        .on_window_event(|_, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) { data_jobs::cancel_all(); cache_management::cancel_all(); }
        })
        .manage(data_asset_protocol::DataAssets::default())
        .manage(desktop_settings::DesktopUpdates::default())
        .manage(mcp_interaction::McpInteractions::default())
        .manage(terrain_protocol::TerrainSessions::default())
        .register_asynchronous_uri_scheme_protocol("geod-terrain", |context, request, responder| {
            let app=context.app_handle().clone();
            tauri::async_runtime::spawn(async move { responder.respond(terrain_protocol::respond(app,request).await); });
        })
        .register_asynchronous_uri_scheme_protocol("geod-data", |context, request, responder| {
            let app=context.app_handle().clone();
            std::thread::spawn(move || responder.respond(app.state::<data_asset_protocol::DataAssets>().respond(request)));
        })
        .manage(raster_protocol::RasterFiles::default())
        .register_asynchronous_uri_scheme_protocol("geod-raster", |context, request, responder| {
            let app=context.app_handle().clone();
            std::thread::spawn(move || responder.respond(app.state::<raster_protocol::RasterFiles>().respond(request)));
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            python_runtime::initialize(app.handle());
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            network::initialize(data_dir.join("network-settings.json"));
            source_creator::initialize(data_dir.join("wayback"));
            let db_path = data_dir.join("agent-tasks.sqlite");
            TaskStore::open(&db_path).map_err(|error| {
                std::io::Error::other(format!("{}: {}", error.code, error.message))
            })?;
            let recovery_path = db_path.clone();
            app.manage(AppState {
                db_path,
                workspace_dir: data_dir.clone(),
                running_jobs: Arc::new(Mutex::new(HashMap::new())),
                schedule_gate: Mutex::new(()),
            });
            app.manage(services::ServiceState::new(
                data_dir.join("agent-services.json"),
            ));
            app.manage(extensions::ExtensionState::with_runtime(data_dir.join("agent-extensions.json"),codex_runtime::bundled_runtime(app.handle())));
            app.manage(mcp_oauth::OAuthState::default());
            app.manage(codex_runtime::CodexState::new(data_dir.join("codex-runtime")));
            app.manage(ai_channels::AiChannels::new(data_dir.join("ai-channels")));
            if daemon {
                background_runtime::start(app.handle().clone(), data_dir.clone())
                    .map_err(|_| std::io::Error::other("Could not start GeoD background runtime"))?;
                agent_tasks::initialize(app.handle()).map_err(|error|std::io::Error::other(error.message))?;
                background_commands::initialize(app.handle())
                    .map_err(|error| std::io::Error::other(error.message))?;
                // Recovery must run only after acquiring the daemon's exclusive
                // lease. A duplicate process cannot touch a live worker's export.
                tauri::async_runtime::spawn_blocking(move || {
                    if let Ok(mut store) = TaskStore::open(&recovery_path) {
                        if let Err(error) = store.recover_verifying_jobs() { eprintln!("GeoD artifact recovery failed: {}", error.code); }
                    }
                });
                schedules::start(app.handle().clone());
                data_schedules::start(app.handle().clone());
                ai_schedules::start(app.handle().clone());
            } else {
                if let Err(error)=desktop_settings::refresh_startup(app.handle()) {eprintln!("GeoD startup path update failed: {}",error["code"]);}
                let client = background_runtime::BackgroundClient::new(data_dir.clone());
                // Keep the desktop available to inspect/recover an unavailable
                // companion. Commands report the precise background error.
                if let Err(error) = client.ensure() { eprintln!("GeoD background unavailable: {}", error["code"]); }
                app.manage(client);
            }
            Ok(())
        })
        .invoke_handler(move |invoke| {
            if !daemon && background_runtime::routes(invoke.message.command()) {
                let client = invoke.message.webview().app_handle().state::<background_runtime::BackgroundClient>().inner().clone();
                background_runtime::forward(invoke, client);
                return true;
            }
            if matches!(invoke.message.command(), "background_status" | "background_stop" | "background_start") { return handlers(invoke); }
            let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            desktop_settings::desktop_settings_get,
            desktop_settings::desktop_autostart_set,
            desktop_settings::desktop_update_preferences,
            desktop_settings::desktop_update_check,
            desktop_settings::desktop_update_download,
            desktop_settings::desktop_update_install,
            desktop_settings::desktop_backup_create,
            conversation_files::conversation_export_save,
            ai_channels::ai_channels_list,
            sponsored_channels::ai_sponsors_refresh,
            sponsored_channels::ai_sponsor_open_website,
            ai_channels::ai_channel_save,
            ai_channels::ai_channel_remove,
            ai_channels::ai_channel_models,
            ai_channels::ai_channel_probe,
            ai_channels::ai_model_select,
            ai_channels::ai_model_selection,
            data_credentials::tiles3d_connections_list,
            terrain_protocol::ion_terrain_open,
            terrain_protocol::ion_terrain_close,
            terrain_protocol::ion_terrain_status,
            execution_receipts::billing_runs_list,
            execution_receipts::billing_run_snapshot,
            ai_schedules::ai_schedules_create,
            ai_schedules::ai_schedules_list,
            ai_schedules::ai_schedules_set_enabled,
            ai_schedules::ai_schedules_run_events,
            ai_schedules::ai_schedules_cancel_run,
            ai_schedules::ai_schedules_retry_run,
            data_credentials::tiles3d_connection_prepare,
            data_credentials::tiles3d_connection_save,
            data_credentials::tiles3d_connection_remove,
            data_credentials::tiles3d_connection_test,
            cache_management::cache_inventory,
            cache_management::cache_maintenance_start,
            cache_management::cache_maintenance_status,
            cache_management::cache_maintenance_cancel,
            cache_management::cache_relocation_preflight,
            cache_management::cache_relocation_start,
            imagery_recovery::imagery_plans_claim,
            imagery_recovery::imagery_recovery_plan,
            data_schedules::data_schedules_create,
            data_schedules::data_schedules_list,
            data_schedules::data_schedules_set_enabled,
            data_schedules::data_schedules_runs,
            data_schedules::data_schedules_cancel_run,
            data_jobs::data_download_plan,
            agent_tasks::agent_tasks_spawn,
            agent_tasks::agent_tasks_list,
            agent_tasks::agent_tasks_get,
            agent_tasks::agent_tasks_read_file,
            agent_tasks::agent_tasks_cancel,
            data_jobs::data_download_list,
            data_jobs::data_download_get,
            data_jobs::data_download_start,
            data_jobs::data_download_start_auto,
            data_jobs::data_download_cancel,
            data_jobs::data_download_discard,
            data_jobs::data_download_inspect,
            data_jobs::data_download_preview,
            data_asset_protocol::data_asset_unregister,
            schedules::schedules_create,
            schedules::schedules_list,
            schedules::schedules_set_enabled,
            schedules::schedules_runs,
            schedules::schedules_cancel_run,
            network_get,
            network_set,
            network_test,
            workspace_get,
            workspace_default,
            workspace_set,
            workspace_open_directory,
            output_directory_suggest,
            workspace_boundaries_list,
            workspace_gis_files_list,
            workspace_skills_list,
            workspace_skill_import,
            workspace_boundary_use,
            boundary_inspect,
            boundary_inputs::boundaries_save,
            boundary_inputs::boundaries_list,
            boundary_inputs::boundaries_get,
            boundary_inputs::boundaries_combine,
            data_inputs::data_input_read,
            online_inputs::online_connections_list,
            online_inputs::online_connection_save,
            online_inputs::online_connection_remove,
            online_inputs::online_services_discover,
            data_inputs::data_connections_list,
            data_inputs::data_connection_connect,
            data_inputs::data_layer_inspect,
            data_inputs::data_connection_save,
            data_inputs::data_connection_remove,
            sql_connections::sql_connections_list,
            sql_connections::sql_connection_connect,
            sql_connections::sql_connection_save,
            sql_connections::sql_connection_remove,
            sql_connections::sql_objects_search,
            sql_connections::sql_query,
            us_county_boundary,
            sources_list,
            sources_get,
            source_creator::source_creator_call,
            source_creator::source_thumbnail_metadata,
            source_creator::source_creator_tools,
            sources_save,
            plans_create,
            plans_for_tool_execution,
            plans_get,
            approvals_grant,
            jobs_start,
            jobs_start_auto,
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
            artifact_raster,
            osm_basemap_tile,
            map_preview_tile,
            services::auth_status,
            services::auth_begin,
            services::auth_logout,
            services::agent_generate,
            services::agent_generate_stream,
            services::agent_usage,
            services::agent_messages_list,
            services::agent_messages_read,
            services::agent_message_open_link,
            services::agent_payment_snapshot,
            services::credit_history::agent_credit_history,
            services::credit_history::agent_credit_history_export,
            services::agent_payment_action,
            services::agent_events,
            services::agent_generation_get,
            codex_runtime::codex_available,
            codex_runtime::codex_turn,
            codex_runtime::codex_fork,
            agent_memory::agent_memory_list,
            agent_memory::agent_memory_save,
            agent_memory::agent_memory_remove,
            extensions::skill_remove,
            codex_runtime::codex_command,
            extensions::extensions_list,
            extensions::plugin_package::plugins_list,
            extensions::plugin_package::plugin_preview,
            extensions::plugin_package::plugin_import,
            extensions::plugin_package::plugin_set_enabled,
            extensions::plugin_package::plugin_remove,
            extensions::plugin_hooks::plugin_hooks_preview,
            extensions::plugin_hooks::plugin_hooks_set_enabled,
            extensions::plugin_marketplace::plugin_marketplaces_list,
            extensions::plugin_marketplace::plugin_marketplace_add,
            extensions::plugin_marketplace::plugin_marketplace_refresh,
            extensions::plugin_marketplace::plugin_marketplace_remove,
            extensions::plugin_marketplace::plugin_marketplace_prepare,
            extensions::plugin_marketplace::plugin_marketplace_install,
            extensions::plugin_marketplace::plugin_marketplace_discard,
            extensions::skill_import,
            extensions::skill_catalog_search,
            extensions::skill_source_inspect,
            extensions::skill_remote_stage,
            extensions::skill_preview,
            extensions::skill_set_enabled,
            extensions::skill_read,
            extensions::mcp_add,
            extensions::mcp_remove,
            mcp_oauth::mcp_oauth_start,
            mcp_interaction::mcp_request_open_browser,
            mcp_interaction::mcp_requests_pending,
            mcp_interaction::mcp_request_reply,
            mcp_interaction::mcp_requests_cancel,
            mcp_oauth::mcp_oauth_status,
            image_inputs::image_attachment_add,
            image_inputs::image_attachment_preview,
            attachment_inputs::document_attachment_add,
            attachment_inputs::audio_attachment_draft,
            attachment_inputs::audio_attachment_edit,
            attachment_inputs::document_attachment_discard,
            audio_inputs::audio_settings_get,
            audio_inputs::audio_settings_set,
            audio_inputs::audio_model_download,
            audio_inputs::audio_model_cancel,
            audio_inputs::audio_model_remove,
            audio_inputs::audio_transcription_cancel,
            audio_inputs::audio_attachment_add,
            attachment_inputs::document_attachments_list,
            attachment_inputs::document_attachment_read,
            mcp_oauth::mcp_oauth_pending,
            mcp_oauth::mcp_oauth_open,
            mcp_oauth::mcp_oauth_cancel,
            mcp_oauth::mcp_oauth_disconnect,
            extensions::mcp_add_gdal,
            extensions::mcp_set_enabled,
            extensions::mcp_tools,
            extensions::mcp_call,
            extensions::mcp_result_read,
            extensions::mcp_registry_search,
        ];
            commands(invoke)
        })
        .build(context)
        .expect("GeoD Agent desktop failed to start")
        .run(move |_, event| {
            if daemon {
                if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                    if code.is_none() { api.prevent_exit(); }
                }
            }
        });
}

#[cfg(test)]
mod workspace_tests {
    use super::*;

    #[test]
    fn gis_file_discovery_returns_only_relative_supported_names() {
        let temporary = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(temporary.path()).unwrap();
        fs::create_dir(root.join("data")).unwrap();
        fs::write(root.join("data").join("sample.geojson"), b"{}").unwrap();
        fs::write(root.join("image.TIF"), b"tiff").unwrap();
        fs::write(root.join("notes.txt"), b"private").unwrap();
        let files = list_workspace_gis_files(&root).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files.iter().any(|name| name.ends_with("sample.geojson") && !Path::new(name).is_absolute()));
        assert!(files.iter().any(|name| name == "image.TIF"));
    }

    #[test]
    fn existing_conversation_cannot_be_rebound_to_another_workspace() {
        let temporary = tempfile::tempdir().unwrap();
        let first = temporary.path().join("first");
        let second = temporary.path().join("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        let file = temporary.path().join("conversation.json");
        assert!(ensure_workspace_binding(&file, &first).is_ok());
        fs::write(&file, serde_json::to_vec(&WorkspaceSettings {
            directory: fs::canonicalize(&first).unwrap().to_string_lossy().into_owned(),
            permission: WorkspacePermission::ConfirmEach,
        }).unwrap()).unwrap();
        assert!(ensure_workspace_binding(&file, &fs::canonicalize(&first).unwrap()).is_ok());
        assert_eq!(ensure_workspace_binding(&file, &fs::canonicalize(&second).unwrap()).unwrap_err().code, "WORKSPACE_IMMUTABLE");
    }

    #[test]
    #[ignore = "requires the live Census service and a working local proxy"]
    fn automatic_proxy_reaches_census_boundary_service() {
        let result =
            tauri::async_runtime::block_on(network_test(network::NetworkSettings::default()))
                .unwrap();
        assert_eq!(result.source, "Windows 系统代理");
        assert!(result.effective_proxy.is_some());
        let manual = network::NetworkSettings {
            mode: network::ProxyMode::Manual,
            manual_url: result.effective_proxy,
        };
        let second = tauri::async_runtime::block_on(network_test(manual)).unwrap();
        assert_eq!(second.source, "手动代理");
        let boundary = tauri::async_runtime::block_on(us_county_boundary("36".into(), "Manhattan".into())).unwrap();
        assert!(boundary.polygon_count > 0);
    }

    #[test]
    fn automatic_download_is_confined_to_a_new_direct_child() {
        let temporary = tempfile::tempdir().unwrap();
        let workspace = temporary.path().join("selected");
        let elsewhere = temporary.path().join("elsewhere");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        assert!(validate_auto_destination(&workspace, &workspace.join("imagery-new")).is_ok());
        assert_eq!(
            validate_auto_destination(&workspace, &elsewhere.join("imagery-new"))
                .unwrap_err()
                .code,
            "WORKSPACE_DENIED"
        );
        let nested = workspace.join("nested");
        fs::create_dir_all(&nested).unwrap();
        assert_eq!(
            validate_auto_destination(&workspace, &nested.join("imagery-new"))
                .unwrap_err()
                .code,
            "WORKSPACE_DENIED"
        );
        let existing = workspace.join("already-there");
        fs::create_dir_all(&existing).unwrap();
        assert_eq!(
            validate_auto_destination(&workspace, &existing)
                .unwrap_err()
                .code,
            "WORKSPACE_DENIED"
        );
    }

    #[test]
    fn workspace_boundary_must_resolve_inside_selected_folder() {
        let temporary = tempfile::tempdir().unwrap();
        let workspace = temporary.path().join("selected");
        fs::create_dir_all(&workspace).unwrap();
        let outside = temporary.path().join("outside.geojson");
        fs::write(&outside, "{}").unwrap();
        assert_eq!(inspect_workspace_boundary(&workspace, "../outside.geojson".into()).err().unwrap().code, "WORKSPACE_DENIED");
        assert_eq!(inspect_workspace_boundary(&workspace, outside.to_string_lossy().into_owned()).err().unwrap().code, "WORKSPACE_DENIED");
        fs::write(workspace.join("area.geojson"), r#"{"type":"Polygon","coordinates":[[[-77.05,38.85],[-77.04,38.85],[-77.04,38.86],[-77.05,38.86],[-77.05,38.85]]]}"#).unwrap();
        let boundary = inspect_workspace_boundary(&workspace, "area.geojson".into()).unwrap();
        assert_eq!(boundary.polygon_count, 1);
    }
}

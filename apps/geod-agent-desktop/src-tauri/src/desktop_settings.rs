use crate::{background_runtime, cache_management, codex_runtime::CodexState, desktop_backups};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preferences {
    #[serde(default = "yes")]
    automatic_update_checks: bool,
    last_update_check: Option<String>,
}
fn yes() -> bool {
    true
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            automatic_update_checks: true,
            last_update_check: None,
        }
    }
}
struct Downloaded {
    update: Update,
    path: PathBuf,
    sha256: String,
}
#[derive(Default)]
pub struct DesktopUpdates {
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<Downloaded>>,
    busy: AtomicBool,
    preferences_gate: Mutex<()>,
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn failure(code: &str, message: &str) -> Value {
    json!({"code":code,"message":message})
}
fn path(app: &AppHandle) -> Result<PathBuf, Value> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("desktop-settings.json"))
        .map_err(|_| failure("DESKTOP_SETTINGS", "无法读取应用设置。"))
}
fn preferences(app: &AppHandle) -> Result<Preferences, Value> {
    let file = path(app)?;
    if !file.exists() {
        return Ok(Preferences::default());
    }
    serde_json::from_slice(
        &fs::read(file).map_err(|_| failure("DESKTOP_SETTINGS", "无法读取应用设置。"))?,
    )
    .map_err(|_| failure("DESKTOP_SETTINGS", "应用设置文件不可读。"))
}
fn save(app: &AppHandle, value: &Preferences) -> Result<(), Value> {
    let target = path(app)?;
    let temporary = target.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec(value).unwrap())
        .and_then(|_| fs::rename(temporary, target))
        .map_err(|_| failure("DESKTOP_SETTINGS", "无法保存应用设置。"))
}
fn begin(state: &DesktopUpdates) -> Result<Operation<'_>, Value> {
    state
        .busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| failure("UPDATE_BUSY", "正在处理更新，请稍后重试。"))?;
    Ok(Operation(&state.busy))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateChannel {
    endpoint: String,
    pubkey: String,
}
fn channel() -> Option<UpdateChannel> {
    // Release trust comes from the signed build, never from a model response or
    // an editable user endpoint. A local debug fixture is available for QA.
    if cfg!(debug_assertions) {
        if let Some(file) = std::env::var_os("GEOD_AGENT_DEV_UPDATE_CONFIG") {
            return fs::read(file)
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        }
    }
    Some(UpdateChannel {
        endpoint: option_env!("GEOD_UPDATE_ENDPOINT")?.into(),
        pubkey: option_env!("GEOD_UPDATE_PUBLIC_KEY")?.into(),
    })
}
fn trusted_url(url: &reqwest::Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https"
            || (cfg!(debug_assertions)
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
}
fn update_view(update: &Update) -> Value {
    json!({"state":"available","currentVersion":update.current_version,"version":update.version,"notes":update.body,"publishedAt":update.date.map(|date|date.to_string())})
}

#[tauri::command]
pub fn desktop_settings_get(app: AppHandle) -> Result<Value, Value> {
    let saved = preferences(&app)?;
    let autostart = app
        .autolaunch()
        .is_enabled()
        .map_err(|_| failure("AUTOSTART_READ", "无法检查开机启动设置。"))?;
    Ok(
        json!({"version":app.package_info().version.to_string(),"development":cfg!(debug_assertions),"autostart":autostart,"automaticUpdateChecks":saved.automatic_update_checks,"lastUpdateCheck":saved.last_update_check,"updateConfigured":channel().is_some()}),
    )
}
#[tauri::command]
pub fn desktop_autostart_set(app: AppHandle, enabled: bool) -> Result<Value, Value> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|_| failure("AUTOSTART_SAVE", "无法修改开机启动设置。"))?;
    if enabled {
        quote_windows_startup_path()?;
    }
    desktop_settings_get(app)
}

pub(crate) fn refresh_startup(app: &AppHandle) -> Result<(), Value> {
    if app.autolaunch().is_enabled().unwrap_or(false) {
        app.autolaunch().enable().map_err(|_| failure("AUTOSTART_SAVE", "无法更新开机启动路径。"))?;
        quote_windows_startup_path()?;
    }
    Ok(())
}
fn quote_windows_startup_path() -> Result<(), Value> {
    #[cfg(windows)] {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        // auto-launch 0.6 writes an unquoted path; installed directories contain spaces.
        let executable = std::env::current_exe().map_err(|_| failure("AUTOSTART_SAVE", "无法定位后台程序。"))?;
        let name = if cfg!(debug_assertions) { "GeoD Agent (development)" } else { "GeoD Agent" };
        let (run, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
            .map_err(|_| failure("AUTOSTART_SAVE", "无法更新开机启动路径。"))?;
        run.set_value(name, &format!("\"{}\" --background-runtime", executable.display()))
            .map_err(|_| failure("AUTOSTART_SAVE", "无法更新开机启动路径。"))?;
    }
    Ok(())
}
#[tauri::command]
pub fn desktop_update_preferences(
    app: AppHandle,
    state: State<'_, DesktopUpdates>,
    automatic_checks: bool,
) -> Result<Value, Value> {
    let _gate = state.preferences_gate.lock().unwrap();
    let mut value = preferences(&app)?;
    value.automatic_update_checks = automatic_checks;
    save(&app, &value)?;
    desktop_settings_get(app)
}
#[tauri::command]
pub async fn desktop_update_check(
    app: AppHandle,
    state: State<'_, DesktopUpdates>,
) -> Result<Value, Value> {
    let _operation = begin(&state)?;
    let Some(channel) = channel() else {
        return Ok(
            json!({"state":"unconfigured","currentVersion":app.package_info().version.to_string()}),
        );
    };
    let endpoint = reqwest::Url::parse(&channel.endpoint)
        .map_err(|_| failure("UPDATE_CHANNEL", "更新渠道配置不可读。"))?;
    if !trusted_url(&endpoint) || channel.pubkey.trim().is_empty() {
        return Err(failure("UPDATE_CHANNEL", "更新渠道配置不可读。"));
    }
    let proxy = crate::network::proxy_for(endpoint.as_str())
        .map_err(|_| failure("UPDATE_NETWORK", "无法读取更新网络设置。"))?;
    let mut builder = app
        .updater_builder()
        .pubkey(channel.pubkey)
        .endpoints(vec![endpoint])
        .map_err(|_| failure("UPDATE_CHANNEL", "更新渠道配置不可读。"))?
        .timeout(Duration::from_secs(30));
    builder = if let Some(proxy) = proxy {
        builder.proxy(
            reqwest::Url::parse(&proxy)
                .map_err(|_| failure("UPDATE_NETWORK", "更新代理地址不可读。"))?,
        )
    } else {
        builder.no_proxy()
    };
    let update = builder
        .build()
        .map_err(|_| failure("UPDATE_CHANNEL", "更新渠道尚未准备好。"))?
        .check()
        .await
        .map_err(|_| failure("UPDATE_CHECK", "检查更新失败，请检查网络后重试。"))?;
    if update
        .as_ref()
        .is_some_and(|update| !trusted_url(&update.download_url))
    {
        return Err(failure("UPDATE_DOWNLOAD_URL", "更新下载地址不可用。"));
    }
    {
        let _gate = state.preferences_gate.lock().unwrap();
        let mut value = preferences(&app)?;
        value.last_update_check = Some(chrono::Utc::now().to_rfc3339());
        save(&app, &value)?;
    }
    let result = update.as_ref().map(update_view).unwrap_or_else(
        || json!({"state":"upToDate","currentVersion":app.package_info().version.to_string()}),
    );
    {
        let mut downloaded = state.downloaded.lock().unwrap();
        if downloaded.as_ref().is_some_and(|saved| {
            update
                .as_ref()
                .is_none_or(|new| new.version != saved.update.version)
        }) {
            *downloaded = None;
        }
    }
    *state.pending.lock().unwrap() = update;
    Ok(result)
}
#[tauri::command]
pub async fn desktop_update_download(
    app: AppHandle,
    state: State<'_, DesktopUpdates>,
    version: String,
    events: Channel<Value>,
) -> Result<Value, Value> {
    let _operation = begin(&state)?;
    let update = state
        .pending
        .lock()
        .unwrap()
        .clone()
        .filter(|update| update.version == version)
        .ok_or_else(|| failure("UPDATE_CHANGED", "更新信息已变化，请重新检查。"))?;
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = events
                    .send(json!({"phase":"downloading","downloaded":downloaded,"total":total}));
            },
            || {
                let _ = events.send(json!({"phase":"verifying"}));
            },
        )
        .await
        .map_err(|error| {
            // Keep plugin diagnostics on disk without returning URLs/headers to chat.
            eprintln!("GeoD updater download failed: {error}");
            failure(
                "UPDATE_VERIFY",
                "更新下载或签名验证失败，请重新检查后重试。",
            )
        })?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| failure("UPDATE_STORAGE", "无法保存更新文件。"))?
        .join("updates");
    fs::create_dir_all(&directory).map_err(|_| failure("UPDATE_STORAGE", "无法保存更新文件。"))?;
    let target = directory.join(format!("{}.exe", &sha256[..24]));
    let temporary = target.with_extension("download");
    fs::write(&temporary, &bytes)
        .and_then(|_| fs::rename(temporary, &target))
        .map_err(|_| failure("UPDATE_STORAGE", "无法保存更新文件。"))?;
    let size = bytes.len();
    *state.downloaded.lock().unwrap() = Some(Downloaded {
        update: update.clone(),
        path: target,
        sha256,
    });
    let _ = events.send(json!({"phase":"ready","downloaded":size}));
    Ok(json!({"state":"ready","version":update.version,"bytes":size,"verified":true}))
}

fn backup_records(app: &AppHandle, ui_state: Value) -> Result<Value, Value> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| failure("UPDATE_BACKUP", "无法备份本机记录。"))?;
    desktop_backups::create(&root,&app.package_info().version.to_string(),ui_state)
}
#[tauri::command]
pub async fn desktop_backup_create(app:AppHandle,state:State<'_,DesktopUpdates>,ui_state:Value) -> Result<Value,Value> {
    let _operation=begin(&state)?;desktop_backups::validate_ui(&ui_state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _maintenance=app.state::<CodexState>().begin_maintenance().map_err(|_|failure("UPDATE_TASKS_ACTIVE","请等当前回复结束后再备份记录。"))?;
        cache_management::ensure_idle().map_err(|_|failure("UPDATE_TASKS_ACTIVE","请等缓存维护结束后再备份记录。"))?;
        let _background=app.state::<background_runtime::BackgroundClient>().begin_maintenance()?;
        app.state::<CodexState>().shutdown();
        backup_records(&app,ui_state)
    }).await.map_err(|_|failure("UPDATE_BACKUP","本机记录备份失败。"))?
}
#[tauri::command]
pub async fn desktop_update_install(
    app: AppHandle,
    state: State<'_, DesktopUpdates>,
    version: String,
    ui_state: Option<Value>,
) -> Result<Value, Value> {
    let _operation = begin(&state)?;
    if cfg!(debug_assertions) {
        return Err(failure(
            "UPDATE_DEVELOPMENT",
            "开发版使用热更新，无需安装更新。",
        ));
    }
    let ui_state=ui_state.ok_or_else(||failure("UPDATE_BACKUP","请从应用设置中安装更新，以保存完整会话记录。"))?;
    desktop_backups::validate_ui(&ui_state)?;
    let downloaded = state
        .downloaded
        .lock()
        .unwrap()
        .as_ref()
        .filter(|download| download.update.version == version)
        .map(|download| {
            (
                download.update.clone(),
                download.path.clone(),
                download.sha256.clone(),
            )
        })
        .ok_or_else(|| failure("UPDATE_NOT_READY", "请先下载并验证更新。"))?;
    // Keep synchronous background clients and their recovery guards on one
    // blocking worker, including every error path and guard destructor.
    tauri::async_runtime::spawn_blocking(move || {
        let _maintenance = app
            .state::<CodexState>()
            .begin_maintenance()
            .map_err(|_| failure("UPDATE_TASKS_ACTIVE", "请等当前回复结束后再安装更新。"))?;
        cache_management::ensure_idle()
            .map_err(|_| failure("UPDATE_TASKS_ACTIVE", "请等缓存维护结束后再安装更新。"))?;
        let bytes = fs::read(&downloaded.1)
            .map_err(|_| failure("UPDATE_STORAGE", "更新文件不可读，请重新下载。"))?;
        if format!("{:x}", Sha256::digest(&bytes)) != downloaded.2 {
            return Err(failure("UPDATE_VERIFY", "更新文件已变化，请重新下载。"));
        }
        let mut background=app.state::<background_runtime::BackgroundClient>().begin_maintenance()?;
        app.state::<CodexState>().shutdown();
        backup_records(&app,ui_state)?;
        downloaded
            .0
            .install(bytes)
            .map_err(|_| failure("UPDATE_INSTALL", "无法启动更新安装，请稍后重试。"))?;
        background.keep_stopped();
        Ok(json!({"installed":true}))
    }).await.map_err(|_|failure("UPDATE_INSTALL","无法启动更新安装，请稍后重试。"))?
}

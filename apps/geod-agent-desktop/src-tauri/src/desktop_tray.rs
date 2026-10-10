use crate::{background_runtime::BackgroundClient, cache_management, codex_runtime::CodexState};
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::{menu::{Menu, MenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, AppHandle, Manager, Window, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[derive(Default)]
pub(crate) struct DesktopTray {
    available: AtomicBool,
    exiting: AtomicBool,
    exit_pending: AtomicBool,
    english: AtomicBool,
    items: Mutex<Option<(MenuItem<Wry>, MenuItem<Wry>)>>,
}

pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn available(app: &AppHandle) -> bool {
    app.state::<DesktopTray>().available.load(Ordering::Acquire)
}

pub(crate) fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "geod-tray-open", "打开 GeoD Agent", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "geod-tray-quit", "退出 GeoD Agent", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let icon = app.default_window_icon().cloned().ok_or_else(|| std::io::Error::other("GeoD tray icon is unavailable"))?;
    TrayIconBuilder::with_id("geod-agent-main")
        .icon(icon)
        .tooltip("GeoD Agent")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "geod-tray-open" => show_main(app),
            "geod-tray-quit" => desktop_quit(app.clone()),
            _ => {},
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. }) {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    let state = app.state::<DesktopTray>();
    *state.items.lock().unwrap() = Some((open, quit));
    state.available.store(true, Ordering::Release);
    Ok(())
}

// Only hide a window once its tray entry exists. If the shell rejects the tray,
// preserve ordinary close behavior so the app cannot become invisible.
// Minimize always remains a normal taskbar window; only closing hides it.
pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" { return; }
    let state = window.app_handle().state::<DesktopTray>();
    if !state.available.load(Ordering::Acquire) || state.exiting.load(Ordering::Acquire) { return; }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if window.hide().is_ok() { api.prevent_close(); }
        },
        _ => {},
    }
}

#[tauri::command]
pub(crate) fn desktop_tray_locale_set(app: AppHandle, locale: String) -> Result<(), String> {
    if !matches!(locale.as_str(), "zh-CN" | "en") { return Err("Unsupported tray language".into()); }
    let state = app.state::<DesktopTray>();
    let english = locale == "en";
    state.english.store(english, Ordering::Release);
    if let Some((open, quit)) = state.items.lock().unwrap().as_ref() {
        open.set_text(if english { "Open GeoD Agent" } else { "打开 GeoD Agent" }).map_err(|error| error.to_string())?;
        quit.set_text(if english { "Quit GeoD Agent" } else { "退出 GeoD Agent" }).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn desktop_quit(app: AppHandle) {
    if app.state::<DesktopTray>().exit_pending.swap(true, Ordering::AcqRel) { return; }
    // The same idle gates used for updates: a tray click never kills an approved
    // download, scheduled command or active AI turn. Keep the UI thread responsive.
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<(), ()> {
            let _turns = app.state::<CodexState>().begin_maintenance().map_err(|_| ())?;
            cache_management::ensure_idle().map_err(|_| ())?;
            let mut background = match app.state::<BackgroundClient>().begin_maintenance() {
                Ok(guard) => Some(guard),
                // No endpoint exists: let the UI exit even when its companion
                // failed to start. An uncertain/reachable worker remains protected.
                Err(error) if error["code"] == "BACKGROUND_OFFLINE" => None,
                Err(_) => return Err(()),
            };
            app.state::<CodexState>().shutdown();
            if let Some(guard) = background.as_mut() { guard.keep_stopped(); }
            app.state::<DesktopTray>().exiting.store(true, Ordering::Release);
            app.exit(0);
            Ok(())
        })();
        if result.is_err() {
            let state = app.state::<DesktopTray>();
            state.exit_pending.store(false, Ordering::Release);
            let english = state.english.load(Ordering::Acquire);
            show_main(&app);
            app.dialog().message(if english {
                "GeoD Agent could not safely stop its background services. Stop active tasks or wait for them to finish, then try quitting again."
            } else {
                "暂时无法安全停止后台服务。请先停止正在运行的任务，或等待任务完成，再重试退出。"
            }).title("GeoD Agent").kind(MessageDialogKind::Warning).show(|_| {});
        }
    });
}

//! Only expose the first native window after the startup document has content.
use std::sync::atomic::{AtomicBool,Ordering};
use tauri::{Manager,State,WebviewWindow};

#[derive(Default)]
pub(crate) struct StartupWindow { ready:AtomicBool }
pub(crate) fn ready(app:&tauri::AppHandle)->bool {
    app.try_state::<StartupWindow>().is_some_and(|state|state.ready.load(Ordering::Acquire))
}
pub(crate) fn show_first(window:&WebviewWindow)->Result<bool,String> {
    if window.label()!="main" {return Err("Startup window is not main".into());}
    let state:State<StartupWindow>=window.state();
    if state.ready.swap(true,Ordering::AcqRel){return Ok(false);}
    if let Err(error)=window.show(){state.ready.store(false,Ordering::Release);return Err(error.to_string());}
    let _=window.set_focus();
    #[cfg(debug_assertions)]
    eprintln!("GEOD_STARTUP_WINDOW_SHOWN");
    Ok(true)
}
#[tauri::command]
pub(crate) fn desktop_boot_ready(window:WebviewWindow)->Result<bool,String>{show_first(&window)}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn visibility_gate_is_initially_closed_and_does_not_reopen_on_reload(){
        let state=StartupWindow::default();assert!(!state.ready.load(Ordering::Acquire));
        assert!(!state.ready.swap(true,Ordering::AcqRel));assert!(state.ready.swap(true,Ordering::AcqRel));
    }
}

//! Small application-local interpreter. GIS dependencies are optional skill components.
use crate::{workspace_error, AppError};
use std::{path::PathBuf, sync::OnceLock};
use tauri::{AppHandle, Manager};

static RESOURCES: OnceLock<PathBuf> = OnceLock::new();
pub(crate) fn initialize(app: &AppHandle) {
    if let Ok(root) = app.path().resource_dir() { let _ = RESOURCES.set(root); }
    crate::gis_components::initialize(app);
}
pub(crate) fn root() -> Result<PathBuf, AppError> {
    let mut roots = Vec::new();
    if let Some(root) = RESOURCES.get() { roots.push(root.join("python-runtime")); }
    if cfg!(debug_assertions) { roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/python")); }
    if let Some(root) = std::env::current_exe().ok().and_then(|path|path.parent().map(|p|p.to_owned())) { roots.push(root.join("python-runtime")); }
    roots.into_iter().find(|root|["python.exe","python313.dll","python313._pth","manifest.json"].iter().all(|name|root.join(name).is_file()))
        .ok_or_else(||workspace_error("INPUT_RUNTIME_MISSING","内置数据运行环境缺失，请准备开发运行环境或修复应用"))
}
pub(crate) fn gis_command(script:&str, components:&[&str])->Result<tokio::process::Command,AppError>{
    let paths=crate::gis_components::paths(components)?;
    let setup=format!("import sys; sys.dont_write_bytecode=True; sys.path[:0]={}\n",serde_json::to_string(&paths).map_err(|_|workspace_error("GIS_STORAGE","无法准备 GIS 搜索路径"))?);
    command(&(setup+script))
}
pub(crate) fn command(script: &str) -> Result<tokio::process::Command, AppError> {
    let root = root()?;
    let mut command = tokio::process::Command::new(root.join("python.exe"));
    command.args(["-X","utf8","-I","-c",script]).env_clear();
    for key in ["SYSTEMROOT","WINDIR","TEMP","TMP","APPDATA","LOCALAPPDATA","USERPROFILE"] {
        if let Some(value) = std::env::var_os(key) { command.env(key,value); }
    }
    if let Some(windows)=std::env::var_os("SYSTEMROOT") { command.env("PATH",PathBuf::from(windows).join("System32")); }
    #[cfg(windows)] command.creation_flags(0x0800_0000);
    Ok(command)
}

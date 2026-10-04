use crate::services::{self, ServiceState};
use std::path::Path;
use tauri::State;

fn validate(path: &Path, content: &str) -> Result<(), String> {
    if !path.is_absolute() || !matches!(path.extension().and_then(|value|value.to_str()), Some("json"|"md")) {
        return Err("请选择 JSON 或 Markdown 文件保存位置。".into());
    }
    if content.len() > 16 * 1024 * 1024 { return Err("会话导出超过 16 MB，请分批导出。".into()); }
    if !path.parent().is_some_and(Path::is_dir) { return Err("保存目录不存在。".into()); }
    Ok(())
}
#[tauri::command]
pub async fn conversation_export_save(state: State<'_, ServiceState>, path: String, content: String) -> Result<usize, String> {
    services::current_user_id(&state).map_err(|error|error.message)?;
    tauri::async_runtime::spawn_blocking(move || {
        let target=Path::new(&path);validate(target,&content)?;
        std::fs::write(target,content.as_bytes()).map_err(|_|"无法保存会话文件，请检查目录和磁盘空间。".to_string())?;
        Ok(content.len())
    }).await.map_err(|_|"会话文件保存中断。".to_string())?
}

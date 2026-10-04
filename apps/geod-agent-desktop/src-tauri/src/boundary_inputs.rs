use crate::{open_store, AppError, AppState, BoundaryImport};
use geod_task_engine::boundary_store::{BoundarySummary, StoredBoundary};
use tauri::State;

#[tauri::command]
pub(crate) fn boundaries_save(state: State<'_, AppState>, conversation_id: String, boundary: BoundaryImport) -> Result<StoredBoundary, AppError> {
    Ok(open_store(&state)?.save_boundary(&conversation_id, &boundary.name, boundary.geometry)?)
}
#[tauri::command]
pub(crate) fn boundaries_list(state: State<'_, AppState>, conversation_id: String) -> Result<Vec<BoundarySummary>, AppError> {
    Ok(open_store(&state)?.list_boundaries(&conversation_id)?)
}
#[tauri::command]
pub(crate) fn boundaries_get(state: State<'_, AppState>, conversation_id: String, boundary_id: String) -> Result<StoredBoundary, AppError> {
    open_store(&state)?.get_boundary(&conversation_id, &boundary_id)?.ok_or(AppError { code: "BOUNDARY_NOT_IN_CONVERSATION", message: "当前会话没有这个范围，请先查询或导入范围".into() })
}
#[tauri::command]
pub(crate) fn boundaries_combine(state: State<'_, AppState>, conversation_id: String, boundary_ids: Vec<String>, name: Option<String>) -> Result<StoredBoundary, AppError> {
    Ok(open_store(&state)?.combine_boundaries(&conversation_id, &boundary_ids, name.as_deref())?)
}

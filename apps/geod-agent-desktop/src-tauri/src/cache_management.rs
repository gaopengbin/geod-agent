//! User-visible cache maintenance. Long operations run outside the UI thread.
use crate::{services, workspace_error, AppError, AppState};
use geod_core::cache_maintenance::{self as cache, CacheInventory, CacheProgress, MigrationJob, RelocationPreflight};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::{atomic::{AtomicBool,Ordering},Arc,Mutex,OnceLock}};
use tauri::State;

static BUSY: AtomicBool = AtomicBool::new(false);
static OPERATIONS: OnceLock<Mutex<HashMap<String,Operation>>> = OnceLock::new();
fn operations() -> &'static Mutex<HashMap<String,Operation>> { OPERATIONS.get_or_init(Mutex::default) }
#[derive(Clone)]
struct Operation { public: MaintenanceStatus, cancel: Arc<AtomicBool> }
#[derive(Clone,Debug,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct MaintenanceStatus {
    operation_id: String, action: String, state: String, progress: CacheProgress,
    error: Option<String>, source_path: String, target_path: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct InventoryResponse {
    directory: String, inventory: CacheInventory, active_jobs: Vec<String>,
    operation: Option<MaintenanceStatus>,
}
#[derive(Clone,Copy,Deserialize)]
#[serde(rename_all="lowercase")]
pub(crate) enum MaintenanceAction { Verify, Migrate }

/// Call while holding AppState.running_jobs before admitting a new worker.
/// Maintenance takes that same mutex while setting BUSY, closing the race.
pub(crate) fn ensure_idle() -> Result<(),AppError> {
    if BUSY.load(Ordering::Acquire) { Err(workspace_error("CACHE_BUSY","下载缓存正在维护，请完成或取消后再开始下载")) } else {Ok(())}
}
pub(crate) fn cancel_all() {
    if let Ok(entries)=operations().lock(){for op in entries.values(){if op.public.state=="running" {op.cancel.store(true,Ordering::Release);}}}
}
fn logged_in(services: &services::ServiceState) -> Result<(),AppError> {
    services::current_user_id(services).map(|_|()).map_err(|e|workspace_error(e.code,e.message))
}
fn root(state:&AppState)->Result<PathBuf,AppError>{cache::cache_root_for_database(&state.db_path).map_err(Into::into)}

#[tauri::command]
pub(crate) async fn cache_inventory(state:State<'_,AppState>,services:State<'_,services::ServiceState>)->Result<InventoryResponse,AppError>{
    let auth=services.inner().clone();
    tauri::async_runtime::spawn_blocking(move||logged_in(&auth)).await.map_err(|e|workspace_error("CACHE_ERROR",e.to_string()))??;
    let directory=root(&state)?;
    let active_jobs=state.running_jobs.lock().map_err(|_|workspace_error("CACHE_ERROR","无法读取下载状态"))?.keys().cloned().collect();
    let operation=operations().lock().map_err(|_|workspace_error("CACHE_ERROR","无法读取维护状态"))?.values().filter(|op|op.public.state=="running").map(|op|op.public.clone()).next();
    let scan_root=directory.clone();
    let inventory=tauri::async_runtime::spawn_blocking(move||cache::inventory(&scan_root)).await.map_err(|e|workspace_error("CACHE_ERROR",e.to_string()))??;
    Ok(InventoryResponse{directory:directory.to_string_lossy().into_owned(),inventory,active_jobs,operation})
}

fn reserve(state:&AppState,action:&str,target:Option<String>)->Result<(String,Arc<AtomicBool>,PathBuf),AppError>{
    let running=state.running_jobs.lock().map_err(|_|workspace_error("CACHE_ERROR","无法读取下载状态"))?;
    if !running.is_empty(){return Err(workspace_error("CACHE_IN_USE","仍有影像下载在运行，请先暂停或等待完成"));}
    let path=root(state)?;
    if BUSY.compare_exchange(false,true,Ordering::AcqRel,Ordering::Acquire).is_err(){return Err(workspace_error("CACHE_BUSY","已有缓存维护正在进行"));}
    let id=uuid::Uuid::new_v4().to_string();let cancel=Arc::new(AtomicBool::new(false));
    let public=MaintenanceStatus{operation_id:id.clone(),action:action.into(),state:"running".into(),progress:CacheProgress{phase:"preparing".into(),..Default::default()},error:None,source_path:path.to_string_lossy().into_owned(),target_path:target};
    match operations().lock(){Ok(mut entries)=>{if entries.len()>=32{entries.retain(|_,op|op.public.state=="running");}entries.insert(id.clone(),Operation{public,cancel:Arc::clone(&cancel)});},Err(_)=>{BUSY.store(false,Ordering::Release);return Err(workspace_error("CACHE_ERROR","无法创建维护记录"));}}
    drop(running);Ok((id,cancel,path))
}
fn progress(id:&str,p:&CacheProgress){if let Ok(mut entries)=operations().lock(){if let Some(op)=entries.get_mut(id){op.public.progress=p.clone();}}}
fn finish(id:&str,result:Result<CacheProgress,String>,cancelled:bool){
    if let Ok(mut entries)=operations().lock(){if let Some(op)=entries.get_mut(id){match result{Ok(p)=>{op.public.state="completed".into();op.public.progress=p;},Err(message)=>{op.public.state=if cancelled{"cancelled"}else{"failed"}.into();op.public.error=Some(message);}}}}
    BUSY.store(false,Ordering::Release);
}

#[tauri::command]
pub(crate) fn cache_maintenance_start(state:State<'_,AppState>,services:State<'_,services::ServiceState>,action:MaintenanceAction,job_ids:Option<Vec<String>>)->Result<String,AppError>{
    logged_in(&services)?;
    let name=match action{MaintenanceAction::Verify=>"verify",MaintenanceAction::Migrate=>"migrate"};
    let (id,cancel,cache_root)=reserve(&state,name,None)?;
    let db_path=state.db_path.clone();let operation_id=id.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||->Result<CacheProgress,AppError>{
            if matches!(action,MaintenanceAction::Verify){return cache::verify(&cache_root,&cancel,|p|progress(&operation_id,p)).map_err(Into::into);}
            let store=geod_task_engine::ledger::TaskStore::open(&db_path)?;
            let inventory=cache::inventory(&cache_root)?;
            let ids=job_ids.unwrap_or_else(||inventory.job_caches.into_iter().map(|v|v.job_id).collect());
            if ids.len()>100_000{return Err(workspace_error("CACHE_ERROR","一次最多迁移十万个历史任务"));}
            let mut jobs=Vec::new();let mut skipped=Vec::new();
            for id in ids {
                let Some(job)=store.get_job(&id)? else {skipped.push(format!("{id}：未找到任务记录"));continue;};
                let Some(plan)=store.get_plan(&job.plan_id)? else {skipped.push(format!("{id}：未找到原计划"));continue;};
                let Some(source)=store.get_registered_source(&plan.plan.spec.source_id)? else {skipped.push(format!("{id}：图源已移除"));continue;};
                let overlays=plan.plan.spec.export_options.as_ref().map(|o|o.overlay_sources.clone()).unwrap_or_default();
                jobs.push(MigrationJob{job_id:id,plan_hash:job.plan_hash,source:source.endpoint,overlays});
            }
            let mut result=cache::migrate_jobs(&cache_root,&jobs,&cancel,|p|progress(&operation_id,p))?;
            result.skipped+=skipped.len() as u64;result.warnings.extend(skipped.into_iter().take(20));Ok(result)
        }));
        let result=match result{Ok(result)=>result.map_err(|e|e.message),Err(_)=>Err("缓存维护异常退出，原缓存保留".into())};
        finish(&operation_id,result,cancel.load(Ordering::Acquire));
    });Ok(id)
}
#[tauri::command]
pub(crate) fn cache_maintenance_status(services:State<'_,services::ServiceState>,operation_id:String)->Result<MaintenanceStatus,AppError>{
    logged_in(&services)?;
    operations().lock().map_err(|_|workspace_error("CACHE_ERROR","无法读取维护状态"))?.get(&operation_id).map(|op|op.public.clone()).ok_or_else(||workspace_error("CACHE_OPERATION_MISSING","未找到缓存维护记录"))
}
#[tauri::command]
pub(crate) fn cache_maintenance_cancel(services:State<'_,services::ServiceState>,operation_id:String)->Result<(),AppError>{
    logged_in(&services)?;
    let entries=operations().lock().map_err(|_|workspace_error("CACHE_ERROR","无法读取维护状态"))?;
    let op=entries.get(&operation_id).ok_or_else(||workspace_error("CACHE_OPERATION_MISSING","未找到缓存维护记录"))?;
    if op.public.progress.phase=="switching"{return Err(workspace_error("CACHE_COMMITTING","正在切换缓存位置，请稍候"));}
    op.cancel.store(true,Ordering::Release);Ok(())
}
#[tauri::command]
pub(crate) async fn cache_relocation_preflight(state:State<'_,AppState>,services:State<'_,services::ServiceState>,target_path:String)->Result<RelocationPreflight,AppError>{
    let auth=services.inner().clone();
    tauri::async_runtime::spawn_blocking(move||logged_in(&auth)).await.map_err(|e|workspace_error("CACHE_ERROR",e.to_string()))??;
    let db_path=state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move||cache::relocation_preflight(&db_path,&PathBuf::from(target_path))).await.map_err(|e|workspace_error("CACHE_ERROR",e.to_string()))?.map_err(Into::into)
}
#[tauri::command]
pub(crate) fn cache_relocation_start(state:State<'_,AppState>,services:State<'_,services::ServiceState>,target_path:String)->Result<String,AppError>{
    logged_in(&services)?;
    let (id,cancel,_)=reserve(&state,"relocate",Some(target_path.clone()))?;
    let db_path=state.db_path.clone();let operation_id=id.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||cache::relocate(&db_path,&PathBuf::from(target_path),&cancel,|p|progress(&operation_id,p))));
        let result=match result{Ok(result)=>result.map_err(|e|e.message),Err(_)=>Err("缓存迁移异常退出，原目录保留".into())};
        finish(&operation_id,result,cancel.load(Ordering::Acquire));
    });Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_gate_excludes_workers_and_overlapping_maintenance() {
        let temp=tempfile::tempdir().unwrap();
        let state=AppState{db_path:temp.path().join("state.sqlite"),workspace_dir:temp.path().join("workspaces"),running_jobs:Arc::new(Mutex::new(HashMap::new())),schedule_gate:Mutex::new(())};
        let (id,_,_)=reserve(&state,"verify",None).unwrap();
        assert_eq!(ensure_idle().unwrap_err().code,"CACHE_BUSY");
        assert_eq!(reserve(&state,"migrate",None).unwrap_err().code,"CACHE_BUSY");
        finish(&id,Err("test finished".into()),false);
        assert!(ensure_idle().is_ok());
        state.running_jobs.lock().unwrap().insert("running-job".into(),Arc::new(crate::WorkerControl::default()));
        assert_eq!(reserve(&state,"relocate",None).unwrap_err().code,"CACHE_IN_USE");
        assert!(ensure_idle().is_ok());
    }
}

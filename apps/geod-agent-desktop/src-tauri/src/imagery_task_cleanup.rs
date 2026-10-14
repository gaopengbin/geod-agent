//! Reversible task-list cleanup; output files and execution evidence are retained.
use super::*;
use rusqlite::params;

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct TaskRecord { pub stored: StoredPlan, pub record_state: String, pub job: Option<Job> }

#[tauri::command]
pub fn imagery_tasks_list(app:AppHandle,state:State<'_,AppState>,services:State<'_,services::ServiceState>,conversation_id:String)->Result<Vec<TaskRecord>,AppError>{
    let workspace=read_workspace(&app,&state,&services,&conversation_id)?;
    let owner=services::current_user_id(&services).map_err(|e|workspace_error(e.code,e.message))?;
    list(&state,&owner,&conversation_id,Path::new(&workspace.directory))
}

pub(crate) fn list(state:&AppState,owner:&str,conversation:&str,root:&Path)->Result<Vec<TaskRecord>,AppError>{
    let store=open_store(state)?;
    let db=imagery_recovery::db(state)?;
    let mut query=db.prepare("SELECT plan_id FROM imagery_plan_owners WHERE owner_id=?1 AND conversation_id=?2 ORDER BY bound_at,plan_id").map_err(storage)?;
    let ids=query.query_map(params![owner,conversation],|r|r.get::<_,String>(0)).map_err(storage)?;
    let mut result=Vec::new();
    for id in ids {
        let id=id.map_err(storage)?;
        imagery_recovery::assert_plan_owner(state,owner,conversation,root,&id)?;
        if let Some(stored)=store.get_plan(&id)? {
            result.push(TaskRecord{record_state:store.plan_visibility(&id)?.unwrap_or_else(||"visible".into()),job:store.job_for_plan(&id)?,stored});
        }
    }
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct ActionReport { pub changed:Vec<String>, pub rejected:Vec<imagery_recovery::ClaimFailure>, pub files_preserved:bool }

#[tauri::command]
pub fn imagery_tasks_cleanup(app:AppHandle,state:State<'_,AppState>,services:State<'_,services::ServiceState>,conversation_id:String,plan_ids:Vec<String>,action:String)->Result<ActionReport,AppError>{
    let workspace=read_workspace(&app,&state,&services,&conversation_id)?;
    let owner=services::current_user_id(&services).map_err(|e|workspace_error(e.code,e.message))?;
    change(&state,&owner,&conversation_id,Path::new(&workspace.directory),plan_ids,&action)
}

pub(crate) fn change(state:&AppState,owner:&str,conversation:&str,root:&Path,ids:Vec<String>,action:&str)->Result<ActionReport,AppError>{
    if ids.is_empty()||ids.len()>1000||!matches!(action,"discard"|"clean"|"restore") {return Err(workspace_error("INVALID_SPEC","请选择 1–1000 项任务及有效的清理操作"));}
    let mut result=ActionReport{changed:Vec::new(),rejected:Vec::new(),files_preserved:true};
    // Worker registration, resume and cleanup share this mutex; start_job's
    // SQLite transaction independently protects queued creation vs cleanup.
    let active=state.running_jobs.lock().map_err(storage)?;
    let mut store=open_store(state)?;
    for id in ids {
        if result.changed.contains(&id)||result.rejected.iter().any(|e|e.plan_id==id){continue;}
        let apply=||->Result<(),AppError>{
            imagery_recovery::assert_plan_owner(state,owner,conversation,root,&id)?;
            if action!="restore" && store.job_for_plan(&id)?.is_some_and(|job|active.contains_key(&job.job_id)) {return Err(workspace_error("JOB_STATE_CONFLICT","任务仍在运行或停止中，请稍后清理"));}
            Ok(())
        };
        let outcome=apply().and_then(|_|store.set_plan_visibility(&id,match action{"discard"=>Some("discarded"),"clean"=>Some("cleaned"),_=>None}).map_err(Into::into));
        match outcome {Ok(())=>result.changed.push(id),Err(e)=>result.rejected.push(imagery_recovery::ClaimFailure{plan_id:id,code:e.code,message:e.message})}
    }
    Ok(result)
}
fn storage(e:impl std::fmt::Display)->AppError{workspace_error("STORAGE_ERROR",e.to_string())}

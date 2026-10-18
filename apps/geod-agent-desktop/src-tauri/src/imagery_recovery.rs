//! Recovery always creates a new plan and output folder. Old jobs and artifacts
//! remain immutable; ordinary approval/start commands execute the new plan.
use super::*;
use rusqlite::{params, Connection, OptionalExtension};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryMode { RetryMissing, ExportAvailable }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPlan {
    pub stored: StoredPlan,
    pub original_job_id: String,
    pub mode: RecoveryMode,
    pub permission: WorkspacePermission,
    pub requires_plan_confirmation: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimFailure { pub plan_id: String, pub code: &'static str, pub message: String }
#[derive(Serialize)]
pub struct ClaimReport { pub bound: Vec<String>, pub rejected: Vec<ClaimFailure> }

pub(crate) fn db(state: &AppState) -> Result<Connection, AppError> {
    let conn = Connection::open(&state.db_path).map_err(storage)?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(storage)?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS imagery_plan_owners (
      plan_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      workspace TEXT NOT NULL, bound_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imagery_recoveries (
      plan_id TEXT PRIMARY KEY, original_job_id TEXT NOT NULL, mode TEXT NOT NULL);").map_err(storage)?;
    crate::download_telemetry::schema(&conn)?;
    Ok(conn)
}
fn storage(error: impl std::fmt::Display) -> AppError { workspace_error("STORAGE_ERROR", error.to_string()) }
pub(crate) fn proposal_guard()->Result<std::sync::MutexGuard<'static,()>,AppError>{
    static LOCK:std::sync::Mutex<()>=std::sync::Mutex::new(());
    LOCK.lock().map_err(storage)
}
pub(crate) fn reusable_pending_plan(state:&AppState,owner:&str,conversation:&str,workspace:&Path,spec:&TaskSpec,source:&SourceDescriptor)->Result<Option<StoredPlan>,AppError>{
    let root=fs::canonicalize(workspace).map_err(storage)?.to_string_lossy().into_owned();
    let conn=db(state)?;
    let ids={let mut q=conn.prepare("SELECT o.plan_id FROM imagery_plan_owners o WHERE o.owner_id=?1 AND o.conversation_id=?2 AND o.workspace=?3 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.plan_id=o.plan_id) ORDER BY o.bound_at DESC").map_err(storage)?;
        let rows=q.query_map(params![owner,conversation,root],|r|r.get::<_,String>(0)).map_err(storage)?.collect::<Result<Vec<_>,_>>().map_err(storage)?;rows};
    let mut store=open_store(state)?;
    let mut expected=serde_json::to_value(spec).map_err(storage)?;
    expected.as_object_mut().unwrap().remove("outputDirectory");
    for id in ids{
        if store.plan_visibility(&id)?.is_some(){continue;}
        let Some(old)=store.get_plan(&id)? else{continue};
        let mut actual=serde_json::to_value(&old.plan.spec).map_err(storage)?;
        actual.as_object_mut().unwrap().remove("outputDirectory");
        if actual!=expected{continue;}
        assert_plan_owner(state,owner,conversation,workspace,&id)?;
        match store.revalidate_plan(&id,&old.plan.plan_hash,source,Utc::now()){
            Ok(valid)=>return Ok(Some(valid)),
            Err(cause) if cause.code=="STORAGE_ERROR"=>return Err(cause.into()),
            Err(_)=>continue,
        }
    }
    Ok(None)
}

fn plan_workspace(plan: &StoredPlan, workspace: &Path) -> Result<PathBuf, AppError> {
    let root = fs::canonicalize(workspace).map_err(storage)?;
    let output = Path::new(&plan.plan.spec.output_directory);
    let parent = output.parent().and_then(|p| fs::canonicalize(p).ok());
    if parent.as_deref() != Some(root.as_path()) || output.file_name().is_none() {
        return Err(workspace_error("WORKSPACE_DENIED", "计划不属于当前会话保存的工作区"));
    }
    Ok(root)
}

/// Called by plans_create immediately after its native durable write. The legacy
/// migration command uses the same check and cannot replace an existing owner.
pub(crate) fn bind_created_plan(state: &AppState, owner: &str, conversation_id: &str, workspace: &Path, plan_id: &str) -> Result<(), AppError> {
    let stored = open_store(state)?.get_plan(plan_id)?.ok_or_else(|| workspace_error("PLAN_NOT_FOUND", "计划不存在"))?;
    let root = plan_workspace(&stored, workspace)?.to_string_lossy().into_owned();
    let conn = db(state)?;
    conn.execute("INSERT OR IGNORE INTO imagery_plan_owners(plan_id,owner_id,conversation_id,workspace,bound_at) VALUES(?1,?2,?3,?4,?5)",
        params![plan_id,owner,conversation_id,root,Utc::now().to_rfc3339()]).map_err(storage)?;
    let actual: (String,String,String) = conn.query_row("SELECT owner_id,conversation_id,workspace FROM imagery_plan_owners WHERE plan_id=?1", [plan_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(storage)?;
    if actual != (owner.into(),conversation_id.into(),root) {
        return Err(workspace_error("PLAN_NOT_OWNED", "计划已属于其他账号或会话，无法重新绑定"));
    }
    Ok(())
}

#[tauri::command]
pub fn imagery_plans_claim(app: AppHandle, state: State<'_, AppState>, services: State<'_, services::ServiceState>, conversation_id: String, plan_ids: Vec<String>) -> Result<ClaimReport, AppError> {
    // A new conversation has no historical plans to migrate or workspace to recover.
    if plan_ids.is_empty() { return Ok(ClaimReport{bound:Vec::new(),rejected:Vec::new()}); }
    if plan_ids.len()>1000 { return Err(workspace_error("INVALID_SPEC", "每次最多迁移 1000 项计划")); }
    // A migration must originate from a saved account-scoped workspace, never
    // from the fallback directory shared by as-yet-unbound conversations.
    if !workspace_file(&state,&services,&conversation_id)?.is_file() {
        return Err(workspace_error("WORKSPACE_NOT_BOUND", "请先恢复此历史会话保存的工作区，再迁移任务归属"));
    }
    let workspace = read_workspace(&app,&state,&services,&conversation_id)?;
    let owner = services::current_user_id(&services).map_err(|e|workspace_error(e.code,e.message))?;
    let mut result=ClaimReport{bound:Vec::new(),rejected:Vec::new()};
    for id in plan_ids {
        if result.bound.contains(&id) || result.rejected.iter().any(|e|e.plan_id==id) { continue; }
        match bind_created_plan(&state,&owner,&conversation_id,Path::new(&workspace.directory),&id) {
            Ok(())=>result.bound.push(id),
            Err(e)=>result.rejected.push(ClaimFailure{plan_id:id,code:e.code,message:e.message}),
        }
    }
    Ok(result)
}

pub(crate) fn assert_plan_owner(state:&AppState,owner:&str,conversation_id:&str,workspace:&Path,plan_id:&str)->Result<(),AppError>{
    let actual: Option<(String,String,String)> = db(state)?.query_row("SELECT owner_id,conversation_id,workspace FROM imagery_plan_owners WHERE plan_id=?1",[plan_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(storage)?;
    let root=fs::canonicalize(workspace).map_err(storage)?.to_string_lossy().into_owned();
    if actual.as_ref()!=Some(&(owner.into(),conversation_id.into(),root)) {
        return Err(workspace_error("PLAN_NOT_OWNED","此任务未绑定到当前账号和会话，请先在原会话中恢复任务"));
    }
    Ok(())
}

fn create_recovery(state:&AppState,owner:&str,conversation_id:&str,workspace:&WorkspaceSettings,job_id:&str,mode:RecoveryMode,execution_id:&str)->Result<RecoveryPlan,AppError>{
    if execution_id.trim().is_empty() || execution_id.len()>256 {return Err(workspace_error("INVALID_SPEC","恢复请求标识需要 1–256 个字符"));}
    let mut store=open_store(state)?;
    let original=store.get_job(job_id)?.ok_or_else(||workspace_error("JOB_NOT_FOUND","原任务不存在"))?;
    assert_plan_owner(state,owner,conversation_id,Path::new(&workspace.directory),&original.plan_id)?;
    if state.running_jobs.lock().map_err(storage)?.contains_key(job_id){return Err(workspace_error("JOB_STATE_CONFLICT","原任务仍在执行，请先暂停或取消后再生成恢复计划"));}
    let previous=store.get_plan(&original.plan_id)?.ok_or_else(||workspace_error("PLAN_NOT_FOUND","原计划不存在"))?;
    plan_workspace(&previous,Path::new(&workspace.directory))?;
    let source=store.get_registered_source(&previous.plan.spec.source_id)?.ok_or_else(||workspace_error("SOURCE_NOT_FOUND","原图源已移除，请重新配置后规划"))?;
    // The source registry is the authority. Credentials, subdomains, coordinate
    // correction and annotation revisions must match the original cached pixels.
    let current=geod_task_engine::plan(previous.plan.spec.clone(),&source.descriptor,Utc::now()).map_err(|e|workspace_error(e.code,e.message))?;
    if current.source_fingerprint!=previous.plan.source_fingerprint {return Err(workspace_error("PLAN_STALE","原图源配置已变化，请重新规划，不能将不同版本瓦片混入恢复成果"));}
    store.plan_overlays(&previous.plan.spec,&source.descriptor)?;
    let key=format!("imagery-recovery:{:x}",Sha256::digest(serde_json::to_vec(&(owner,conversation_id,job_id,mode,execution_id)).map_err(storage)?));
    let stored=if let Some(existing)=store.get_plan_for_tool_execution(&key)? {existing} else {
        let mut spec=previous.plan.spec.clone();
        spec.export_options.get_or_insert_with(Default::default).cache_only=mode==RecoveryMode::ExportAvailable;
        spec.export_options.as_mut().unwrap().reuse_verified_cache=mode==RecoveryMode::RetryMissing;
        let label=if mode==RecoveryMode::ExportAvailable {"cached"}else{"repair"};
        spec.output_directory=Path::new(&workspace.directory).join(format!("imagery-{label}-{}-{}",Utc::now().format("%Y%m%d-%H%M%S"),&key[key.len()-12..])).to_string_lossy().into_owned();
        validate_auto_destination(Path::new(&workspace.directory),Path::new(&spec.output_directory))?;
        store.create_plan_for_tool_execution(&key,spec,&source.descriptor,Utc::now())?
    };
    bind_created_plan(state,owner,conversation_id,Path::new(&workspace.directory),&stored.plan_id)?;
    db(state)?.execute("INSERT OR IGNORE INTO imagery_recoveries(plan_id,original_job_id,mode) VALUES(?1,?2,?3)",params![stored.plan_id,job_id,serde_json::to_string(&mode).map_err(storage)?]).map_err(storage)?;
    Ok(RecoveryPlan{stored,original_job_id:job_id.into(),mode,permission:workspace.permission,requires_plan_confirmation:workspace.permission!=WorkspacePermission::FullAccess})
}

#[tauri::command]
pub fn imagery_recovery_plan(app:AppHandle,state:State<'_,AppState>,services:State<'_,services::ServiceState>,conversation_id:String,job_id:String,mode:RecoveryMode,execution_id:String)->Result<RecoveryPlan,AppError>{
    let workspace=read_workspace(&app,&state,&services,&conversation_id)?;
    let owner=services::current_user_id(&services).map_err(|e|workspace_error(e.code,e.message))?;
    create_recovery(&state,&owner,&conversation_id,&workspace,&job_id,mode,&execution_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn cleanup_is_owned_reversible_and_retains_outputs_and_ledger() {
        let (dir,state,_,old,job)=fixture();
        let output=dir.path().join("original");fs::create_dir(&output).unwrap();fs::write(output.join("sentinel"),b"keep").unwrap();
        let change=|ids,action|crate::imagery_task_cleanup::change(&state,"owner-a","conversation-a",dir.path(),ids,action).unwrap();
        assert_eq!(change(vec![old.plan_id.clone()],"clean").rejected[0].code,"JOB_STATE_CONFLICT");
        open_store(&state).unwrap().cancel_inactive_job(&job.job_id).unwrap();
        let report=change(vec![old.plan_id.clone(),"missing".into(),old.plan_id.clone()],"clean");
        assert_eq!(report.changed,vec![old.plan_id.clone()]);assert_eq!(report.rejected.len(),1);assert!(report.files_preserved);
        assert_eq!(open_store(&state).unwrap().plan_visibility(&old.plan_id).unwrap().as_deref(),Some("cleaned"));
        assert!(open_store(&state).unwrap().assert_plan_visible(&old.plan_id).is_err());
        let records=crate::imagery_task_cleanup::list(&state,"owner-a","conversation-a",dir.path()).unwrap();assert_eq!(records[0].record_state,"cleaned");assert_eq!(records[0].job.as_ref().unwrap().state,geod_task_engine::ledger::JobState::Cancelled);
        assert_eq!(crate::task_state_context::snapshot(&state.db_path,"owner-a","conversation-a")["counts"]["cleaned"],1);
        let wrong=crate::imagery_task_cleanup::change(&state,"other","conversation-a",dir.path(),vec![old.plan_id.clone()],"restore").unwrap();assert_eq!(wrong.rejected[0].code,"PLAN_NOT_OWNED");
        assert_eq!(change(vec![old.plan_id.clone()],"restore").changed.len(),1);
        assert_eq!(open_store(&state).unwrap().plan_visibility(&old.plan_id).unwrap(),None);
        assert_eq!(fs::read(output.join("sentinel")).unwrap(),b"keep");
        assert_eq!(open_store(&state).unwrap().get_plan(&old.plan_id).unwrap(),Some(old));
        assert!(!open_store(&state).unwrap().events_after(&job.job_id,0,100).unwrap().is_empty());
    }

    #[test] fn discarded_plan_cannot_start_even_with_prior_approval() {
        let (dir,state,_,old,_)=fixture();let mut store=open_store(&state).unwrap();
        let source=store.get_registered_source(&old.plan.spec.source_id).unwrap().unwrap();
        let mut spec=old.plan.spec.clone();spec.output_directory=dir.path().join("pending").to_string_lossy().into_owned();
        let pending=store.create_plan(spec,&source.descriptor,Utc::now()).unwrap();
        bind_created_plan(&state,"owner-a","conversation-a",dir.path(),&pending.plan_id).unwrap();
        let approval=store.grant_approval(&pending.plan_id,&pending.plan.plan_hash,"owner-a","test",Utc::now()).unwrap();
        let schedule=store.create_schedule("owner-a","conversation-a","cleanup-schedule","Cleanup schedule",Some(&pending.plan_id),pending.plan.spec.clone(),Utc::now()+chrono::Duration::hours(1),None,0,Utc::now()).unwrap();
        assert_eq!(store.set_plan_visibility(&pending.plan_id,Some("cleaned")).unwrap_err().code,"SCHEDULE_CONFLICT");
        store.set_schedule_enabled("owner-a",&schedule.schedule_id,false,None,Utc::now()).unwrap();
        assert_eq!(crate::imagery_task_cleanup::change(&state,"owner-a","conversation-a",dir.path(),vec![pending.plan_id.clone()],"discard").unwrap().changed.len(),1);
        assert_eq!(store.start_job(&pending.plan_id,&pending.plan.plan_hash,&approval.approval_id,"late-start",&source.descriptor,Utc::now()).unwrap_err().code,"PLAN_DISCARDED");
        store.set_plan_visibility(&pending.plan_id,None).unwrap();
        assert!(store.start_job(&pending.plan_id,&pending.plan.plan_hash,&approval.approval_id,"late-start",&source.descriptor,Utc::now()).is_ok());
        assert_eq!(store.set_plan_visibility(&pending.plan_id,Some("cleaned")).unwrap_err().code,"JOB_STATE_CONFLICT");
    }
    fn fixture() -> (tempfile::TempDir,AppState,WorkspaceSettings,StoredPlan,Job) {
        let dir=tempfile::tempdir().unwrap();
        let state=AppState{db_path:dir.path().join("test.sqlite"),workspace_dir:dir.path().into(),running_jobs:Arc::new(Mutex::new(HashMap::new())),schedule_gate:Mutex::new(())};
        let workspace=WorkspaceSettings{directory:dir.path().to_string_lossy().into_owned(),permission:WorkspacePermission::ConfirmEach,output_crs:None};
        let endpoint:HttpSource=serde_json::from_value(serde_json::json!({"id":"recovery-source","name":"Recovery fixture","attribution":"","license":"","urlTemplate":"https://tiles.example.org/{z}/{x}/{y}.png","scheme":"XYZ","tileSize":256,"networkPolicy":"PublicHttps","minIntervalMs":0})).unwrap();
        let mut store=open_store(&state).unwrap();let source=store.save_source(endpoint,0,22,false,Utc::now()).unwrap();
        let spec:TaskSpec=serde_json::from_value(serde_json::json!({"schemaVersion":"0.1","kind":"imagery","sourceId":source.id,"bounds":[-1,1,1,2],"zoomLevels":[1],"outputFormats":["geotiff","mbtiles"],"outputDirectory":dir.path().join("original").to_string_lossy(),"limits":{"maxTiles":100,"maxDecodedRgbaBytes":100000000}})).unwrap();
        let old=store.create_plan(spec,&source,Utc::now()).unwrap();
        let approval=store.grant_approval(&old.plan_id,&old.plan.plan_hash,"owner-a","test",Utc::now()).unwrap();
        let job=store.start_job(&old.plan_id,&old.plan.plan_hash,&approval.approval_id,"original-start",&source,Utc::now()).unwrap();
        bind_created_plan(&state,"owner-a","conversation-a",dir.path(),&old.plan_id).unwrap();
        (dir,state,workspace,old,job)
    }
    #[test] fn identical_pending_proposals_reuse_only_same_owner_workspace_and_current_source(){
        let (dir,state,_,old,_)=fixture();let mut store=open_store(&state).unwrap();
        let source=store.get_registered_source(&old.plan.spec.source_id).unwrap().unwrap();
        let mut spec=old.plan.spec.clone();spec.output_directory=dir.path().join("pending").to_string_lossy().into_owned();
        let pending=store.create_plan(spec.clone(),&source.descriptor,Utc::now()).unwrap();
        bind_created_plan(&state,"owner-a","conversation-a",dir.path(),&pending.plan_id).unwrap();
        spec.output_directory=dir.path().join("retry-output").to_string_lossy().into_owned();
        let find=|owner:&str,conversation:&str,spec:&TaskSpec|reusable_pending_plan(&state,owner,conversation,dir.path(),spec,&source.descriptor).unwrap();
        assert_eq!(find("owner-a","conversation-a",&spec).unwrap().plan_id,pending.plan_id);
        assert!(find("owner-b","conversation-a",&spec).is_none());assert!(find("owner-a","conversation-b",&spec).is_none());
        let mut changed=spec.clone();changed.zoom_levels=vec![2];assert!(find("owner-a","conversation-a",&changed).is_none());
        store.set_plan_visibility(&pending.plan_id,Some("cleaned")).unwrap();assert!(find("owner-a","conversation-a",&spec).is_none());
        store.set_plan_visibility(&pending.plan_id,None).unwrap();
        let mut endpoint=source.endpoint;endpoint.min_interval_ms=7;
        let revised=store.save_source(endpoint,0,22,true,Utc::now()).unwrap();
        assert!(reusable_pending_plan(&state,"owner-a","conversation-a",dir.path(),&spec,&revised).unwrap().is_none());
        let approval=store.grant_approval(&pending.plan_id,&pending.plan.plan_hash,"owner-a","test",Utc::now()).unwrap();
        store.start_job(&pending.plan_id,&pending.plan.plan_hash,&approval.approval_id,"start-pending",&source.descriptor,Utc::now()).unwrap();
        assert!(find("owner-a","conversation-a",&spec).is_none());
    }
    #[test] fn recovery_copies_geometry_formats_and_never_mutates_original_artifacts() {
        let (dir,state,mut workspace,old,job)=fixture();
        fs::create_dir(dir.path().join("original")).unwrap();fs::write(dir.path().join("original/sentinel"),b"original bytes").unwrap();
        let repaired=create_recovery(&state,"owner-a","conversation-a",&workspace,&job.job_id,RecoveryMode::RetryMissing,"retry-request").unwrap();
        assert!(repaired.requires_plan_confirmation);assert!(!repaired.stored.plan.spec.export_options.as_ref().unwrap().cache_only);
        assert!(repaired.stored.plan.spec.export_options.as_ref().unwrap().reuse_verified_cache);
        let cached=create_recovery(&state,"owner-a","conversation-a",&workspace,&job.job_id,RecoveryMode::ExportAvailable,"cache-request").unwrap();
        assert!(cached.stored.plan.spec.export_options.as_ref().unwrap().cache_only);
        for new in [&repaired.stored,&cached.stored] {
            assert_ne!(new.plan_id,old.plan_id);assert_ne!(new.plan.spec.output_directory,old.plan.spec.output_directory);
            assert_eq!(new.plan.spec.bounds,old.plan.spec.bounds);assert_eq!(new.plan.spec.boundary,old.plan.spec.boundary);assert_eq!(new.plan.spec.output_formats,old.plan.spec.output_formats);
            assert!(open_store(&state).unwrap().job_for_plan(&new.plan_id).unwrap().is_none());
        }
        let replay=create_recovery(&state,"owner-a","conversation-a",&workspace,&job.job_id,RecoveryMode::RetryMissing,"retry-request").unwrap();assert_eq!(replay.stored,repaired.stored);
        workspace.permission=WorkspacePermission::FullAccess;
        let full=create_recovery(&state,"owner-a","conversation-a",&workspace,&job.job_id,RecoveryMode::RetryMissing,"full-request").unwrap();assert!(!full.requires_plan_confirmation);
        assert_eq!(open_store(&state).unwrap().get_plan(&old.plan_id).unwrap(),Some(old));
        assert_eq!(fs::read(dir.path().join("original/sentinel")).unwrap(),b"original bytes");
    }
    #[test] fn ownership_cannot_be_reassigned_across_account_conversation_or_workspace() {
        let (dir,state,workspace,old,job)=fixture();
        assert_eq!(bind_created_plan(&state,"owner-b","conversation-a",dir.path(),&old.plan_id).unwrap_err().code,"PLAN_NOT_OWNED");
        assert_eq!(bind_created_plan(&state,"owner-a","conversation-b",dir.path(),&old.plan_id).unwrap_err().code,"PLAN_NOT_OWNED");
        let other=tempfile::tempdir().unwrap();assert_eq!(bind_created_plan(&state,"owner-a","conversation-a",other.path(),&old.plan_id).unwrap_err().code,"WORKSPACE_DENIED");
        assert_eq!(create_recovery(&state,"owner-b","conversation-a",&workspace,&job.job_id,RecoveryMode::RetryMissing,"x").err().unwrap().code,"PLAN_NOT_OWNED");
        assert_eq!(create_recovery(&state,"owner-a","conversation-b",&workspace,&job.job_id,RecoveryMode::ExportAvailable,"x").err().unwrap().code,"PLAN_NOT_OWNED");
    }
    #[test] fn recovery_refuses_running_worker_and_changed_source() {
        let (_dir,state,workspace,old,job)=fixture();
        state.running_jobs.lock().unwrap().insert(job.job_id.clone(),Arc::new(WorkerControl::default()));
        assert_eq!(create_recovery(&state,"owner-a","conversation-a",&workspace,&job.job_id,RecoveryMode::RetryMissing,"x").err().unwrap().code,"JOB_STATE_CONFLICT");
        state.running_jobs.lock().unwrap().clear();
        let mut store=open_store(&state).unwrap();let mut source=store.get_registered_source(&old.plan.spec.source_id).unwrap().unwrap();source.endpoint.min_interval_ms=1;
        store.save_source(source.endpoint,0,22,true,Utc::now()).unwrap();
        assert_eq!(create_recovery(&state,"owner-a","conversation-a",&workspace,&job.job_id,RecoveryMode::RetryMissing,"x").err().unwrap().code,"PLAN_STALE");
    }
    #[test] fn recovery_refuses_changed_annotation_revision() {
        let (dir,state,workspace,old,_)=fixture();let mut store=open_store(&state).unwrap();
        let mut overlay=store.get_registered_source(&old.plan.spec.source_id).unwrap().unwrap().endpoint;overlay.id="annotation".into();
        let descriptor=store.save_source(overlay.clone(),0,22,false,Utc::now()).unwrap();let mut spec=old.plan.spec;
        spec.output_directory=dir.path().join("annotated").to_string_lossy().into_owned();
        spec.export_options=Some(serde_json::from_value(serde_json::json!({"overlaySources":[{"sourceId":"annotation","configRevision":descriptor.config_revision}]})).unwrap());
        let source=store.get_registered_source(&spec.source_id).unwrap().unwrap().descriptor;
        let planned=store.create_plan(spec,&source,Utc::now()).unwrap();let approval=store.grant_approval(&planned.plan_id,&planned.plan.plan_hash,"owner-a","test",Utc::now()).unwrap();
        let job=store.start_job(&planned.plan_id,&planned.plan.plan_hash,&approval.approval_id,"overlay",&source,Utc::now()).unwrap();
        bind_created_plan(&state,"owner-a","conversation-a",dir.path(),&planned.plan_id).unwrap();
        overlay.min_interval_ms=1;store.save_source(overlay,0,22,true,Utc::now()).unwrap();
        assert_eq!(create_recovery(&state,"owner-a","conversation-a",&workspace,&job.job_id,RecoveryMode::ExportAvailable,"x").err().unwrap().code,"PLAN_STALE");
    }
    #[test] fn simultaneous_replayed_recovery_returns_one_durable_plan() {
        let (_dir,state,workspace,_,job)=fixture();let state=Arc::new(state);
        let calls=(0..4).map(|_| {
            let state=state.clone();let workspace=workspace.clone();let id=job.job_id.clone();
            std::thread::spawn(move || create_recovery(&state,"owner-a","conversation-a",&workspace,&id,RecoveryMode::RetryMissing,"same-call").unwrap().stored)
        }).collect::<Vec<_>>();
        let plans=calls.into_iter().map(|c|c.join().unwrap()).collect::<Vec<_>>();
        assert!(plans.iter().all(|p|p==&plans[0]));
        let count:u32=db(&state).unwrap().query_row("SELECT count(*) FROM imagery_recoveries",[],|r|r.get(0)).unwrap();assert_eq!(count,1);
    }
}

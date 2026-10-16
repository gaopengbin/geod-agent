//! Restore missing history records only; this module never starts downloads.
use super::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::io::Read;

fn failure(message: &str) -> AppError { workspace_error("HISTORY_RECOVERY", message) }
fn sql(_: rusqlite::Error) -> AppError { failure("任务记录读取或恢复失败，原记录未覆盖。") }
fn read_only(file: &Path) -> Result<Connection, AppError> {
    Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sql)
}
fn digest(file: &Path) -> Result<String, AppError> {
    let mut input=fs::File::open(file).map_err(|_|failure("备份文件不可读。"))?;
    let mut hash=Sha256::new();let mut buffer=[0u8;65536];
    loop {let n=input.read(&mut buffer).map_err(|_|failure("备份文件不可读。"))?;if n==0 {break;}hash.update(&buffer[..n]);}
    Ok(format!("{:x}",hash.finalize()))
}
#[derive(Clone)]
struct Backup { file:PathBuf, sha256:String, bytes:u64 }
fn backups(root: &Path) -> Vec<Backup> {
    let parent=root.join("upgrade-backups");let Ok(canonical)=parent.canonicalize() else{return Vec::new()};
    let Ok(entries)=fs::read_dir(&parent) else{return Vec::new()};
    let mut folders=entries.flatten().map(|e|e.path()).filter(|p|p.is_dir()&&!p.file_name().unwrap_or_default().to_string_lossy().starts_with('.')).collect::<Vec<_>>();
    folders.sort();folders.reverse();let mut result=Vec::new();
    for folder in folders {
        let manifest=folder.join("manifest.json");
        let Ok(path)=manifest.canonicalize() else{continue};if !path.starts_with(&canonical){continue;}
        if fs::metadata(&path).map_or(true,|m|m.len()>16*1024*1024){continue;}
        let Some(value)=fs::read(path).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok()) else{continue};
        if value["schemaVersion"]!=1 {continue;}
        let Some(records)=value["records"].as_array() else{continue};
        for record in records.iter().filter(|r|r["path"]=="agent-tasks.sqlite"&&r["kind"]=="sqlite") {
            let (Some(name),Some(hash),Some(bytes))=(record["file"].as_str(),record["sha256"].as_str(),record["bytes"].as_u64()) else{continue};
            let Ok(file)=folder.join(name).canonicalize() else{continue};
            let Ok(folder)=folder.canonicalize() else{continue};
            if !file.starts_with(&canonical)||!file.starts_with(&folder)||hash.len()!=64||!hash.bytes().all(|c|c.is_ascii_hexdigit()){continue;}
            result.push(Backup{file,sha256:hash.into(),bytes});
        }
    }
    result
}
fn eligible(db: &Connection, owner:&str, conversation:&str, workspace:&Path, id:&str) -> bool {
    let row=db.query_row("SELECT p.plan_hash,p.body,o.owner_id,o.conversation_id,o.workspace FROM plans p JOIN imagery_plan_owners o ON p.plan_id=o.plan_id WHERE p.plan_id=?1",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).optional();
    let Ok(Some((hash,body,account,chat,folder)))=row else{return false};
    if account!=owner||chat!=conversation||Path::new(&folder).canonicalize().ok().as_deref()!=Some(workspace){return false;}
    let Ok(plan)=serde_json::from_str::<geod_task_engine::Plan>(&body) else{return false};
    if plan.plan_hash!=hash||Path::new(&plan.spec.output_directory).parent().and_then(|p|p.canonicalize().ok()).as_deref()!=Some(workspace){return false;}
    // In-progress snapshots are not reintroduced into the worker queue.
    let active=db.query_row("SELECT count(*) FROM jobs WHERE plan_id=?1 AND state NOT IN ('completed','failed','cancelled')",[id],|r|r.get::<_,u32>(0));
    matches!(active,Ok(0))
}
fn candidates(root:&Path,owner:&str,conversation:&str,workspace:&Path,ids:&[String]) -> Vec<(String,Backup)> {
    let mut result=Vec::new();
    for backup in backups(root) {
        let Ok(db)=read_only(&backup.file) else{continue};
        for id in ids {
            if !result.iter().any(|(found,_)|found==id)&&eligible(&db,owner,conversation,workspace,id){result.push((id.clone(),backup.clone()));}
        }
        if result.len()==ids.len(){break;}
    }
    result
}
fn context(state:&AppState,services:&services::ServiceState,conversation:&str)->Result<(String,PathBuf,PathBuf),AppError>{
    let owner=services::current_user_id(services).map_err(|e|workspace_error(e.code,e.message))?;
    let binding=workspace_file(state,services,conversation)?;
    Ok((owner,binding,state.workspace_dir.clone()))
}
#[tauri::command]
pub async fn imagery_history_inspect(state:State<'_,AppState>,services:State<'_,services::ServiceState>,conversation_id:String,plan_ids:Vec<String>)->Result<Value,AppError>{
    if plan_ids.len()>1000{return Err(failure("每次最多检查 1000 项任务。"));}
    let (owner,binding,root)=context(&state,&services,&conversation_id)?;let database=state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move||{
        let workspace=fs::read(&binding).ok().and_then(|v|serde_json::from_slice::<WorkspaceSettings>(&v).ok());
        let directory=workspace.as_ref().map(|w|w.directory.clone());
        let available=directory.as_ref().and_then(|d|Path::new(d).canonicalize().ok()).filter(|d|d.is_dir());
        let db=read_only(&database)?;
        let mut missing=Vec::new();
        for id in plan_ids {if db.query_row("SELECT count(*) FROM plans WHERE plan_id=?1",[&id],|r|r.get::<_,u32>(0)).map_err(sql)?==0{missing.push(id);}}
        let found=available.as_ref().map(|path|candidates(&root,&owner,&conversation_id,path,&missing)).unwrap_or_default();
        let actual=database.canonicalize().unwrap_or_else(|_|database.clone());
        Ok(json!({"workspaceBound":binding.is_file(),"workspaceDirectory":directory,"workspaceAvailable":available.is_some(),"databasePath":database,"actualDatabasePath":actual,"dataDirectoryRedirected":normalized(&actual)!=normalized(&database),"recoverablePlanIds":found.into_iter().map(|(id,_)|id).collect::<Vec<_>>()}))
    }).await.map_err(|_|failure("历史任务检查未完成，请重试。"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture()->(tempfile::TempDir,AppState,PathBuf,StoredPlan,Job){
        let dir=tempfile::tempdir().unwrap();let profile=dir.path().join("profile");let workspace=dir.path().join("workspace");fs::create_dir_all(&profile).unwrap();fs::create_dir_all(&workspace).unwrap();
        let state=AppState{db_path:profile.join("agent-tasks.sqlite"),workspace_dir:profile,running_jobs:Arc::new(Mutex::new(HashMap::new())),schedule_gate:Mutex::new(())};
        let mut store=open_store(&state).unwrap();
        let endpoint:HttpSource=serde_json::from_value(json!({"id":"fixture","name":"Fixture","attribution":"","license":"","urlTemplate":"https://tiles.example.org/{z}/{x}/{y}.png","scheme":"XYZ","tileSize":256,"networkPolicy":"PublicHttps","minIntervalMs":0})).unwrap();
        let source=store.save_source(endpoint,0,22,false,Utc::now()).unwrap();
        let spec:TaskSpec=serde_json::from_value(json!({"schemaVersion":"0.1","kind":"imagery","sourceId":source.id,"bounds":[-1,1,1,2],"zoomLevels":[1],"outputFormats":["geotiff"],"outputDirectory":workspace.join("original"),"limits":{"maxTiles":100,"maxDecodedRgbaBytes":100000000}})).unwrap();
        let plan=store.create_plan(spec,&source,Utc::now()).unwrap();
        let approval=store.grant_approval(&plan.plan_id,&plan.plan.plan_hash,"owner-a","test",Utc::now()).unwrap();
        let job=store.start_job(&plan.plan_id,&plan.plan.plan_hash,&approval.approval_id,"original",&source,Utc::now()).unwrap();
        imagery_recovery::bind_created_plan(&state,"owner-a","conversation-a",&workspace,&plan.plan_id).unwrap();
        store.cancel_inactive_job(&job.job_id).unwrap();
        fs::create_dir(workspace.join("original")).unwrap();fs::write(workspace.join("original/sentinel.tif"),b"original output bytes").unwrap();
        desktop_backups::create(&state.workspace_dir,"test",json!({"schemaVersion":1,"entries":[]})).unwrap();
        (dir,state,workspace.canonicalize().unwrap(),plan,job)
    }
    fn empty(state:&AppState)->AppState{
        let next=AppState{db_path:state.workspace_dir.join(format!("recovered-{}.sqlite",Uuid::new_v4())),workspace_dir:state.workspace_dir.clone(),running_jobs:Arc::new(Mutex::new(HashMap::new())),schedule_gate:Mutex::new(())};
        open_store(&next).unwrap();imagery_recovery::db(&next).unwrap();next
    }
    #[test]fn restore_keeps_ids_events_ownership_and_outputs_without_resuming_downloads(){
        let (_dir,state,workspace,plan,job)=fixture();let target=empty(&state);
        let before=read_only(&state.db_path).unwrap().query_row("SELECT count(*) FROM job_events",[],|r|r.get::<_,u32>(0)).unwrap();
        let result=restore(&state.workspace_dir,&target.db_path,"owner-a","conversation-a",&workspace,&[plan.plan_id.clone()]).unwrap();
        assert_eq!(result["restored"],json!([plan.plan_id]));assert!(Path::new(result["snapshotPath"].as_str().unwrap()).is_file());
        let store=open_store(&target).unwrap();assert_eq!(store.get_plan(&plan.plan_id).unwrap(),Some(plan.clone()));
        assert_eq!(store.get_job(&job.job_id).unwrap().unwrap().state,geod_task_engine::ledger::JobState::Cancelled);
        assert_eq!(store.events_after(&job.job_id,0,100).unwrap().len(),before as usize);
        imagery_recovery::assert_plan_owner(&target,"owner-a","conversation-a",&workspace,&plan.plan_id).unwrap();
        assert!(target.running_jobs.lock().unwrap().is_empty());assert_eq!(fs::read(workspace.join("original/sentinel.tif")).unwrap(),b"original output bytes");
        assert_eq!(read_only(&target.db_path).unwrap().query_row("SELECT count(*) FROM sources",[],|r|r.get::<_,u32>(0)).unwrap(),0);
        let replay=restore(&state.workspace_dir,&target.db_path,"owner-a","conversation-a",&workspace,&[plan.plan_id]).unwrap();assert_eq!(replay["restored"],json!([]));
    }
    #[test]fn backup_recovery_refuses_other_owners_conversations_workspaces_and_active_jobs(){
        let (_dir,state,workspace,plan,job)=fixture();let backup=backups(&state.workspace_dir).remove(0);let db=read_only(&backup.file).unwrap();
        assert!(!eligible(&db,"owner-b","conversation-a",&workspace,&plan.plan_id));assert!(!eligible(&db,"owner-a","conversation-b",&workspace,&plan.plan_id));assert!(!eligible(&db,"owner-a","conversation-a",&state.workspace_dir,&plan.plan_id));drop(db);
        let db=Connection::open(&backup.file).unwrap();db.execute("UPDATE jobs SET state='downloading' WHERE job_id=?1",[job.job_id]).unwrap();drop(db);
        assert!(!eligible(&read_only(&backup.file).unwrap(),"owner-a","conversation-a",&workspace,&plan.plan_id));
    }
    #[test]fn corrupt_or_changed_backups_never_write_partial_history(){
        let (_dir,state,workspace,plan,_)=fixture();let target=empty(&state);let backup=backups(&state.workspace_dir).remove(0);
        let db=Connection::open(&backup.file).unwrap();db.execute("UPDATE sources SET body=body||' '",[]).unwrap();drop(db);
        let result=restore(&state.workspace_dir,&target.db_path,"owner-a","conversation-a",&workspace,&[plan.plan_id.clone()]).unwrap();assert_eq!(result["rejected"].as_array().unwrap().len(),1);
        assert!(open_store(&target).unwrap().get_plan(&plan.plan_id).unwrap().is_none());
        assert_eq!(read_only(&target.db_path).unwrap().query_row("SELECT count(*) FROM approvals",[],|r|r.get::<_,u32>(0)).unwrap(),0);
    }
    #[test]fn conflicting_record_ids_roll_back_the_entire_plan_and_preserve_existing_history(){
        let (_dir,state,workspace,plan,job)=fixture();let target=empty(&state);let backup=backups(&state.workspace_dir).remove(0);
        let db=Connection::open(&target.db_path).unwrap();let source=read_only(&backup.file).unwrap();
        db.execute("INSERT INTO plans SELECT 'other',?1,?2",rusqlite::params![plan.plan.plan_hash,serde_json::to_string(&plan.plan).unwrap()]).unwrap();
        let fields:(String,String,String)=source.query_row("SELECT actor,confirmation_ui_version,approved_at FROM approvals WHERE approval_id=?1",[&job.approval_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        db.execute("INSERT INTO approvals VALUES(?1,'other',?2,?3,?4,?5)",rusqlite::params![job.approval_id,plan.plan.plan_hash,fields.0,fields.1,fields.2]).unwrap();
        db.execute("INSERT INTO jobs VALUES(?1,'other',?2,?3,'existing','completed',1,'test')",rusqlite::params![job.job_id,job.approval_id,plan.plan.plan_hash]).unwrap();drop(db);drop(source);
        let result=restore(&state.workspace_dir,&target.db_path,"owner-a","conversation-a",&workspace,&[plan.plan_id.clone()]).unwrap();assert_eq!(result["rejected"].as_array().unwrap().len(),1);
        let db=read_only(&target.db_path).unwrap();assert_eq!(db.query_row("SELECT count(*) FROM plans",[],|r|r.get::<_,u32>(0)).unwrap(),1);assert!(open_store(&target).unwrap().get_plan(&plan.plan_id).unwrap().is_none());
        assert_eq!(db.query_row("SELECT plan_id FROM jobs WHERE job_id=?1",[job.job_id],|r|r.get::<_,String>(0)).unwrap(),"other");
    }
}
fn normalized(path:&Path)->String{path.to_string_lossy().trim_start_matches(r"\\?\").replace('\\',"/").to_lowercase()}

fn restore_one(target:&mut Connection,backup:&Backup,owner:&str,conversation:&str,workspace:&Path,id:&str)->Result<(),AppError>{
    if fs::metadata(&backup.file).map_or(true,|m|m.len()!=backup.bytes)||digest(&backup.file)?!=backup.sha256{return Err(failure("备份校验失败，未使用这份备份。"));}
    let source=read_only(&backup.file)?;
    if !eligible(&source,owner,conversation,workspace,id){return Err(failure("备份中的任务不属于此账号、会话和工作区，或仍在执行。"));}
    let integrity:String=source.query_row("PRAGMA quick_check",[],|r|r.get(0)).map_err(sql)?;
    if integrity!="ok"{return Err(failure("备份数据库损坏，未使用这份备份。"));}
    drop(source);
    let mut uri=url::Url::from_file_path(&backup.file).map_err(|_|failure("备份路径不可用。"))?;uri.set_query(Some("mode=ro"));
    target.execute("ATTACH DATABASE ?1 AS history_backup",[uri.as_str()]).map_err(sql)?;
    let restored=(||{
        let tx=target.transaction().map_err(sql)?;
        for (name,columns) in [
            ("plans","plan_id,plan_hash,body"),
            ("approvals","approval_id,plan_id,plan_hash,actor,confirmation_ui_version,approved_at"),
            ("jobs","job_id,plan_id,approval_id,plan_hash,idempotency_key,state,version,created_at"),
            ("imagery_plan_owners","plan_id,owner_id,conversation_id,workspace,bound_at")
        ]{tx.execute(&format!("INSERT INTO main.{name}({columns}) SELECT {columns} FROM history_backup.{name} WHERE plan_id=?1"),[id]).map_err(sql)?;}
        tx.execute("INSERT INTO main.job_events(job_id,seq,body) SELECT job_id,seq,body FROM history_backup.job_events WHERE job_id IN (SELECT job_id FROM history_backup.jobs WHERE plan_id=?1)",[id]).map_err(sql)?;
        for (name,columns) in [("plan_visibility","plan_id,state,updated_at"),("imagery_recoveries","plan_id,original_job_id,mode")] {
            if tx.query_row("SELECT count(*) FROM history_backup.sqlite_master WHERE type='table' AND name=?1",[name],|r|r.get::<_,u32>(0)).map_err(sql)?==1 {
                tx.execute(&format!("INSERT INTO main.{name}({columns}) SELECT {columns} FROM history_backup.{name} WHERE plan_id=?1"),[id]).map_err(sql)?;
            }
        }
        tx.commit().map_err(sql)
    })();
    let detach=target.execute("DETACH DATABASE history_backup",[]).map_err(sql);
    restored?;detach?;Ok(())
}
fn restore(root:&Path,database:&Path,owner:&str,conversation:&str,workspace:&Path,ids:&[String])->Result<Value,AppError>{
    let mut target=Connection::open(database).map_err(sql)?;target.busy_timeout(Duration::from_secs(5)).map_err(sql)?;
    target.execute_batch("PRAGMA foreign_keys=ON").map_err(sql)?;
    let mut missing=Vec::new();
    for id in ids {if target.query_row("SELECT count(*) FROM plans WHERE plan_id=?1",[id],|r|r.get::<_,u32>(0)).map_err(sql)?==0{missing.push(id.clone());}}
    let found=candidates(root,owner,conversation,workspace,&missing);
    if found.is_empty(){return Ok(json!({"restored":[],"notFound":missing,"snapshotPath":null}));}
    let folder=root.join("history-recovery-backups");fs::create_dir_all(&folder).map_err(|_|failure("无法保存恢复前快照，未修改任务记录。"))?;
    let snapshot=folder.join(format!("before-{}.sqlite",Uuid::new_v4()));
    target.execute("VACUUM INTO ?1",[snapshot.to_string_lossy().as_ref()]).map_err(sql)?;
    let mut restored=Vec::new();let mut rejected=Vec::new();
    for (id,backup) in found {
        match restore_one(&mut target,&backup,owner,conversation,workspace,&id){Ok(())=>restored.push(id),Err(e)=>rejected.push(json!({"planId":id,"code":e.code,"message":e.message}))}
    }
    Ok(json!({"restored":restored,"rejected":rejected,"notFound":missing.into_iter().filter(|id|!restored.contains(id)).collect::<Vec<_>>(),"snapshotPath":snapshot}))
}
#[tauri::command]
pub async fn imagery_history_restore(app:AppHandle,state:State<'_,AppState>,services:State<'_,services::ServiceState>,conversation_id:String,plan_ids:Vec<String>)->Result<Value,AppError>{
    if plan_ids.len()>1000{return Err(failure("每次最多恢复 1000 项任务。"));}
    let (owner,binding,root)=context(&state,&services,&conversation_id)?;
    if !binding.is_file(){return Err(workspace_error("WORKSPACE_NOT_BOUND","请先恢复原工作区。"));}
    let workspace=read_workspace(&app,&state,&services,&conversation_id)?;
    let directory=Path::new(&workspace.directory).canonicalize().map_err(|_|failure("请先连接原工作区所在磁盘。"))?;
    open_store(&state)?;imagery_recovery::db(&state)?;
    let database=state.db_path.clone();
    tauri::async_runtime::spawn_blocking(move||restore(&root,&database,&owner,&conversation_id,&directory,&plan_ids)).await.map_err(|_|failure("任务记录恢复未完成，请重新检查。"))?
}

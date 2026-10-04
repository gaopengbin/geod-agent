//! Independent Codex task agents with native, workspace-confined file tools.
use crate::{codex_runtime,read_workspace,services,workspace_error,AppError,AppState,WorkspacePermission};
use rusqlite::{Connection,params,OptionalExtension};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::HashMap,fs,io::Read,path::{Component,Path,PathBuf},sync::{Arc,Mutex,OnceLock,atomic::{AtomicBool,Ordering}}};
use tauri::{AppHandle,Manager};
use uuid::Uuid;

static GATE:Mutex<()>=Mutex::new(());
static ACTIVE:OnceLock<Mutex<HashMap<String,Active>>>=OnceLock::new();
struct Active{owner:String,runtime:Arc<codex_runtime::CodexState>,cancel:Arc<AtomicBool>,run_id:String}
fn active()->&'static Mutex<HashMap<String,Active>>{ACTIVE.get_or_init(||Mutex::new(HashMap::new()))}
pub(crate) fn active_count()->usize{active().lock().unwrap().len()}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Draft{pub name:String,pub prompt:String,#[serde(default)]pub input_files:Vec<String>,#[serde(default="read_only")]pub read_only:bool}
fn read_only()->bool{true}
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Record{pub id:String,pub conversation_id:String,pub name:String,pub read_only:bool,pub status:String,pub created_at:String,pub updated_at:String,pub run_id:String,pub thread_id:Option<String>,pub result:Option<String>,pub error:Option<String>,pub cancel_requested:bool,#[serde(default)]pub model_route:Option<crate::ai_channels::RouteSnapshot>}
fn storage(app:&AppHandle)->Result<PathBuf,AppError>{let root=app.path().app_data_dir().map_err(|_|workspace_error("AGENT_STORAGE","子任务目录不可用"))?.join("agent-tasks");fs::create_dir_all(&root).map_err(|_|workspace_error("AGENT_STORAGE","子任务目录创建失败"))?;Ok(root)}
fn db(app:&AppHandle)->Result<Connection,AppError>{
    let db=Connection::open(storage(app)?.join("tasks.sqlite")).map_err(|_|workspace_error("AGENT_STORAGE","子任务记录不可用"))?;
    db.busy_timeout(std::time::Duration::from_secs(10)).map_err(|_|workspace_error("AGENT_STORAGE","子任务记录忙"))?;
    db.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS tasks(owner TEXT,id TEXT PRIMARY KEY,conversation TEXT,parent_directory TEXT,execution_key TEXT,fingerprint TEXT,data TEXT,UNIQUE(owner,conversation,execution_key));CREATE TABLE IF NOT EXISTS events(id TEXT,sequence INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT);").map_err(|_|workspace_error("AGENT_STORAGE","子任务记录初始化失败"))?;Ok(db)
}
fn identity(app:&AppHandle,conversation:&str)->Result<(String,crate::WorkspaceSettings),AppError>{let services=app.state::<services::ServiceState>();let owner=services::current_user_id(&services).map_err(|e|workspace_error(e.code,e.message))?;let settings=read_workspace(app,&app.state::<AppState>(),&services,conversation)?;Ok((owner,settings))}
fn task_root(app:&AppHandle,owner:&str,id:&str)->Result<PathBuf,AppError>{
    if Uuid::parse_str(id).is_err(){return Err(workspace_error("AGENT_NOT_FOUND","子任务不存在"));}
    let digest=format!("{:x}",Sha256::digest(owner));let storage=storage(app)?;let old=storage.join(&digest).join(id);
    // Short paths also work when a packaged launcher redirects AppData.
    // Ownership is verified against the full account ID in SQLite on every call.
    Ok(if old.exists(){old}else{storage.join(&digest[..16]).join(id)})
}
fn row(db:&Connection,owner:&str,id:&str)->Result<(Record,String),AppError>{db.query_row("SELECT data,parent_directory FROM tasks WHERE owner=? AND id=?",params![owner,id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional().map_err(|_|workspace_error("AGENT_STORAGE","子任务记录读取失败"))?.map(|(data,folder)|serde_json::from_str(&data).map(|r|(r,folder)).map_err(|_|workspace_error("AGENT_STORAGE","子任务记录无效"))).transpose()?.ok_or_else(||workspace_error("AGENT_NOT_FOUND","未找到当前账号的子任务"))}
fn authorized(app:&AppHandle,conversation:&str,id:&str)->Result<(String,Record),AppError>{let(owner,settings)=identity(app,conversation)?;let(record,parent)=row(&db(app)?,&owner,id)?;if record.conversation_id!=conversation||settings.directory!=parent{return Err(workspace_error("AGENT_NOT_FOUND","子任务不属于当前会话与工作区"));}Ok((owner,record))}
fn update(app:&AppHandle,owner:&str,id:&str,change:impl FnOnce(&mut Record))->Result<Record,AppError>{let _gate=GATE.lock().unwrap();let db=db(app)?;let(mut record,_)=row(&db,owner,id)?;change(&mut record);record.updated_at=chrono::Utc::now().to_rfc3339();db.execute("UPDATE tasks SET data=? WHERE owner=? AND id=?",params![serde_json::to_string(&record).unwrap(),owner,id]).map_err(|_|workspace_error("AGENT_STORAGE","子任务记录保存失败"))?;Ok(record)}
fn event(app:&AppHandle,id:&str,value:&Value)->Result<(),AppError>{
    // Token deltas and heartbeats are live transport, not durable operations.
    if value["type"]=="heartbeat"||value["type"]=="delta"||value["method"].as_str().is_some_and(|m|m.to_ascii_lowercase().contains("delta")){return Ok(());}
    let text=serde_json::to_string(value).unwrap();if text.len()>256*1024{return Ok(());}let db=db(app)?;db.execute("INSERT INTO events(id,data) VALUES(?,?)",params![id,text]).map_err(|_|workspace_error("AGENT_STORAGE","子任务事件保存失败"))?;db.execute("DELETE FROM events WHERE id=? AND sequence NOT IN(SELECT sequence FROM events WHERE id=? ORDER BY sequence DESC LIMIT 400)",params![id,id]).map_err(|_|workspace_error("AGENT_STORAGE","子任务事件整理失败"))?;Ok(())
}
pub(crate) fn initialize(app:&AppHandle)->Result<(),AppError>{
    let db=db(app)?;
    let mut statement=db.prepare("SELECT owner,json_extract(data,'$.runId') FROM tasks WHERE json_extract(data,'$.status') IN('queued','running')").map_err(|_|workspace_error("AGENT_STORAGE","子任务恢复失败"))?;
    let pending=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|_|workspace_error("AGENT_STORAGE","子任务恢复失败"))?.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|workspace_error("AGENT_STORAGE","子任务恢复失败"))?;
    for (owner,run) in pending{crate::execution_receipts::finish(&app.state::<codex_runtime::CodexState>().receipts_path(),&owner,&run,"interrupted")?;}
    db.execute("UPDATE tasks SET data=json_set(data,'$.status','interrupted','$.updatedAt',?,'$.error','后台意外退出；结果记录已保留，未自动重跑') WHERE json_extract(data,'$.status') IN('queued','running')",params![chrono::Utc::now().to_rfc3339()]).map_err(|_|workspace_error("AGENT_STORAGE","子任务恢复失败"))?;Ok(())
}
fn confined(root:&Path,relative:&str,write:bool)->Result<PathBuf,AppError>{
    if relative.is_empty()||relative.len()>256||relative.split('/').count()>16||relative.contains(['\\',':'])||relative.chars().any(char::is_control)||!Path::new(relative).components().all(|c|matches!(c,Component::Normal(_))){return Err(workspace_error("AGENT_FILE_SCOPE","文件路径必须属于子任务工作区"));}
    let root=root.canonicalize().map_err(|_|workspace_error("AGENT_FILE_SCOPE","子任务工作区不可用"))?;let target=root.join(relative);let mut current=root.clone();
    for part in Path::new(relative).components(){current.push(part.as_os_str());if current.exists(){let meta=fs::symlink_metadata(&current).map_err(|_|workspace_error("AGENT_FILE_SCOPE","文件不可读"))?;if meta.file_type().is_symlink(){return Err(workspace_error("AGENT_FILE_SCOPE","不读取链接文件"));}
        #[cfg(windows)]{use std::os::windows::fs::MetadataExt;if meta.file_attributes()&0x400!=0{return Err(workspace_error("AGENT_FILE_SCOPE","不读取重解析路径"));}}
        if !current.canonicalize().map_err(|_|workspace_error("AGENT_FILE_SCOPE","路径不可读"))?.starts_with(&root){return Err(workspace_error("AGENT_FILE_SCOPE","文件不属于子任务工作区"));}
    }else if write{if current!=target{fs::create_dir(&current).map_err(|_|workspace_error("AGENT_FILE_SCOPE","无法创建结果目录"))?;}}else{return Err(workspace_error("AGENT_FILE_MISSING","子任务文件不存在"));}}
    Ok(target)
}
fn files(root:&Path)->Result<Vec<Value>,AppError>{let root=root.canonicalize().map_err(|_|workspace_error("AGENT_FILE_SCOPE","子任务目录不可读"))?;let mut stack=vec![root.clone()];let mut files=Vec::new();while let Some(folder)=stack.pop(){for entry in fs::read_dir(&folder).map_err(|_|workspace_error("AGENT_FILE_SCOPE","文件列表不可读"))?{let entry=entry.map_err(|_|workspace_error("AGENT_FILE_SCOPE","文件不可读"))?;let path=entry.path();let rel=path.strip_prefix(&root).map_err(|_|workspace_error("AGENT_FILE_SCOPE","文件路径不属于子任务"))?.to_string_lossy().replace('\\',"/");if rel.split('/').count()>16{return Err(workspace_error("AGENT_FILE_LIMIT","文件目录层级过深"));}let path=confined(&root,&rel,false)?;if path.is_dir(){stack.push(path);}else{files.push(json!({"path":rel,"bytes":fs::metadata(path).map_err(|_|workspace_error("AGENT_FILE_SCOPE","文件不可读"))?.len()}));}if files.len()+stack.len()>256{return Err(workspace_error("AGENT_FILE_LIMIT","子任务文件数量超过 256"));}}}files.sort_by_key(|v|v["path"].as_str().unwrap_or("").to_owned());Ok(files)}
fn bounded_read(path:&Path,maximum:u64)->Result<Vec<u8>,AppError>{let mut bytes=Vec::new();fs::File::open(path).map_err(|_|workspace_error("AGENT_FILE_MISSING","文件不可读"))?.take(maximum+1).read_to_end(&mut bytes).map_err(|_|workspace_error("AGENT_FILE_MISSING","文件不可读"))?;if bytes.len() as u64>maximum{return Err(workspace_error("AGENT_FILE_LIMIT","文件超过读取限制"));}Ok(bytes)}
fn read_text(root:&Path,path:&str)->Result<Value,AppError>{let file=confined(root,path,false)?;let bytes=bounded_read(&file,1024*1024)?;let text=String::from_utf8(bytes).map_err(|_|workspace_error("AGENT_FILE_FORMAT","文件不是可读取的 UTF-8 文本"))?;Ok(json!({"path":path,"text":text}))}
fn execute_file(app:&AppHandle,owner:&str,record:&Record,tool:&str,a:&Value)->Result<Value,AppError>{
    let(current,settings)=identity(app,&record.conversation_id)?;let(_,parent)=row(&db(app)?,owner,&record.id)?;
    if current!=owner||settings.directory!=parent{return Err(workspace_error("AGENT_CONTEXT_CHANGED","所属账号或工作区已变化"));}
    let root=task_root(app,owner,&record.id)?.join("workspace");
    match tool{
        "worker_files_list"=>Ok(json!({"files":files(&root)?,"readOnly":record.read_only})),
        "worker_file_read"=>read_text(&root,a["path"].as_str().unwrap_or("")),
        "worker_file_write"=>{if record.read_only||settings.permission!=WorkspacePermission::FullAccess{return Err(workspace_error("AGENT_READ_ONLY","此子任务仅可读取文件"));}let text=a["text"].as_str().ok_or_else(||workspace_error("AGENT_FILE_FORMAT","结果必须是文本"))?;if text.len()>1024*1024{return Err(workspace_error("AGENT_FILE_LIMIT","结果文件超过 1 MiB"));}let path=confined(&root,a["path"].as_str().unwrap_or(""),true)?;if !path.exists()&&files(&root)?.len()>=256{return Err(workspace_error("AGENT_FILE_LIMIT","子任务文件数量超过 256"));}fs::write(path,text).map_err(|_|workspace_error("AGENT_FILE_WRITE","结果文件保存失败"))?;Ok(json!({"path":a["path"],"bytes":text.len(),"saved":true}))},
        _=>Err(workspace_error("AGENT_TOOL_NOT_ALLOWED","子任务没有此执行工具")),
    }
}
pub(crate) fn spawn(app:&AppHandle,conversation:String,key:String,draft:Draft)->Result<Record,AppError>{
    if draft.name.trim().is_empty()||draft.name.len()>160||draft.prompt.trim().is_empty()||draft.prompt.len()>50_000||draft.input_files.len()>16||key.is_empty()||key.len()>256{return Err(workspace_error("AGENT_INPUT","子任务名称、指令或输入无效"));}
    let(owner,settings)=identity(app,&conversation)?;if !draft.read_only&&settings.permission!=WorkspacePermission::FullAccess{return Err(workspace_error("AGENT_PERMISSION","写入子任务需要当前工作区完全访问权限"));}
    let fingerprint=format!("{:x}",Sha256::digest(serde_json::to_vec(&draft).unwrap()));
    let _gate=GATE.lock().unwrap();let db=db(app)?;
    if let Some((id,old,parent))=db.query_row("SELECT id,fingerprint,parent_directory FROM tasks WHERE owner=? AND conversation=? AND execution_key=?",params![owner,conversation,key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).optional().map_err(|_|workspace_error("AGENT_STORAGE","子任务记录不可读"))?{if old!=fingerprint||parent!=settings.directory{return Err(workspace_error("AGENT_CONFLICT","同一执行编号已用于不同子任务"));}return Ok(row(&db,&owner,&id)?.0);}
    if active_count()>=3{return Err(workspace_error("AGENT_CAPACITY","当前已有三个子任务运行，请等待或取消其中一个"));}
    let id=Uuid::new_v4().to_string();let root=task_root(app,&owner,&id)?;let workspace=root.join("workspace");fs::create_dir_all(&workspace).map_err(|_|workspace_error("AGENT_STORAGE","子任务工作区创建失败"))?;
    let mut total=0u64;for name in &draft.input_files{let source=confined(Path::new(&settings.directory),name,false)?;let bytes=bounded_read(&source,32*1024*1024-total)?;total+=bytes.len() as u64;let target=confined(&workspace,name,true)?;fs::write(target,bytes).map_err(|_|workspace_error("AGENT_FILE_WRITE","输入快照保存失败"))?;}
    crate::workspace_set(app.state(),app.state(),id.clone(),workspace.to_string_lossy().into_owned(),if draft.read_only{WorkspacePermission::ConfirmEach}else{WorkspacePermission::FullAccess})?;
    let model_route=crate::ai_channels::inherit(app,&owner,&conversation).map_err(|e|workspace_error(e.code,e.message))?;
    let now=chrono::Utc::now().to_rfc3339();let record=Record{id:id.clone(),conversation_id:conversation,name:draft.name,read_only:draft.read_only,status:"queued".into(),created_at:now.clone(),updated_at:now,run_id:Uuid::new_v4().to_string(),thread_id:None,result:None,error:None,cancel_requested:false,model_route:Some(model_route)};
    db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)",params![owner,id,record.conversation_id,settings.directory,key,fingerprint,serde_json::to_string(&record).unwrap()]).map_err(|_|workspace_error("AGENT_STORAGE","子任务保存失败"))?;
    let runtime=Arc::new(codex_runtime::CodexState::new_isolated(root.join("engine"),app.state::<codex_runtime::CodexState>().receipts_path(),owner.clone()));let cancel=Arc::new(AtomicBool::new(false));
    active().lock().unwrap().insert(id.clone(),Active{owner:owner.clone(),runtime:runtime.clone(),cancel:cancel.clone(),run_id:record.run_id.clone()});
    let app=app.clone();let saved=record.clone();let prompt=draft.prompt;
    tauri::async_runtime::spawn(async move{
        let sink_app=app.clone();let sink_owner=owner.clone();let sink_record=saved.clone();let sink_runtime=runtime.clone();let sink_cancel=cancel.clone();
        let sink:codex_runtime::EventSink=Arc::new(move|value|{
            event(&sink_app,&sink_record.id,&value).map_err(|e|services::ServiceError{code:e.code,message:e.message})?;
            if value["type"]=="thread"{let _=update(&sink_app,&sink_owner,&sink_record.id,|r|r.thread_id=value["threadId"].as_str().map(str::to_owned));}
            if value["type"]=="tool"{let result=if sink_cancel.load(Ordering::Acquire){json!({"error":"AGENT_CANCELLED"})}else{execute_file(&sink_app,&sink_owner,&sink_record,value["tool"].as_str().unwrap_or(""),&value["arguments"]).unwrap_or_else(|e|json!({"error":{"code":e.code,"message":e.message}}))};event(&sink_app,&sink_record.id,&json!({"type":"toolResult","requestId":value["requestId"],"tool":value["tool"],"error":result["error"],"saved":result["saved"],"path":result["path"],"bytes":result["bytes"]})).map_err(|e|services::ServiceError{code:e.code,message:e.message})?;codex_runtime::send_command(&sink_runtime,&sink_owner,&sink_record.run_id,json!({"type":"response","requestId":value["requestId"],"value":{"result":result}}))?;}
            if value["type"]=="request"{codex_runtime::send_command(&sink_runtime,&sink_owner,&sink_record.run_id,json!({"type":"response","requestId":value["requestId"],"error":"AGENT_TOOL_NOT_ALLOWED"}))?;}
            Ok(())
        });
        let result=if cancel.load(Ordering::Acquire){Ok(json!({"status":"interrupted"}))}else{
            let _=update(&app,&owner,&saved.id,|r|r.status="running".into());
            let turn=codex_runtime::run_turn(app.clone(),&runtime,saved.run_id.clone(),saved.id.clone(),prompt,json!([]),sink,None,true,None,saved.model_route.clone());
            tokio::pin!(turn);
            let mut timer=tokio::time::interval(std::time::Duration::from_millis(100));
            loop{tokio::select!{result=&mut turn=>break result,_=timer.tick()=>{if cancel.load(Ordering::Acquire){let _=codex_runtime::send_command(&runtime,&owner,&saved.run_id,json!({"type":"interrupt"}));}}}}
        };
        let terminal=if cancel.load(Ordering::Acquire){"cancelled"}else{match &result{Ok(value)if value["status"]=="completed"=>"completed",Ok(_)=>"interrupted",Err(_)=>"failed"}};
        let _=crate::execution_receipts::finish(&runtime.receipts_path(),&owner,&saved.run_id,terminal);
        let _=update(&app,&owner,&saved.id,|r|{r.status=terminal.into();match result{Ok(ref value)=>{r.result=value["text"].as_str().map(|s|s.chars().take(32_000).collect());},Err(ref e)=>{r.error=Some(e.message.clone());}}});
        runtime.shutdown();active().lock().unwrap().remove(&saved.id);
    });
    Ok(record)
}
pub(crate) fn list(app:&AppHandle,conversation:String)->Result<Value,AppError>{let(owner,settings)=identity(app,&conversation)?;let db=db(app)?;let mut statement=db.prepare("SELECT data FROM tasks WHERE owner=? AND conversation=? AND parent_directory=? ORDER BY rowid DESC LIMIT 50").map_err(|_|workspace_error("AGENT_STORAGE","子任务列表不可读"))?;let rows=statement.query_map(params![owner,conversation,settings.directory],|r|r.get::<_,String>(0)).map_err(|_|workspace_error("AGENT_STORAGE","子任务列表不可读"))?;let records:Vec<Value>=rows.filter_map(Result::ok).filter_map(|s|serde_json::from_str(&s).ok()).collect();Ok(json!({"tasks":records,"maximumConcurrent":3,"background":true}))}
pub(crate) fn get(app:&AppHandle,conversation:String,id:String)->Result<Value,AppError>{let(owner,record)=authorized(app,&conversation,&id)?;let root=task_root(app,&owner,&id)?.join("workspace");let db=db(app)?;let mut statement=db.prepare("SELECT data FROM events WHERE id=? ORDER BY sequence DESC LIMIT 100").map_err(|_|workspace_error("AGENT_STORAGE","子任务事件不可读"))?;let rows=statement.query_map(params![id],|r|r.get::<_,String>(0)).map_err(|_|workspace_error("AGENT_STORAGE","子任务事件不可读"))?;let mut events:Vec<Value>=rows.filter_map(Result::ok).filter_map(|s|serde_json::from_str(&s).ok()).collect();events.reverse();Ok(json!({"task":record,"files":files(&root)?,"events":events,"execution":"isolated-workspace-file-tools"}))}
pub(crate) fn cancel(app:&AppHandle,conversation:String,id:String)->Result<Record,AppError>{let(owner,record)=authorized(app,&conversation,&id)?;if !matches!(record.status.as_str(),"queued"|"running"){return Ok(record);}if let Some(active)=active().lock().unwrap().get(&id){if active.owner!=owner{return Err(workspace_error("AGENT_NOT_FOUND","子任务不存在"));}active.cancel.store(true,Ordering::Release);let _=codex_runtime::send_command(&active.runtime,&owner,&active.run_id,json!({"type":"interrupt"}));}update(app,&owner,&id,|r|r.cancel_requested=true)}
pub(crate) fn read_file(app:&AppHandle,conversation:String,id:String,path:String)->Result<Value,AppError>{let(owner,_)=authorized(app,&conversation,&id)?;read_text(&task_root(app,&owner,&id)?.join("workspace"),&path)}

#[tauri::command]pub fn agent_tasks_spawn(app:AppHandle,conversation_id:String,idempotency_key:String,draft:Draft)->Result<Record,AppError>{spawn(&app,conversation_id,idempotency_key,draft)}
#[tauri::command]pub fn agent_tasks_list(app:AppHandle,conversation_id:String)->Result<Value,AppError>{list(&app,conversation_id)}
#[tauri::command]pub fn agent_tasks_get(app:AppHandle,conversation_id:String,task_id:String)->Result<Value,AppError>{get(&app,conversation_id,task_id)}
#[tauri::command]pub fn agent_tasks_read_file(app:AppHandle,conversation_id:String,task_id:String,path:String)->Result<Value,AppError>{read_file(&app,conversation_id,task_id,path)}
#[tauri::command]pub fn agent_tasks_cancel(app:AppHandle,conversation_id:String,task_id:String)->Result<Record,AppError>{cancel(&app,conversation_id,task_id)}

#[cfg(test)]mod tests{use super::*;#[test]fn file_scope_rejects_traversal_absolute_and_oversize(){let root=tempfile::tempdir().unwrap();for value in ["../outside","/absolute","C:/file","a\\b","."]{assert!(confined(root.path(),value,true).is_err());}let file=confined(root.path(),"a/result.txt",true).unwrap();fs::write(&file,"结果").unwrap();assert_eq!(read_text(root.path(),"a/result.txt").unwrap()["text"],"结果");assert_eq!(files(root.path()).unwrap().len(),1);assert!(bounded_read(&file,1).is_err());}}

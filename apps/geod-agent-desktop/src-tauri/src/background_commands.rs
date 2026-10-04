//! Durable, conversation-owned standalone Codex commands in the companion.
use crate::{read_workspace, services, workspace_error, AppError, AppState};
use base64::Engine;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, io::{BufRead, BufReader, Write}, path::{Component, Path, PathBuf}, process::{ChildStdin, Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex, OnceLock}, time::Duration};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const CAP: usize = 262144;
fn execution_mode() -> &'static str { if cfg!(windows) { "windowsUser" } else { "workspaceSandbox" } }
static ENGINE: OnceLock<CommandEngine> = OnceLock::new();
static INIT: Mutex<()> = Mutex::new(());
static START: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Draft { title: String, command: Vec<String>, relative_cwd: Option<String>, timeout_ms: Option<u32> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Record {
    pub id: String, pub conversation_id: String, pub title: String, pub command: Vec<String>,
    pub workspace: String, pub cwd: String, pub timeout_ms: Option<u32>, pub plan_hash: String,
    #[serde(default)] pub execution_mode: String,
    pub status: String, pub created_at: String, pub started_at: Option<String>, pub finished_at: Option<String>,
    pub exit_code: Option<i64>, pub output_truncated: bool, pub error: Option<Value>,
    #[serde(default, skip_serializing_if="Option::is_none")] pub stdout: Option<String>,
    #[serde(default, skip_serializing_if="Option::is_none")] pub stderr: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Overview { pub commands: Vec<Record>, pub total: u64, pub next_offset: Option<u32> }
struct Control { input: Mutex<Option<ChildStdin>>, cancelled: AtomicBool, replies: Mutex<HashMap<String,mpsc::Sender<bool>>> }
struct CommandEngine { db: PathBuf, root: PathBuf, workers: Mutex<HashMap<String,Arc<Control>>> }
fn storage() -> AppError { workspace_error("COMMAND_STORAGE_FAILED", "后台命令记录无法读取或保存") }
fn connection(engine: &CommandEngine) -> Result<Connection,AppError> {
    let db=Connection::open(&engine.db).map_err(|_|storage())?;
    db.busy_timeout(Duration::from_secs(10)).map_err(|_|storage())?; Ok(db)
}
pub(crate) fn initialize(app:&AppHandle)->Result<(),AppError>{ engine(app).map(|_|()) }
fn engine(app:&AppHandle)->Result<&'static CommandEngine,AppError>{
    if let Some(engine)=ENGINE.get(){return Ok(engine);}
    let _gate=INIT.lock().map_err(|_|storage())?;
    if let Some(engine)=ENGINE.get(){return Ok(engine);}
    let root=app.path().app_data_dir().map_err(|_|storage())?.join("background-commands");
    fs::create_dir_all(&root).map_err(|_|storage())?;
    let value=CommandEngine{db:app.state::<AppState>().db_path.clone(),root,workers:Mutex::new(HashMap::new())};
    let mut db=connection(&value)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS background_commands(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,conversation_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,record TEXT NOT NULL,stdout BLOB NOT NULL DEFAULT X'',stderr BLOB NOT NULL DEFAULT X'',UNIQUE(user_id,conversation_id,idempotency_key));").map_err(|_|storage())?;
    // Only the companion initializes this table. Its previous process group is gone.
    let previous:Vec<(String,String)>=db.prepare("SELECT id,record FROM background_commands").map_err(|_|storage())?
        .query_map([],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|_|storage())?.collect::<Result<_,_>>().map_err(|_|storage())?;
    let transaction=db.transaction().map_err(|_|storage())?;
    for (id,text) in previous {
        let mut record:Record=serde_json::from_str(&text).map_err(|_|storage())?;
        if ["queued","running","stopping"].contains(&record.status.as_str()) {
            record.status="interrupted".into();record.finished_at=Some(Utc::now().to_rfc3339());
            record.error=Some(json!({"code":"COMMAND_INTERRUPTED","message":"后台已退出，命令中断。请核对已有文件后重新运行。"}));
            transaction.execute("UPDATE background_commands SET record=? WHERE id=?",params![serde_json::to_string(&record).map_err(|_|storage())?,id]).map_err(|_|storage())?;
        }
    }
    transaction.commit().map_err(|_|storage())?;
    ENGINE.set(value).map_err(|_|storage())?;Ok(ENGINE.get().unwrap())
}
pub(crate) fn active_count()->usize{ENGINE.get().map(|e|e.workers.lock().unwrap().len()).unwrap_or(0)}
fn owner(app:&AppHandle)->Result<String,AppError>{services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|workspace_error(e.code,e.message))}
fn assert_owner(app: &AppHandle, user: &str) -> Result<(), AppError> {
    if owner(app)? != user { return Err(workspace_error("ACCOUNT_CHANGED", "账号已切换，请在当前会话重新操作")); }
    Ok(())
}
fn read(engine:&CommandEngine,user:&str,conversation:&str,id:&str,output:bool)->Result<Record,AppError>{
    let db=connection(engine)?;
    let row:Option<(String,Vec<u8>,Vec<u8>)>=db.query_row("SELECT record,stdout,stderr FROM background_commands WHERE id=? AND user_id=? AND conversation_id=?",params![id,user,conversation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|storage())?;
    let (text,stdout,stderr)=row.ok_or_else(||workspace_error("COMMAND_NOT_FOUND","此会话中不存在该后台命令"))?;
    let mut record:Record=serde_json::from_str(&text).map_err(|_|storage())?;
    if output {record.stdout=Some(decode_output(&stdout));record.stderr=Some(decode_output(&stderr));}
    Ok(record)
}
fn decode_output(bytes: &[u8]) -> String {
    // A bounded stream can end halfway through a UTF-8 character. Preserve
    // complete characters and avoid adding a replacement glyph at the cap.
    let complete = match std::str::from_utf8(bytes) {
        Err(error) if error.error_len().is_none() => &bytes[..error.valid_up_to()],
        _ => bytes,
    };
    String::from_utf8_lossy(complete).into_owned()
}
fn update(engine:&CommandEngine,user:&str,conversation:&str,id:&str,action:impl FnOnce(&mut Record))->Result<Record,AppError>{
    let mut db=connection(engine)?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_|storage())?;
    let text:String=tx.query_row("SELECT record FROM background_commands WHERE id=? AND user_id=? AND conversation_id=?",params![id,user,conversation],|r|r.get(0)).map_err(|_|workspace_error("COMMAND_NOT_FOUND","此会话中不存在该后台命令"))?;
    let mut record:Record=serde_json::from_str(&text).map_err(|_|storage())?;action(&mut record);
    tx.execute("UPDATE background_commands SET record=? WHERE id=?",params![serde_json::to_string(&record).map_err(|_|storage())?,id]).map_err(|_|storage())?;tx.commit().map_err(|_|storage())?;Ok(record)
}
fn output(engine:&CommandEngine,user:&str,conversation:&str,id:&str,stream:&str,bytes:&[u8],cap:bool)->Result<(),AppError>{
    let mut db=connection(engine)?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_|storage())?;
    let row:(String,Vec<u8>,Vec<u8>)=tx.query_row("SELECT record,stdout,stderr FROM background_commands WHERE id=? AND user_id=? AND conversation_id=?",params![id,user,conversation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|_|storage())?;
    let mut record:Record=serde_json::from_str(&row.0).map_err(|_|storage())?;let mut stdout=row.1;let mut stderr=row.2;
    let selected=if stream=="stdout"{&mut stdout}else if stream=="stderr"{&mut stderr}else{return Err(storage());};
    let remaining=CAP.saturating_sub(selected.len());selected.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
    record.output_truncated|=cap||bytes.len()>remaining;
    tx.execute("UPDATE background_commands SET record=?,stdout=?,stderr=? WHERE id=?",params![serde_json::to_string(&record).map_err(|_|storage())?,stdout,stderr,id]).map_err(|_|storage())?;
    tx.commit().map_err(|_|storage())?;Ok(())
}
fn send(control:&Control,value:&Value)->Result<(),AppError>{
    let mut input=control.input.lock().map_err(|_|storage())?;
    let input=input.as_mut().ok_or_else(||workspace_error("COMMAND_STARTING","命令正在启动，请稍后重试"))?;
    writeln!(input,"{}",value).and_then(|_|input.flush()).map_err(|_|workspace_error("COMMAND_ENGINE_EXITED","命令进程已退出，请刷新状态"))
}
pub(crate) fn prepare(app:&AppHandle,conversation:String,key:String,draft:Draft)->Result<Value,AppError>{
    if draft.title.trim().is_empty()||draft.title.chars().count()>120||draft.command.is_empty()||draft.command[0].trim().is_empty()||draft.command.len()>256||draft.command.iter().any(|v|v.contains('\0'))||draft.command.iter().map(|v|v.encode_utf16().count()+3).sum::<usize>()>30000||draft.timeout_ms==Some(0)||key.is_empty()||key.len()>256||conversation.is_empty()||conversation.len()>128 {
        return Err(workspace_error("COMMAND_INPUT_INVALID","请提供命令名称、有效的程序与参数数组；命令长度不能超过 Windows 执行上限"));
    }
    let user=owner(app)?;let engine=engine(app)?;
    let workspace=read_workspace(app,&app.state::<AppState>(),&app.state::<services::ServiceState>(),&conversation)?;
    let root=fs::canonicalize(workspace.directory).map_err(|_|workspace_error("WORKSPACE_READ_FAILED","工作区不存在"))?;
    let relative=draft.relative_cwd.as_deref().filter(|v|!v.is_empty()).unwrap_or(".");
    if Path::new(relative).components().any(|v|!matches!(v,Component::Normal(_)|Component::CurDir)){return Err(workspace_error("WORKSPACE_DENIED","命令工作目录需要位于当前工作区"));}
    let cwd=fs::canonicalize(root.join(relative)).map_err(|_|workspace_error("WORKSPACE_READ_FAILED","命令工作目录不存在"))?;
    if !cwd.is_dir()||!cwd.starts_with(&root){return Err(workspace_error("WORKSPACE_DENIED","命令工作目录超出当前工作区"));}
    assert_owner(app, &user)?;
    let hash=format!("{:x}",Sha256::digest(json!({"title":draft.title,"command":draft.command,"workspace":root,"cwd":cwd,"timeoutMs":draft.timeout_ms,"executionMode":execution_mode()}).to_string().as_bytes()));
    let _gate=START.lock().map_err(|_|storage())?;let db=connection(engine)?;
    let old:Option<String>=db.query_row("SELECT record FROM background_commands WHERE user_id=? AND conversation_id=? AND idempotency_key=?",params![user,conversation,key],|r|r.get(0)).optional().map_err(|_|storage())?;
    let record=if let Some(text)=old {
        let old:Record=serde_json::from_str(&text).map_err(|_|storage())?;
        if old.plan_hash!=hash{return Err(workspace_error("COMMAND_IDEMPOTENCY_CONFLICT","同一请求已保存不同的命令，请重新准备"));}old
    }else{
        let record=Record{id:Uuid::new_v4().to_string(),conversation_id:conversation.clone(),title:draft.title,command:draft.command,workspace:root.to_string_lossy().into_owned(),cwd:cwd.to_string_lossy().into_owned(),timeout_ms:draft.timeout_ms,plan_hash:hash,execution_mode:execution_mode().into(),status:"planned".into(),created_at:Utc::now().to_rfc3339(),started_at:None,finished_at:None,exit_code:None,output_truncated:false,error:None,stdout:None,stderr:None};
        db.execute("INSERT INTO background_commands(id,user_id,conversation_id,idempotency_key,record) VALUES(?,?,?,?,?)",params![record.id,user,conversation,key,serde_json::to_string(&record).map_err(|_|storage())?]).map_err(|_|storage())?;record
    };
    Ok(json!({"command":record,"permission":workspace.permission,"confirmationRequired":workspace.permission!=crate::WorkspacePermission::FullAccess,"windowRequired":false}))
}
pub(crate) fn list(app:&AppHandle,conversation:String,offset:Option<u32>)->Result<Overview,AppError>{
    let user=owner(app)?;let engine=engine(app)?;let db=connection(engine)?;let offset=offset.unwrap_or(0);
    let total:u64=db.query_row("SELECT count(*) FROM background_commands WHERE user_id=? AND conversation_id=?",params![user,conversation],|r|r.get(0)).map_err(|_|storage())?;
    let rows:Vec<String>=db.prepare("SELECT record FROM background_commands WHERE user_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT 50 OFFSET ?").map_err(|_|storage())?
        .query_map(params![user,conversation,offset],|r|r.get(0)).map_err(|_|storage())?.collect::<Result<_,_>>().map_err(|_|storage())?;
    let commands=rows.iter().map(|v|serde_json::from_str(v).map_err(|_|storage())).collect::<Result<Vec<_>,_>>()?;
    let next=offset as u64+commands.len() as u64;
    Ok(Overview{commands,total,next_offset:(next<total).then_some(next as u32)})
}
pub(crate) fn get(app:&AppHandle,conversation:String,id:String)->Result<Record,AppError>{read(engine(app)?,&owner(app)?,&conversation,&id,true)}
pub(crate) fn start(app:&AppHandle,conversation:String,id:String,hash:String,confirmed:bool)->Result<Record,AppError>{
    let user=owner(app)?;let engine=engine(app)?;let _gate=START.lock().map_err(|_|storage())?;
    let record=read(engine,&user,&conversation,&id,false)?;
    if record.plan_hash!=hash{return Err(workspace_error("COMMAND_PLAN_CHANGED","命令参数与确认记录不一致，请重新准备"));}
    if record.status!="planned"{return Ok(record);}
    if record.execution_mode != execution_mode() { return Err(workspace_error("COMMAND_PLAN_CHANGED", "命令执行方式发生变化，请重新准备命令")); }
    if crate::background_runtime::STOPPING.load(Ordering::Acquire){return Err(workspace_error("BACKGROUND_STOPPING","后台正在退出"));}
    let settings=read_workspace(app,&app.state::<AppState>(),&app.state::<services::ServiceState>(),&conversation)?;
    if settings.permission!=crate::WorkspacePermission::FullAccess&&!confirmed{return Err(workspace_error("USER_CONFIRMATION_REQUIRED","请在右侧后台命令中确认这条命令"));}
    let root=fs::canonicalize(settings.directory).map_err(|_|workspace_error("WORKSPACE_READ_FAILED","工作区不存在"))?;
    let cwd=fs::canonicalize(&record.cwd).map_err(|_|workspace_error("WORKSPACE_READ_FAILED","命令工作目录不存在"))?;
    if root!=PathBuf::from(&record.workspace)||cwd!=PathBuf::from(&record.cwd)||!cwd.starts_with(&root){return Err(workspace_error("COMMAND_WORKSPACE_CHANGED","工作区位置发生变化，请重新准备命令"));}
    assert_owner(app, &user)?;
    let control=Arc::new(Control{input:Mutex::new(None),cancelled:AtomicBool::new(false),replies:Mutex::new(HashMap::new())});
    let record=update(engine,&user,&conversation,&id,|r|{r.status="queued".into();r.started_at=Some(Utc::now().to_rfc3339());})?;
    engine.workers.lock().unwrap().insert(id.clone(),control.clone());
    let app=app.clone();let running=record.clone();
    std::thread::spawn(move||{
        let result=run(&app,engine,&user,&conversation,&running,&control);
        let cancelled=control.cancelled.load(Ordering::Acquire);
        let _=update(engine,&user,&conversation,&id,|r|{
            r.finished_at=Some(Utc::now().to_rfc3339());
            match result {Ok(value)=>{r.exit_code=value["result"]["exitCode"].as_i64();r.error=value.get("error").cloned();r.status=if cancelled||value["cancelled"]==true{"cancelled"}else if r.error.is_none()&&r.exit_code==Some(0){"completed"}else{"failed"}.into();},Err(error)=>{r.status=if cancelled{"cancelled"}else{"failed"}.into();r.error=Some(json!(error));}}
        });
        for (_,reply) in control.replies.lock().unwrap().drain(){let _=reply.send(false);}
        engine.workers.lock().unwrap().remove(&id);
    });Ok(record)
}
fn run(app:&AppHandle,engine:&CommandEngine,user:&str,conversation:&str,record:&Record,control:&Control)->Result<Value,AppError>{
    if control.cancelled.load(Ordering::Acquire){return Ok(json!({"cancelled":true}));}
    let (codex,node)=crate::codex_runtime::command_dependencies(app).map_err(|e|workspace_error(e.code,e.message))?;
    // Globally unique command IDs are already owner-scoped by the ledger. Avoid
    // another 72-character account directory: packaged Windows roaming paths
    // plus Codex's SQLite filename can exceed its native path limit.
    let home=engine.root.join(&record.id);
    fs::create_dir_all(&home).map_err(|_|storage())?;let script=home.join("managed-command-host.mjs");
    let source=if cfg!(debug_assertions){fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("managed-command-host.mjs")).unwrap_or_else(|_|include_str!("../managed-command-host.mjs").into())}else{include_str!("../managed-command-host.mjs").into()};
    fs::write(&script,source).map_err(|_|storage())?;
    let mut command=Command::new(node);command.arg(script).current_dir(&record.cwd).env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    for key in ["SystemRoot","WINDIR","TEMP","TMP","LOCALAPPDATA","APPDATA","USERPROFILE","USERNAME","COMSPEC","PATH","PATHEXT","PROGRAMDATA","PROGRAMFILES","PROGRAMFILES(X86)","PROCESSOR_ARCHITECTURE","NUMBER_OF_PROCESSORS","OS"]{if let Some(value)=std::env::var_os(key){command.env(key,value);}}
    #[cfg(windows)]{use std::os::windows::process::CommandExt;command.creation_flags(0x0800_0000);}
    let mut child=command.spawn().map_err(|_|workspace_error("COMMAND_RUNTIME_MISSING","后台命令需要配套的 Node 和 Codex 运行环境"))?;
    #[cfg(windows)]let _tree={use std::os::windows::io::AsRawHandle;match crate::codex_runtime::ProcessTree::attach_handle(child.as_raw_handle()){Ok(tree)=>tree,Err(error)=>{let _=child.kill();let _=child.wait();return Err(workspace_error(error.code,error.message));}}};
    let stdout=child.stdout.take().unwrap();*control.input.lock().unwrap()=child.stdin.take();
    let setup=send(control,&json!({"type":"start","id":record.id,"command":record.command,"cwd":record.cwd,"workspace":record.workspace,"timeoutMs":record.timeout_ms,"codex":codex,"home":home}));
    if setup.is_err(){let _=child.kill();let _=child.wait();return Err(setup.unwrap_err());}
    if control.cancelled.load(Ordering::Acquire){let _=send(control,&json!({"type":"stop"}));}
    let mut result=Err(workspace_error("COMMAND_ENGINE_EXITED","后台命令连接已中断，请核对文件和执行记录"));
    for line in BufReader::new(stdout).lines(){
        let Ok(line)=line else{break;};if line.len()>2*CAP{break;}
        let Ok(value)=serde_json::from_str::<Value>(&line)else{continue;};
        match value["type"].as_str(){
            Some("started")=>{let _=update(engine,user,conversation,&record.id,|r|{if r.status=="queued"{r.status="running".into();}});},
            Some("output")=>{
                if let Some(encoded)=value["deltaBase64"].as_str(){if let Ok(bytes)=base64::engine::general_purpose::STANDARD.decode(encoded){if output(engine,user,conversation,&record.id,value["stream"].as_str().unwrap_or(""),&bytes,value["capReached"]==true).is_err(){result=Err(storage());break;}}}
            },
            Some("writeResult")=>{if let Some(id)=value["requestId"].as_str(){if let Some(reply)=control.replies.lock().unwrap().remove(id){let _=reply.send(value["ok"]==true);}}},
            Some("done")=>{result=Ok(value);break;},_=>{}
        }
    }
    control.input.lock().unwrap().take();
    for _ in 0..20 {if child.try_wait().ok().flatten().is_some(){break;}std::thread::sleep(Duration::from_millis(50));}
    let _=child.kill();let _=child.wait();result
}
pub(crate) fn stop(app:&AppHandle,conversation:String,id:String)->Result<Record,AppError>{
    let user=owner(app)?;let engine=engine(app)?;let _gate=START.lock().map_err(|_|storage())?;
    let record=read(engine,&user,&conversation,&id,false)?;
    if record.status=="planned"{return update(engine,&user,&conversation,&id,|r|{r.status="cancelled".into();r.finished_at=Some(Utc::now().to_rfc3339());});}
    let control=engine.workers.lock().unwrap().get(&id).cloned();
    if let Some(control)=control{control.cancelled.store(true,Ordering::Release);let record=update(engine,&user,&conversation,&id,|r|{if ["queued","running"].contains(&r.status.as_str()){r.status="stopping".into();}})?;let _=send(&control,&json!({"type":"stop"}));Ok(record)}else{Ok(record)}
}
pub(crate) fn write(app:&AppHandle,conversation:String,id:String,input:Option<String>,close:bool)->Result<Value,AppError>{
    let user=owner(app)?;let engine=engine(app)?;let record=read(engine,&user,&conversation,&id,false)?;
    if record.status!="running"{return Err(workspace_error("COMMAND_NOT_RUNNING","命令尚未运行或已结束，请刷新状态"));}
    if input.as_ref().is_some_and(|v|v.len()>65536){return Err(workspace_error("COMMAND_INPUT_INVALID","单次命令输入不能超过 64 KiB"));}
    let control=engine.workers.lock().unwrap().get(&id).cloned().ok_or_else(||workspace_error("COMMAND_NOT_RUNNING","命令进程已结束"))?;
    let request_id=Uuid::new_v4().to_string();let (tx,rx)=mpsc::channel();control.replies.lock().unwrap().insert(request_id.clone(),tx);
    if let Err(error)=send(&control,&json!({"type":"write","requestId":request_id,"deltaBase64":input.map(|v|base64::engine::general_purpose::STANDARD.encode(v.as_bytes())),"closeStdin":close})){control.replies.lock().unwrap().remove(&request_id);return Err(error);}
    let accepted=rx.recv_timeout(Duration::from_secs(8)).unwrap_or(false);control.replies.lock().unwrap().remove(&request_id);
    if !accepted{return Err(workspace_error("COMMAND_INPUT_REJECTED","命令没有接收这次输入，请检查进程状态或输入通道"));}
    Ok(json!({"commandId":id,"accepted":true,"stdinClosed":close}))
}

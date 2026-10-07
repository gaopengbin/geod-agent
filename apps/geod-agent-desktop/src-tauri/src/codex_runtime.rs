use crate::{read_workspace, services, AppState};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs, io::{BufRead, BufReader, Write}, path::PathBuf, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, mpsc, atomic::{AtomicBool, Ordering}}};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use services::ServiceError;

type Input = Arc<Mutex<ChildStdin>>;
pub(crate) type EventSink = Arc<dyn Fn(Value) -> Result<(), ServiceError> + Send + Sync>;
struct ActiveRun { owner: String, input: Input, cancelled: Arc<AtomicBool> }
struct HostProcess {
    owner: String,
    child: Child, input: Input, route: Arc<Mutex<Option<mpsc::Sender<Value>>>>,
    alive: Arc<AtomicBool>, source_hash: String,
    #[cfg(windows)] _tree: ProcessTree,
}
impl Drop for HostProcess { fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); } }
pub struct CodexState { root: PathBuf, receipt_path:PathBuf, isolated:bool, expected_owner:Option<String>, active: Arc<Mutex<HashMap<String, ActiveRun>>>, hosts: Arc<Mutex<HashMap<String, HostProcess>>>, leases: Arc<Mutex<HashSet<String>>>,maintenance:Arc<AtomicBool> }
impl CodexState {
    pub fn new(root: PathBuf) -> Self { Self { receipt_path:root.join("execution-receipts.sqlite"),root,isolated:false,expected_owner:None, active: Arc::new(Mutex::new(HashMap::new())), hosts: Arc::new(Mutex::new(HashMap::new())), leases: Arc::new(Mutex::new(HashSet::new())),maintenance:Arc::new(AtomicBool::new(false)) } }
    pub(crate) fn new_isolated(root:PathBuf,receipt_path:PathBuf,owner:String)->Self{let mut state=Self::new(root);state.isolated=true;state.receipt_path=receipt_path;state.expected_owner=Some(owner);state}
    pub(crate) fn shutdown(&self) { self.hosts.lock().unwrap().clear(); }
    pub(crate) fn receipts_path(&self)->PathBuf { self.receipt_path.clone() }
    pub(crate) fn begin_maintenance(&self)->Result<MaintenanceGuard,ServiceError>{
        let leases=self.leases.lock().unwrap();
        if !leases.is_empty()||self.maintenance.swap(true,Ordering::AcqRel){return Err(error("CODEX_BUSY","还有会话正在执行，暂不能更新。"));}
        Ok(MaintenanceGuard(self.maintenance.clone()))
    }
}
pub(crate) struct MaintenanceGuard(Arc<AtomicBool>);
impl Drop for MaintenanceGuard{fn drop(&mut self){self.0.store(false,Ordering::Release);}}
struct TurnGuard { leases:Arc<Mutex<HashSet<String>>>,key:String }
impl Drop for TurnGuard { fn drop(&mut self) { self.leases.lock().unwrap().remove(&self.key); } }
fn conversation_home(account_root:&PathBuf,thread_key:&str)->PathBuf {
    account_root.join(format!("conversation-{}",&format!("{:x}",Sha256::digest(thread_key.as_bytes()))[..16]))
}
fn find_rollout(root:&PathBuf,thread_id:&str)->Option<PathBuf> {
    for entry in fs::read_dir(root).ok()?.filter_map(Result::ok) {
        let path=entry.path();let Ok(kind)=entry.file_type()else{continue;};
        if kind.is_symlink(){continue;}
        if kind.is_dir(){if let Some(found)=find_rollout(&path,thread_id){return Some(found);}}
        else if path.extension().is_some_and(|ext|ext=="jsonl")&&entry.file_name().to_string_lossy().contains(thread_id){return Some(path);}
    }
    None
}
fn saved_rollout(account_root:&PathBuf,path:&std::path::Path,thread_id:&str)->Option<PathBuf>{
    if path.extension().is_none_or(|extension|extension!="jsonl")||!path.file_name()?.to_string_lossy().contains(thread_id){return None;}
    // Packaged Windows launchers can redirect the roaming directory through a
    // junction. Compare the physical owner directory, not its two spellings.
    let root=fs::canonicalize(account_root).ok()?;
    let actual=fs::canonicalize(path).ok()?;
    (actual.starts_with(root)&&actual.is_file()).then_some(actual)
}
fn thread_record(account_root:&PathBuf,thread_key:&str)->Option<Value> {
    for home in [conversation_home(account_root,thread_key),account_root.clone()] {
        let Some(index)=fs::read(home.join("geod-threads.json")).ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok())else{continue;};
        let Some(record)=index.get(thread_key)else{continue;};
        let id=record.as_str().or_else(||record["id"].as_str())?;
        if uuid::Uuid::parse_str(id).is_err(){return None;}
        let path=record["path"].as_str().and_then(|path|saved_rollout(account_root,std::path::Path::new(path),id)).or_else(||find_rollout(&home.join("sessions"),id).and_then(|path|saved_rollout(account_root,&path,id)));
        return Some(json!({"id":id,"path":path}));
    }
    None
}
fn fork_sqlite_snapshot(source:&std::path::Path,target:&std::path::Path)->Result<(),ServiceError>{
    if !source.is_dir(){return Ok(());}
    fs::create_dir_all(target).map_err(|_|error("CODEX_STORAGE_ERROR","无法创建会话分支记录目录"))?;
    for entry in fs::read_dir(source).map_err(|_|error("CODEX_STORAGE_ERROR","无法读取原会话索引"))?.filter_map(Result::ok){
        let path=entry.path();
        if path.extension().is_none_or(|extension|extension!="sqlite")||entry.file_name().to_string_lossy().starts_with("logs_"){continue;}
        let destination=target.join(entry.file_name());
        if destination.exists(){return Err(error("CODEX_FORK_CONFLICT","目标分支已包含引擎记录，请创建新分支"));}
        let db=rusqlite::Connection::open_with_flags(&path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|_|error("CODEX_STORAGE_ERROR","无法读取原会话索引"))?;
        db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|_|error("CODEX_STORAGE_ERROR","无法读取原会话索引"))?;
        db.execute("VACUUM INTO ?1",[destination.to_string_lossy().as_ref()]).map_err(|_|error("CODEX_STORAGE_ERROR","无法保存原会话的完整索引"))?;
    }
    Ok(())
}
fn stage_fork_history(source:&Value,home:&std::path::Path,sqlite_home:&std::path::Path)->Result<Value,ServiceError>{
    let id=source["id"].as_str().ok_or_else(||error("CODEX_THREAD_NOT_FOUND","原会话还没有可分支的引擎记录"))?;
    let original=source["path"].as_str().map(PathBuf::from).filter(|path|path.is_file()).ok_or_else(||error("CODEX_THREAD_NOT_FOUND","原会话的历史文件已无法读取"))?;
    // A paginated Codex fork validates that its source rollout belongs to the
    // current Codex home. Preserve the real rollout verbatim in the new home;
    // only the copied index's location changes. The source stays untouched.
    let sessions=home.join("sessions");
    fs::create_dir_all(&sessions).map_err(|_|error("CODEX_STORAGE_ERROR","无法创建分支历史目录"))?;
    let destination=sessions.join(original.file_name().ok_or_else(||error("CODEX_STORAGE_ERROR","原会话历史文件名无效"))?);
    if destination.exists(){return Err(error("CODEX_FORK_CONFLICT","目标分支已包含历史文件，请创建新分支"));}
    fs::copy(&original,&destination).map_err(|_|error("CODEX_STORAGE_ERROR","无法保存原会话的历史副本"))?;
    let actual=fs::canonicalize(&destination).map_err(|_|error("CODEX_STORAGE_ERROR","无法定位分支历史副本"))?;
    for entry in fs::read_dir(sqlite_home).map_err(|_|error("CODEX_STORAGE_ERROR","无法读取分支索引"))?.filter_map(Result::ok){
        let path=entry.path();
        if path.extension().is_none_or(|extension|extension!="sqlite")||entry.file_name().to_string_lossy().starts_with("logs_"){continue;}
        let db=rusqlite::Connection::open(&path).map_err(|_|error("CODEX_STORAGE_ERROR","无法打开分支索引"))?;
        let has_threads:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='threads')",[],|row|row.get(0)).map_err(|_|error("CODEX_STORAGE_ERROR","无法检查分支索引"))?;
        if has_threads {db.execute("UPDATE threads SET rollout_path=?1 WHERE id=?2",rusqlite::params![actual.to_string_lossy().as_ref(),id]).map_err(|_|error("CODEX_STORAGE_ERROR","无法关联分支历史副本"))?;}
    }
    Ok(json!({"id":id,"path":actual}))
}
fn error(code: &'static str, message: impl Into<String>) -> ServiceError { ServiceError { code, message: message.into() } }

#[cfg(test)]
mod fork_storage_tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {fn new()->Self{let path=std::env::temp_dir().join(format!("geod-fork-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&path).unwrap();Self(path)}}
    impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}
    #[test]
    fn fork_preserves_wal_and_relocates_only_the_copied_rollout(){
        let fixture=Fixture::new();let source=fixture.0.join("source");let target=fixture.0.join("target");let home=fixture.0.join("home");
        fs::create_dir_all(&source).unwrap();fs::create_dir_all(&home).unwrap();
        let id=uuid::Uuid::new_v4().to_string();let rollout=source.join(format!("rollout-{id}.jsonl"));let bytes=b"{\"type\":\"session_meta\"}\n{\"type\":\"real_tool_output\",\"marker\":\"retained\"}\n";fs::write(&rollout,bytes).unwrap();
        let db=rusqlite::Connection::open(source.join("state_5.sqlite")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,history_mode TEXT);CREATE TABLE history(marker TEXT);").unwrap();
        db.execute("INSERT INTO threads VALUES(?1,?2,'paginated')",rusqlite::params![id,rollout.to_string_lossy()]).unwrap();db.execute("INSERT INTO history VALUES('committed-in-wal')",[]).unwrap();
        assert!(source.join("state_5.sqlite-wal").is_file());
        assert!(fork_sqlite_snapshot(&source,&target).is_ok());
        let staged=stage_fork_history(&json!({"id":id,"path":rollout}),&home,&target).ok().unwrap();
        assert_eq!(fs::read(staged["path"].as_str().unwrap()).unwrap(),bytes);
        let copy=rusqlite::Connection::open(target.join("state_5.sqlite")).unwrap();
        assert_eq!(copy.query_row("SELECT marker FROM history",[],|row|row.get::<_,String>(0)).unwrap(),"committed-in-wal");
        assert_eq!(copy.query_row("SELECT rollout_path FROM threads",[],|row|row.get::<_,String>(0)).unwrap(),staged["path"].as_str().unwrap());
        assert_eq!(db.query_row("SELECT rollout_path FROM threads",[],|row|row.get::<_,String>(0)).unwrap(),rollout.to_string_lossy());
        assert!(fork_sqlite_snapshot(&source,&target).is_err());
        assert!(stage_fork_history(&json!({"id":id,"path":rollout}),&home,&target).is_err());
    }
    #[test]
    fn stored_rollout_must_belong_to_this_owner_and_thread(){
        let fixture=Fixture::new();let owner=fixture.0.join("owner");let other=fixture.0.join("other");fs::create_dir_all(&owner).unwrap();fs::create_dir_all(&other).unwrap();
        let id=uuid::Uuid::new_v4().to_string();let allowed=owner.join(format!("rollout-{id}.jsonl"));let outside=other.join(format!("rollout-{id}.jsonl"));fs::write(&allowed,b"real").unwrap();fs::write(&outside,b"other").unwrap();
        assert!(saved_rollout(&owner,&allowed,&id).is_some());assert!(saved_rollout(&owner,&outside,&id).is_none());assert!(saved_rollout(&owner,&allowed,&uuid::Uuid::new_v4().to_string()).is_none());
    }
}

pub(crate) fn bundled_runtime(app: &AppHandle) -> Option<PathBuf> {
    let mut roots = vec![app.path().resource_dir().ok()?.join("codex-runtime")];
    if cfg!(debug_assertions) { roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/codex")); }
    roots.into_iter().find(|root| ["codex.exe", "node.exe", "codex-command-runner.exe", "codex-windows-sandbox-setup.exe", "codex-code-mode-host.exe", "manifest.json"].iter().all(|file| root.join(file).is_file()))
}
fn codex_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(root) = bundled_runtime(app) { return Some(root.join("codex.exe")); }
    if let Some(path) = std::env::var_os("GEOD_CODEX_EXE").map(PathBuf::from).filter(|p| p.is_file()) { return Some(path); }
    let base = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("OpenAI").join("Codex").join("bin");
    let mut paths: Vec<_> = fs::read_dir(base).ok()?.filter_map(Result::ok).map(|entry| entry.path().join("codex.exe")).filter(|p| p.is_file()).collect();
    paths.sort(); paths.pop()
}
pub(crate) fn command_dependencies(app:&AppHandle)->Result<(PathBuf,std::ffi::OsString),ServiceError>{
    let codex=codex_path(app).ok_or_else(||error("CODEX_UNAVAILABLE","未找到配套 Codex 引擎"))?;
    let node=bundled_runtime(app).map(|root|root.join("node.exe").into_os_string()).or_else(||std::env::var_os("GEOD_CODEX_NODE")).unwrap_or_else(||"node".into());
    Ok((codex,node))
}
#[tauri::command]
pub fn codex_available(app: AppHandle) -> Value {
    json!({"available": codex_path(&app).is_some(), "runtime": "codex", "requiredVersion": "0.159.2", "bundled": bundled_runtime(&app).is_some(), "development": cfg!(debug_assertions)})
}

#[cfg(windows)]
pub(crate) struct ProcessTree(usize);
#[cfg(windows)]
impl ProcessTree {
    fn attach(child: &std::process::Child) -> Result<Self, ServiceError> {
        use std::os::windows::io::AsRawHandle;
        Self::attach_handle(child.as_raw_handle())
    }
    pub(crate) fn attach_handle(handle:std::os::windows::io::RawHandle)->Result<Self,ServiceError> {
        use windows_sys::Win32::System::JobObjects::*;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() { return Err(error("CODEX_PROCESS_ERROR", "无法创建 Codex 进程组")); }
            let guard = Self(job as usize);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) == 0 || AssignProcessToJobObject(job, handle as _) == 0 {
                return Err(error("CODEX_PROCESS_ERROR", "无法管理 Codex 子进程的退出，请检查运行环境"));
            }
            Ok(guard)
        }
    }
}
#[cfg(windows)]
impl Drop for ProcessTree { fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _); } } }

fn write_command(input: &Input, command: &Value) -> Result<(), ServiceError> {
    let value = serde_json::to_string(command).map_err(|_| error("CODEX_COMMAND_INVALID", "无效的 Codex 响应"))?;
    if value.len() > 48_000_000 { return Err(error("CODEX_COMMAND_INVALID", "Codex 响应过大")); }
    writeln!(input.lock().unwrap(), "{value}").map_err(|_| error("CODEX_PROCESS_ERROR", "Codex 进程不可用"))
}

fn spawn_host(home: &PathBuf, host: &PathBuf, source_hash: String, node: &std::ffi::OsStr,isolated:bool,owner:String) -> Result<HostProcess, ServiceError> {
    let mut command = Command::new(node);
    // Model credentials can also exist in the launching shell. Neither the
    // bridge nor Codex inherits arbitrary application secrets from that shell.
    command.env_clear();
    for key in ["SYSTEMROOT","SYSTEMDRIVE","WINDIR","TEMP","TMP","APPDATA","LOCALAPPDATA","USERPROFILE","PROGRAMFILES","PROGRAMFILES(X86)","PROGRAMDATA","COMSPEC","PATHEXT","NUMBER_OF_PROCESSORS","OS","USERNAME"]{if let Some(value)=std::env::var_os(key){command.env(key,value);}}
    if let Some(folder) = PathBuf::from(node).parent().filter(|path| !path.as_os_str().is_empty()) {
        let mut paths = vec![folder.to_path_buf()];
        if isolated{if let Some(windows)=std::env::var_os("SYSTEMROOT"){paths.push(PathBuf::from(windows).join("System32"));}}
        else{paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));}
        if let Ok(path) = std::env::join_paths(paths) { command.env("PATH", path); }
    }
    command.arg(host).current_dir(home).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
    let mut child = command.spawn().map_err(|cause| error("CODEX_NODE_UNAVAILABLE", &format!("无法启动配套 Codex 运行环境：{cause}")))?;
    #[cfg(windows)] let tree = match ProcessTree::attach(&child) { Ok(guard) => guard, Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e); } };
    let stdout = child.stdout.take().unwrap();
    let input = Arc::new(Mutex::new(child.stdin.take().unwrap()));
    let route: Arc<Mutex<Option<mpsc::Sender<Value>>>> = Arc::new(Mutex::new(None));
    let alive = Arc::new(AtomicBool::new(true));
    let reader_route = Arc::clone(&route); let reader_alive = Arc::clone(&alive);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break; };
            if line.len() > 48_000_000 { break; }
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if let Some(sender) = reader_route.lock().unwrap().as_ref() { let _ = sender.send(value); }
            }
        }
        reader_alive.store(false, Ordering::Release);
        if let Some(sender) = reader_route.lock().unwrap().take() { let _ = sender.send(json!({"type":"failed","error":"Codex 进程已退出"})); }
    });
    Ok(HostProcess { owner,child, input, route, alive, source_hash, #[cfg(windows)] _tree: tree })
}

#[tauri::command]
pub async fn codex_turn(
    app: AppHandle,
    runtime: State<'_, CodexState>, run_id: String, conversation_id: String, input: String,
    history: Value, events: Channel<Value>, images: Option<Vec<String>>, document_ids: Option<Vec<String>>,
) -> Result<Value, ServiceError> {
    let owner=services::current_user_id(&app.state::<services::ServiceState>())?;
    crate::attachment_inputs::publish(&app,&owner,&conversation_id,&document_ids.unwrap_or_default()).map_err(|e|error(e.code,e.message))?;
    run_turn(app, runtime.inner(), run_id, conversation_id, input, history,
        Arc::new(move |value| events.send(value).map_err(|_| error("CODEX_VIEW_CLOSED", "对话界面已关闭，执行已停止"))), images, false, None, None).await
}

pub(crate) async fn run_turn(
    app: AppHandle, runtime: &CodexState, run_id: String, conversation_id: String,
    input: String, history: Value, events: EventSink, images: Option<Vec<String>>, background: bool, thread_scope: Option<String>, model_route: Option<crate::ai_channels::RouteSnapshot>,
) -> Result<Value, ServiceError> {
    run_operation(app,runtime,run_id,conversation_id,input,history,events,images,background,thread_scope,"start",json!({}),model_route).await
}
#[tauri::command]
pub async fn codex_fork(app:AppHandle,runtime:State<'_,CodexState>,source_conversation_id:String,conversation_id:String,image_ids:Option<Vec<String>>,document_ids:Option<Vec<String>>)->Result<Value,ServiceError>{
    if source_conversation_id==conversation_id||uuid::Uuid::parse_str(&source_conversation_id).is_err()||uuid::Uuid::parse_str(&conversation_id).is_err(){return Err(error("CODEX_INPUT_INVALID","会话分支标识无效"));}
    let fork_owner=services::current_user_id(&app.state::<services::ServiceState>())?;
    let fork_route=crate::ai_channels::selected(&app,&fork_owner,&source_conversation_id)?;
    crate::ai_channels::remember(&app,&conversation_id,&fork_route)?;
    let result=run_operation(app.clone(),runtime.inner(),uuid::Uuid::new_v4().to_string(),conversation_id.clone(),"创建会话分支".into(),json!([]),Arc::new(|_|Ok(())),None,false,None,"fork",json!({"sourceConversationId":source_conversation_id}),Some(fork_route)).await?;
    let (images,documents)=tauri::async_runtime::spawn_blocking(move||{
        let owner=services::current_user_id(&app.state::<services::ServiceState>())?;
        let images=crate::image_inputs::clone_images(&app,&owner,&source_conversation_id,&conversation_id,&image_ids.unwrap_or_default()).map_err(|e|error(e.code,e.message))?;
        let documents=crate::attachment_inputs::clone_documents(&app,&owner,&source_conversation_id,&conversation_id,&document_ids.unwrap_or_default()).map_err(|e|error(e.code,e.message))?;
        Ok::<_,ServiceError>((images,documents))
    }).await.map_err(|_|error("CODEX_STORAGE_ERROR","分支图片处理失败"))??;
    Ok(json!({"threadId":result["threadId"],"sourceThreadId":result["sourceThreadId"],"forkedFromId":result["forkedFromId"],"images":images,"documents":documents}))
}
async fn run_operation(
    app:AppHandle,runtime:&CodexState,run_id:String,conversation_id:String,input:String,history:Value,events:EventSink,images:Option<Vec<String>>,background:bool,thread_scope:Option<String>,operation_type:&'static str,operation:Value,model_route:Option<crate::ai_channels::RouteSnapshot>,
) -> Result<Value, ServiceError> {
    if uuid::Uuid::parse_str(&run_id).is_err() || input.len() > 60_000 || input.trim().is_empty() { return Err(error("CODEX_INPUT_INVALID", "对话输入无效或过长")); }
    let executable = codex_path(&app).ok_or_else(|| error("CODEX_UNAVAILABLE", "未找到 Codex 引擎，请运行 prepare-codex-runtime.py 准备开发运行环境"))?;
    let node = bundled_runtime(&app).map(|root| root.join("node.exe").into_os_string()).or_else(|| std::env::var_os("GEOD_CODEX_NODE")).unwrap_or_else(|| "node".into());
    let root = if background && !runtime.isolated { runtime.root.join("background") } else { runtime.root.clone() };
    let receipts=runtime.receipts_path();
    let isolated=runtime.isolated;
    let expected_owner=runtime.expected_owner.clone();
    let active = Arc::clone(&runtime.active);
    let hosts = Arc::clone(&runtime.hosts);
    let leases=Arc::clone(&runtime.leases);
    let maintenance=Arc::clone(&runtime.maintenance);
    tauri::async_runtime::spawn_blocking(move || {
        let _ = events(json!({"type":"stage","stage":"preparing","message":"正在检查本机连接…"}));
        let state = app.state::<AppState>();
        let services = app.state::<services::ServiceState>();
        let owner = services::current_user_id(&services)?;
        let thread_key=thread_scope.unwrap_or_else(||conversation_id.clone());
        let host_key=format!("{owner}:{thread_key}");
        {let mut leased=leases.lock().unwrap();if maintenance.load(Ordering::Acquire){return Err(error("CODEX_BUSY","应用正在准备更新，请稍后发送。"));}if !leased.insert(host_key.clone()){return Err(error("CODEX_BUSY","此会话正在处理上一轮请求"));}}
        let _guard=TurnGuard{leases,key:host_key.clone()};
        let _source_guard=if operation_type=="fork" {
            let source=operation["sourceConversationId"].as_str().ok_or_else(||error("CODEX_INPUT_INVALID","会话分支标识无效"))?;
            let key=format!("{owner}:{source}");let leases=Arc::clone(&_guard.leases);
            {let mut leased=leases.lock().unwrap();if !leased.insert(key.clone()){return Err(error("CODEX_BUSY","原会话正在执行，请等回复结束后再创建分支"));}}
            Some(TurnGuard{leases,key})
        }else{None};
        if expected_owner.as_ref().is_some_and(|expected|expected!=&owner){return Err(error("ACCOUNT_CHANGED","子任务所属账号已变化，执行已停止"));}
        let images=crate::image_inputs::model_images(&app,&owner,&conversation_id,&images.unwrap_or_default()).map_err(|e|error(e.code,e.message))?;
        let settings = read_workspace(&app, &state, &services, &conversation_id).map_err(|e| error(e.code, e.message))?;
        let workspace = settings.directory;
        let model_route=model_route.map(Ok).unwrap_or_else(||crate::ai_channels::selected(&app,&owner,&conversation_id))?;
        if model_route.owner_id!=owner{return Err(error("AI_CHANNEL_OWNER","任务渠道不属于当前账号"));}
        let _model_route_guard=crate::ai_channels::bind(&app,&run_id,&conversation_id,&model_route)?;
        let mut capabilities = if model_route.is_personal()||model_route.is_sponsored(){model_route.capabilities()}else{services::codex_capabilities(&services)?};
        capabilities["isolatedWorker"]=json!(isolated);
        let extensions = if isolated{json!({"skillDirectories":[],"selectedSkills":[],"mcpServers":[]})}else{app.state::<crate::extensions::ExtensionState>().codex_bundle_owned(&root.join(format!("account-{:x}", Sha256::digest(owner.as_bytes()))),&owner).map_err(|e| error(e.code, e.message))?};
        let memory = if isolated{json!({"entries":[],"omitted":0})}else{crate::agent_memory::prompt(&app, &conversation_id).map_err(|e|error(e.code,e.message))?};
        if services::current_user_id(&services)?!=owner{return Err(error("ACCOUNT_CHANGED","账号已切换，请在当前账号重新发送请求"));}
        // An isolated runtime already lives under its owner's unique task root.
        // Repeating owner hashes here can exceed Windows CreateProcess cwd limits.
        let account_root=if isolated{root.join("home")}else{root.join(format!("account-{:x}", Sha256::digest(owner.as_bytes())))};
        let home=if isolated{account_root.clone()}else{conversation_home(&account_root,&thread_key)};
        // SQLite creates journal/WAL paths beside its DB. A packaged Windows
        // launch expands AppData paths and can exceed SQLite's path limit even
        // when the session directory itself is writable. Keep its durable DBs
        // in a shorter, owner-and-thread-specific directory.
        let sqlite_home=if isolated{home.clone()}else{root.join("db").join(&format!("{:x}",Sha256::digest(host_key.as_bytes()))[..32])};
        let resume=thread_record(&account_root,&thread_key);
        let mut source_thread=operation["sourceConversationId"].as_str().and_then(|key|thread_record(&account_root,key));
        let has_thread=resume.is_some()||fs::read(home.join("geod-threads.json")).ok().and_then(|bytes|serde_json::from_slice::<Value>(&bytes).ok()).is_some_and(|index|index.get(&thread_key).is_some());
        let mut history_images=Vec::new();
        if !has_thread {
            let ids:Vec<String>=history.as_array().into_iter().flatten().rev().flat_map(|message|message["images"].as_array().into_iter().flatten().filter_map(|image|image["id"].as_str().map(str::to_owned))).take(8).collect();
            history_images=crate::image_inputs::model_images(&app,&owner,&conversation_id,&ids).map_err(|e|error(e.code,e.message))?;
        }
        fs::create_dir_all(&home).map_err(|_| error("CODEX_STORAGE_ERROR", "无法创建 Codex 会话目录"))?;
        if operation_type=="fork"{
            if has_thread{return Err(error("CODEX_FORK_CONFLICT","目标会话已经存在"));}
            let source=operation["sourceConversationId"].as_str().unwrap();
            let source_key=format!("{owner}:{source}");
            let source_sqlite=root.join("db").join(&format!("{:x}",Sha256::digest(source_key.as_bytes()))[..32]);
            // Paginated Codex histories also need their native SQLite index.
            // Snapshot it consistently with WAL, then let Codex perform the
            // real fork in the target's independent engine/data directory.
            fork_sqlite_snapshot(&source_sqlite,&sqlite_home)?;
            fs::create_dir_all(&sqlite_home).map_err(|_|error("CODEX_STORAGE_ERROR","无法创建分支索引目录"))?;
            source_thread=Some(stage_fork_history(source_thread.as_ref().ok_or_else(||error("CODEX_THREAD_NOT_FOUND","原会话还没有可分支的引擎记录"))?,&home,&sqlite_home)?);
        }
        if operation_type=="start"{crate::execution_receipts::begin(&receipts,&owner,&run_id,&conversation_id,&workspace).map_err(|e|error(e.code,e.message))?;}
        let host = home.join("codex-host.mjs");
        let tools = home.join("codex-tools.json");
        let mut host_source = include_str!("../codex-host.mjs").to_owned();
        if cfg!(debug_assertions) {
            if let Ok(source) = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("codex-host.mjs")) { host_source = source; }
        }
        let mut hook_source=include_str!("../plugin-hook-runner.mjs").to_owned();
        let mut bulk_source=include_str!("../codex-bulk-data.mjs").to_owned();
        let mut rtk_source=include_str!("../rtk-output.mjs").to_owned();
        if cfg!(debug_assertions){if let Ok(source)=fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("rtk-output.mjs")){rtk_source=source;}}
        if cfg!(debug_assertions){if let Ok(source)=fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("codex-bulk-data.mjs")){bulk_source=source;}}
        if cfg!(debug_assertions){if let Ok(source)=fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("plugin-hook-runner.mjs")){hook_source=source;}}
        // A loaded Codex thread retains its lifecycle handlers even after an
        // MCP reload. Replace the idle owned process when reviewed automation
        // changes; resume the durable thread under the newly exported hooks.
        let source_hash = format!("{:x}", Sha256::digest(format!("{host_source}\n{hook_source}\n{bulk_source}\n{rtk_source}\n{capabilities}\n{}",extensions["pluginHooks"]).as_bytes()));
        fs::write(home.join("rtk-output.mjs"),rtk_source).map_err(|_|error("CODEX_STORAGE_ERROR","无法准备命令输出精简环境"))?;
        fs::write(home.join("codex-bulk-data.mjs"),bulk_source).map_err(|_|error("CODEX_STORAGE_ERROR","无法准备本机几何数据传递环境"))?;
        fs::write(home.join("plugin-hook-runner.mjs"),hook_source).map_err(|_|error("CODEX_STORAGE_ERROR","无法准备插件自动化运行环境"))?;
        fs::write(home.join("codex-input-wait.mjs"),include_str!("../codex-input-wait.mjs")).map_err(|_|error("CODEX_STORAGE_ERROR","无法准备问答等待运行环境"))?;
        fs::write(&host, host_source).map_err(|_| error("CODEX_STORAGE_ERROR", "无法准备 Codex 适配层"))?;
        fs::write(&tools, if isolated{include_str!("../worker-tools.json")}else{include_str!("../codex-tools.json")}).map_err(|_| error("CODEX_STORAGE_ERROR", "无法准备 GeoD 工具定义"))?;
        let (sender, receiver) = mpsc::channel();
        let (stdin, route) = {
            let mut pool = hosts.lock().unwrap();
            // Switching accounts closes the old engine and its isolated credentials/context.
            pool.retain(|_,host|host.owner==owner);
            if pool.get(&host_key).is_some_and(|host| !host.alive.load(Ordering::Acquire) || host.source_hash != source_hash) { pool.remove(&host_key); }
            if !pool.contains_key(&host_key) { pool.insert(host_key.clone(), spawn_host(&home, &host, source_hash, &node,isolated,owner.clone())?); }
            let host = pool.get(&host_key).unwrap();
            (Arc::clone(&host.input), Arc::clone(&host.route))
        };
        let cancelled=Arc::new(AtomicBool::new(false));
        {
            let mut runs = active.lock().unwrap();
            if runs.contains_key(&run_id) { return Err(error("CODEX_BUSY", "请求编号已经在执行")); }
            runs.insert(run_id.clone(), ActiveRun { owner:owner.clone(), input: Arc::clone(&stdin), cancelled:cancelled.clone() });
        }
        *route.lock().unwrap() = Some(sender);
        let start = json!({"type":operation_type,"runId":run_id,"options":{"codex":executable,"home":home,"sqliteHome":sqlite_home,"toolsFile":tools,"capabilities":capabilities},"params":{"conversationId":conversation_id,"threadKey":thread_key,"workspace":workspace,"permission":settings.permission,"outputCrs":settings.output_crs,"rtkOutput":if isolated{None}else{crate::rtk_runtime::descriptor(&owner)},"input":input,"history":history,"images":images,"historyImages":history_images,"skillDirectories":extensions["skillDirectories"],"selectedSkills":extensions["selectedSkills"],"mcpServers":extensions["mcpServers"],"pluginHooks":extensions["pluginHooks"],"memory":memory,"background":background,"sourceConversationId":operation["sourceConversationId"],"resumeThread":resume,"sourceThread":source_thread}});
        if write_command(&stdin, &start).is_err() { active.lock().unwrap().remove(&run_id); *route.lock().unwrap() = None; return Err(error("CODEX_PROCESS_ERROR", "无法启动 Codex 对话")); }
        let mut result = Err(error("CODEX_PROCESS_ERROR", "Codex 对话进程提前结束，请重新发送消息"));
        let last_model_error=Arc::new(Mutex::new(None::<ServiceError>));
        let hook_calls=Arc::new(Mutex::new(HashMap::<String,Arc<AtomicBool>>::new()));
        while let Ok(value) = receiver.recv() {
            if value.get("runId").is_some_and(|id| id != &run_id) { continue; }
            if value["type"] == "done" { result = Ok(value["result"].clone()); break; }
            if value["type"] == "failed" { result = Err(error("CODEX_TURN_FAILED", value["error"].as_str().unwrap_or("Codex 对话失败"))); break; }
            if value["type"]=="pluginHookMcpCancel" {
                if let Some(flag)=value["requestId"].as_str().and_then(|id|hook_calls.lock().unwrap().get(id).cloned()){flag.store(true,Ordering::Release);}
                continue;
            }
            if value["type"]=="pluginHookMcp" {
                let request_id=value["requestId"].as_str().unwrap_or("").to_owned();
                let call_id=value["callId"].as_str().unwrap_or("");
                if request_id.is_empty()||call_id.len()!=64||!call_id.bytes().all(|byte|byte.is_ascii_hexdigit()){result=Err(error("PLUGIN_HOOK_INVALID","插件自动化运行目标无效"));break;}
                let call_cancel=Arc::new(AtomicBool::new(false));hook_calls.lock().unwrap().insert(request_id.clone(),call_cancel.clone());
                let calls=hook_calls.clone();let hook_app=app.clone();let hook_owner=owner.clone();let hook_conversation=conversation_id.clone();let hook_input=stdin.clone();let hook_events=events.clone();let hook_cancel=cancelled.clone();
                let execution_id=format!("hook:{run_id}:{call_id}");
                std::thread::spawn(move||{
                    let outcome=tauri::async_runtime::block_on(crate::extensions::plugin_hooks::call_mcp(&hook_app,&hook_owner,&hook_conversation,execution_id.clone(),value["target"].clone(),value["arguments"].clone(),background,hook_cancel.clone(),call_cancel));
                    let (output,code)=match outcome {Ok(output)=>(output,None),Err(cause)=>(json!({"isError":true,"content":[{"type":"text","text":format!("{}: {}",cause.code,cause.message)}]}),Some(cause.code))};
                    let _=hook_events(json!({"type":"pluginHookMcpResult","executionId":execution_id,"hookRunId":value["hookRunId"],"error":code,"success":output["isError"]!=true}));
                    let _=write_command(&hook_input,&json!({"type":"response","requestId":request_id,"value":output}));
                    if background&&matches!(code.as_deref(),Some("APPROVAL_REQUIRED"|"USER_INPUT_REQUIRED"|"VIEW_REQUIRED")){hook_cancel.store(true,Ordering::Release);let _=write_command(&hook_input,&json!({"type":"interrupt"}));}
                    calls.lock().unwrap().remove(&request_id);
                });
                continue;
            }
            if value["type"]=="embeddedData" {
                let request_id=value["requestId"].as_str().unwrap_or("");
                let execution_id=format!("codex:{conversation_id}:{}",value["callId"].as_str().unwrap_or(""));
                let output=crate::extensions::save_embedded_result_for_owner(&app.state::<crate::extensions::ExtensionState>(),&owner,&conversation_id,value["connectorId"].as_str().unwrap_or(""),value["toolName"].as_str().unwrap_or(""),&value["arguments"],&execution_id,value["result"].clone());
                let reply=match output{Ok(output)=>json!({"type":"response","requestId":request_id,"value":output}),Err(cause)=>json!({"type":"response","requestId":request_id,"error":cause.message})};
                if write_command(&stdin,&reply).is_err(){result=Err(error("CODEX_PROCESS_ERROR","无法保存本机地图结果"));break;}continue;
            }
            if value["type"] == "model" {
                if operation_type=="start"{if let Err(cause)=crate::execution_receipts::requested(&receipts,&owner,&run_id,value["generationId"].as_str().unwrap_or("")){result=Err(error(cause.code,cause.message));break;}}
                let service = services.inner().clone(); let model_input = Arc::clone(&stdin); let channel = events.clone();
                let receipt_path=receipts.clone();let receipt_owner=owner.clone();let receipt_run=run_id.clone();
                let selected_route=model_route.clone();let model_app=app.clone();let model_cancel=cancelled.clone();let model_error=last_model_error.clone();
                let _ = events(json!({"type":"model","generationId":value["generationId"]}));
                std::thread::spawn(move || {
                    let request_id = &value["requestId"];
                    let on_event=|kind:&str, data:&Value| {
                        if model_cancel.load(Ordering::Acquire){return;}
                        if kind=="wire"{let _=write_command(&model_input,&json!({"type":"wire","requestId":request_id,"event":data["event"],"value":data["data"]}));}
                        if kind == "content_delta" || kind == "reasoning_delta" {
                            let _ = write_command(&model_input, &json!({"type":"delta","requestId":request_id,"part":if kind == "reasoning_delta" {"reasoning"} else {"content"},"text":data["text"]}));
                        }
                    };
                    let generation = if selected_route.is_personal(){crate::ai_channels::generate(&model_app,&selected_route,value["generationId"].as_str().unwrap_or(""),value["conversationId"].as_str().unwrap_or(""),value["request"].clone(),model_cancel.clone(),on_event)}else if selected_route.is_sponsored(){services::codex_generate_sponsored(&service, value["generationId"].as_str().unwrap_or(""), value["conversationId"].as_str().unwrap_or(""), value["request"].clone(),selected_route.sponsor_request(),on_event)}else{services::codex_generate(&service,value["generationId"].as_str().unwrap_or(""),value["conversationId"].as_str().unwrap_or(""),value["request"].clone(),on_event)};
                    let reply = match generation { Ok(value) => {
                        *model_error.lock().unwrap()=None;
                        match crate::execution_receipts::generation(&receipt_path,&receipt_owner,&receipt_run,&value){
                            Ok(())=>{let _=channel(json!({"type":"generationResult","generation":value}));json!({"type":"response","requestId":request_id,"value":value})},
                            Err(cause)=>json!({"type":"response","requestId":request_id,"error":cause.message})
                        }
                    }, Err(cause) => {
                        *model_error.lock().unwrap()=Some(error(cause.code,cause.message.clone()));
                        if selected_route.is_personal(){if let Ok(Some(failed))=crate::ai_channels::generation_get(&model_app,&receipt_owner,value["generationId"].as_str().unwrap_or("")){let _=crate::execution_receipts::generation(&receipt_path,&receipt_owner,&receipt_run,&failed);let _=channel(json!({"type":"generationResult","generation":failed}));}}
                        json!({"type":"response","requestId":request_id,"error":cause.message,"errorCode":cause.code})
                    } };
                    let _ = write_command(&model_input, &reply);
                });
                continue;
            }
            if operation_type=="start"{if let Err(cause)=crate::execution_receipts::observe(&receipts,&owner,&run_id,&value){result=Err(error(cause.code,cause.message));break;}}
            crate::mcp_interaction::register_codex(&app,&owner,&conversation_id,&run_id,&value);
            if let Err(cause) = events(value) { result = Err(cause); break; }
        }
        // Core classifies streaming errors; retain the native service's precise
        // reason for a failed turn instead of exposing a generic bridge error.
        if result.as_ref().map_or(true,|value|value["status"]=="failed") {
            if let Some(cause)=last_model_error.lock().unwrap().take(){result=Err(cause);}
        }
        cancelled.store(true,Ordering::Release);
        if result.is_err() { let _ = write_command(&stdin, &json!({"type":"interrupt"})); hosts.lock().unwrap().remove(&host_key); }
        active.lock().unwrap().remove(&run_id);
        crate::mcp_interaction::dismiss_scope(&app,&run_id);
        *route.lock().unwrap() = None;
        if operation_type=="start"{let status=match &result{Ok(v)if v["status"]=="completed"=>"completed",Ok(v)if v["status"]=="interrupted"=>"interrupted",_=>"failed"};crate::execution_receipts::finish(&receipts,&owner,&run_id,status).map_err(|e|error(e.code,e.message))?;}
        result
    }).await.map_err(|_| error("CODEX_PROCESS_ERROR", "Codex 执行线程中断"))?
}

#[tauri::command]
pub fn codex_command(app:AppHandle,runtime: State<'_, CodexState>, services: State<'_, services::ServiceState>, run_id: String, command: Value) -> Result<(), ServiceError> {
    let owner = services::current_user_id(&services)?;
    crate::mcp_interaction::validate_codex_reply(&app,&owner,&run_id,&command)?;
    send_command(runtime.inner(), &owner, &run_id, command)
}
pub(crate) fn send_command(runtime: &CodexState, owner: &str, run_id: &str, command: Value) -> Result<(), ServiceError> {
    if !matches!(command["type"].as_str(), Some("response" | "interrupt" | "steer" | "userInputState")) { return Err(error("CODEX_COMMAND_INVALID", "无效的 Codex 响应")); }
    let runs = runtime.active.lock().unwrap();
    let run=runs.get(run_id).filter(|run| run.owner == owner).ok_or_else(|| error("CODEX_RUN_NOT_FOUND", "本轮对话已结束"))?;
    if command["type"]=="interrupt"{run.cancelled.store(true,Ordering::Release);}
    let input = Arc::clone(&run.input);
    drop(runs);
    crate::execution_receipts::replied(&runtime.receipts_path(),owner,run_id,&command).map_err(|e|error(e.code,e.message))?;
    write_command(&input, &command)
}

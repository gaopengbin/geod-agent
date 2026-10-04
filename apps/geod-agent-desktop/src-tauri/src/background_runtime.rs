//! A windowless companion owns download workers and schedules. The desktop is
//! only a client; both processes use the existing native commands and ledger.
use crate::{cache_management, data_jobs, data_schedules, schedules, services, AppState};
use fs2::FileExt;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions}, io::Read, path::{Path, PathBuf},
    process::{Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, RwLock, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tiny_http::{Header, Response, Server, StatusCode};
use uuid::Uuid;

const PROTOCOL: u32 = 1;
const MAX_BODY: u64 = 12 * 1024 * 1024;
pub(crate) static STOPPING: AtomicBool = AtomicBool::new(false);
static REQUEST_GATE: RwLock<()> = RwLock::new(());
static START_GATE: Mutex<()> = Mutex::new(());

pub(crate) fn is_daemon() -> bool {
    std::env::args_os().any(|arg| arg == "--background-runtime")
}
fn fingerprint() -> String {
    static VALUE: OnceLock<String> = OnceLock::new();
    // Version identity covers every native module and linked dependency.
    VALUE.get_or_init(|| {
        let mut hash=Sha256::new();
        if let Ok(mut file)=std::env::current_exe().and_then(File::open) {
            let mut buffer=[0u8;64*1024];
            loop {match file.read(&mut buffer){Ok(0)=>break,Ok(n)=>hash.update(&buffer[..n]),Err(_)=>{hash.update(b"unreadable-runtime");break;}}}
        } else {hash.update(concat!(env!("CARGO_PKG_VERSION"),include_str!("background_runtime.rs")).as_bytes());}
        format!("{:x}",hash.finalize())
    }).clone()
}
fn credential(dir: &Path) -> Result<keyring::Entry, Value> {
    keyring::Entry::new("dev.geod-agent.background", &format!("runtime-{:x}", Sha256::digest(dir.to_string_lossy().as_bytes())))
        .map_err(|_| failure("BACKGROUND_CREDENTIAL", "无法访问本机后台凭据"))
}
fn failure(code: &str, message: &str) -> Value { json!({"code":code,"message":message}) }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Endpoint { port: u16, pid: u32, protocol: u32, fingerprint: String }
#[derive(Clone)]
pub(crate) struct BackgroundClient { dir: PathBuf, stopped: Arc<AtomicBool>, maintenance: Arc<AtomicBool> }
impl BackgroundClient {
    pub(crate) fn new(dir: PathBuf) -> Self { Self { dir, stopped: Arc::new(AtomicBool::new(false)), maintenance:Arc::new(AtomicBool::new(false)) } }
    fn endpoint(&self) -> Result<Endpoint, Value> {
        let bytes = fs::read(self.dir.join("background-endpoint.json"))
            .map_err(|_| failure("BACKGROUND_OFFLINE", "本机后台尚未运行"))?;
        serde_json::from_slice(&bytes).map_err(|_| failure("BACKGROUND_OFFLINE", "本机后台连接记录无效"))
    }
    fn request(&self, command: &str, args: Value, timeout: Duration) -> Result<Value, Value> {
        let endpoint = self.endpoint()?;
        if endpoint.protocol != PROTOCOL { return Err(failure("BACKGROUND_VERSION", "后台版本需要更新")); }
        let token = credential(&self.dir)?.get_password()
            .map_err(|_| failure("BACKGROUND_CREDENTIAL", "本机后台凭据不可用"))?;
        let client = reqwest::blocking::Client::builder().no_proxy()
            .redirect(reqwest::redirect::Policy::none()).timeout(timeout).build()
            .map_err(|_| failure("BACKGROUND_OFFLINE", "无法连接本机后台"))?;
        let response = client.post(format!("http://127.0.0.1:{}/rpc", endpoint.port))
            .bearer_auth(token).json(&json!({"command":command,"args":args})).send()
            .map_err(|_| failure("BACKGROUND_UNCERTAIN", "后台连接已中断，请重新打开应用核对任务状态后继续"))?;
        let status = response.status();
        let mut bytes=Vec::new();
        response.take(MAX_BODY+1).read_to_end(&mut bytes).map_err(|_| failure("BACKGROUND_UNCERTAIN", "后台结果未完整收到，请核对任务状态"))?;
        if bytes.len() > MAX_BODY as usize { return Err(failure("BACKGROUND_RESPONSE", "后台返回超过读取上限")); }
        let envelope: Value = serde_json::from_slice(&bytes)
            .map_err(|_| failure("BACKGROUND_RESPONSE", "本机后台返回无效结果"))?;
        if status.is_success() && envelope["ok"] == true { Ok(envelope["result"].clone()) }
        else { Err(envelope.get("error").cloned().unwrap_or_else(|| failure("BACKGROUND_RESPONSE", "本机后台拒绝请求"))) }
    }
    pub(crate) fn call(&self, command: &str, args: Value) -> Result<Value, Value> {
        if !routes(command) { return Err(failure("BACKGROUND_COMMAND", "此操作不属于后台任务")); }
        self.ensure()?;
        // Never replay a mutation after a lost response. Existing command keys
        // and ledger readback determine whether the operation already ran.
        self.request(command, args, Duration::from_secs(120))
    }
    pub(crate) fn ensure(&self) -> Result<Value, Value> {
        let _start = START_GATE.lock().map_err(|_| failure("BACKGROUND_START", "后台启动状态不可用"))?;
        self.ensure_locked()
    }
    fn ensure_locked(&self) -> Result<Value,Value> {
        if self.maintenance.load(Ordering::Acquire) {return Err(failure("BACKGROUND_MAINTENANCE", "正在备份或更新应用，后台稍后恢复"));}
        if self.stopped.load(Ordering::Acquire) { return Err(failure("BACKGROUND_STOPPED", "后台已退出，请在后台运行设置中启动")); }
        match self.request("runtime_status", json!({}), Duration::from_secs(2)) {
            Ok(status) => {
                if status["fingerprint"] == fingerprint() { return Ok(status); }
                self.request("runtime_stop", json!({}), Duration::from_secs(5))?;
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(error) if matches!(error["code"].as_str(), Some("BACKGROUND_VERSION" | "BACKGROUND_AUTH" | "BACKGROUND_CREDENTIAL" | "BACKGROUND_RESPONSE")) => {
                // A reachable but incompatible/unauthorized companion must not
                // cause repeated duplicate launches or hide its precise error.
                return Err(error);
            }
            Err(_) => {}
        }
        let executable = std::env::current_exe().map_err(|_| failure("BACKGROUND_START", "无法定位后台程序"))?;
        let output = OpenOptions::new().create(true).append(true).open(self.dir.join("background.log"))
            .map_err(|_| failure("BACKGROUND_START", "无法创建后台日志"))?;
        let mut command = Command::new(executable);
        command.arg("--background-runtime").stdin(Stdio::null()).stdout(output.try_clone().map_err(|_| failure("BACKGROUND_START", "无法打开后台日志"))?).stderr(output);
        command.env_remove("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            // A companion must survive its launching desktop and its job tree.
            command.creation_flags(0x00000008 | 0x00000200 | 0x01000000);
        }
        command.spawn().map_err(|_| failure("BACKGROUND_START", "无法启动独立后台程序"))?;
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Ok(status) = self.request("runtime_status", json!({}), Duration::from_secs(1)) {
                if status["fingerprint"] == fingerprint() { return Ok(status); }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err(failure("BACKGROUND_START", "独立后台没有就绪，请检查后台日志"))
    }
    fn start_requested(&self)->Result<Value,Value>{
        let _start=START_GATE.lock().map_err(|_|failure("BACKGROUND_START","后台启动状态不可用"))?;
        if self.maintenance.load(Ordering::Acquire){return Err(failure("BACKGROUND_MAINTENANCE","正在备份或更新应用，后台稍后恢复"));}
        self.stopped.store(false,Ordering::Release);self.ensure_locked()
    }
    fn stop_requested(&self)->Result<Value,Value>{
        let _start=START_GATE.lock().map_err(|_|failure("BACKGROUND_START","后台启动状态不可用"))?;
        if self.maintenance.load(Ordering::Acquire){return Err(failure("BACKGROUND_MAINTENANCE","正在备份或更新应用，后台稍后恢复"));}
        let result=self.request("runtime_stop",json!({}),Duration::from_secs(5))?;self.stopped.store(true,Ordering::Release);Ok(result)
    }
    pub(crate) fn begin_maintenance(&self) -> Result<BackgroundMaintenance,Value> {
        let _start=START_GATE.lock().map_err(|_|failure("BACKGROUND_START","后台启动状态不可用"))?;
        if self.maintenance.swap(true,Ordering::AcqRel){return Err(failure("BACKGROUND_MAINTENANCE","正在备份或更新应用，后台稍后恢复"));}
        let result=(|| {
            let running=if self.stopped.load(Ordering::Acquire){false}else{self.request("runtime_status",json!({}),Duration::from_secs(5))?["running"]==true};
            if running {self.request("runtime_stop",json!({}),Duration::from_secs(5))?;self.stopped.store(true,Ordering::Release);}
            Ok(BackgroundMaintenance{client:self.clone(),restart:running})
        })();
        if result.is_err(){self.maintenance.store(false,Ordering::Release);}
        result
    }
}
pub(crate) struct BackgroundMaintenance {client:BackgroundClient,restart:bool}
impl BackgroundMaintenance {pub(crate) fn keep_stopped(&mut self){self.restart=false;}}
impl Drop for BackgroundMaintenance {
    fn drop(&mut self){
        self.client.maintenance.store(false,Ordering::Release);
        if self.restart {if let Err(error)=self.client.start_requested(){eprintln!("GeoD background restore failed: {}",error["code"]);}}
    }
}

#[tauri::command]
pub(crate) async fn background_status(client: State<'_, BackgroundClient>) -> Result<Value, Value> {
    let client = client.inner().clone();
    tauri::async_runtime::spawn_blocking(move || if client.stopped.load(Ordering::Acquire) { Ok(json!({"running":false,"activeDownloads":0,"windowRequired":false})) } else { client.ensure() }).await
        .map_err(|_| failure("BACKGROUND_OFFLINE", "读取后台状态失败"))?
}
#[tauri::command]
pub(crate) async fn background_stop(client: State<'_, BackgroundClient>) -> Result<Value, Value> {
    let client = client.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        client.stop_requested()
    }).await
        .map_err(|_| failure("BACKGROUND_OFFLINE", "停止后台失败"))?
}
#[tauri::command]
pub(crate) async fn background_start(client: State<'_, BackgroundClient>) -> Result<Value, Value> {
    let client = client.inner().clone();
    tauri::async_runtime::spawn_blocking(move || client.start_requested()).await
        .map_err(|_| failure("BACKGROUND_OFFLINE", "启动后台失败"))?
}

pub(crate) fn routes(command: &str) -> bool {
    matches!(command,
        "billing_runs_list" | "billing_run_snapshot" |
        "agent_tasks_spawn" | "agent_tasks_list" | "agent_tasks_get" | "agent_tasks_read_file" | "agent_tasks_cancel" |
        "background_command_prepare" | "background_command_list" | "background_command_get" | "background_command_start" | "background_command_stop" | "background_command_write" |
        "ai_schedules_create" | "ai_schedules_list" | "ai_schedules_set_enabled" | "ai_schedules_run_events" | "ai_schedules_cancel_run" | "ai_schedules_retry_run" |
        "jobs_start" | "jobs_start_auto" | "jobs_resume" | "jobs_pause" | "jobs_cancel" |
        "jobs_get" | "jobs_for_plan" | "jobs_list" | "jobs_active" | "jobs_events" | "artifacts_inspect" |
        "data_download_plan" | "data_download_list" | "data_download_get" | "data_download_start" |
        "data_download_start_auto" | "data_download_cancel" | "data_download_discard" | "data_download_inspect" |
        "schedules_create" | "schedules_list" | "schedules_set_enabled" | "schedules_runs" | "schedules_cancel_run" |
        "data_schedules_create" | "data_schedules_list" | "data_schedules_set_enabled" | "data_schedules_runs" | "data_schedules_cancel_run" |
        "cache_inventory" | "cache_maintenance_start" | "cache_maintenance_status" | "cache_maintenance_cancel" |
        "cache_relocation_preflight" | "cache_relocation_start")
}
pub(crate) fn forward(invoke: tauri::ipc::Invoke<tauri::Wry>, client: BackgroundClient) {
    let command = invoke.message.command().to_owned();
    let args = match invoke.message.payload() {
        tauri::ipc::InvokeBody::Json(value) => value.clone(),
        _ => { invoke.resolver.reject(failure("BACKGROUND_INPUT", "后台任务需要结构化参数")); return; }
    };
    tauri::async_runtime::spawn_blocking(move || match client.call(&command, args) {
        Ok(value) => invoke.resolver.resolve(value), Err(error) => invoke.resolver.reject(error),
    });
}

struct ServerLease { _lock: File, endpoint: Endpoint, dir: PathBuf }
impl Drop for ServerLease {
    fn drop(&mut self) {
        let path = self.dir.join("background-endpoint.json");
        let own = fs::read(&path).ok().and_then(|s| serde_json::from_slice::<Endpoint>(&s).ok())
            .is_some_and(|e| e.pid == self.endpoint.pid);
        if own { let _ = fs::remove_file(path); }
    }
}
fn authorized(expected: &str, supplied: &str) -> bool {
    expected.len() == supplied.len() && expected.as_bytes().iter().zip(supplied.as_bytes()).fold(0_u8, |a,(x,y)| a | (x ^ y)) == 0
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { command: String, args: Value }

pub(crate) fn start(app: AppHandle, dir: PathBuf) -> Result<(), Value> {
    let lock = OpenOptions::new().create(true).read(true).write(true).open(dir.join("background.lock"))
        .map_err(|_| failure("BACKGROUND_LOCK", "无法创建后台运行锁"))?;
    lock.try_lock_exclusive().map_err(|_| failure("BACKGROUND_RUNNING", "已有后台进程运行"))?;
    let server = Server::http("127.0.0.1:0").map_err(|_| failure("BACKGROUND_START", "无法监听本机后台端口"))?;
    let port = server.server_addr().to_ip().ok_or_else(|| failure("BACKGROUND_START", "后台监听地址无效"))?.port();
    let endpoint = Endpoint { port, pid: std::process::id(), protocol: PROTOCOL, fingerprint: fingerprint() };
    let token = format!("Bearer {}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    credential(&dir)?.set_password(token.strip_prefix("Bearer ").unwrap())
        .map_err(|_| failure("BACKGROUND_CREDENTIAL", "无法保存本机后台凭据"))?;
    let temp = dir.join(format!("background-endpoint-{}.tmp", endpoint.pid));
    fs::write(&temp, serde_json::to_vec(&endpoint).unwrap()).and_then(|_| fs::rename(&temp, dir.join("background-endpoint.json")))
        .map_err(|_| failure("BACKGROUND_START", "无法保存后台连接状态"))?;
    let lease = Arc::new(ServerLease { _lock: lock, endpoint, dir });
    let server = Arc::new(server);
    // Bounded request concurrency; each worker executes the same native commands
    // as the desktop. There is no public HTTP/CORS endpoint or generic shell.
    for _ in 0..8 {
        let server = Arc::clone(&server); let lease = Arc::clone(&lease);
        let app = app.clone(); let token = token.clone();
        std::thread::spawn(move || {
            while let Ok(mut request) = server.recv() {
                let auth = request.headers().iter().find(|h| h.field.equiv("Authorization")).map(|h| h.value.as_str()).unwrap_or("");
                let origin = request.headers().iter().any(|h| h.field.equiv("Origin"));
                if origin || !authorized(&token, auth) {
                    respond(request, 403, Err(failure("BACKGROUND_AUTH", "后台请求未通过认证"))); continue;
                }
                if request.method() != &tiny_http::Method::Post || request.url() != "/rpc" {
                    respond(request, 404, Err(failure("BACKGROUND_ROUTE", "后台接口不存在"))); continue;
                }
                if request.body_length().is_some_and(|n| n as u64 > MAX_BODY) {
                    respond(request, 413, Err(failure("BACKGROUND_INPUT", "后台请求过大"))); continue;
                }
                let mut bytes = Vec::new();
                if request.as_reader().take(MAX_BODY + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > MAX_BODY {
                    respond(request, 400, Err(failure("BACKGROUND_INPUT", "后台参数读取失败"))); continue;
                }
                let parsed = serde_json::from_slice::<Request>(&bytes);
                let result = match parsed {
                    Ok(r) if r.args.is_object() => dispatch(&app, &lease.endpoint, &r.command, &r.args),
                    _ => Err(failure("BACKGROUND_INPUT", "后台参数无效")),
                };
                let stopped = result.as_ref().is_ok_and(|v| v["stopped"] == true);
                respond(request, 200, result);
                if stopped { app.exit(0); break; }
            }
        });
    }
    Ok(())
}
fn respond(request: tiny_http::Request, status: u16, result: Result<Value, Value>) {
    let body = match result { Ok(result) => json!({"ok":true,"result":result}), Err(error) => json!({"ok":false,"error":error}) };
    let response = Response::from_string(body.to_string()).with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap());
    let _ = request.respond(response);
}
fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, Value> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|_| failure("BACKGROUND_INPUT", &format!("后台参数 {key} 无效")))
}
fn encode<T: Serialize, E: Serialize>(result: Result<T, E>) -> Result<Value, Value> {
    result.map_err(|e| serde_json::to_value(e).unwrap_or_else(|_| failure("BACKGROUND_RESULT", "后台执行失败")))
        .and_then(|v| serde_json::to_value(v).map_err(|_| failure("BACKGROUND_RESULT", "后台结果编码失败")))
}
fn dispatch(app: &AppHandle, endpoint: &Endpoint, command: &str, a: &Value) -> Result<Value, Value> {
    let _read = if command != "runtime_stop" { Some(REQUEST_GATE.read().unwrap()) } else { None };
    let _write = if command == "runtime_stop" { Some(REQUEST_GATE.write().unwrap()) } else { None };
    let state = app.state::<AppState>();
    if command == "runtime_status" {
        return Ok(json!({"running":true,"pid":endpoint.pid,"protocol":PROTOCOL,"fingerprint":endpoint.fingerprint,
            "activeDownloads":state.running_jobs.lock().unwrap().len()+data_jobs::active_count(),
            "maintenanceActive":cache_management::ensure_idle().is_err(),
            "activeCommands":crate::background_commands::active_count(),"activeAiTurns":usize::from(crate::ai_schedules::ACTIVE.load(Ordering::Acquire))+crate::agent_tasks::active_count(),"windowRequired":false}));
    }
    if command == "runtime_stop" {
        STOPPING.store(true, Ordering::Release);
        let _gate = state.schedule_gate.lock().unwrap();
        let _data_gate = data_schedules::GATE.lock().unwrap();
        let _ai_gate = crate::ai_schedules::GATE.lock().unwrap();
        if !state.running_jobs.lock().unwrap().is_empty() || data_jobs::active_count() != 0 || cache_management::ensure_idle().is_err() || crate::ai_schedules::ACTIVE.load(Ordering::Acquire) || crate::background_commands::active_count()!=0 || crate::agent_tasks::active_count()!=0 {
            STOPPING.store(false, Ordering::Release);
            return Err(failure("BACKGROUND_BUSY", "还有下载、命令、AI 执行或缓存维护在运行，请先停止或等待完成"));
        }
        return Ok(json!({"stopped":true}));
    }
    if STOPPING.load(Ordering::Acquire) { return Err(failure("BACKGROUND_STOPPING", "后台正在退出，请稍后重试")); }
    if !routes(command) { return Err(failure("BACKGROUND_COMMAND", "后台操作未开放")); }
    let services = app.state::<services::ServiceState>();
    services::current_user_id(&services).map_err(|e| serde_json::to_value(e).unwrap())?;
    macro_rules! get { ($name:literal) => { arg(a, $name)? }; }
    match command {
        "agent_tasks_spawn" => encode(crate::agent_tasks::spawn(app,get!("conversationId"),get!("idempotencyKey"),get!("draft"))),
        "agent_tasks_list" => encode(crate::agent_tasks::list(app,get!("conversationId"))),
        "agent_tasks_get" => encode(crate::agent_tasks::get(app,get!("conversationId"),get!("taskId"))),
        "agent_tasks_read_file" => encode(crate::agent_tasks::read_file(app,get!("conversationId"),get!("taskId"),get!("path"))),
        "agent_tasks_cancel" => encode(crate::agent_tasks::cancel(app,get!("conversationId"),get!("taskId"))),
        "background_command_prepare" => encode(crate::background_commands::prepare(app,get!("conversationId"),get!("idempotencyKey"),get!("draft"))),
        "billing_runs_list" => encode(crate::execution_receipts::billing_runs_list(app.clone(),get!("conversationId"),get!("offset"))),
        "billing_run_snapshot" => encode(crate::execution_receipts::billing_run_snapshot(app.clone(),get!("runId"))),
        "background_command_list" => encode(crate::background_commands::list(app,get!("conversationId"),get!("offset"))),
        "background_command_get" => encode(crate::background_commands::get(app,get!("conversationId"),get!("commandId"))),
        "background_command_start" => encode(crate::background_commands::start(app,get!("conversationId"),get!("commandId"),get!("planHash"),get!("confirmed"))),
        "background_command_stop" => encode(crate::background_commands::stop(app,get!("conversationId"),get!("commandId"))),
        "background_command_write" => encode(crate::background_commands::write(app,get!("conversationId"),get!("commandId"),get!("input"),get!("closeStdin"))),
        "ai_schedules_create" => encode(crate::ai_schedules::ai_schedules_create(app.clone(),get!("conversationId"),get!("name"),get!("prompt"),get!("nextRunAt"),get!("repeatSeconds"),get!("executionId"),get!("history"))),
        "ai_schedules_list" => encode(crate::ai_schedules::ai_schedules_list(app.clone(),get!("conversationId"))),
        "ai_schedules_set_enabled" => encode(crate::ai_schedules::ai_schedules_set_enabled(app.clone(),get!("scheduleId"),get!("enabled"),get!("nextRunAt"))),
        "ai_schedules_run_events" => encode(crate::ai_schedules::ai_schedules_run_events(app.clone(),get!("runId"))),
        "ai_schedules_cancel_run" => encode(crate::ai_schedules::ai_schedules_cancel_run(app.clone(),get!("runId"))),
        "ai_schedules_retry_run" => encode(crate::ai_schedules::ai_schedules_retry_run(app.clone(),get!("runId"))),
        "jobs_start" => encode(crate::jobs_start(state, get!("planId"), get!("planHash"), get!("approvalId"), get!("idempotencyKey"))),
        "jobs_start_auto" => encode(crate::jobs_start_auto(app.clone(), state, services, get!("planId"), get!("conversationId"), get!("idempotencyKey"))),
        "jobs_resume" => encode(crate::jobs_resume(state, get!("jobId"))),
        "jobs_pause" => encode(crate::jobs_pause(state, get!("jobId"))),
        "jobs_cancel" => encode(crate::jobs_cancel(state, get!("jobId"))),
        "jobs_get" => encode(crate::jobs_get(state, get!("jobId"))),
        "jobs_for_plan" => encode(crate::jobs_for_plan(state, get!("planId"))),
        "jobs_list" => encode(crate::jobs_list(state)),
        "jobs_active" => Ok(json!(crate::jobs_active(state))),
        "jobs_events" => encode(crate::jobs_events(state, get!("jobId"), get!("afterSeq"))),
        "artifacts_inspect" => encode(crate::artifacts_inspect(state, get!("jobId"))),
        "data_download_plan" => encode(data_jobs::data_download_plan(app.clone(), state, services, get!("conversationId"), get!("title"), get!("idempotencyKey"), get!("request"))),
        "data_download_list" => encode(data_jobs::data_download_list(app.clone(), state, services, get!("conversationId"))),
        "data_download_get" => encode(data_jobs::data_download_get(app.clone(), state, services, get!("conversationId"), get!("taskId"))),
        "data_download_start" => encode(data_jobs::data_download_start(app.clone(), state, services, get!("conversationId"), get!("taskId"), get!("planHash"), get!("confirmed"))),
        "data_download_start_auto" => encode(data_jobs::data_download_start_auto(app.clone(), state, services, get!("conversationId"), get!("taskId"), get!("planHash"))),
        "data_download_cancel" => encode(data_jobs::data_download_cancel(app.clone(), state, services, get!("conversationId"), get!("taskId"))),
        "data_download_discard" => encode(data_jobs::data_download_discard(app.clone(), state, services, get!("conversationId"), get!("taskId"))),
        "data_download_inspect" => encode(data_jobs::data_download_inspect(app.clone(), state, services, get!("conversationId"), get!("taskId"))),
        "schedules_create" => encode(schedules::schedules_create(app.clone(), state, services, get!("conversationId"), get!("planId"), get!("name"), get!("nextRunAt"), get!("repeatSeconds"), get!("maxRetries"), get!("executionId"))),
        "schedules_list" => encode(schedules::schedules_list(state, services, get!("conversationId"))),
        "schedules_set_enabled" => encode(schedules::schedules_set_enabled(state, services, get!("scheduleId"), get!("enabled"), get!("nextRunAt"))),
        "schedules_runs" => encode(schedules::schedules_runs(state, services, get!("conversationId"))),
        "schedules_cancel_run" => encode(schedules::schedules_cancel_run(state, services, get!("runId"))),
        "data_schedules_create" => encode(data_schedules::data_schedules_create(app.clone(), state, services, get!("conversationId"), get!("taskId"), get!("name"), get!("nextRunAt"), get!("repeatSeconds"), get!("executionId"))),
        "data_schedules_list" => encode(data_schedules::data_schedules_list(app.clone(), state, services, get!("conversationId"))),
        "data_schedules_set_enabled" => encode(data_schedules::data_schedules_set_enabled(app.clone(), state, services, get!("scheduleId"), get!("enabled"), get!("nextRunAt"))),
        "data_schedules_runs" => encode(data_schedules::data_schedules_runs(app.clone(), state, services, get!("conversationId"))),
        "data_schedules_cancel_run" => encode(data_schedules::data_schedules_cancel_run(app.clone(), state, services, get!("runId"))),
        "cache_inventory" => encode(tauri::async_runtime::block_on(cache_management::cache_inventory(state, services))),
        "cache_maintenance_start" => encode(cache_management::cache_maintenance_start(state, services, get!("action"), get!("jobIds"))),
        "cache_maintenance_status" => encode(cache_management::cache_maintenance_status(services, get!("operationId"))),
        "cache_maintenance_cancel" => encode(cache_management::cache_maintenance_cancel(services, get!("operationId"))),
        "cache_relocation_preflight" => encode(tauri::async_runtime::block_on(cache_management::cache_relocation_preflight(state, services, get!("targetPath")))),
        "cache_relocation_start" => encode(cache_management::cache_relocation_start(state, services, get!("targetPath"))),
        _ => Err(failure("BACKGROUND_COMMAND", "后台操作未开放")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_unregistered_commands_and_wrong_auth() {
        assert!(!routes("codex_turn")); assert!(!routes("mcp_call"));
        assert!(!routes("data_download_preview")); assert!(routes("data_download_start_auto"));
        assert!(!authorized("Bearer abcd", "Bearer abce"));
        assert!(!authorized("Bearer abcd", "Bearer abc")); assert!(authorized("Bearer abcd", "Bearer abcd"));
        assert!(arg::<String>(&json!({}), "planId").is_err());
        assert_eq!(arg::<Option<u32>>(&json!({}), "repeatSeconds").unwrap(), None);
    }
}

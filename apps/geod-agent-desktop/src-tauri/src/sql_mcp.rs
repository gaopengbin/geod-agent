//! Account-scoped DBHub MCP sessions; the Agent receives neither DSNs nor credentials.
use crate::{workspace_error, AppError};
use rmcp::{model::CallToolRequestParams, transport::async_rw::AsyncRwTransport, ServiceExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::{Component, Path, PathBuf}, process::Stdio, sync::OnceLock, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::{io::AsyncReadExt, process::{Child, Command}, task::JoinHandle};

static VERIFIED: OnceLock<PathBuf> = OnceLock::new();
const MANIFEST: &str = include_str!("../resources/dbhub/manifest.json");
const CONFIG: &str = include_str!("../dbhub-config.toml");
pub(crate) fn runtime(app: &AppHandle) -> Result<PathBuf, AppError> {
    if let Some(root) = VERIFIED.get() { return Ok(root.clone()); }
    let mut candidates = vec![];
    if cfg!(debug_assertions) { candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/dbhub")); }
    if let Ok(path) = app.path().resource_dir() { candidates.push(path.join("dbhub-runtime")); }
    let root = candidates.into_iter().find(|path|path.join("manifest.json").is_file()).ok_or_else(||workspace_error("INPUT_RUNTIME_MISSING","内置数据库 MCP 缺失，请准备运行环境或修复应用"))?;
    if fs::read_to_string(root.join("manifest.json")).ok().as_deref()!=Some(MANIFEST) || fs::read_to_string(root.join("dbhub.toml")).ok().as_deref()!=Some(CONFIG) {return Err(workspace_error("INPUT_RUNTIME_INVALID","内置数据库 MCP 校验失败"));}
    let manifest:Value=serde_json::from_str(MANIFEST).map_err(|_|workspace_error("INPUT_RUNTIME_INVALID","数据库 MCP 清单无效"))?;
    for (name,digest) in manifest["files"].as_object().ok_or_else(||workspace_error("INPUT_RUNTIME_INVALID","数据库 MCP 清单无效"))? {
        if !Path::new(name).components().all(|part|matches!(part,Component::Normal(_))) {return Err(workspace_error("INPUT_RUNTIME_INVALID","数据库 MCP 清单路径无效"));}
        let bytes=fs::read(root.join(name)).map_err(|_|workspace_error("INPUT_RUNTIME_INVALID","内置数据库 MCP 文件缺失"))?;
        if format!("{:x}",Sha256::digest(bytes))!=digest.as_str().unwrap_or("") {return Err(workspace_error("INPUT_RUNTIME_INVALID","内置数据库 MCP 文件校验失败"));}
    }
    let _=VERIFIED.set(root.clone()); Ok(root)
}
fn sanitized_error(text:&str,code:Option<&str>)->AppError {
    let lower=text.to_ascii_lowercase();
    if code==Some("READONLY_VIOLATION") {return workspace_error("INPUT_READ_ONLY","当前数据连接用于读取，不执行写入 SQL");}
    // Startup diagnostics include DSN SSL settings even when the actual failure
    // is authentication. Match concrete credential errors before TLS settings.
    if lower.contains("authentication")||lower.contains("authenticate")||lower.contains("password")||lower.contains("access denied")||lower.contains("login failed")||lower.contains("ora-01017")||lower.contains("elogin") {return workspace_error("INPUT_AUTH_REQUIRED","数据库需要有效的认证信息，请在本机输入密码");}
    if lower.contains("certificate")||lower.contains("tls")||lower.contains("ssl") {return workspace_error("INPUT_TLS_FAILED","数据库加密连接失败，请检查连接方式和证书");}
    if lower.contains("timeout")||lower.contains("timed out") {return workspace_error("INPUT_TIMEOUT","数据库连接或查询超时，请检查网络或缩小查询");}
    workspace_error("INPUT_READ_FAILED","数据库读取失败，请检查地址、数据库、表和账号权限")
}

#[cfg(test)]
mod tests {
    use super::sanitized_error;
    #[test]
    fn missing_password_is_not_overridden_by_ssl_configuration_log() {
        let error=sanitized_error("sslmode=disable; MySQL: Access denied for user (using password: NO)",None);
        assert_eq!(error.code,"INPUT_AUTH_REQUIRED");
        assert!(!error.message.contains("Access denied"));
    }
    #[test]
    fn tls_verification_error_is_not_an_authentication_challenge() {
        assert_eq!(sanitized_error("TLS certificate verification failed: rejectUnauthorized=true",None).code,"INPUT_TLS_FAILED");
    }
}
pub(crate) struct Session {
    client:rmcp::service::RunningService<rmcp::RoleClient,()>, child:Child, stderr:JoinHandle<String>, calls:u32,
    _tls: Option<crate::sql_tls::Material>,
}
impl Drop for Session {fn drop(&mut self){let _=self.child.start_kill(); self.stderr.abort();}}
impl Session {
    pub(crate) async fn start(app:&AppHandle,root:&Path,dsn:&str,tls:Option<crate::sql_tls::Material>)->Result<Self,AppError>{
        let node=crate::codex_runtime::bundled_runtime(app).ok_or_else(||workspace_error("INPUT_RUNTIME_MISSING","内置 Node 运行环境缺失"))?.join("node.exe");
        let mut command=Command::new(node);
        command.arg(root.join("node_modules/@bytebase/dbhub/dist/index.js")).arg("--transport=stdio").arg(format!("--config={}",root.join("dbhub.toml").display()))
            .env_clear().env("GEOD_DBHUB_DSN",dsn).current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        for key in ["SYSTEMROOT","WINDIR","TEMP","TMP","APPDATA","LOCALAPPDATA"] {if let Some(value)=std::env::var_os(key){command.env(key,value);}}
        if let Some(tls) = &tls {
            command.env("GEOD_DBHUB_TLS_FILE", &tls.settings);
            if let Some(ca) = &tls.ca { command.env("NODE_EXTRA_CA_CERTS", ca); }
        }
        #[cfg(windows)] command.creation_flags(0x0800_0000);
        let mut child=command.spawn().map_err(|_|workspace_error("INPUT_RUNTIME_MISSING","无法启动内置数据库 MCP"))?;
        let stdout=child.stdout.take().unwrap();let stdin=child.stdin.take().unwrap();let mut err=child.stderr.take().unwrap();
        let mut stderr=tokio::spawn(async move {let mut retained=vec![];let mut chunk=[0u8;4096];while let Ok(size)=err.read(&mut chunk).await {if size==0{break;}let keep=size.min((65536usize).saturating_sub(retained.len()));retained.extend_from_slice(&chunk[..keep]);}String::from_utf8_lossy(&retained).into_owned()});
        let started=tokio::time::timeout(Duration::from_secs(25),().serve(AsyncRwTransport::new(stdout,stdin))).await;
        let client=match started {Ok(Ok(client))=>client,failed=>{let _=child.kill().await;let detail=tokio::time::timeout(Duration::from_secs(1),&mut stderr).await.ok().and_then(Result::ok).unwrap_or_default();stderr.abort();return Err(if failed.is_err(){workspace_error("INPUT_TIMEOUT","数据库连接超时")}else{sanitized_error(&detail,None)});}};
        let session=Self{client,child,stderr,calls:0,_tls:tls};
        let peer=session.client.peer_info().ok_or_else(||workspace_error("INPUT_RUNTIME_INVALID","数据库 MCP 未返回服务信息"))?;
        let info=peer.server_info.as_ref().ok_or_else(||workspace_error("INPUT_RUNTIME_INVALID","数据库 MCP 未返回服务信息"))?;
        if info.name!="DBHub MCP Server"||info.version!="1.4.0" {return Err(workspace_error("INPUT_RUNTIME_INVALID","数据库 MCP 版本不匹配"));}
        let tools=tokio::time::timeout(Duration::from_secs(10),session.client.list_tools(Default::default())).await.map_err(|_|workspace_error("INPUT_TIMEOUT","数据库工具发现超时"))?.map_err(|_|workspace_error("INPUT_READ_FAILED","数据库工具发现失败"))?;
        for name in ["execute_sql","search_objects"] {if !tools.tools.iter().any(|tool|tool.name==name){return Err(workspace_error("INPUT_RUNTIME_INVALID","数据库 MCP 缺少所需工具"));}}
        Ok(session)
    }
    pub(crate) async fn call(&mut self,name:&str,args:Value)->Result<Value,AppError>{
        if !["execute_sql","search_objects"].contains(&name){return Err(workspace_error("INPUT_INVALID","数据库工具名称无效"));}
        let reply=tokio::time::timeout(Duration::from_secs(25),self.client.call_tool(CallToolRequestParams::new(name.to_owned()).with_arguments(args.as_object().cloned().ok_or_else(||workspace_error("INPUT_INVALID","数据库参数无效"))?))).await.map_err(|_|workspace_error("INPUT_TIMEOUT","数据库查询超时，请缩小查询"))?.map_err(|_|workspace_error("INPUT_READ_FAILED","数据库 MCP 连接已中断"))?;
        self.calls+=1;
        let reply=serde_json::to_value(reply).map_err(|_|workspace_error("INPUT_READ_FAILED","数据库结果无效"))?;
        let text=reply["content"].as_array().into_iter().flatten().filter_map(|item|item["text"].as_str()).collect::<Vec<_>>().join("\n");
        if text.len()>2*1024*1024{return Err(workspace_error("INPUT_TOO_LARGE","数据库结果过大，请减少列、行数或查询范围"));}
        let value:Value=serde_json::from_str(&text).map_err(|_|workspace_error("INPUT_READ_FAILED","数据库 MCP 返回无效 JSON"))?;
        if reply["isError"]==true||value["success"]!=true {return Err(sanitized_error(value["error"].as_str().unwrap_or(""),value["code"].as_str()));}
        Ok(value["data"].clone())
    }
    pub(crate) fn metadata(&self)->Value {json!({"server":"DBHub MCP Server","version":"1.4.0","transport":"stdio","toolCalls":self.calls,"readOnly":true,"maxRows":500})}
}

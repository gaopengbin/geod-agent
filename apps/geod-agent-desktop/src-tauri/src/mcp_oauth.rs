//! MCP authorization uses the official SDK's discovery, PKCE and refresh logic.
//! Only the final credentials are committed to the Windows vault.
use crate::{extensions::ExtensionState, services, AppError};
use async_trait::async_trait;
use fs2::FileExt;
use rmcp::transport::auth::{AuthError,AuthorizationManager,AuthorizationRequest,AuthorizationSession,CredentialRefreshGuard,CredentialStore,InMemoryCredentialStore,OAuthHttpClient,OAuthHttpClientFuture,OAuthHttpRequest,StoredCredentials};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::BTreeMap,fs::OpenOptions,path::PathBuf,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use tauri::{AppHandle,Manager,State};
use tiny_http::{Header,Response,Server,StatusCode};
use uuid::Uuid;

fn error(code:&'static str,message:&str)->AppError{AppError{code,message:message.into()}}
fn auth_error(_:AuthError)->AppError{error("MCP_AUTH_REQUIRED","MCP 授权未完成或已失效，请在连接器中重新授权")}

#[derive(Clone)]
pub(crate) struct VaultStore {pub path:PathBuf,pub id:String}
impl VaultStore {
    fn entry(&self)->Result<keyring::Entry,AuthError>{keyring::Entry::new("GeoD-MCP-OAuth",&format!("{:x}:{}",Sha256::digest(self.path.to_string_lossy().as_bytes()),self.id)).map_err(|_|AuthError::CredentialStoreError("Vault unavailable".into()))}
}
#[async_trait]
impl CredentialStore for VaultStore {
    async fn load(&self)->Result<Option<StoredCredentials>,AuthError>{
        let store=self.clone();tauri::async_runtime::spawn_blocking(move||match store.entry()?.get_password(){
            Ok(value)=>serde_json::from_str(&value).map(Some).map_err(|_|AuthError::CredentialStoreError("Unreadable credential".into())),
            Err(keyring::Error::NoEntry)=>Ok(None),Err(_)=>Err(AuthError::CredentialStoreError("Vault read failed".into())),
        }).await.map_err(|_|AuthError::CredentialStoreError("Vault task failed".into()))?
    }
    async fn save(&self,credentials:StoredCredentials)->Result<(),AuthError>{
        let store=self.clone();tauri::async_runtime::spawn_blocking(move||{
            let value=serde_json::to_string(&credentials).map_err(|_|AuthError::CredentialStoreError("Credential invalid".into()))?;
            if value.len()>48*1024{return Err(AuthError::CredentialStoreError("Credential too large".into()));}
            store.entry()?.set_password(&value).map_err(|_|AuthError::CredentialStoreError("Vault write failed".into()))
        }).await.map_err(|_|AuthError::CredentialStoreError("Vault task failed".into()))?
    }
    async fn clear(&self)->Result<(),AuthError>{
        let store=self.clone();tauri::async_runtime::spawn_blocking(move||match store.entry()?.delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>Ok(()),Err(_)=>Err(AuthError::CredentialStoreError("Vault delete failed".into()))}).await.map_err(|_|AuthError::CredentialStoreError("Vault task failed".into()))?
    }
    async fn acquire_refresh_guard(&self)->Result<Option<CredentialRefreshGuard>,AuthError>{
        let path=self.path.with_file_name(format!("mcp-oauth-{}.lock",self.id));
        tauri::async_runtime::spawn_blocking(move||{
            let file=OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).map_err(|_|AuthError::CredentialStoreError("Lock unavailable".into()))?;
            file.lock_exclusive().map_err(|_|AuthError::CredentialStoreError("Lock failed".into()))?;
            Ok(Some(CredentialRefreshGuard::new(file)))
        }).await.map_err(|_|AuthError::CredentialStoreError("Lock task failed".into()))?
    }
}

struct NativeHttp;
impl OAuthHttpClient for NativeHttp {
    fn execute(&self,operation:OAuthHttpRequest)->OAuthHttpClientFuture<'_>{Box::pin(async move{
        let mut request=reqwest_mcp::Request::try_from(operation.request)?;
        let url=request.url();let host=url.host_str().unwrap_or("");
        if !url.username().is_empty()||url.password().is_some()||url.fragment().is_some()||!(url.scheme()=="https"||url.scheme()=="http"&&matches!(host,"localhost"|"127.0.0.1"|"::1"|"[::1]")){return Err(std::io::Error::other("OAuth endpoint must be HTTPS or loopback HTTP").into());}
        let origin=request.url().origin();
        for hop in 0..=6 {
            let client=crate::extensions::http_client(request.url().as_str()).map_err(|_|std::io::Error::other("OAuth network unavailable"))?;
            let replay=request.try_clone().ok_or_else(||std::io::Error::other("OAuth request cannot be replayed"))?;
            let mut response=client.execute(replay).await?;
            if response.status().is_redirection() && matches!(operation.redirect_policy,rmcp::transport::auth::OAuthHttpRedirectPolicy::Follow) {
                if hop==6 {return Err(std::io::Error::other("OAuth redirect limit").into());}
                let target=response.headers().get("location").and_then(|v|v.to_str().ok()).ok_or_else(||std::io::Error::other("Invalid OAuth redirect"))?;
                let target=request.url().join(target)?;
                if target.origin()!=origin {return Err(std::io::Error::other("Cross-origin OAuth redirect rejected").into());}
                if matches!(response.status().as_u16(),301|302|303) && request.method()!=reqwest_mcp::Method::GET {
                    *request.method_mut()=reqwest_mcp::Method::GET;*request.body_mut()=None;request.headers_mut().remove("content-length");request.headers_mut().remove("content-type");
                }
                *request.url_mut()=target;continue;
            }
            let mut result=http::Response::builder().status(response.status());
            for (key,value) in response.headers(){result=result.header(key,value);}
            let mut bytes=Vec::new();
            while let Some(chunk)=response.chunk().await?{if bytes.len()+chunk.len()>1024*1024{return Err(std::io::Error::other("OAuth response too large").into());}bytes.extend_from_slice(&chunk);}
            return Ok(result.body(bytes)?);
        }
        Err(std::io::Error::other("OAuth request failed").into())
    })}
}
pub(crate) async fn manager(path:PathBuf,id:String,url:&str)->Result<AuthorizationManager,AppError>{
    let mut manager=AuthorizationManager::new_with_oauth_http_client(url,Arc::new(NativeHttp)).await.map_err(auth_error)?;
    manager.set_credential_store(VaultStore{path,id});
    if !manager.initialize_from_store().await.map_err(auth_error)?{return Err(error("MCP_AUTH_REQUIRED","此 MCP 需要浏览器授权"));}
    Ok(manager)
}

struct Pending {owner:String,connector_id:String,state:&'static str,message:String,authorization_url:String,cancelled:Arc<AtomicBool>,created:Instant}
#[derive(Default)]
pub(crate) struct OAuthState {pending:Arc<Mutex<BTreeMap<String,Pending>>>}
impl OAuthState {
    pub(crate) fn abort_connector(&self,id:&str,owner:&str)->Result<(),AppError>{
        let mut values=self.pending.lock().map_err(|_|error("MCP_AUTH_BUSY","授权状态暂时不可用"))?;
        if values.values().any(|value|value.connector_id==id&&value.owner==owner&&value.state=="saving"){return Err(error("MCP_AUTH_BUSY","授权正在保存，请稍后再操作"));}
        for value in values.values_mut().filter(|value|value.connector_id==id&&value.owner==owner&&value.state=="waiting"){value.cancelled.store(true,Ordering::Release);value.state="cancelled";value.message="授权已取消".into();}
        Ok(())
    }
}
fn public(id:&str,pending:&Pending)->Value{json!({"authorizationId":id,"connectorId":pending.connector_id,"state":pending.state,"message":pending.message})}

#[tauri::command]
pub(crate) async fn mcp_oauth_start(app:AppHandle,state:State<'_,OAuthState>,id:String,client_id:Option<String>,scopes:Option<Vec<String>>)->Result<Value,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    let extensions=app.state::<ExtensionState>();
    let (path,url)=extensions.oauth_target(&id,&owner)?;
    let scopes=scopes.unwrap_or_default();
    if scopes.len()>20||scopes.iter().any(|v|v.is_empty()||v.len()>200||v.chars().any(char::is_whitespace)){return Err(error("MCP_AUTH_INVALID","授权范围格式无效"));}
    if client_id.as_ref().is_some_and(|v|v.is_empty()||v.len()>2048){return Err(error("MCP_AUTH_INVALID","客户端 ID 无效"));}
    let server=Server::http("127.0.0.1:0").map_err(|_|error("MCP_AUTH_CALLBACK","无法准备本机授权回调"))?;
    let address=server.server_addr().to_ip().ok_or_else(||error("MCP_AUTH_CALLBACK","本机授权回调无效"))?;
    let redirect=format!("http://127.0.0.1:{}/callback",address.port());
    let memory=InMemoryCredentialStore::new();
    let mut manager=AuthorizationManager::new_with_oauth_http_client(&url,Arc::new(NativeHttp)).await.map_err(auth_error)?;
    manager.set_credential_store(memory.clone());
    let resolution=manager.resolve_metadata().await.map_err(auth_error)?;
    let expected_issuer=resolution.metadata.issuer.clone();
    let require_issuer=resolution.metadata.additional_fields.get("authorization_response_iss_parameter_supported").and_then(Value::as_bool)==Some(true);
    manager.set_metadata(resolution.metadata);
    let mut request=AuthorizationRequest::new(&redirect).with_client_name("GeoD Agent").with_scopes(scopes);
    if let Some(client_id)=client_id {request=request.with_preregistered_client(client_id);}
    let session=AuthorizationSession::new(manager,request).await.map_err(|(_,e)|auth_error(e))?;
    let authorization_url=session.get_authorization_url().to_owned();
    let expected_state=reqwest_mcp::Url::parse(&authorization_url).map_err(|_|error("MCP_AUTH_INVALID","授权地址无效"))?.query_pairs().find(|(key,_)|key=="state").map(|(_,value)|value.into_owned()).ok_or_else(||error("MCP_AUTH_INVALID","授权流程缺少校验值"))?;
    let authorization_id=Uuid::new_v4().to_string();let cancelled=Arc::new(AtomicBool::new(false));
    let pending=state.pending.clone();
    {
        let mut values=pending.lock().map_err(|_|error("MCP_AUTH_BUSY","授权状态暂时不可用"))?;
        values.retain(|_,value|value.created.elapsed()<Duration::from_secs(600));
        if values.values().any(|value|value.connector_id==id&&matches!(value.state,"waiting"|"saving")){return Err(error("MCP_AUTH_BUSY","此连接器已有待完成的授权"));}
        if values.len()>=16{return Err(error("MCP_AUTH_BUSY","待处理授权较多，请先完成或取消"));}
        values.insert(authorization_id.clone(),Pending{owner:owner.clone(),connector_id:id.clone(),state:"waiting",message:"请在浏览器中完成授权".into(),authorization_url:authorization_url.clone(),cancelled:cancelled.clone(),created:Instant::now()});
    }
    let aid=authorization_id.clone();let reply_id=id.clone();
    std::thread::spawn(move||{
        let deadline=Instant::now()+Duration::from_secs(300);
        let mut outcome=Err(error("MCP_AUTH_TIMEOUT","授权超时，请重新发起"));
        while Instant::now()<deadline&&!cancelled.load(Ordering::Acquire) {
            let Ok(Some(request))=server.recv_timeout(Duration::from_millis(100)) else{continue;};
            let callback=reqwest_mcp::Url::parse(&format!("http://127.0.0.1:{}{}",address.port(),request.url()));
            let valid=callback.as_ref().is_ok_and(|url|{
                let issuer=url.query_pairs().find(|(key,_)|key=="iss").map(|(_,value)|value.into_owned());
                let issuer_valid=if let Some(issuer)=issuer{Some(issuer)==expected_issuer}else{!require_issuer};
                let code=url.query_pairs().filter(|(key,_)|key=="code").count();let denied=url.query_pairs().filter(|(key,_)|key=="error").count();
                url.path()=="/callback"&&url.query_pairs().filter(|(key,_)|key=="state").count()==1&&url.query_pairs().any(|(key,value)|key=="state"&&value==expected_state)&&issuer_valid&&url.query_pairs().filter(|(key,_)|key=="iss").count()<=1&&((code==1&&denied==0)||(code==0&&denied==1))
            })
                && request.method()==&tiny_http::Method::Get
                && !request.headers().iter().any(|h|h.field.equiv("Origin"))
                && request.headers().iter().any(|h|h.field.equiv("Host")&&h.value.as_str()==address.to_string());
            if !valid {let _=request.respond(Response::from_string("Invalid authorization callback").with_status_code(StatusCode(400)));continue;}
            let callback=callback.unwrap();
            if callback.query_pairs().any(|(k,_)|k=="error") {
                outcome=Err(error("MCP_AUTH_DENIED","浏览器授权未获批准"));
            } else {
                outcome=tauri::async_runtime::block_on(async{
                    session.handle_callback_url(callback.as_str()).await.map_err(auth_error)?;
                    let credentials=memory.load().await.map_err(auth_error)?.ok_or_else(||error("MCP_AUTH_REQUIRED","未获得授权凭据"))?;
                    let store=VaultStore{path:path.clone(),id:id.clone()};
                    let _guard=store.acquire_refresh_guard().await.map_err(auth_error)?;
                    if cancelled.load(Ordering::Acquire){return Err(error("MCP_AUTH_CANCELLED","授权已取消"));}
                    let current=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
                    if current!=owner{return Err(error("MCP_AUTH_CANCELLED","账号已切换，授权未保存"));}
                    {let mut values=pending.lock().map_err(|_|error("MCP_AUTH_BUSY","授权状态暂时不可用"))?;if cancelled.load(Ordering::Acquire){return Err(error("MCP_AUTH_CANCELLED","授权已取消"));}values.get_mut(&aid).unwrap().state="saving";}
                    let previous=store.load().await.map_err(auth_error)?;
                    store.save(credentials).await.map_err(auth_error)?;
                    if let Err(error)=app.state::<ExtensionState>().activate_oauth(&id,&owner,true){
                        if error.code!="MCP_NOT_FOUND" {if let Some(previous)=previous {let _=store.save(previous).await;}else{let _=store.clear().await;}}else{let _=store.clear().await;}
                        return Err(error);
                    }
                    Ok(())
                });
            }
            let text=if outcome.is_ok(){"GeoD Agent authorization completed. You may close this page."}else{"GeoD Agent authorization was not saved. Return to the app and retry."};
            let _=request.respond(Response::from_string(text).with_header(Header::from_bytes("Cache-Control","no-store").unwrap()).with_header(Header::from_bytes("Content-Security-Policy","default-src 'none'").unwrap()));
            break;
        }
        if let Ok(mut values)=pending.lock(){if let Some(value)=values.get_mut(&aid){
            if cancelled.load(Ordering::Acquire){value.state="cancelled";value.message="授权已取消".into();}
            else{match outcome{Ok(())=>{value.state="authorized";value.message="授权已保存".into();},Err(error)=>{value.state="failed";value.message=error.message;}}}
        }}
    });
    Ok(json!({"authorizationId":authorization_id,"connectorId":reply_id,"state":"waiting","authorizationUrl":authorization_url}))
}

#[tauri::command]
pub(crate) fn mcp_oauth_pending(app:AppHandle,state:State<'_,OAuthState>,id:String)->Result<Option<Value>,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    app.state::<ExtensionState>().oauth_target(&id,&owner)?;
    let values=state.pending.lock().map_err(|_|error("MCP_AUTH_BUSY","授权状态暂时不可用"))?;
    Ok(values.iter().filter(|(_,v)|v.owner==owner&&v.connector_id==id&&matches!(v.state,"waiting"|"saving")).max_by_key(|(_,v)|v.created).map(|(key,value)|public(key,value)))
}
#[tauri::command]
pub(crate) fn mcp_oauth_status(app:AppHandle,state:State<'_,OAuthState>,authorization_id:String)->Result<Value,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    let values=state.pending.lock().map_err(|_|error("MCP_AUTH_BUSY","授权状态暂时不可用"))?;
    let value=values.get(&authorization_id).filter(|value|value.owner==owner).ok_or_else(||error("MCP_AUTH_NOT_FOUND","未找到此授权"))?;
    Ok(public(&authorization_id,value))
}
#[tauri::command]
pub(crate) fn mcp_oauth_open(app:AppHandle,state:State<'_,OAuthState>,authorization_id:String)->Result<(),AppError>{
    use tauri_plugin_opener::OpenerExt;
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    let values=state.pending.lock().map_err(|_|error("MCP_AUTH_BUSY","授权状态暂时不可用"))?;
    let value=values.get(&authorization_id).filter(|value|value.owner==owner&&value.state=="waiting").ok_or_else(||error("MCP_AUTH_NOT_FOUND","授权已结束，请重新发起"))?;
    let url=reqwest_mcp::Url::parse(&value.authorization_url).map_err(|_|error("MCP_AUTH_INVALID","授权地址无效"))?;
    let host=url.host_str().unwrap_or("");
    if !url.username().is_empty()||url.password().is_some()||url.fragment().is_some()||!(url.scheme()=="https"||url.scheme()=="http"&&matches!(host,"localhost"|"127.0.0.1"|"::1"|"[::1]")){return Err(error("MCP_AUTH_INVALID","授权地址必须使用 HTTPS 或本机 HTTP"));}
    app.opener().open_url(url.as_str(),None::<String>).map_err(|_|error("MCP_AUTH_BROWSER","无法打开授权浏览器，请检查系统默认浏览器"))
}
#[tauri::command]
pub(crate) fn mcp_oauth_cancel(app:AppHandle,state:State<'_,OAuthState>,authorization_id:String)->Result<Value,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    let mut values=state.pending.lock().map_err(|_|error("MCP_AUTH_BUSY","授权状态暂时不可用"))?;
    let value=values.get_mut(&authorization_id).filter(|value|value.owner==owner).ok_or_else(||error("MCP_AUTH_NOT_FOUND","未找到此授权"))?;
    if value.state=="waiting"{value.cancelled.store(true,Ordering::Release);value.state="cancelled";value.message="授权已取消".into();}
    Ok(public(&authorization_id,value))
}
#[tauri::command]
pub(crate) async fn mcp_oauth_disconnect(app:AppHandle,id:String)->Result<Value,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    let (path,_)=app.state::<ExtensionState>().oauth_target(&id,&owner)?;
    app.state::<OAuthState>().abort_connector(&id,&owner)?;
    let store=VaultStore{path,id:id.clone()};
    let _guard=store.acquire_refresh_guard().await.map_err(auth_error)?;
    store.clear().await.map_err(auth_error)?;
    app.state::<ExtensionState>().activate_oauth(&id,&owner,false)?;
    Ok(json!({"disconnected":true}))
}

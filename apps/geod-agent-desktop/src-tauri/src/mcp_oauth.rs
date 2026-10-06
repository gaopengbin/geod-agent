//! MCP authorization uses the official SDK's discovery, PKCE and refresh logic.
//! Only the final credentials are committed to the Windows vault.
use crate::{extensions::ExtensionState, services, AppError};
use async_trait::async_trait;
use fs2::FileExt;
use rmcp::transport::auth::{AuthError,AuthorizationManager,AuthorizationRequest,AuthorizationSession,CredentialRefreshGuard,CredentialStore,InMemoryCredentialStore,OAuthClientConfig,OAuthHttpClient,OAuthHttpClientFuture,OAuthHttpRequest,StoredCredentials};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use oauth2::TokenResponse;
use base64::Engine;
use sha2::{Digest,Sha256};
use std::{collections::BTreeMap,fs::OpenOptions,io::Write,path::PathBuf,sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},time::{Duration,Instant}};
use tauri::{AppHandle,Manager,State};
use tiny_http::Server;
use uuid::Uuid;

fn error(code:&'static str,message:&str)->AppError{AppError{code,message:message.into()}}
fn auth_error(_:AuthError)->AppError{error("MCP_AUTH_REQUIRED","MCP 授权未完成或已失效，请在连接器中重新授权")}
fn callback_reply(request:tiny_http::Request,status:u16,text:&str){
    // tiny_http ignores Connection headers on Response. A fixed callback port
    // needs a closing response so browsers cannot reuse a finished listener.
    let mut writer=request.into_writer();
    let reason=if status==400{"Bad Request"}else{"OK"};
    let _=write!(writer,"HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\n\r\n{text}",text.len());
    let _=writer.flush();
}

#[derive(Clone)]
pub(crate) struct VaultStore {pub path:PathBuf,pub id:String}
#[derive(Serialize,Deserialize)]
struct ClientIdentity {client_id:String,client_secret:String,redirect_uri:String,issuer:Option<String>}
impl ClientIdentity {
    fn matches(&self,credentials:&StoredCredentials)->bool{self.client_id==credentials.client_id&&self.issuer==credentials.issuer}
}
impl Drop for ClientIdentity {fn drop(&mut self){use zeroize::Zeroize;self.client_secret.zeroize();}}
// The SDK stores tokens only. Keep configured client credentials in the same
// vault entry so token rotation cannot discard them, and read legacy entries.
#[derive(Serialize,Deserialize)]
#[serde(untagged)]
enum SavedAuthorization {Configured{credentials:StoredCredentials,client:ClientIdentity},Legacy(StoredCredentials)}
impl VaultStore {
    fn entry(&self)->Result<keyring::Entry,AuthError>{keyring::Entry::new("GeoD-MCP-OAuth",&format!("{:x}:{}",Sha256::digest(self.path.to_string_lossy().as_bytes()),self.id)).map_err(|_|AuthError::CredentialStoreError("Vault unavailable".into()))}
    fn read(&self)->Result<Option<SavedAuthorization>,AuthError>{match self.entry()?.get_password(){
        Ok(value)=>{let value=zeroize::Zeroizing::new(value);serde_json::from_str(&value).map(Some).map_err(|_|AuthError::CredentialStoreError("Unreadable credential".into()))},
        Err(keyring::Error::NoEntry)=>Ok(None),Err(_)=>Err(AuthError::CredentialStoreError("Vault read failed".into())),
    }}
    fn write(&self,saved:SavedAuthorization)->Result<(),AuthError>{
        let value=zeroize::Zeroizing::new(serde_json::to_string(&saved).map_err(|_|AuthError::CredentialStoreError("Credential invalid".into()))?);
        if value.len()>48*1024{return Err(AuthError::CredentialStoreError("Credential too large".into()));}
        self.entry()?.set_password(&value).map_err(|_|AuthError::CredentialStoreError("Vault write failed".into()))
    }
    async fn snapshot(&self)->Result<Option<SavedAuthorization>,AuthError>{
        let store=self.clone();tauri::async_runtime::spawn_blocking(move||store.read()).await.map_err(|_|AuthError::CredentialStoreError("Vault task failed".into()))?
    }
    async fn restore(&self,saved:SavedAuthorization)->Result<(),AuthError>{
        let store=self.clone();tauri::async_runtime::spawn_blocking(move||store.write(saved)).await.map_err(|_|AuthError::CredentialStoreError("Vault task failed".into()))?
    }
    async fn configured_client(&self)->Result<Option<OAuthClientConfig>,AuthError>{
        match self.snapshot().await? {
            Some(SavedAuthorization::Configured{credentials,client})=>{
                if !client.matches(&credentials){return Err(AuthError::CredentialStoreError("OAuth client binding changed".into()));}
                Ok(Some(OAuthClientConfig::new(&client.client_id,&client.redirect_uri).with_client_secret(&client.client_secret).with_scopes(credentials.granted_scopes)))
            },
            _=>Ok(None),
        }
    }
}
#[async_trait]
impl CredentialStore for VaultStore {
    async fn load(&self)->Result<Option<StoredCredentials>,AuthError>{
        Ok(self.snapshot().await?.map(|saved|match saved{SavedAuthorization::Configured{credentials,..}|SavedAuthorization::Legacy(credentials)=>credentials}))
    }
    async fn save(&self,credentials:StoredCredentials)->Result<(),AuthError>{
        let store=self.clone();tauri::async_runtime::spawn_blocking(move||{
            let saved=match store.read()?{Some(SavedAuthorization::Configured{client,..}) if client.matches(&credentials)=>SavedAuthorization::Configured{credentials,client},_=>SavedAuthorization::Legacy(credentials)};
            store.write(saved)
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
    let store=VaultStore{path,id};manager.set_credential_store(store.clone());
    if !manager.initialize_from_store().await.map_err(auth_error)?{return Err(error("MCP_AUTH_REQUIRED","此 MCP 需要浏览器授权"));}
    if let Some(client)=store.configured_client().await.map_err(auth_error)?{manager.configure_client(client).map_err(auth_error)?;}
    Ok(manager)
}

#[derive(Clone,Copy,Serialize)]
#[serde(rename_all="camelCase")]
enum Revocation {Revoked,Partial,Unsupported,Unavailable,NoCredentials}
impl Revocation {
    fn message(self)->&'static str{match self{
        Self::Revoked=>"已断开本机授权，服务端令牌撤销请求已确认",
        Self::Partial=>"已断开本机授权，部分服务端令牌撤销未获确认；可在提供方账号设置中核对",
        Self::Unsupported=>"已断开本机授权；提供方未提供可用的撤权接口，可在其账号设置中撤销",
        Self::Unavailable=>"已断开本机授权；服务端撤权未获确认，可在提供方账号设置中撤销",
        Self::NoCredentials=>"本机授权已移除",
    }}
}
async fn revoke_saved(url:&str,saved:Option<&SavedAuthorization>)->Revocation{
    let (credentials,secret)=match saved{
        Some(SavedAuthorization::Configured{credentials,client}) if client.matches(credentials)=>(credentials,Some(client.client_secret.as_str())),
        Some(SavedAuthorization::Configured{..})=>return Revocation::Unavailable,
        Some(SavedAuthorization::Legacy(credentials))=>(credentials,None),
        None=>return Revocation::NoCredentials,
    };
    let Some(tokens)=credentials.token_response.as_ref()else{return Revocation::NoCredentials;};
    // Bind rediscovery to the issuer that issued the stored tokens. Never
    // synthesize an endpoint or send them to a newly substituted issuer.
    let Some(issuer)=credentials.issuer.as_ref()else{return Revocation::Unavailable;};
    let Ok(manager)=AuthorizationManager::new_with_oauth_http_client(url,Arc::new(NativeHttp)).await else{return Revocation::Unavailable;};
    let Ok(resolution)=manager.resolve_metadata().await else{return Revocation::Unavailable;};
    if !resolution.source.is_discovered()||resolution.metadata.issuer.as_ref()!=Some(issuer){return Revocation::Unavailable;}
    let fields=&resolution.metadata.additional_fields;
    let Some(endpoint)=fields.get("revocation_endpoint").and_then(Value::as_str)else{return Revocation::Unsupported;};
    let Ok(endpoint_url)=reqwest_mcp::Url::parse(endpoint)else{return Revocation::Unavailable;};
    let loopback_http=endpoint_url.scheme()=="http"&&matches!(endpoint_url.host_str(),Some("localhost"|"127.0.0.1"|"::1"|"[::1]"))&&reqwest_mcp::Url::parse(issuer).is_ok_and(|url|url.origin()==endpoint_url.origin());
    if !endpoint_url.username().is_empty()||endpoint_url.password().is_some()||endpoint_url.fragment().is_some()||!(endpoint_url.scheme()=="https"||loopback_http){return Revocation::Unavailable;}
    let methods=fields.get("revocation_endpoint_auth_methods_supported").and_then(Value::as_array);
    let has=|method:&str|methods.is_some_and(|values|values.iter().any(|value|value.as_str()==Some(method)));
    let basic_auth=if secret.is_some(){
        if methods.is_none()||has("client_secret_basic"){true}
        else if has("client_secret_post"){false}
        else{return Revocation::Unsupported;}
    }else{
        if methods.is_some()&&!has("none")&&!has("client_secret_basic")&&!has("client_secret_post"){return Revocation::Unsupported;}
        false
    };
    let Ok(network)=crate::extensions::http_client(endpoint)else{return Revocation::Unavailable;};
    let mut requests=Vec::new();
    if let Some(token)=tokens.refresh_token(){requests.push((token.secret().as_str(),"refresh_token"));}
    requests.push((tokens.access_token().secret().as_str(),"access_token"));
    let total=requests.len();let mut confirmed=0;
    for (token,hint) in requests{
        let request={
        let mut form=url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("token",token).append_pair("token_type_hint",hint);
        let mut request=network.post(endpoint).header("content-type","application/x-www-form-urlencoded");
        if basic_auth{
            // RFC 6749 encodes each component before joining it for HTTP Basic.
            let encode=|text:&str|url::form_urlencoded::byte_serialize(text.as_bytes()).collect::<String>();
            let identity=zeroize::Zeroizing::new(format!("{}:{}",encode(&credentials.client_id),encode(secret.unwrap())));
            request=request.header("authorization",format!("Basic {}",base64::engine::general_purpose::STANDARD.encode(identity.as_bytes())));
        }else{
            form.append_pair("client_id",&credentials.client_id);
            if let Some(secret)=secret{form.append_pair("client_secret",secret);}
        }
        let body=zeroize::Zeroizing::new(form.finish());
        request.body(body.to_string())
        };
        // RFC 7009 success is conveyed by HTTP 200; ignore provider bodies.
        // The shared native client never follows redirects.
        if request.send().await.is_ok_and(|response|response.status().as_u16()==200){confirmed+=1;}
    }
    if confirmed==total{Revocation::Revoked}else if confirmed>0{Revocation::Partial}else{Revocation::Unavailable}
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
pub(crate) async fn mcp_oauth_start(app:AppHandle,state:State<'_,OAuthState>,id:String,client_id:Option<String>,scopes:Option<Vec<String>>,client_secret:Option<String>,callback_port:Option<u16>)->Result<Value,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    let extensions=app.state::<ExtensionState>();
    let (path,url)=extensions.oauth_target(&id,&owner)?;
    let scopes=scopes.unwrap_or_default();
    if scopes.len()>20||scopes.iter().any(|v|v.is_empty()||v.len()>200||v.chars().any(char::is_whitespace)){return Err(error("MCP_AUTH_INVALID","授权范围格式无效"));}
    if client_id.as_ref().is_some_and(|v|v.is_empty()||v.len()>2048){return Err(error("MCP_AUTH_INVALID","客户端 ID 无效"));}
    let client_secret=client_secret.filter(|value|!value.is_empty()).map(zeroize::Zeroizing::new);
    if client_secret.as_ref().is_some_and(|value|value.len()>8192||value.contains('\0')){return Err(error("MCP_AUTH_INVALID","客户端密钥格式无效"));}
    if client_secret.is_some()&&client_id.is_none(){return Err(error("MCP_AUTH_INVALID","填写客户端密钥时，请同时提供客户端 ID"));}
    if callback_port==Some(0){return Err(error("MCP_AUTH_INVALID","本机回调端口必须为 1 到 65535"));}
    let server=Server::http(("127.0.0.1",callback_port.unwrap_or(0))).map_err(|_|error("MCP_AUTH_CALLBACK","无法准备本机授权回调，请检查端口是否被占用"))?;
    let address=server.server_addr().to_ip().ok_or_else(||error("MCP_AUTH_CALLBACK","本机授权回调无效"))?;
    let redirect=format!("http://127.0.0.1:{}/callback",address.port());
    let memory=InMemoryCredentialStore::new();
    let mut manager=AuthorizationManager::new_with_oauth_http_client(&url,Arc::new(NativeHttp)).await.map_err(auth_error)?;
    manager.set_credential_store(memory.clone());
    let resolution=manager.resolve_metadata().await.map_err(auth_error)?;
    let expected_issuer=resolution.metadata.issuer.clone();
    let require_issuer=resolution.metadata.additional_fields.get("authorization_response_iss_parameter_supported").and_then(Value::as_bool)==Some(true);
    manager.set_metadata(resolution.metadata);
    let configured_client=client_secret.as_ref().map(|secret|ClientIdentity{client_id:client_id.as_ref().unwrap().clone(),client_secret:secret.to_string(),redirect_uri:redirect.clone(),issuer:expected_issuer.clone()});
    let mut request=AuthorizationRequest::new(&redirect).with_client_name("GeoD Agent").with_scopes(scopes);
    if let Some(client_id)=client_id {request=request.with_preregistered_client(client_id);}
    if let Some(secret)=client_secret {request=request.with_client_secret(secret.as_str());}
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
            if !valid {callback_reply(request,400,"Invalid authorization callback");continue;}
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
                    let previous=store.snapshot().await.map_err(auth_error)?;
                    let saved=if let Some(client)=configured_client{if !client.matches(&credentials){return Err(error("MCP_AUTH_REQUIRED","MCP 授权身份与客户端配置不一致，请重新授权"));}SavedAuthorization::Configured{credentials,client}}else{SavedAuthorization::Legacy(credentials)};
                    store.restore(saved).await.map_err(auth_error)?;
                    if let Err(error)=app.state::<ExtensionState>().activate_oauth(&id,&owner,true){
                        if error.code!="MCP_NOT_FOUND" {if let Some(previous)=previous {let _=store.restore(previous).await;}else{let _=store.clear().await;}}else{let _=store.clear().await;}
                        return Err(error);
                    }
                    Ok(())
                });
            }
            let text=if outcome.is_ok(){"GeoD Agent authorization completed. You may close this page."}else{"GeoD Agent authorization was not saved. Return to the app and retry."};
            callback_reply(request,200,text);
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
    let (path,url)=app.state::<ExtensionState>().oauth_target(&id,&owner)?;
    app.state::<OAuthState>().abort_connector(&id,&owner)?;
    let store=VaultStore{path,id:id.clone()};
    let _guard=store.acquire_refresh_guard().await.map_err(auth_error)?;
    let saved=store.snapshot().await;
    store.clear().await.map_err(auth_error)?;
    app.state::<ExtensionState>().activate_oauth(&id,&owner,false)?;
    let revocation=match saved{
        Ok(saved)=>tokio::time::timeout(Duration::from_secs(10),revoke_saved(&url,saved.as_ref())).await.unwrap_or(Revocation::Unavailable),
        Err(_)=>Revocation::Unavailable,
    };
    Ok(json!({"disconnected":true,"revocation":revocation,"message":revocation.message()}))
}

use crate::services::{self, ServiceError};
use rmcp::{ClientHandler, RoleClient, model::{ClientConfig, ElicitRequestParams, ElicitResult, ElicitationAction}, service::RequestContext};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

fn error(code:&'static str,message:&str)->ServiceError{ServiceError{code,message:message.into()}}
struct Pending{owner:String,conversation:String,scope:String,request:Value,opened:bool,reply:Option<oneshot::Sender<ElicitResult>>}
#[derive(Default)]
pub(crate) struct McpInteractions{pending:Mutex<HashMap<String,Pending>>}

pub(crate) fn browser_url(value:&str)->Result<reqwest::Url,ServiceError>{
    let url=reqwest::Url::parse(value).map_err(|_|error("MCP_BROWSER_URL","连接器返回了无效的浏览器地址"))?;
    let loopback=url.host_str().is_some_and(|host|matches!(host,"localhost"|"127.0.0.1"|"[::1]"|"::1"));
    if value.len()>8192||url.host_str().is_none()||!(url.scheme()=="https"||url.scheme()=="http"&&loopback)||!url.username().is_empty()||url.password().is_some(){return Err(error("MCP_BROWSER_URL","浏览器流程仅支持 HTTPS 或本机 HTTP 地址"));}
    Ok(url)
}

pub(crate) fn register_codex(app:&AppHandle,owner:&str,conversation:&str,scope:&str,value:&Value){
    if value["type"]!="request"||value["method"]!="mcpServer/elicitation/request"||!matches!(value["params"]["mode"].as_str(),Some("url"|"openai/userVerification")){return;}
    let Some(id)=value["requestId"].as_str()else{return;};
    app.state::<McpInteractions>().pending.lock().unwrap().insert(id.into(),Pending{owner:owner.into(),conversation:conversation.into(),scope:scope.into(),request:value.clone(),opened:false,reply:None});
}
pub(crate) fn dismiss_scope(app:&AppHandle,scope:&str){
    app.state::<McpInteractions>().pending.lock().unwrap().retain(|_,request|request.scope!=scope);
    let _=app.emit("geod:mcp-requests-changed",());
}
fn validate_interaction_reply(request:&Pending,owner:&str,scope:&str,command:&Value)->Result<(),ServiceError>{
    if request.owner!=owner||request.scope!=scope{return Err(error("MCP_REQUEST_GONE","此授权请求已失效"));}
    if command["value"]["action"]=="accept"{
        if request.request["params"]["mode"]=="openai/userVerification"{return Err(error("MCP_VERIFICATION_UNAVAILABLE","当前引擎未向 GeoD 开放此设备身份验证方式"));}
        if !request.opened{return Err(error("MCP_BROWSER_NOT_OPENED","请先打开连接器的浏览器页面"));}
    }
    Ok(())
}
pub(crate) fn validate_codex_reply(app:&AppHandle,owner:&str,scope:&str,command:&Value)->Result<(),ServiceError>{
    if command["type"]!="response"{return Ok(());}
    let Some(id)=command["requestId"].as_str()else{return Ok(());};
    let state=app.state::<McpInteractions>();let mut pending=state.pending.lock().unwrap();
    if let Some(request)=pending.get(id){
        validate_interaction_reply(request,owner,scope,command)?;
        pending.remove(id);
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn mcp_request_open_browser(app:AppHandle,services:State<'_,services::ServiceState>,request_id:String)->Result<Value,ServiceError>{
    let owner=services::current_user_id(&services)?;
    let state=app.state::<McpInteractions>();let mut pending=state.pending.lock().unwrap();
    let request=pending.get_mut(&request_id).filter(|request|request.owner==owner).ok_or_else(||error("MCP_REQUEST_GONE","此授权请求已失效"))?;
    let url=browser_url(request.request["params"]["url"].as_str().unwrap_or(""))?;
    app.opener().open_url(url.as_str(),None::<&str>).map_err(|_|error("MCP_BROWSER_OPEN_FAILED","无法打开系统浏览器，请重试"))?;
    request.opened=true;
    Ok(json!({"opened":true}))
}
#[tauri::command]
pub(crate) fn mcp_requests_pending(app:AppHandle,services:State<'_,services::ServiceState>,conversation_id:String)->Result<Value,ServiceError>{
    let owner=services::current_user_id(&services)?;
    let requests:Vec<_>=app.state::<McpInteractions>().pending.lock().unwrap().values().filter(|request|request.owner==owner&&request.conversation==conversation_id&&request.reply.is_some()).map(|request|request.request.clone()).collect();
    Ok(json!(requests))
}
#[tauri::command]
pub(crate) fn mcp_request_reply(app:AppHandle,services:State<'_,services::ServiceState>,request_id:String,value:Value)->Result<(),ServiceError>{
    let owner=services::current_user_id(&services)?;
    let result: ElicitResult=serde_json::from_value(value).map_err(|_|error("MCP_REPLY_INVALID","连接器回复格式无效"))?;
    let state=app.state::<McpInteractions>();let mut pending=state.pending.lock().unwrap();
    let request=pending.get(&request_id).filter(|request|request.owner==owner&&request.reply.is_some()).ok_or_else(||error("MCP_REQUEST_GONE","此连接器请求已失效"))?;
    if request.request["params"]["mode"]=="url"&&result.action==ElicitationAction::Accept&&!request.opened{return Err(error("MCP_BROWSER_NOT_OPENED","请先打开连接器的浏览器页面"));}
    if let Some(mut request)=pending.remove(&request_id){let _=request.reply.take().unwrap().send(result);}
    drop(pending);let _=app.emit("geod:mcp-requests-changed",());Ok(())
}
#[tauri::command]
pub(crate) fn mcp_requests_cancel(app:AppHandle,services:State<'_,services::ServiceState>,conversation_id:String)->Result<(),ServiceError>{
    let owner=services::current_user_id(&services)?;let state=app.state::<McpInteractions>();let mut pending=state.pending.lock().unwrap();
    let ids:Vec<_>=pending.iter().filter(|(_,request)|request.owner==owner&&request.conversation==conversation_id&&request.reply.is_some()).map(|(id,_)|id.clone()).collect();
    for id in ids{if let Some(mut request)=pending.remove(&id){if let Some(reply)=request.reply.take(){let _=reply.send(ElicitResult::new(ElicitationAction::Cancel));}}}
    drop(pending);let _=app.emit("geod:mcp-requests-changed",());Ok(())
}

#[derive(Clone)]
pub(crate) struct InteractiveMcp{pub app:AppHandle,pub owner:String,pub conversation:String,pub scope:String,pub connector:String}
#[derive(Clone,Default)]
pub(crate) struct McpClient{pub interactive:Option<InteractiveMcp>}
struct PendingGuard{app:AppHandle,id:String}
impl Drop for PendingGuard{fn drop(&mut self){self.app.state::<McpInteractions>().pending.lock().unwrap().remove(&self.id);let _=self.app.emit("geod:mcp-requests-changed",());}}
impl ClientHandler for McpClient{
    fn get_info(&self)->ClientConfig{
        let mut config=ClientConfig::default();
        if self.interactive.is_some(){config.capabilities.elicitation=Some(serde_json::from_value(json!({"form":{},"url":{}})).unwrap());}
        config
    }
    async fn create_elicitation(&self,request:ElicitRequestParams,_context:RequestContext<RoleClient>)->Result<ElicitResult,rmcp::ErrorData>{
        let Some(context)=self.interactive.as_ref()else{return Err(rmcp::ErrorData::internal_error("MCP_USER_REQUIRED: 请在对话中完成连接器授权",None));};
        if services::current_user_id(&context.app.state()).ok().as_deref()!=Some(context.owner.as_str()){return Ok(ElicitResult::new(ElicitationAction::Cancel));}
        let id=uuid::Uuid::new_v4().to_string();let params=serde_json::to_value(request).map_err(|_|rmcp::ErrorData::internal_error("无法读取连接器请求",None))?;
        let value=json!({"type":"request","requestId":id,"method":"mcpServer/elicitation/request","params":params,"connectorName":context.connector});
        let(sender,receiver)=oneshot::channel();
        context.app.state::<McpInteractions>().pending.lock().unwrap().insert(id.clone(),Pending{owner:context.owner.clone(),conversation:context.conversation.clone(),scope:context.scope.clone(),request:value,opened:false,reply:Some(sender)});
        let _guard=PendingGuard{app:context.app.clone(),id};let _=context.app.emit("geod:mcp-requests-changed",());
        match tokio::time::timeout(Duration::from_secs(600),receiver).await{Ok(Ok(value))=>Ok(value),_=>Ok(ElicitResult::new(ElicitationAction::Cancel))}
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    fn fixture(mode:&str,opened:bool)->Pending{Pending{owner:"owner".into(),conversation:"conversation".into(),scope:"run".into(),request:json!({"params":{"mode":mode}}),opened,reply:None}}
    #[test]fn interaction_replies_require_the_original_account_and_run(){
        let request=fixture("url",true);let command=json!({"value":{"action":"cancel","content":null}});
        assert_eq!(validate_interaction_reply(&request,"other","run",&command).unwrap_err().code,"MCP_REQUEST_GONE");
        assert_eq!(validate_interaction_reply(&request,"owner","other",&command).unwrap_err().code,"MCP_REQUEST_GONE");
        assert!(validate_interaction_reply(&request,"owner","run",&command).is_ok());
    }
    #[test]fn unprovided_device_proofs_cannot_be_accepted(){
        let request=fixture("openai/userVerification",true);
        let command=json!({"value":{"action":"accept","content":{"proof":{"credentialId":"invented","signature":"invented"}}}});
        assert_eq!(validate_interaction_reply(&request,"owner","run",&command).unwrap_err().code,"MCP_VERIFICATION_UNAVAILABLE");
        assert!(validate_interaction_reply(&request,"owner","run",&json!({"value":{"action":"cancel","content":null}})).is_ok());
    }
    #[test]fn browser_acceptance_still_requires_the_native_opener(){
        let command=json!({"value":{"action":"accept","content":null}});
        assert_eq!(validate_interaction_reply(&fixture("url",false),"owner","run",&command).unwrap_err().code,"MCP_BROWSER_NOT_OPENED");
        assert!(validate_interaction_reply(&fixture("url",true),"owner","run",&command).is_ok());
    }
    #[test]fn browser_flow_accepts_only_web_addresses_without_embedded_credentials(){
        for value in ["https://login.example.com/authorize?state=one#continue","http://127.0.0.1:18345/authorize","http://localhost:8000/login","http://[::1]:8080/login"]{assert!(browser_url(value).is_ok(),"{value}");}
        for value in ["javascript:alert(1)","file:///C:/secret.txt","http://example.com/auth","https://user:password@example.com/","https://user@example.com/","not-url"]{assert!(browser_url(value).is_err(),"{value}");}
        assert!(browser_url(&format!("https://example.com/{}","a".repeat(8192))).is_err());
    }
    #[test]fn background_clients_do_not_advertise_interactive_browser_flows(){assert!(McpClient::default().get_info().capabilities.elicitation.is_none());}
}

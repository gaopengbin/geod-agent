//! Native read-only acceptance. A model cannot supply its own verification result.
use crate::{AppState,read_workspace,services};
use serde_json::{Value,json};
use std::{sync::{Arc,atomic::{AtomicBool,Ordering}},process::Stdio,time::Duration};
use tauri::{AppHandle,Manager};
use tokio::io::AsyncWriteExt;

pub(crate) async fn verify(app:&AppHandle,owner:&str,conversation:&str,check:Value,cancel:Arc<AtomicBool>)->Value {
    let unavailable=||json!({"verified":false,"error":"WORKFLOW_VERIFICATION_UNAVAILABLE","message":"成果核验不可用，请保留文件并修复当前步骤。"});
    if cancel.load(Ordering::Acquire)||services::current_user_id(&app.state::<services::ServiceState>()).ok().as_deref()!=Some(owner){return unavailable();}
    let workspace=match read_workspace(app,&app.state::<AppState>(),&app.state::<services::ServiceState>(),conversation){Ok(v)=>v,Err(_)=>return unavailable()};
    if check["kind"]=="native" {
        let wait_app=app.clone();let wait_owner=owner.to_owned();let wait_conversation=conversation.to_owned();
        return tokio::task::spawn_blocking(move||crate::background_wait::wait(&wait_app,&wait_owner,&wait_conversation,check["resourceKind"].as_str().unwrap_or(""),check["resourceId"].as_str().unwrap_or(""),&cancel,&Arc::new(AtomicBool::new(false)),|_|{})).await.unwrap_or_else(|_|unavailable());
    }
    let components:&[&str]=match check["kind"].as_str(){Some("raster")=>&["gis-common","gis-raster"],Some("vector")=>&["gis-common","gis-vector"],Some("file"|"json")=>&[],_=>return unavailable()};
    let mut command=match crate::python_runtime::gis_command(include_str!("workflow_verify.py"),components){Ok(v)=>v,Err(_)=>return unavailable()};
    command.current_dir(&workspace.directory).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child=match command.spawn(){Ok(v)=>v,Err(_)=>return unavailable()};
    if let Some(mut input)=child.stdin.take(){if input.write_all(check.to_string().as_bytes()).await.is_err(){return unavailable();}}
    let operation=child.wait_with_output();tokio::pin!(operation);
    let timeout=tokio::time::sleep(Duration::from_secs(180));tokio::pin!(timeout);
    loop {tokio::select!{
        result=&mut operation=>{
            if cancel.load(Ordering::Acquire)||services::current_user_id(&app.state::<services::ServiceState>()).ok().as_deref()!=Some(owner){return unavailable();}
            let current=read_workspace(app,&app.state::<AppState>(),&app.state::<services::ServiceState>(),conversation).ok();
            if current.as_ref().map(|s|&s.directory)!=Some(&workspace.directory){return unavailable();}
            return result.ok().filter(|r|r.status.success()).and_then(|r|serde_json::from_slice::<Value>(&r.stdout).ok()).unwrap_or_else(unavailable);
        },
        _=&mut timeout=>return unavailable(),
        _=tokio::time::sleep(Duration::from_millis(100))=>if cancel.load(Ordering::Acquire){return unavailable();}
    }}
}

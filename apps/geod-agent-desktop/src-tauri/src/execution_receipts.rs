//! Native turn/request linkage for inactive billing candidates. No monetary charge.
use crate::{codex_runtime::CodexState, services, AppError, AppState, workspace_error};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tauri::{AppHandle, Manager};

fn storage(_:rusqlite::Error)->AppError{workspace_error("RECEIPT_STORAGE","无法保存模型执行凭据")}
fn db(path:&Path)->Result<Connection,AppError>{
    if let Some(parent)=path.parent(){std::fs::create_dir_all(parent).map_err(|_|workspace_error("RECEIPT_STORAGE","无法创建执行凭据目录"))?;}
    let db=Connection::open(path).map_err(storage)?;db.busy_timeout(Duration::from_secs(10)).map_err(storage)?;
    db.execute_batch("PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS ai_receipt_runs(owner TEXT,run_id TEXT,conversation TEXT,workspace TEXT,status TEXT,created_at TEXT,finished_at TEXT,PRIMARY KEY(owner,run_id));
      CREATE TABLE IF NOT EXISTS ai_receipt_requests(owner TEXT,run_id TEXT,generation_id TEXT,state TEXT,body TEXT,PRIMARY KEY(owner,generation_id));
      CREATE TABLE IF NOT EXISTS ai_receipt_tools(owner TEXT,run_id TEXT,request_id TEXT,purpose TEXT,replied INTEGER DEFAULT 0,PRIMARY KEY(owner,run_id,request_id));
      CREATE TABLE IF NOT EXISTS ai_receipt_links(owner TEXT,run_id TEXT,kind TEXT,reference TEXT,PRIMARY KEY(owner,run_id,kind,reference));
      CREATE INDEX IF NOT EXISTS ai_receipt_run_owner ON ai_receipt_runs(owner,created_at);").map_err(storage)?;Ok(db)
}
pub(crate) fn begin(path:&Path,owner:&str,run:&str,conversation:&str,workspace:&str)->Result<(),AppError>{
    let db=db(path)?;
    let old:Option<(String,String)>=db.query_row("SELECT conversation,workspace FROM ai_receipt_runs WHERE owner=?1 AND run_id=?2",params![owner,run],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(storage)?;
    if old.is_some_and(|(c,w)|c!=conversation||w!=workspace){return Err(workspace_error("RECEIPT_CONFLICT","执行标识已属于其他会话"));}
    db.execute("INSERT OR IGNORE INTO ai_receipt_runs VALUES (?1,?2,?3,?4,'running',?5,NULL)",params![owner,run,conversation,workspace,Utc::now().to_rfc3339()]).map_err(storage)?;Ok(())
}
fn purpose(value:&Value)->Option<&'static str>{
    let mut name=value["tool"].as_str()?;
    if name=="mcp_call"{
        if value["arguments"]["connectorId"]!="builtin-data-downloads"{return None;}
        name=value["arguments"]["toolName"].as_str()?;
    }
    match name{"plan_imagery"|"plan_imagery_batch"=>Some("imagery"),"jobs_start"=>Some("imagery-job"),"data_download_plan"|"data_download_start"=>Some("data"),_=>None}
}
pub(crate) fn observe(path:&Path,owner:&str,run:&str,value:&Value)->Result<(),AppError>{
    if value["type"]=="tool"{if let(Some(kind),Some(id))=(purpose(value),value["requestId"].as_str()){
        db(path)?.execute("INSERT OR IGNORE INTO ai_receipt_tools(owner,run_id,request_id,purpose) VALUES (?1,?2,?3,?4)",params![owner,run,id,kind]).map_err(storage)?;
    }}Ok(())
}
pub(crate) fn requested(path:&Path,owner:&str,run:&str,id:&str)->Result<(),AppError>{
    let db=db(path)?;
    let previous:Option<String>=db.query_row("SELECT run_id FROM ai_receipt_requests WHERE owner=?1 AND generation_id=?2",params![owner,id],|r|r.get(0)).optional().map_err(storage)?;
    if previous.is_some_and(|r|r!=run){return Err(workspace_error("RECEIPT_CONFLICT","模型请求已属于其他执行"));}
    db.execute("INSERT OR IGNORE INTO ai_receipt_requests VALUES (?1,?2,?3,'requested',NULL)",params![owner,run,id]).map_err(storage)?;Ok(())
}
fn usage(value:&Value)->Value{
    json!({"generationId":value["generationId"],"conversationId":value["conversationId"],"state":value["state"],"model":value["model"],"billingScope":value.get("billingScope").cloned().unwrap_or(json!("hosted")),"channelId":value["channelId"],"channelRevision":value["channelRevision"],"selectedModel":value["selectedModel"],"usageKnown":value["usageKnown"],"inputTokens":value["inputTokens"],"outputTokens":value["outputTokens"],"cachedInputTokens":value.get("cachedInputTokens").cloned().unwrap_or_else(||value["result"]["usage"]["cachedInputTokens"].clone()),"reasoningTokens":value.get("reasoningTokens").cloned().unwrap_or_else(||value["result"]["usage"]["reasoningTokens"].clone()),"upstreamRequestId":value["upstreamRequestId"],"createdAt":value["createdAt"],"updatedAt":value["updatedAt"],"errorCode":value["errorCode"]})
}
pub(crate) fn generation(path:&Path,owner:&str,run:&str,value:&Value)->Result<(),AppError>{
    let db=db(path)?;let Some(id)=value["generationId"].as_str()else{return Err(workspace_error("RECEIPT_INVALID","模型结果缺少请求标识"));};
    let binding:Option<(String,String)>=db.query_row("SELECT run_id,conversation FROM ai_receipt_requests JOIN ai_receipt_runs USING(owner,run_id) WHERE owner=?1 AND generation_id=?2",params![owner,id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(storage)?;
    if binding.as_ref().is_none_or(|(r,c)|r!=run||value["conversationId"].as_str()!=Some(c)){return Err(workspace_error("RECEIPT_CONFLICT","模型结果与本机执行不匹配"));}
    db.execute("UPDATE ai_receipt_requests SET state=?1,body=?2 WHERE owner=?3 AND run_id=?4 AND generation_id=?5",params![value["state"].as_str().unwrap_or("unknown"),usage(value).to_string(),owner,run,id]).map_err(storage)?;Ok(())
}
fn references(value:&Value,kind:&str,out:&mut Vec<String>,depth:usize){
    if depth>8||out.len()>=100{return;}
    match value{
        Value::Object(fields)=>{let key=match kind{"imagery"=>"planId","imagery-job"=>"jobId",_=>"taskId"};
            if let Some(id)=fields.get(key).and_then(Value::as_str).filter(|id|!id.is_empty()&&id.len()<=160){out.push(id.to_owned());}
            for(k,v)in fields{if k!="error"{references(v,kind,out,depth+1);}}
        },Value::Array(items)=>for v in items.iter().take(100){references(v,kind,out,depth+1)},_=>{}
    }
}
pub(crate) fn replied(path:&Path,owner:&str,run:&str,command:&Value)->Result<(),AppError>{
    if command["type"]!="response"||command["error"].is_string(){return Ok(());}
    let Some(id)=command["requestId"].as_str()else{return Ok(());};let mut db=db(path)?;let tx=db.transaction().map_err(storage)?;
    let record:Option<(String,bool)>=tx.query_row("SELECT purpose,replied FROM ai_receipt_tools WHERE owner=?1 AND run_id=?2 AND request_id=?3",params![owner,run,id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(storage)?;
    let Some((kind,false))=record else{return Ok(());};
    let mut refs=vec![];references(&command["value"]["result"],&kind,&mut refs,0);
    for reference in refs{tx.execute("INSERT OR IGNORE INTO ai_receipt_links VALUES (?1,?2,?3,?4)",params![owner,run,kind,reference]).map_err(storage)?;}
    tx.execute("UPDATE ai_receipt_tools SET replied=1 WHERE owner=?1 AND run_id=?2 AND request_id=?3",params![owner,run,id]).map_err(storage)?;tx.commit().map_err(storage)?;Ok(())
}
pub(crate) fn finish(path:&Path,owner:&str,run:&str,status:&str)->Result<(),AppError>{
    db(path)?.execute("UPDATE ai_receipt_runs SET status=?1,finished_at=?2 WHERE owner=?3 AND run_id=?4",params![status,Utc::now().to_rfc3339(),owner,run]).map_err(storage)?;Ok(())
}
fn rows(path:&Path,owner:&str,run:&str)->Result<Value,AppError>{
    let db=db(path)?;
    let row:Option<Value>=db.query_row("SELECT conversation,workspace,status,created_at,finished_at FROM ai_receipt_runs WHERE owner=?1 AND run_id=?2",params![owner,run],|r|Ok(json!({"runId":run,"conversationId":r.get::<_,String>(0)?,"workspace":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"createdAt":r.get::<_,String>(3)?,"finishedAt":r.get::<_,Option<String>>(4)?}))).optional().map_err(storage)?;
    let mut result=row.ok_or_else(||workspace_error("RECEIPT_NOT_FOUND","执行凭据不存在或属于其他账号"))?;
    let mut statement=db.prepare("SELECT generation_id,state,body FROM ai_receipt_requests WHERE owner=?1 AND run_id=?2 ORDER BY rowid").map_err(storage)?;
    let generations=statement.query_map(params![owner,run],|r|{let id:String=r.get(0)?;let state:String=r.get(1)?;let body:Option<String>=r.get(2)?;Ok(body.and_then(|b|serde_json::from_str::<Value>(&b).ok()).unwrap_or_else(||json!({"generationId":id,"state":state}))) }).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
    let mut statement=db.prepare("SELECT kind,reference FROM ai_receipt_links WHERE owner=?1 AND run_id=?2 ORDER BY kind,reference").map_err(storage)?;
    let links=statement.query_map(params![owner,run],|r|Ok(json!({"kind":r.get::<_,String>(0)?,"id":r.get::<_,String>(1)?}))).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
    result["generations"]=json!(generations);result["links"]=json!(links);Ok(result)
}
#[tauri::command]
pub fn billing_runs_list(app:AppHandle,conversation_id:Option<String>,offset:Option<u32>)->Result<Value,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|workspace_error(e.code,e.message))?;
    let path=app.state::<CodexState>().receipts_path();let db=db(&path)?;let offset=offset.unwrap_or(0).min(100000);
    let mut statement=db.prepare("SELECT run_id,conversation,status,created_at,finished_at FROM ai_receipt_runs WHERE owner=?1 AND (?2 IS NULL OR conversation=?2) ORDER BY created_at DESC LIMIT 51 OFFSET ?3").map_err(storage)?;
    let mut rows=statement.query_map(params![owner,conversation_id,offset],|r|Ok(json!({"runId":r.get::<_,String>(0)?,"conversationId":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"createdAt":r.get::<_,String>(3)?,"finishedAt":r.get::<_,Option<String>>(4)?}))).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
    let more=rows.len()>50;rows.truncate(50);Ok(json!({"mode":"preview","chargesEnabled":false,"runs":rows,"nextOffset":if more{Some(offset+50)}else{None}}))
}
#[tauri::command]
pub fn billing_run_snapshot(app:AppHandle,run_id:String)->Result<Value,AppError>{
    let service=app.state::<services::ServiceState>();let owner=services::current_user_id(&service).map_err(|e|workspace_error(e.code,e.message))?;
    let mut result=rows(&app.state::<CodexState>().receipts_path(),&owner,&run_id)?;
    let conversation=result["conversationId"].as_str().unwrap_or("");let state=app.state::<AppState>();
    crate::read_workspace(&app,&state,&service,conversation)?;
    let root=std::path::PathBuf::from(result["workspace"].as_str().unwrap_or(""));
    let mut tasks=vec![];
    for link in result["links"].as_array().into_iter().flatten(){
        let id=link["id"].as_str().unwrap_or("");let kind=link["kind"].as_str().unwrap_or("");
        let task=if kind=="data"{
            let task=crate::data_jobs::data_download_get(app.clone(),state.clone(),service.clone(),conversation.into(),id.into());
            match task{Ok(t)=>json!({"kind":"data","id":t.id,"status":t.status,"verified":true}),Err(_)=>json!({"kind":"data","id":id,"status":"unavailable","verified":false})}
        }else{
            let store=crate::open_store(&state)?;
            let job=if kind=="imagery-job"{store.get_job(id)?}else{store.job_for_plan(id)?};
            let plan_id=job.as_ref().map(|j|j.plan_id.as_str()).unwrap_or(id);
            let owned=crate::imagery_recovery::assert_plan_owner(&state,&owner,conversation,&root,plan_id).is_ok();
            if owned{job.as_ref().map(|j|json!({"kind":"imagery","id":j.job_id,"planId":j.plan_id,"status":j.state,"verified":true})).unwrap_or_else(||json!({"kind":"imagery","planId":plan_id,"status":"planned","verified":true}))}
            else{json!({"kind":"imagery","id":id,"status":"unavailable","verified":false})}
        };if !tasks.contains(&task){tasks.push(task);}
    }
    let settled=result["generations"].as_array().is_some_and(|g|!g.is_empty()&&g.iter().all(|g|matches!(g["state"].as_str(),Some("settled"|"failed"))));
    let failed_tasks=!tasks.is_empty()&&tasks.iter().all(|t|t["verified"]==true&&t["status"]=="failed");
    let eligible=settled&&(failed_tasks||tasks.is_empty()&&result["status"]=="failed");
    result.as_object_mut().unwrap().remove("workspace");result["tasks"]=json!(tasks);result["refundEligible"]=json!(eligible);result["usageResolved"]=json!(settled);result["mode"]=json!("preview");result["chargesEnabled"]=json!(false);
    Ok(result)
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn receipts_bind_gateway_usage_and_only_expected_native_tools(){
        let dir=tempfile::tempdir().unwrap();let path=dir.path().join("receipts.sqlite");begin(&path,"owner","run","conversation","workspace").unwrap();
        requested(&path,"owner","run","generation").unwrap();assert!(requested(&path,"owner","other","generation").is_err());
        let value=json!({"generationId":"generation","conversationId":"conversation","state":"settled","model":"deepseek-flash","inputTokens":100,"outputTokens":5,"cachedInputTokens":80});generation(&path,"owner","run",&value).unwrap();
        let mut wrong=value.clone();wrong["conversationId"]=json!("other");assert!(generation(&path,"owner","run",&wrong).is_err());
        observe(&path,"owner","run",&json!({"type":"tool","tool":"mcp_call","requestId":"call","arguments":{"connectorId":"builtin-data-downloads","toolName":"data_download_plan"}})).unwrap();
        let command=json!({"type":"response","requestId":"call","value":{"result":{"connectorId":"builtin-data-downloads","result":{"taskId":"actual-task"}}}});replied(&path,"owner","run",&command).unwrap();replied(&path,"owner","run",&command).unwrap();
        observe(&path,"owner","run",&json!({"type":"tool","tool":"mcp_call","requestId":"untrusted","arguments":{"connectorId":"private","toolName":"data_download_plan"}})).unwrap();replied(&path,"owner","run",&json!({"type":"response","requestId":"untrusted","value":{"result":{"taskId":"forged-task"}}})).unwrap();
        finish(&path,"owner","run","completed").unwrap();let row=rows(&path,"owner","run").unwrap();assert_eq!(row["links"].as_array().unwrap().len(),1);assert_eq!(row["generations"][0]["cachedInputTokens"],80);assert!(rows(&path,"another-owner","run").is_err());
    }
}

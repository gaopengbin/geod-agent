//! Replay an existing native run and reconcile follow-ups without issuing another turn.
use crate::services::ServiceError;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::{Path,PathBuf}, sync::{Arc,Mutex}, time::Duration};
use crate::codex_runtime::EventSink;

fn err(code:&'static str,message:impl Into<String>)->ServiceError{ServiceError{code,message:message.into()}}
fn storage(_:rusqlite::Error)->ServiceError{err("CODEX_STREAM_STORAGE","无法保存会话恢复记录")}
fn db(path:&Path)->Result<Connection,ServiceError>{
    if let Some(parent)=path.parent(){std::fs::create_dir_all(parent).map_err(|_|err("CODEX_STREAM_STORAGE","无法创建会话恢复目录"))?;}
    let db=Connection::open(path).map_err(storage)?;db.busy_timeout(Duration::from_secs(5)).map_err(storage)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS stream_runs(owner TEXT,run TEXT,conversation TEXT,status TEXT,result TEXT,error TEXT,PRIMARY KEY(owner,run));
      CREATE TABLE IF NOT EXISTS stream_events(owner TEXT,run TEXT,sequence INTEGER,body TEXT,PRIMARY KEY(owner,run,sequence));
      CREATE TABLE IF NOT EXISTS stream_replies(owner TEXT,run TEXT,request TEXT,PRIMARY KEY(owner,run,request));
      CREATE TABLE IF NOT EXISTS stream_callbacks(owner TEXT,run TEXT,request TEXT,response TEXT,PRIMARY KEY(owner,run,request));
      CREATE TABLE IF NOT EXISTS stream_followups(owner TEXT,request TEXT,run TEXT,conversation TEXT,fingerprint TEXT,state TEXT,body TEXT,PRIMARY KEY(owner,request));").map_err(storage)?;Ok(db)
}
struct Stream {db:Connection,owner:String,run:String,conversation:String,sequence:u64,sink:Option<EventSink>}
#[derive(Clone)]
pub(crate) struct Hub {path:PathBuf,live:Arc<Mutex<HashMap<String,Arc<Mutex<Stream>>>>>}
impl Hub {
    pub fn new(path:PathBuf)->Self{Self{path,live:Arc::new(Mutex::new(HashMap::new()))}}
    fn key(owner:&str,run:&str)->String{format!("{owner}:{run}")}
    pub fn begin(&self,owner:&str,run:&str,conversation:&str,sink:EventSink)->Result<EventSink,ServiceError>{
        let db=db(&self.path)?;
        if db.execute("INSERT OR IGNORE INTO stream_runs VALUES(?1,?2,?3,'running',NULL,NULL)",params![owner,run,conversation]).map_err(storage)?==0{return Err(err("CODEX_RUN_CONFLICT","执行标识已存在，请恢复原执行"));}
        let stream=Arc::new(Mutex::new(Stream{db,owner:owner.into(),run:run.into(),conversation:conversation.into(),sequence:0,sink:Some(sink)}));
        self.live.lock().unwrap().insert(Self::key(owner,run),stream.clone());
        Ok(Arc::new(move|mut value|{
            let mut s=stream.lock().unwrap();s.sequence+=1;
            value["sequence"]=json!(s.sequence);value["runId"]=json!(s.run);value["conversationId"]=json!(s.conversation);value["emittedAt"]=json!(chrono::Utc::now().timestamp_millis());
            s.db.execute("INSERT INTO stream_events VALUES(?1,?2,?3,?4)",params![s.owner,s.run,s.sequence,value.to_string()]).map_err(storage)?;
            observe_followup(&s.db,&s.owner,&value)?;
            if s.sink.as_ref().is_some_and(|sink|sink(value).is_err()){s.sink=None;}
            Ok(())
        }))
    }
    pub fn finish(&self,owner:&str,run:&str,result:&Result<Value,ServiceError>)->Result<(),ServiceError>{
        let db=db(&self.path)?;
        let (status,body,error)=match result{Ok(value)=>(value["status"].as_str().unwrap_or("completed"),Some(value.to_string()),None),Err(error)=>("failed",None,Some(serde_json::to_string(error).unwrap()))};
        db.execute("UPDATE stream_runs SET status=?1,result=?2,error=?3 WHERE owner=?4 AND run=?5",params![status,body,error,owner,run]).map_err(storage)?;
        db.execute("UPDATE stream_followups SET state='outcome-unknown' WHERE owner=?1 AND run=?2 AND state='sending'",params![owner,run]).map_err(storage)?;
        self.live.lock().unwrap().remove(&Self::key(owner,run));Ok(())
    }
    pub fn reconnect(&self,owner:&str,run:&str,conversation:&str,after:u64,sink:EventSink)->Result<Value,ServiceError>{
        let live=self.live.lock().unwrap().get(&Self::key(owner,run)).cloned();
        // Keep replay and replacement of the live sink ordered with new events.
        let mut locked=live.as_ref().map(|stream|stream.lock().unwrap());
        let db=db(&self.path)?;
        let record:Option<(String,String,Option<String>,Option<String>)>=db.query_row("SELECT conversation,status,result,error FROM stream_runs WHERE owner=?1 AND run=?2",params![owner,run],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(storage)?;
        let Some((stored,status,result,error))=record else{return Err(err("CODEX_RUN_NOT_FOUND","原执行不存在或属于其他账号"));};
        if stored!=conversation{return Err(err("CODEX_RUN_CONFLICT","原执行与会话不匹配"));}
        let mut query=db.prepare("SELECT body FROM stream_events WHERE owner=?1 AND run=?2 AND sequence>?3 ORDER BY sequence").map_err(storage)?;
        let records=query.query_map(params![owner,run,after],|r|r.get::<_,String>(0)).map_err(storage)?.collect::<Result<Vec<_>,_>>().map_err(storage)?;
        for record in records{let value:Value=serde_json::from_str(&record).map_err(|_|err("CODEX_STREAM_STORAGE","会话恢复记录损坏"))?;sink(value)?;}
        if let Some(ref mut stream)=locked{stream.sink=Some(sink);}
        let mut query=db.prepare("SELECT request FROM stream_replies WHERE owner=?1 AND run=?2").map_err(storage)?;
        let replied=query.query_map(params![owner,run],|r|r.get::<_,String>(0)).map_err(storage)?.collect::<Result<Vec<_>,_>>().map_err(storage)?;
        let mut pending=vec![];
        if status=="running"&&live.is_some(){
            let mut query=db.prepare("SELECT body FROM stream_events WHERE owner=?1 AND run=?2 ORDER BY sequence").map_err(storage)?;
            for body in query.query_map(params![owner,run],|r|r.get::<_,String>(0)).map_err(storage)?{
                if let Ok(mut event)=serde_json::from_str::<Value>(&body.map_err(storage)?){
                    if matches!(event["type"].as_str(),Some("tool"|"request"))&&event["requestId"].as_str().is_some_and(|id|!replied.iter().any(|done|done==id)){
                        event.as_object_mut().unwrap().remove("sequence");pending.push(event);
                    }
                }
            }
        }
        Ok(json!({"status":if status=="running"&&live.is_none(){"unavailable"}else{&status},"result":result.and_then(|v|serde_json::from_str::<Value>(&v).ok()),"error":error.and_then(|v|serde_json::from_str::<Value>(&v).ok()),"repliedRequestIds":replied,"pendingCallbacks":pending}))
    }
    pub fn claim(&self,owner:&str,run:&str,conversation:&str,request:&str)->Result<Value,ServiceError>{
        let mut db=db(&self.path)?;let tx=db.transaction().map_err(storage)?;
        let stored:Option<String>=tx.query_row("SELECT conversation FROM stream_runs WHERE owner=?1 AND run=?2",params![owner,run],|r|r.get(0)).optional().map_err(storage)?;
        if stored.as_deref()!=Some(conversation){return Err(err("CODEX_RUN_CONFLICT","工具请求与当前会话不匹配"));}
        let existing:Option<Option<String>>=tx.query_row("SELECT response FROM stream_callbacks WHERE owner=?1 AND run=?2 AND request=?3",params![owner,run,request],|r|r.get(0)).optional().map_err(storage)?;
        if let Some(response)=existing{return Ok(match response{Some(body)=>json!({"state":"replied","response":serde_json::from_str::<Value>(&body).unwrap_or(Value::Null)}),None=>json!({"state":"outcome-unknown"})});}
        tx.execute("INSERT INTO stream_callbacks VALUES(?1,?2,?3,NULL)",params![owner,run,request]).map_err(storage)?;tx.commit().map_err(storage)?;Ok(json!({"state":"claimed"}))
    }
    pub fn replied(&self,owner:&str,run:&str,request:&str,response:&Value)->Result<(),ServiceError>{
        let mut db=db(&self.path)?;let tx=db.transaction().map_err(storage)?;
        tx.execute("INSERT OR IGNORE INTO stream_replies VALUES(?1,?2,?3)",params![owner,run,request]).map_err(storage)?;
        tx.execute("INSERT INTO stream_callbacks VALUES(?1,?2,?3,?4) ON CONFLICT(owner,run,request) DO UPDATE SET response=excluded.response",params![owner,run,request,response.to_string()]).map_err(storage)?;tx.commit().map_err(storage)?;Ok(())
    }
    pub fn reserve(&self,owner:&str,run:&str,conversation:&str,request:&str,payload:&Value)->Result<bool,ServiceError>{
        let mut db=db(&self.path)?;let tx=db.transaction().map_err(storage)?;
        let fingerprint=format!("{:x}",Sha256::digest(payload.to_string().as_bytes()));
        let old:Option<(String,String,String)>=tx.query_row("SELECT run,conversation,fingerprint FROM stream_followups WHERE owner=?1 AND request=?2",params![owner,request],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(storage)?;
        if let Some((r,c,f))=old{if r!=run||c!=conversation||f!=fingerprint{return Err(err("CODEX_FOLLOWUP_CONFLICT","消息标识已用于其他内容，未重复提交"));}return Ok(false);}
        tx.execute("INSERT INTO stream_followups VALUES(?1,?2,?3,?4,?5,'sending',?6)",params![owner,request,run,conversation,fingerprint,payload.to_string()]).map_err(storage)?;tx.commit().map_err(storage)?;Ok(true)
    }
    pub fn followup(&self,owner:&str,conversation:&str,request:&str)->Result<Value,ServiceError>{
        let db=db(&self.path)?;
        let value:Option<(String,String,String,String)>=db.query_row("SELECT conversation,run,state,body FROM stream_followups WHERE owner=?1 AND request=?2",params![owner,request],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(storage)?;
        let Some((c,run,mut state,body))=value else{return Ok(json!({"state":"not-submitted","clientRequestId":request}));};
        if c!=conversation{return Err(err("CODEX_FOLLOWUP_CONFLICT","消息记录与当前会话不匹配"));}
        if state=="sending"&&!self.live.lock().unwrap().contains_key(&Self::key(owner,&run)){state="outcome-unknown".into();}
        Ok(json!({"state":state,"runId":run,"conversationId":c,"clientRequestId":request,"result":serde_json::from_str::<Value>(&body).unwrap_or(Value::Null)}))
    }
    pub fn failed(&self,owner:&str,request:&str,error:&ServiceError)->Result<(),ServiceError>{
        let state=if error.code=="CODEX_PROCESS_ERROR"{"outcome-unknown"}else{"failed"};
        db(&self.path)?.execute("UPDATE stream_followups SET state=?1,body=?2 WHERE owner=?3 AND request=?4",params![state,json!({"code":error.code,"message":error.message}).to_string(),owner,request]).map_err(storage)?;Ok(())
    }
}
fn observe_followup(db:&Connection,owner:&str,event:&Value)->Result<(),ServiceError>{
    let Some(id)=event["requestId"].as_str()else{return Ok(());};
    let state=match event["type"].as_str(){Some("steered")=>"accepted",Some("commandError")if event["commandType"]=="steer"=>if event["outcomeUnknown"]==true{"outcome-unknown"}else{"failed"},_=>return Ok(())};
    db.execute("UPDATE stream_followups SET state=?1,body=?2 WHERE owner=?3 AND request=?4 AND run=?5",params![state,event.to_string(),owner,id,event["runId"].as_str().unwrap_or("")]).map_err(storage)?;Ok(())
}

#[cfg(test)]mod tests{
 use super::*;
 fn setup()->(tempfile::TempDir,Hub){let dir=tempfile::tempdir().unwrap();let hub=Hub::new(dir.path().join("stream.sqlite"));(dir,hub)}
 #[test]fn reconnect_replays_once_in_sequence_and_checks_owner(){let(_dir,hub)=setup();let sink=hub.begin("alice","run","chat",Arc::new(|_|Err(err("GONE","closed")))).unwrap();sink(json!({"type":"heartbeat"})).unwrap();sink(json!({"type":"event","method":"item/agentMessage/delta","params":{"delta":"一"}})).unwrap();let rows=Arc::new(Mutex::new(vec![]));let captured=rows.clone();let read:EventSink=Arc::new(move|v|{captured.lock().unwrap().push(v);Ok(())});let status=hub.reconnect("alice","run","chat",1,read.clone()).unwrap();assert_eq!(status["status"],"running");sink(json!({"type":"heartbeat"})).unwrap();assert_eq!(rows.lock().unwrap().iter().map(|v|v["sequence"].as_u64().unwrap()).collect::<Vec<_>>(),vec![2,3]);assert!(hub.reconnect("bob","run","chat",0,read.clone()).is_err());assert!(hub.reconnect("alice","run","other",0,read).is_err());}
 #[test]fn receipt_is_idempotent_and_terminal_unknown_never_claims_acceptance(){let(_dir,hub)=setup();hub.begin("a","r","c",Arc::new(|_|Ok(()))).unwrap();assert!(hub.reserve("a","r","c","id",&json!({"text":"x"})).unwrap());assert!(!hub.reserve("a","r","c","id",&json!({"text":"x"})).unwrap());assert!(hub.reserve("a","r","c","id",&json!({"text":"y"})).is_err());hub.finish("a","r",&Ok(json!({"status":"interrupted"}))).unwrap();assert_eq!(hub.followup("a","c","id").unwrap()["state"],"outcome-unknown");assert_eq!(hub.followup("b","c","id").unwrap()["state"],"not-submitted");}
 #[test]fn accepted_receipt_and_finished_result_survive_a_new_hub(){let(dir,hub)=setup();let sink=hub.begin("a","r","c",Arc::new(|_|Ok(()))).unwrap();hub.reserve("a","r","c","id",&json!({"text":"x"})).unwrap();sink(json!({"type":"steered","requestId":"id","text":"x"})).unwrap();hub.finish("a","r",&Ok(json!({"status":"completed","text":"done"}))).unwrap();let restored=Hub::new(dir.path().join("stream.sqlite"));assert_eq!(restored.followup("a","c","id").unwrap()["state"],"accepted");assert_eq!(restored.reconnect("a","r","c",1,Arc::new(|_|Ok(()))).unwrap()["result"]["text"],"done");}
 #[test]fn callback_claim_survives_reload_and_replays_only_recorded_response(){let(dir,hub)=setup();hub.begin("a","r","c",Arc::new(|_|Ok(()))).unwrap();assert_eq!(hub.claim("a","r","c","tool").unwrap()["state"],"claimed");let restored=Hub::new(dir.path().join("stream.sqlite"));assert_eq!(restored.claim("a","r","c","tool").unwrap()["state"],"outcome-unknown");assert!(restored.claim("b","r","c","tool").is_err());hub.replied("a","r","tool",&json!({"type":"response","requestId":"tool","value":{"jobId":"job-1"}})).unwrap();assert_eq!(restored.claim("a","r","c","tool").unwrap()["response"]["value"]["jobId"],"job-1");}
 #[test]fn crashed_host_never_leaves_a_followup_looking_in_flight(){let(dir,hub)=setup();hub.begin("a","r","c",Arc::new(|_|Ok(()))).unwrap();hub.reserve("a","r","c","id",&json!({"text":"x"})).unwrap();let restored=Hub::new(dir.path().join("stream.sqlite"));assert_eq!(restored.followup("a","c","id").unwrap()["state"],"outcome-unknown");}
 #[test]fn unresolved_callbacks_remain_recoverable_after_display_cursor_passes_them(){let(_dir,hub)=setup();let sink=hub.begin("a","r","c",Arc::new(|_|Ok(()))).unwrap();sink(json!({"type":"tool","requestId":"job"})).unwrap();sink(json!({"type":"heartbeat"})).unwrap();let first=hub.reconnect("a","r","c",2,Arc::new(|_|Ok(()))).unwrap();assert_eq!(first["pendingCallbacks"][0]["requestId"],"job");assert!(first["pendingCallbacks"][0].get("sequence").is_none());hub.replied("a","r","job",&json!({"value":{"jobId":"one"}})).unwrap();assert!(hub.reconnect("a","r","c",2,Arc::new(|_|Ok(()))).unwrap()["pendingCallbacks"].as_array().unwrap().is_empty());}
}

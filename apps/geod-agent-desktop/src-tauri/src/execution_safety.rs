//! Conversation-scoped spending and evidence of stalled tool execution.
//! This is a local safety journal, never a wallet or an alternative billing ledger.
use crate::{ai_channels::AiChannels, services::ServiceError};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const NANO_PER_CREDIT: i64 = 1_000_000;
pub(crate) fn error(message: &str) -> ServiceError { ServiceError {code:"EXECUTION_SAFETY",message:message.into()} }
fn storage(_: rusqlite::Error) -> ServiceError { error("无法读取或保存会话费用记录。") }
fn db(state: &AiChannels) -> Result<Connection,ServiceError> {
    let db=state.db()?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS execution_budgets(owner TEXT,conversation TEXT,budget INTEGER,PRIMARY KEY(owner,conversation));
      CREATE TABLE IF NOT EXISTS execution_costs(owner TEXT,generation TEXT,conversation TEXT,charge INTEGER,PRIMARY KEY(owner,generation));
      CREATE TABLE IF NOT EXISTS execution_reviews(owner TEXT,conversation TEXT,run TEXT,request TEXT,reason TEXT,decision TEXT,additional INTEGER,created TEXT,PRIMARY KEY(owner,request));").map_err(storage)?;
    Ok(db)
}
#[derive(Clone,Debug)]
pub(crate) struct Spending { pub budget:Option<i64>, pub spent:i64, pub unknown:u32, pub requests:u32, pub unconfirmed:HashSet<String> }
impl Spending {
    pub fn view(&self)->Value {json!({"budgetCredits":self.budget.map(|n|n/NANO_PER_CREDIT),"spentCredits":self.spent as f64/NANO_PER_CREDIT as f64,"unknownRequests":self.unknown,"recordedRequests":self.requests})}
    pub fn reason(&self,ack_unknown:&HashSet<String>)->Option<&'static str>{
        if self.budget.is_some_and(|n|self.spent>=n){Some("budget")}
        else if self.budget.is_some()&&self.unconfirmed.iter().any(|id|!ack_unknown.contains(id)){Some("unknownCost")}
        else {None}
    }
}
pub(crate) fn spending(state:&AiChannels,owner:&str,conversation:&str)->Result<Spending,ServiceError>{
    let db=db(state)?;
    let budget=db.query_row("SELECT budget FROM execution_budgets WHERE owner=?1 AND conversation=?2",params![owner,conversation],|r|r.get::<_,Option<i64>>(0)).optional().map_err(storage)?.flatten();
    let (spent,unknown,requests)=db.query_row("SELECT COALESCE(SUM(charge),0),COUNT(*)-COUNT(charge),COUNT(*) FROM execution_costs WHERE owner=?1 AND conversation=?2",params![owner,conversation],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(storage)?;
    let mut statement=db.prepare("SELECT generation FROM execution_costs WHERE owner=?1 AND conversation=?2 AND charge IS NULL").map_err(storage)?;
    let unconfirmed=statement.query_map(params![owner,conversation],|r|r.get::<_,String>(0)).map_err(storage)?.collect::<rusqlite::Result<HashSet<_>>>().map_err(storage)?;
    Ok(Spending{budget,spent,unknown,requests,unconfirmed})
}
pub(crate) fn set_budget(state:&AiChannels,owner:&str,conversation:&str,credits:Option<u32>)->Result<(),ServiceError>{
    if credits.is_some_and(|n| !(1..=100_000_000).contains(&n)){return Err(error("会话预算需为 1–100,000,000 Credits，或留空。"));}
    db(state)?.execute("INSERT INTO execution_budgets VALUES(?1,?2,?3) ON CONFLICT(owner,conversation) DO UPDATE SET budget=excluded.budget",params![owner,conversation,credits.map(|n|i64::from(n)*NANO_PER_CREDIT)]).map_err(storage)?;Ok(())
}
pub(crate) fn requested(state:&AiChannels,owner:&str,conversation:&str,generation:&str,hosted:bool)->Result<(),ServiceError>{
    let db=db(state)?;
    let prior:Option<String>=db.query_row("SELECT conversation FROM execution_costs WHERE owner=?1 AND generation=?2",params![owner,generation],|r|r.get(0)).optional().map_err(storage)?;
    if prior.is_some_and(|c|c!=conversation){return Err(error("模型请求的会话归属不一致。"));}
    db.execute("INSERT OR IGNORE INTO execution_costs VALUES(?1,?2,?3,?4)",params![owner,generation,conversation,if hosted{None}else{Some(0i64)}]).map_err(storage)?;Ok(())
}
pub(crate) fn settled(state:&AiChannels,owner:&str,conversation:&str,generation:&str,value:&Value,hosted:bool)->Result<(),ServiceError>{
    if value["generationId"].as_str()!=Some(generation)||value["conversationId"].as_str()!=Some(conversation){return Err(error("模型费用结果的请求归属不一致。"));}
    let charge=if !hosted{Some(0)}else if value["billing"]["state"]=="released"&&value["billing"]["chargeNanoCny"]=="0"{Some(0)}else if value["billing"]["state"]=="settled"{
        value["billing"]["chargeNanoCny"].as_str().and_then(|n|n.parse::<i64>().ok()).or_else(||value["billing"]["chargeNanoCny"].as_i64()).filter(|n|*n>=0)
    }else{None};
    // A replay cannot erase or count a settled charge twice. Unknown is never zero.
    db(state)?.execute("UPDATE execution_costs SET charge=COALESCE(charge,?1) WHERE owner=?2 AND generation=?3 AND conversation=?4",params![charge,owner,generation,conversation]).map_err(storage)?;Ok(())
}
#[derive(Clone,Debug,PartialEq)]
pub(crate) enum Decision { Continue(Option<u32>), Stop }
pub(crate) struct Review {pub id:String,pub reason:String,pub spending:Spending,pub decision:Option<Decision>}
#[derive(Default)]
pub(crate) struct Guard {
    pub review:Option<Review>, pub acknowledged_unknown:HashSet<String>,
    accepted:HashMap<String,Value>,
    operations:HashMap<String,String>, pending:HashMap<String,(String,Value)>, completed:HashSet<String>,
    unchanged:u32, policy_stagnation:bool, pub last_tool:String,
}
// Ignore only observation metadata, never coordinates, task status or progress.
fn stable(value:&Value)->Value{match value{
    Value::Object(fields)=>{let mut keys=fields.keys().filter(|k|!matches!(k.as_str(),"readAt"|"observedAt"|"durationMs")).collect::<Vec<_>>();keys.sort();Value::Object(keys.into_iter().map(|k|(k.clone(),stable(&fields[k]))).collect())},
    Value::Array(items)=>Value::Array(items.iter().map(stable).collect()),
    Value::String(text) if text.trim_start().starts_with(['{','['])=>serde_json::from_str::<Value>(text).ok().map(|v|stable(&v)).unwrap_or_else(||value.clone()),_=>value.clone()
}}
fn fingerprint(value:&Value)->String{format!("{:x}",Sha256::digest(stable(value).to_string().as_bytes()))}
impl Guard {
    pub fn reply(&mut self,id:&str,value:&Value)->Result<bool,ServiceError>{
        if let Some(prior)=self.accepted.get(id){return if prior==value{Ok(true)}else{Err(error("这条执行确认已经处理。"))};}
        let Some(review)=self.review.as_mut().filter(|r|r.id==id)else{
            if id.starts_with("execution-review-"){return Err(error("这条执行确认已失效，请使用当前确认卡。"));}
            return Ok(false);
        };
        if review.decision.is_some(){return Err(error("这条执行确认已经处理。"));}
        let decision=match value["decision"].as_str(){
            Some("stop")=>Decision::Stop,
            Some("continue")=>{
                let additional=value["additionalCredits"].as_u64().filter(|n|(1..=100_000_000).contains(n)).map(|n|n as u32);
                if review.reason=="budget"&&additional.is_none(){return Err(error("请输入追加的会话预算。"));}
                Decision::Continue(additional)
            },_=>return Err(error("请选择继续或停止执行。"))
        };
        review.decision=Some(decision);self.accepted.insert(id.into(),value.clone());Ok(true)
    }
    pub fn observe(&mut self,id:&str,tool:&str,args:&Value,result:&Value){
        if !self.completed.insert(id.into()){return;}
        let key=fingerprint(&json!([tool,args]));let actual=fingerprint(result);
        self.unchanged=if self.operations.get(&key)==Some(&actual){self.unchanged.saturating_add(1)}else{0};
        self.operations.insert(key,actual);self.last_tool=tool.into();
    }
    pub fn event(&mut self,value:&Value){
        // The host policy knows domain wait states and prerequisite scopes.
        // Do not run the older exact-result detector on those same calls.
        if value["type"]=="tool" && value["policyManaged"]!=true{if let(Some(id),Some(tool))=(value["requestId"].as_str(),value["tool"].as_str()){
            self.pending.insert(id.into(),(tool.into(),value["arguments"].clone()));
        }}
        if value["type"]=="event"&&value["method"]=="item/completed"{
            let item=&value["params"]["item"];let Some(id)=item["id"].as_str()else{return;};
            match item["type"].as_str(){
                Some("mcpToolCall")=>{let tool=format!("{} / {}",item["server"].as_str().unwrap_or("MCP"),item["tool"].as_str().unwrap_or("tool"));self.observe(id,&tool,&item["arguments"],&json!([item["result"],item["error"]]));},
                Some("commandExecution")=>self.observe(id,"运行命令",&item["command"],&json!([item["exitCode"],item["aggregatedOutput"]])),
                Some("fileChange")=>self.observe(id,"修改文件",&item["changes"],&item["status"]),_=>{}
            }
        }
    }
    pub fn tool_reply(&mut self,id:&str,result:&Value){if let Some((tool,args))=self.pending.remove(id){self.observe(id,&tool,&args,result);}}
    pub fn policy_stalled(&mut self,tool:&str){self.policy_stagnation=true;self.last_tool=tool.into();}
    pub fn repeated(&self)->bool{self.policy_stagnation||self.unchanged>=3}
    pub fn resume(&mut self,spending:&Spending){self.unchanged=0;self.policy_stagnation=false;self.acknowledged_unknown.extend(spending.unconfirmed.iter().cloned());}
    #[cfg(test)] fn clear_repeat(&mut self){self.unchanged=0;}
}
pub(crate) fn approve(state:&AiChannels,owner:&str,conversation:&str,run:&str,review:&Review,decision:&Decision)->Result<(),ServiceError>{
    let mut db=db(state)?;let tx=db.transaction().map_err(storage)?;
    let additional=match decision{Decision::Continue(n)=>*n,Decision::Stop=>None};
    if let Some(credits)=additional{
        // Add to the greater of current total allowance and actual expenditure.
        // Starting a new message cannot reset either of these values.
        let current:Option<i64>=tx.query_row("SELECT budget FROM execution_budgets WHERE owner=?1 AND conversation=?2",params![owner,conversation],|r|r.get(0)).optional().map_err(storage)?.flatten();
        let spent:i64=tx.query_row("SELECT COALESCE(SUM(charge),0) FROM execution_costs WHERE owner=?1 AND conversation=?2",params![owner,conversation],|r|r.get(0)).map_err(storage)?;
        let base=current.unwrap_or(spent).max(spent);
        let total=((base+NANO_PER_CREDIT-1)/NANO_PER_CREDIT).checked_add(i64::from(credits)).filter(|n|*n<=100_000_000).and_then(|n|n.checked_mul(NANO_PER_CREDIT)).ok_or_else(||error("追加的预算过大。"))?;
        tx.execute("INSERT INTO execution_budgets VALUES(?1,?2,?3) ON CONFLICT(owner,conversation) DO UPDATE SET budget=excluded.budget",params![owner,conversation,total]).map_err(storage)?;
    }
    tx.execute("INSERT INTO execution_reviews VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![owner,conversation,run,review.id,review.reason,if matches!(decision,Decision::Stop){"stop"}else{"continue"},additional,chrono::Utc::now().to_rfc3339()]).map_err(storage)?;
    tx.commit().map_err(storage)?;Ok(())
}

#[tauri::command]
pub(crate) fn execution_spending_get(app:tauri::AppHandle,account_id:String,conversation_id:String)->Result<Value,ServiceError>{
    use tauri::Manager;
    let owner=crate::services::current_user_id(&app.state::<crate::services::ServiceState>())?;
    if owner!=account_id{return Err(error("账号已切换，请重新读取会话费用。"));}
    spending(&app.state::<AiChannels>(),&owner,&conversation_id).map(|s|s.view())
}
#[tauri::command]
pub(crate) async fn execution_spending_reconcile(app:tauri::AppHandle,conversation_id:String)->Result<Value,ServiceError>{
    tauri::async_runtime::spawn_blocking(move||{
        use tauri::Manager;
        let service=app.state::<crate::services::ServiceState>();let owner=crate::services::current_user_id(&service)?;
        let state=app.state::<AiChannels>();let snapshot=spending(&state,&owner,&conversation_id)?;
        for id in snapshot.unconfirmed.iter().take(8){
            if crate::services::current_user_id(&service)?!=owner{return Err(error("账号已切换，费用核对已取消。"));}
            if let Ok(value)=crate::services::generation_snapshot(&service,id){settled(&state,&owner,&conversation_id,id,&value,true)?;}
        }
        if crate::services::current_user_id(&service)?!=owner{return Err(error("账号已切换，费用核对已取消。"));}
        spending(&state,&owner,&conversation_id).map(|s|s.view())
    }).await.map_err(|_|error("费用核对中断，请重试。"))?
}

#[cfg(test)] mod tests{
    use super::*;
    #[test] fn costs_survive_turns_and_restart_without_default_budget(){
        let dir=tempfile::tempdir().unwrap();let state=AiChannels::new(dir.path().into());
        assert!(spending(&state,"a","chat").unwrap().budget.is_none());
        for i in 0..35{let id=format!("generation-{i}");requested(&state,"a","chat",&id,true).unwrap();let result=json!({"generationId":id,"conversationId":"chat","billing":{"state":"settled","chargeNanoCny":"2000000"}});settled(&state,"a","chat",&id,&result,true).unwrap();settled(&state,"a","chat",&id,&result,true).unwrap();}
        let reopened=AiChannels::new(dir.path().into());let s=spending(&reopened,"a","chat").unwrap();assert_eq!(s.spent,70_000_000);assert_eq!(s.requests,35);assert_eq!(s.reason(&HashSet::new()),None);
        set_budget(&state,"a","chat",Some(80)).unwrap();assert_eq!(spending(&reopened,"a","chat").unwrap().budget,Some(80_000_000));
        assert_eq!(spending(&state,"b","chat").unwrap().spent,0);assert_eq!(spending(&state,"a","other").unwrap().spent,0);
        requested(&state,"a","chat","pending",true).unwrap();assert_eq!(spending(&state,"a","chat").unwrap().reason(&HashSet::new()),Some("unknownCost"));
        assert!(requested(&state,"a","other","pending",true).is_err());
    }
    #[test] fn repeated_calls_and_cycles_pause_but_new_results_keep_long_tasks_running(){
        let mut g=Guard::default();for i in 0..40{g.observe(&i.to_string(),"status",&json!({"id":1}),&json!({"progress":i,"readAt":i}));assert!(!g.repeated());}
        for i in 40..43{g.observe(&i.to_string(),"status",&json!({"id":1}),&json!({"progress":39,"readAt":i}));}assert!(g.repeated());
        g.clear_repeat();g.observe("new","status",&json!({"id":2}),&json!({"progress":0}));assert!(!g.repeated());
        for i in 0..5{g.observe(&format!("cycle{i}"),"status",&json!({"id":if i%2==0{1}else{2}}),&json!({"progress":if i%2==0{39}else{0}}));}assert!(g.repeated());
        g.observe("progress","status",&json!({"id":1}),&json!({"progress":40}));assert!(!g.repeated());
        g.observe("progress","status",&json!({"id":1}),&json!({"progress":40}));assert!(!g.repeated());
    }
    #[test] fn unknown_cost_is_not_zero_and_later_settlement_is_idempotent(){
        let dir=tempfile::tempdir().unwrap();let state=AiChannels::new(dir.path().into());
        requested(&state,"a","c","g",true).unwrap();settled(&state,"a","c","g",&json!({"generationId":"g","conversationId":"c","billing":{"state":"waiting-for-usage"}}),true).unwrap();assert_eq!(spending(&state,"a","c").unwrap().unknown,1);
        let settled_value=json!({"generationId":"g","conversationId":"c","billing":{"state":"settled","chargeNanoCny":"15250000"}});settled(&state,"a","c","g",&settled_value,true).unwrap();settled(&state,"a","c","g",&settled_value,true).unwrap();let s=spending(&state,"a","c").unwrap();assert_eq!(s.unknown,0);assert_eq!(s.spent,15_250_000);
        requested(&state,"a","c","released",true).unwrap();settled(&state,"a","c","released",&json!({"generationId":"released","conversationId":"c","billing":{"state":"released","chargeNanoCny":"0"}}),true).unwrap();assert_eq!(spending(&state,"a","c").unwrap().unknown,0);
        requested(&state,"a","c","personal",false).unwrap();assert_eq!(spending(&state,"a","c").unwrap().spent,15_250_000);
        set_budget(&state,"a","c",Some(100)).unwrap();let mut g=Guard::default();requested(&state,"a","c","unknown-one",true).unwrap();g.resume(&spending(&state,"a","c").unwrap());
        settled(&state,"a","c","unknown-one",&json!({"generationId":"unknown-one","conversationId":"c","billing":{"state":"settled","chargeNanoCny":"1000000"}}),true).unwrap();requested(&state,"a","c","unknown-two",true).unwrap();assert_eq!(spending(&state,"a","c").unwrap().reason(&g.acknowledged_unknown),Some("unknownCost"));
        assert!(settled(&state,"a","c","g",&json!({"generationId":"other","conversationId":"c"}),true).is_err());
    }
    #[test] fn dynamic_tools_and_mcp_json_text_are_observed_once_and_ignore_only_metadata(){
        let mut g=Guard::default();for i in 0..4{let id=format!("native-{i}");g.event(&json!({"type":"tool","requestId":id,"tool":"jobs_list","arguments":{}}));g.tool_reply(&id,&json!({"content":[{"type":"text","text":format!("{{\"status\":\"done\",\"readAt\":{i}}}")}]}));}assert!(g.repeated());
        g.clear_repeat();for i in 0..20{g.event(&json!({"type":"event","method":"item/completed","params":{"item":{"id":format!("mcp-{i}"),"type":"mcpToolCall","server":"map","tool":"download_status","arguments":{"id":1},"result":{"progress":i}}}}));assert!(!g.repeated());}
    }
    #[test] fn budget_confirmation_is_explicit_scoped_idempotent_and_adds_to_total(){
        let dir=tempfile::tempdir().unwrap();let state=AiChannels::new(dir.path().into());set_budget(&state,"a","c",Some(10)).unwrap();
        requested(&state,"a","c","g",true).unwrap();settled(&state,"a","c","g",&json!({"generationId":"g","conversationId":"c","billing":{"state":"settled","chargeNanoCny":"12000000"}}),true).unwrap();
        let s=spending(&state,"a","c").unwrap();assert_eq!(s.reason(&HashSet::new()),Some("budget"));
        let mut guard=Guard::default();guard.review=Some(Review{id:"execution-review-one".into(),reason:"budget".into(),spending:s,decision:None});
        assert!(guard.reply("execution-review-other",&json!({"decision":"continue","additionalCredits":20})).is_err());
        assert!(guard.reply("execution-review-one",&json!({"decision":"continue"})).is_err());
        assert!(guard.reply("execution-review-one",&json!({"decision":"continue","additionalCredits":20})).unwrap());
        assert!(guard.reply("execution-review-one",&json!({"decision":"continue","additionalCredits":20})).unwrap());
        assert!(guard.reply("execution-review-one",&json!({"decision":"continue","additionalCredits":200})).is_err());
        let review=guard.review.take().unwrap();let d=review.decision.as_ref().unwrap();approve(&state,"a","c","run",&review,d).unwrap();assert_eq!(spending(&state,"a","c").unwrap().budget,Some(32_000_000));
        assert!(approve(&state,"a","c","run",&review,d).is_err());assert_eq!(spending(&state,"a","c").unwrap().budget,Some(32_000_000));
    }
}

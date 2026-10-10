use crate::{ai_channels, services};
use rusqlite::{params,OptionalExtension};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use tauri::{AppHandle,Manager};
use services::ServiceError;

#[derive(Clone,Deserialize,Serialize,PartialEq,Debug)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Preferences {pub context_window_tokens:Option<u32>,pub auto_compact_percent:u8,
    // Accept the old saved field, without restoring its obsolete hard cutoff.
    #[serde(default,rename="maxModelRequests",skip_serializing)]_legacy_requests:Option<u32>}
impl Default for Preferences {fn default()->Self{Self{context_window_tokens:None,auto_compact_percent:90,_legacy_requests:None}}}
fn error(message:&str)->ServiceError{ServiceError{code:"CONTEXT_SETTINGS",message:message.into()}}
fn validate(value:&Preferences)->Result<(),ServiceError>{
    if value.context_window_tokens.is_some_and(|n| !(16_000..=4_000_000).contains(&n))||!(50..=95).contains(&value.auto_compact_percent){return Err(error("上下文预算需为 16,000–4,000,000 Token，压缩阈值需为 50–95%。"));}
    Ok(())
}
fn db(state:&ai_channels::AiChannels)->Result<rusqlite::Connection,ServiceError>{
    let db=state.db()?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS context_preferences(owner TEXT PRIMARY KEY,body TEXT NOT NULL)").map_err(|_|error("无法读取上下文设置。"))?;
    Ok(db)
}
pub(crate) fn load(state:&ai_channels::AiChannels,owner:&str)->Result<Preferences,ServiceError>{
    let body:Option<String>=db(state)?.query_row("SELECT body FROM context_preferences WHERE owner=?1",[owner],|r|r.get(0)).optional().map_err(|_|error("无法读取上下文设置。"))?;
    let value=body.map(|body|serde_json::from_str(&body).map_err(|_|error("上下文设置记录损坏。"))).transpose()?.unwrap_or_default();validate(&value)?;Ok(value)
}
fn save(state:&ai_channels::AiChannels,owner:&str,value:&Preferences)->Result<(),ServiceError>{
    validate(value)?;
    db(state)?.execute("INSERT OR REPLACE INTO context_preferences(owner,body) VALUES(?1,?2)",params![owner,serde_json::to_string(value).map_err(|_|error("无法保存上下文设置。"))?]).map_err(|_|error("无法保存上下文设置。"))?;Ok(())
}
pub(crate) fn apply(mut capabilities:Value,value:&Preferences)->Result<Value,ServiceError>{
    validate(value)?;
    let capacity=capabilities["contextWindow"].as_u64().filter(|n| (16_000..=4_000_000).contains(n)).ok_or_else(||error("模型没有返回可用的上下文上限。"))?;
    let budget=value.context_window_tokens.map(u64::from).unwrap_or(capacity).min(capacity);
    let output=capabilities["maxOutputTokens"].as_u64().unwrap_or(4096);
    if budget<=output+1024 {return Err(error("上下文预算过小，需为模型输出和请求结构留出空间。"));}
    let compact=(budget*u64::from(value.auto_compact_percent)/100).min(budget-output-1024).min(budget*95/100);
    capabilities["modelContextWindow"]=json!(capacity);
    capabilities["contextWindow"]=json!(budget);
    capabilities["requestedContextWindow"]=json!(value.context_window_tokens);
    capabilities["autoCompactPercent"]=json!(value.auto_compact_percent);
    capabilities["autoCompactTokenLimit"]=json!(compact);
    Ok(capabilities)
}
fn view(app:&AppHandle,conversation:&str)->Result<Value,ServiceError>{
    let services=app.state::<services::ServiceState>();let owner=services::current_user_id(&services)?;
    let preferences=load(&app.state::<ai_channels::AiChannels>(),&owner)?;
    let route=ai_channels::selected(app,&owner,conversation)?;
    let capabilities=if route.is_personal()||route.is_sponsored(){route.capabilities()}else{services::codex_capabilities(&services)?};
    if services::current_user_id(&services)?!=owner{return Err(error("账号已切换，请重新打开设置。"));}
    // Keep the editor usable when a saved budget is too small for a new model.
    let effective=apply(capabilities.clone(),&preferences);
    let mut result=json!({"preferences":preferences,"model":capabilities["model"],"modelContextWindow":capabilities["contextWindow"],"maxOutputTokens":capabilities["maxOutputTokens"]});
    if conversation!="default" {result["spending"]=crate::execution_safety::spending(&app.state::<ai_channels::AiChannels>(),&owner,conversation)?.view();}
    match effective {Ok(e)=>{result["effectiveContextWindow"]=e["contextWindow"].clone();result["autoCompactTokenLimit"]=e["autoCompactTokenLimit"].clone();},Err(e)=>result["configurationError"]=json!(e.message)};
    Ok(result)
}
#[tauri::command]
pub(crate) async fn context_settings_get(app:AppHandle,conversation_id:String,account_id:String)->Result<Value,ServiceError>{
    tauri::async_runtime::spawn_blocking(move||{
        if services::current_user_id(&app.state::<services::ServiceState>())?!=account_id{return Err(error("账号已切换，请重新打开设置。"));}
        view(&app,&conversation_id)
    }).await.map_err(|_|error("上下文设置读取中断。"))?
}
#[tauri::command]
pub(crate) async fn context_settings_set(app:AppHandle,conversation_id:String,account_id:String,preferences:Preferences,budget_credits:Option<u32>)->Result<Value,ServiceError>{
    tauri::async_runtime::spawn_blocking(move||{
        let owner=services::current_user_id(&app.state::<services::ServiceState>())?;
        if owner!=account_id{return Err(error("账号已切换，请重新打开设置。"));}
        if budget_credits.is_some_and(|n|!(1..=100_000_000).contains(&n)){return Err(error("会话预算需为 1–100,000,000 Credits，或留空。"));}
        let route=ai_channels::selected(&app,&owner,&conversation_id)?;
        let capabilities=if route.is_personal()||route.is_sponsored(){route.capabilities()}else{services::codex_capabilities(&app.state::<services::ServiceState>())?};
        apply(capabilities,&preferences)?;
        if services::current_user_id(&app.state::<services::ServiceState>())?!=owner{return Err(error("账号已切换，请重新打开设置。"));}
        save(&app.state::<ai_channels::AiChannels>(),&owner,&preferences)?;
        if conversation_id!="default"{crate::execution_safety::set_budget(&app.state::<ai_channels::AiChannels>(),&owner,&conversation_id,budget_credits)?;}
        view(&app,&conversation_id)
    }).await.map_err(|_|error("上下文设置保存中断。"))?
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn preferences_persist_per_account_and_reject_invalid_values(){
        let dir=tempfile::tempdir().unwrap();let state=ai_channels::AiChannels::new(dir.path().into());
        assert_eq!(load(&state,"alice").unwrap(),Preferences::default());
        let configured=Preferences{context_window_tokens:Some(256000),auto_compact_percent:92,..Preferences::default()};save(&state,"alice",&configured).unwrap();
        assert_eq!(load(&ai_channels::AiChannels::new(dir.path().into()),"alice").unwrap(),configured);
        assert_eq!(load(&state,"bob").unwrap(),Preferences::default());
        for value in [Preferences{context_window_tokens:Some(0),..Preferences::default()},Preferences{context_window_tokens:Some(4_000_001),..Preferences::default()},Preferences{auto_compact_percent:100,..Preferences::default()}]{assert!(save(&state,"alice",&value).is_err());}
        assert_eq!(load(&state,"alice").unwrap(),configured);
    }
    #[test] fn budget_and_compaction_are_real_and_never_expand_the_declared_model_capacity(){
        let model=json!({"model":"test","contextWindow":1_000_000,"maxOutputTokens":4096});
        let settings=Preferences{context_window_tokens:Some(256000),..Preferences::default()};let actual=apply(model.clone(),&settings).unwrap();
        assert_eq!(actual["contextWindow"],256000);assert_eq!(actual["autoCompactTokenLimit"],230400);assert_eq!(actual["modelContextWindow"],1000000);
        let limited=apply(json!({"contextWindow":128000,"maxOutputTokens":4096}),&settings).unwrap();assert_eq!(limited["contextWindow"],128000);assert_eq!(limited["requestedContextWindow"],256000);
        let automatic=apply(model,&Preferences::default()).unwrap();assert_eq!(automatic["contextWindow"],1000000);
        let reserve=apply(json!({"contextWindow":16000,"maxOutputTokens":8192}),&Preferences::default()).unwrap();assert_eq!(reserve["autoCompactTokenLimit"],6784);
        assert!(apply(json!({"contextWindow":16000,"maxOutputTokens":15000}),&settings).is_err());
        let legacy:Preferences=serde_json::from_value(json!({"contextWindowTokens":null,"autoCompactPercent":90,"maxModelRequests":12})).unwrap();assert!(serde_json::to_value(&legacy).unwrap().get("maxModelRequests").is_none());assert!(apply(json!({"contextWindow":128000}),&legacy).unwrap().get("maxModelRequests").is_none());
    }
}

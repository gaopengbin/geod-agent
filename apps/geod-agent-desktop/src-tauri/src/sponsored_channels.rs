//! Public sponsored catalogue only; the gateway owns provider keys and quota decisions.
use crate::{ai_channels::{AiChannels,Model,RouteSnapshot},services};
use rusqlite::{params,Connection,OptionalExtension};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use tauri::{AppHandle,Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct SponsorRoute {pub id:String,pub name:String,pub revision:String,#[serde(default="default_protocol")]pub protocol:String}
fn default_protocol()->String{"chatCompletions".into()}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Usage {
    quota_enforced:bool,limit_tokens:Option<u64>,remaining_tokens:Option<u64>,committed_tokens:u64,reserved_tokens:u64,pending_reconcile:u64,total_limit_tokens:Option<u64>,
    #[serde(default,skip_serializing_if="Option::is_none")]budget_period:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]period_start:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]period_end:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]prior_reserved_tokens:Option<u64>,
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Sponsor {id:String,name:String,description:String,website:Option<String>,revision:String,enabled:bool,#[serde(default="default_protocol")]protocol:String,#[serde(default)]starts_at:Option<String>,#[serde(default)]ends_at:Option<String>,models:Vec<Model>,billing_scope:String,usage:Usage}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalogue {sponsors:Vec<Sponsor>}
fn error(code:&'static str,message:&str)->services::ServiceError{services::ServiceError{code,message:message.into()}}
fn storage(_:rusqlite::Error)->services::ServiceError{error("AI_CHANNEL_STORAGE","模型配置记录不可用")}
fn valid_text(value:&str,max:usize)->bool{!value.trim().is_empty()&&value.len()<=max&&!value.chars().any(char::is_control)}
fn decode(value:Value)->Result<Catalogue,services::ServiceError>{
    let catalogue:Catalogue=serde_json::from_value(value).map_err(|_|error("SPONSOR_CATALOG_INVALID","赞助渠道目录格式无效"))?;
    if catalogue.sponsors.len()>20{return Err(error("SPONSOR_CATALOG_INVALID","赞助渠道目录格式无效"));}
    let mut ids=std::collections::BTreeSet::new();
    for sponsor in &catalogue.sponsors {
        let website_valid=sponsor.website.as_ref().is_none_or(|text|reqwest::Url::parse(text).is_ok_and(|url|url.scheme()=="https"&&url.host_str().is_some()&&url.username().is_empty()&&url.password().is_none()&&url.query().is_none()&&url.fragment().is_none()));
        if !valid_text(&sponsor.id,40)||!sponsor.id.bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c==b'-')||!ids.insert(&sponsor.id)||!valid_text(&sponsor.name,120)||sponsor.description.len()>1024||sponsor.description.chars().any(char::is_control)||sponsor.revision.len()!=64||!sponsor.revision.bytes().all(|c|c.is_ascii_hexdigit())||sponsor.billing_scope!="sponsored"||!website_valid||sponsor.models.is_empty()||sponsor.models.len()>20 {return Err(error("SPONSOR_CATALOG_INVALID","赞助渠道目录格式无效"));}
        if !matches!(sponsor.protocol.as_str(),"chatCompletions"|"responses"|"anthropic"|"gemini"){return Err(error("SPONSOR_CATALOG_INVALID","赞助渠道接口格式无效"));}
        let starts=sponsor.starts_at.as_deref().map(chrono::DateTime::parse_from_rfc3339).transpose().map_err(|_|error("SPONSOR_CATALOG_INVALID","赞助活动时间格式无效"))?;
        let ends=sponsor.ends_at.as_deref().map(chrono::DateTime::parse_from_rfc3339).transpose().map_err(|_|error("SPONSOR_CATALOG_INVALID","赞助活动时间格式无效"))?;
        if starts.zip(ends).is_some_and(|(start,end)|start>=end){return Err(error("SPONSOR_CATALOG_INVALID","赞助活动时间格式无效"));}
        let mut model_ids=std::collections::BTreeSet::new();
        for model in &sponsor.models {
            if !valid_text(&model.id,120)||!valid_text(&model.name,120)||!model_ids.insert(&model.id)||!(16000..=1000000).contains(&model.context_window)||!(256..=32768).contains(&model.max_output_tokens)||model.max_output_tokens>=model.context_window||!model.input_modalities.iter().any(|part|part=="text")||model.input_modalities.iter().any(|part|!matches!(part.as_str(),"text"|"image"))||model.input_modalities.iter().collect::<std::collections::BTreeSet<_>>().len()!=model.input_modalities.len()||!matches!(model.thinking.as_deref(),None|Some("enabled"|"disabled"|"adaptive"))||(model.thinking.as_deref()==Some("adaptive")&&sponsor.protocol!="anthropic")||(sponsor.protocol=="anthropic"&&model.thinking.as_deref()==Some("enabled")&&model.max_output_tokens<=1024){return Err(error("SPONSOR_CATALOG_INVALID","赞助模型能力格式无效"));}
        }
        if sponsor.usage.quota_enforced&&(sponsor.usage.limit_tokens.is_none()||sponsor.usage.total_limit_tokens.is_none()||sponsor.usage.remaining_tokens.is_none()){return Err(error("SPONSOR_CATALOG_INVALID","赞助额度格式无效"));}
        match sponsor.usage.budget_period.as_deref(){
            None=>if sponsor.usage.period_start.is_some()||sponsor.usage.period_end.is_some()||sponsor.usage.prior_reserved_tokens.is_some(){return Err(error("SPONSOR_CATALOG_INVALID","赞助预算周期格式无效"));},
            Some("month")=>{
                use chrono::{Datelike,Timelike};
                let start=sponsor.usage.period_start.as_deref().and_then(|v|chrono::DateTime::parse_from_rfc3339(v).ok()).ok_or_else(||error("SPONSOR_CATALOG_INVALID","赞助预算周期格式无效"))?;
                let end=sponsor.usage.period_end.as_deref().and_then(|v|chrono::DateTime::parse_from_rfc3339(v).ok()).ok_or_else(||error("SPONSOR_CATALOG_INVALID","赞助预算周期格式无效"))?;
                if start.offset().local_minus_utc()!=0||end.offset().local_minus_utc()!=0||start.day()!=1||start.hour()!=0||start.minute()!=0||start.second()!=0||start.nanosecond()!=0||start.checked_add_months(chrono::Months::new(1))!=Some(end)||sponsor.usage.prior_reserved_tokens.is_none(){return Err(error("SPONSOR_CATALOG_INVALID","赞助预算周期格式无效"));}
            },
            Some(_)=>return Err(error("SPONSOR_CATALOG_INVALID","赞助预算周期格式无效")),
        }
    }
    Ok(catalogue)
}
pub(crate) fn cached(db:&Connection,owner:&str)->Result<(Vec<Value>,Option<String>),services::ServiceError>{
    let row:Option<(String,String)>=db.query_row("SELECT body,updated_at FROM sponsored_catalog WHERE owner=?",[owner],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(storage)?;
    let Some((body,updated))=row else{return Ok((vec![],None));};
    let catalogue=decode(serde_json::from_str(&body).map_err(|_|error("SPONSOR_CATALOG_INVALID","赞助渠道缓存不可读"))?)?;
    Ok((catalogue.sponsors.into_iter().map(|sponsor|serde_json::to_value(sponsor).unwrap()).collect(),Some(updated)))
}
pub(crate) fn resolve(db:&Connection,owner:&str,id:&str,model_id:&str)->Result<RouteSnapshot,services::ServiceError>{
    let (sponsors,_)=cached(db,owner)?;
    let sponsor: Sponsor=sponsors.into_iter().find(|sponsor|sponsor["id"]==id).map(serde_json::from_value).transpose().map_err(|_|error("SPONSOR_CATALOG_INVALID","赞助渠道缓存不可读"))?.ok_or_else(||error("SPONSOR_UNAVAILABLE","赞助渠道不可用，请刷新渠道列表或选择其他模型"))?;
    if !sponsor.enabled{return Err(error("SPONSOR_DISABLED","赞助渠道已停用，请选择其他模型"));}
    let now=chrono::Utc::now();
    if sponsor.starts_at.as_deref().is_some_and(|value|chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|start|now<start)){return Err(error("SPONSOR_NOT_STARTED","赞助活动尚未开始，请稍后使用或选择其他模型"));}
    if sponsor.ends_at.as_deref().is_some_and(|value|chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|end|now>=end)){return Err(error("SPONSOR_ENDED","赞助活动已结束，请选择其他模型"));}
    let model=sponsor.models.into_iter().find(|model|model.id==model_id).ok_or_else(||error("SPONSOR_MODEL_MISSING","赞助模型已移除，请选择其他模型"))?;
    Ok(RouteSnapshot::sponsored(owner,SponsorRoute{id:sponsor.id,name:sponsor.name,revision:sponsor.revision,protocol:sponsor.protocol},model))
}
#[tauri::command]
pub(crate) async fn ai_sponsors_refresh(app:AppHandle,force:Option<bool>)->Result<Value,services::ServiceError>{
    let owner=services::current_user_id(&app.state())?;
    let (existing,updated)=cached(&app.state::<AiChannels>().db()?,&owner)?;
    let expired=existing.iter().any(|sponsor|sponsor["usage"]["budgetPeriod"]=="month"&&sponsor["usage"]["periodEnd"].as_str().is_some_and(|value|chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|end|chrono::Utc::now()>=end)));
    if force!=Some(true)&&!expired&&updated.as_ref().is_some_and(|value|chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|at|chrono::Utc::now().signed_duration_since(at).num_seconds()<300)) {return Ok(json!({"sponsors":existing,"sponsorsUpdatedAt":updated}));}
    let state=app.state::<services::ServiceState>().inner().clone();
    let value=tauri::async_runtime::spawn_blocking(move||services::sponsor_catalogue(&state)).await.map_err(|_|error("SPONSOR_CATALOG_UNAVAILABLE","暂时无法读取赞助渠道"))??;
    let catalogue=decode(value)?;
    if services::current_user_id(&app.state())?!=owner{return Err(error("ACCOUNT_CHANGED","GeoD 账号已切换，请重新读取渠道"));}
    let sponsors:Vec<Value>=catalogue.sponsors.into_iter().map(|sponsor|serde_json::to_value(sponsor).unwrap()).collect();
    let updated=chrono::Utc::now().to_rfc3339();app.state::<AiChannels>().db()?.execute("INSERT OR REPLACE INTO sponsored_catalog VALUES(?,?,?)",params![owner,json!({"sponsors":sponsors}).to_string(),updated]).map_err(storage)?;
    Ok(json!({"sponsors":sponsors,"sponsorsUpdatedAt":updated}))
}

#[tauri::command]
pub(crate) fn ai_sponsor_open_website(app:AppHandle,id:String)->Result<Value,services::ServiceError>{
    let owner=services::current_user_id(&app.state())?;
    let (sponsors,_)=cached(&app.state::<AiChannels>().db()?,&owner)?;
    let website=sponsors.iter().find(|sponsor|sponsor["id"]==id).and_then(|sponsor|sponsor["website"].as_str()).ok_or_else(||error("SPONSOR_WEBSITE_UNAVAILABLE","供应方网站不可用，请刷新渠道列表"))?;
    app.opener().open_url(website,None::<&str>).map_err(|_|error("SPONSOR_BROWSER_OPEN_FAILED","无法打开系统浏览器，请重试"))?;
    Ok(json!({"opened":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn catalogue()->Value{json!({"sponsors":[{"id":"qa","name":"QA Sponsor","description":"Actual test channel","website":null,"revision":"a".repeat(64),"enabled":true,"billingScope":"sponsored","models":[{"id":"qa-model","name":"QA Model","contextWindow":16000,"maxOutputTokens":512,"thinking":null,"inputModalities":["text"]}],"usage":{"quotaEnforced":false,"limitTokens":null,"remainingTokens":null,"committedTokens":1,"reservedTokens":0,"pendingReconcile":0,"totalLimitTokens":null}}]})}
    #[test]
    fn public_metadata_has_no_keys_and_cached_routes_are_account_owned(){
        assert!(decode(catalogue()).is_ok());let mut invalid=catalogue();invalid["sponsors"][0]["apiKey"]=json!("private");assert!(decode(invalid).is_err());
        let db=Connection::open_in_memory().unwrap();db.execute_batch("CREATE TABLE sponsored_catalog(owner TEXT PRIMARY KEY,body TEXT,updated_at TEXT)").unwrap();db.execute("INSERT INTO sponsored_catalog VALUES(?,?,?)",params!["alice",catalogue().to_string(),"2026-10-04T00:00:00Z"]).unwrap();
        let route=resolve(&db,"alice","qa","qa-model").unwrap();assert!(route.is_sponsored());assert!(!route.is_personal());assert_eq!(route.sponsor_request().unwrap()["providerId"],"qa");assert!(resolve(&db,"bob","qa","qa-model").is_err());assert_eq!(resolve(&db,"alice","qa","missing").err().unwrap().code,"SPONSOR_MODEL_MISSING");
    }
    #[test]
    fn sponsored_protocol_snapshots_keep_images_and_legacy_records_while_activity_boundaries_block_selection(){
        let legacy:SponsorRoute=serde_json::from_value(json!({"id":"qa","name":"QA","revision":"a".repeat(64)})).unwrap();assert_eq!(legacy.protocol,"chatCompletions");
        let db=Connection::open_in_memory().unwrap();db.execute_batch("CREATE TABLE sponsored_catalog(owner TEXT PRIMARY KEY,body TEXT,updated_at TEXT)").unwrap();
        for protocol in ["chatCompletions","responses","anthropic","gemini"]{
            let mut value=catalogue();value["sponsors"][0]["protocol"]=json!(protocol);value["sponsors"][0]["models"][0]["inputModalities"]=json!(["text","image"]);assert!(decode(value.clone()).is_ok());
            db.execute("INSERT OR REPLACE INTO sponsored_catalog VALUES(?,?,?)",params!["alice",value.to_string(),chrono::Utc::now().to_rfc3339()]).unwrap();
            let route=resolve(&db,"alice","qa","qa-model").unwrap();assert_eq!(route.capabilities()["protocol"],protocol);assert_eq!(route.capabilities()["inputModalities"],json!(["text","image"]));
            for (field,date,code) in [("startsAt",chrono::Utc::now()+chrono::Duration::days(1),"SPONSOR_NOT_STARTED"),("endsAt",chrono::Utc::now()-chrono::Duration::days(1),"SPONSOR_ENDED")]{
                let mut inactive=value.clone();inactive["sponsors"][0][field]=json!(date.to_rfc3339());db.execute("INSERT OR REPLACE INTO sponsored_catalog VALUES(?,?,?)",params!["alice",inactive.to_string(),chrono::Utc::now().to_rfc3339()]).unwrap();assert_eq!(resolve(&db,"alice","qa","qa-model").err().unwrap().code,code);
            }
        }
    }
    #[test]
    fn calendar_budget_metadata_validates_utc_month_boundaries_and_preserves_old_catalogues(){
        assert!(decode(catalogue()).is_ok());
        let mut value=catalogue();let usage=&mut value["sponsors"][0]["usage"];
        usage["budgetPeriod"]=json!("month");usage["periodStart"]=json!("2026-12-01T00:00:00.000Z");usage["periodEnd"]=json!("2027-01-01T00:00:00.000Z");usage["priorReservedTokens"]=json!(600);
        assert!(decode(value.clone()).is_ok());
        for (field,bad) in [("budgetPeriod",json!("week")),("periodStart",json!("2026-12-02T00:00:00Z")),("periodEnd",json!("2027-02-01T00:00:00Z")),("priorReservedTokens",json!(-1))]{let mut changed=value.clone();changed["sponsors"][0]["usage"][field]=bad;assert!(decode(changed).is_err());}
        let mut changed=catalogue();changed["sponsors"][0]["usage"]["periodEnd"]=json!("2027-01-01T00:00:00Z");assert!(decode(changed).is_err());
    }
}

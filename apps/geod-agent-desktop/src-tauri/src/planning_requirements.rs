//! Only the trusted UI projects actual human output selections here. It never
//! grants execution permission or changes the conversation CRS default.
use crate::{workspace_error,AppError,AppState,services};
use rusqlite::{Connection,OptionalExtension,params};
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use sha2::{Digest,Sha256};
use tauri::{AppHandle,Manager};
#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Conditions{task_origin:String,target_crs:Option<String>,output_formats:Option<Vec<geod_task_engine::OutputFormat>>}
fn storage(_:impl std::fmt::Display)->AppError{workspace_error("PLANNING_STATE_UNAVAILABLE","无法保存已确认的规划条件；未继续提交规划，请恢复本机记录后再试")}
fn write(db:&Connection,owner:&str,conversation:&str,mut value:Option<Conditions>)->Result<Value,AppError>{
    db.execute_batch("CREATE TABLE IF NOT EXISTS planning_output_requirements(owner TEXT NOT NULL,conversation TEXT NOT NULL,revision TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,conversation))").map_err(storage)?;
    if let Some(v)=&mut value{
        if v.task_origin.is_empty()||v.task_origin.len()>200{return Err(workspace_error("INVALID_PLANNING_CONDITIONS","缺少实际用户要求的归属"));}
        if let Some(crs)=&v.target_crs{v.target_crs=Some(crate::export_crs::normalize(crs)?);}
        if let Some(formats)=&mut v.output_formats{formats.sort_unstable();formats.dedup();if formats.is_empty()||formats.len()>6{return Err(workspace_error("INVALID_PLANNING_CONDITIONS","输出格式条件无效"));}}
        let body=serde_json::to_string(v).map_err(storage)?;let revision=format!("{:x}",Sha256::digest(body.as_bytes()));
        db.execute("INSERT INTO planning_output_requirements VALUES(?1,?2,?3,?4) ON CONFLICT(owner,conversation) DO UPDATE SET revision=excluded.revision,body=excluded.body",params![owner,conversation,revision,body]).map_err(storage)?;
    }else{db.execute("DELETE FROM planning_output_requirements WHERE owner=?1 AND conversation=?2",params![owner,conversation]).map_err(storage)?;}
    Ok(read(db,owner,conversation).map_err(storage)?)
}
fn read(db:&Connection,owner:&str,conversation:&str)->rusqlite::Result<Value>{
    let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='planning_output_requirements')",[],|r|r.get(0))?;
    if !exists{return Ok(json!({"available":true,"revision":null,"conditions":null}));}
    let row:Option<(String,String)>=db.query_row("SELECT revision,body FROM planning_output_requirements WHERE owner=?1 AND conversation=?2",params![owner,conversation],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    Ok(match row{Some((revision,body))=>json!({"available":true,"revision":revision,"conditions":serde_json::from_str::<Value>(&body).map_err(|_|rusqlite::Error::InvalidQuery)?}),None=>json!({"available":true,"revision":null,"conditions":null})})
}
pub(crate) fn snapshot(state:&AppState,owner:&str,conversation:&str)->Value{
    Connection::open_with_flags(&state.db_path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY|rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).and_then(|db|{db.busy_timeout(std::time::Duration::from_secs(2))?;read(&db,owner,conversation)}).unwrap_or_else(|_|json!({"available":false}))
}
#[tauri::command]
pub(crate) async fn planning_output_requirements_set(app:AppHandle,account_id:String,conversation_id:String,conditions:Option<Conditions>)->Result<Value,AppError>{
    tauri::async_runtime::spawn_blocking(move||{
        let state=app.state::<AppState>();let service=app.state::<services::ServiceState>();
        let owner=services::current_user_id(&service).map_err(|e|workspace_error(e.code,e.message))?;
        if owner!=account_id{return Err(workspace_error("ACCOUNT_CHANGED","账号已切换，未把原规划条件写入其他账号"));}
        crate::read_workspace(&app,&state,&service,&conversation_id)?;
        let db=Connection::open(&state.db_path).map_err(storage)?;db.busy_timeout(std::time::Duration::from_secs(5)).map_err(storage)?;write(&db,&owner,&conversation_id,conditions)
    }).await.map_err(storage)?
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn confirmed_projection_is_scoped_and_canonical_and_does_not_promote_defaults(){
        let db=Connection::open_in_memory().unwrap();
        let c=|crs:&str|Conditions{task_origin:"actual-user-message".into(),target_crs:Some(crs.into()),output_formats:Some(vec![geod_task_engine::OutputFormat::Tiles])};
        let old=write(&db,"owner","chat",Some(c("EPSG:4326"))).unwrap();let repeated=write(&db,"owner","chat",Some(c("epsg:4326"))).unwrap();assert_eq!(old,repeated);
        let changed=write(&db,"owner","chat",Some(c("EPSG:3857"))).unwrap();assert_ne!(old["revision"],changed["revision"]);
        assert!(read(&db,"other","chat").unwrap()["revision"].is_null());assert!(read(&db,"owner","another").unwrap()["revision"].is_null());
        assert!(write(&db,"owner","chat",None).unwrap()["revision"].is_null());
    }
}

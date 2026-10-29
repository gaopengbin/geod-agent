//! Consent-scoped, durable download outcome outbox. No filenames, geometry,
//! credential values or native task IDs leave this device.
use crate::{services, workspace_error, AppError, AppState};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
#[cfg(test)]
#[path="download_telemetry_live.rs"]mod live_acceptance;

fn storage(_: impl std::fmt::Display) -> AppError {
    workspace_error("TELEMETRY_STORAGE", "下载统计暂不可用，下载不受影响")
}
pub(crate) fn schema(db: &Connection) -> Result<(), AppError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS download_telemetry_consent(owner TEXT PRIMARY KEY,enabled INTEGER NOT NULL,since TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS download_observations(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,resource TEXT NOT NULL,state TEXT NOT NULL,stamp TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS download_attempts(owner TEXT NOT NULL,resource TEXT NOT NULL,attempt TEXT NOT NULL,state TEXT NOT NULL,started TEXT NOT NULL,PRIMARY KEY(owner,resource));
      CREATE TABLE IF NOT EXISTS download_outbox(id TEXT PRIMARY KEY,owner TEXT NOT NULL,body TEXT NOT NULL);").map_err(storage)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS download_transport_state(owner TEXT PRIMARY KEY,last_attempt TEXT,last_delivery TEXT,last_error TEXT);").map_err(storage)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS download_collector_health(owner TEXT PRIMARY KEY,last_tick TEXT NOT NULL,last_error TEXT);").map_err(storage)?;
    let columns={let mut q=db.prepare("PRAGMA table_info(download_telemetry_consent)").map_err(storage)?;let rows=q.query_map([],|r|r.get::<_,String>(1)).map_err(storage)?.collect::<Result<Vec<_>,_>>().map_err(storage)?;rows};
    for(name,definition)in [("diagnostic_consent","INTEGER NOT NULL DEFAULT 0"),("notice_version","INTEGER NOT NULL DEFAULT 1"),("diagnostic_since","TEXT"),("notice_ack_version","INTEGER NOT NULL DEFAULT 0"),("preference_source","TEXT NOT NULL DEFAULT 'legacy'")]{if !columns.iter().any(|n|n==name){db.execute_batch(&format!("ALTER TABLE download_telemetry_consent ADD COLUMN {name} {definition};")).map_err(storage)?;}}
    db.execute_batch("CREATE TABLE IF NOT EXISTS download_collector_cursors(owner TEXT PRIMARY KEY,event_rowid INTEGER NOT NULL);").map_err(storage)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS download_observation_receipts(owner TEXT NOT NULL,resource TEXT NOT NULL,event_seq INTEGER NOT NULL,PRIMARY KEY(owner,resource,event_seq));").map_err(storage)?;
    if !db.prepare("PRAGMA table_info(download_observations)").map_err(storage)?.query_map([],|r|r.get::<_,String>(1)).map_err(storage)?.filter_map(Result::ok).any(|n|n=="event_seq"){
        db.execute_batch("ALTER TABLE download_observations ADD COLUMN event_seq INTEGER;").map_err(storage)?;
    }
    db.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS download_observation_identity ON download_observations(owner,resource,event_seq);").map_err(storage)?;
    let exists = |name: &str| {
        db.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get::<_, i32>(0),
        )
        .optional()
        .map(|v| v.is_some())
        .unwrap_or(false)
    };
    if exists("jobs") && exists("imagery_plan_owners") {
        let upgraded:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='download_imagery_update' AND sql LIKE '%event_seq%')",[],|r|r.get(0)).map_err(storage)?;
        if !upgraded{let migration=db.execute_batch("SAVEPOINT download_trigger_upgrade;
          DROP TRIGGER IF EXISTS download_imagery_insert;DROP TRIGGER IF EXISTS download_imagery_update;
          CREATE TRIGGER download_imagery_insert AFTER INSERT ON jobs WHEN EXISTS(SELECT 1 FROM imagery_plan_owners o JOIN download_telemetry_consent c ON c.owner=o.owner_id WHERE o.plan_id=NEW.plan_id AND c.enabled=1) BEGIN
          INSERT OR IGNORE INTO download_observations(owner,resource,state,stamp,event_seq) SELECT owner_id,'imagery:'||NEW.job_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.version FROM imagery_plan_owners WHERE plan_id=NEW.plan_id; END;
          CREATE TRIGGER download_imagery_update AFTER UPDATE OF state ON jobs WHEN OLD.state<>NEW.state AND EXISTS(SELECT 1 FROM imagery_plan_owners o JOIN download_telemetry_consent c ON c.owner=o.owner_id WHERE o.plan_id=NEW.plan_id AND c.enabled=1) BEGIN
          INSERT OR IGNORE INTO download_observations(owner,resource,state,stamp,event_seq) SELECT owner_id,'imagery:'||NEW.job_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NEW.version FROM imagery_plan_owners WHERE plan_id=NEW.plan_id; END;
          RELEASE download_trigger_upgrade;");if let Err(error)=migration{let _=db.execute_batch("ROLLBACK TO download_trigger_upgrade;RELEASE download_trigger_upgrade;");return Err(storage(error));}}
    }
    if exists("data_download_tasks") {
        db.execute_batch("CREATE TRIGGER IF NOT EXISTS download_data_update AFTER UPDATE OF status ON data_download_tasks WHEN OLD.status<>NEW.status AND EXISTS(SELECT 1 FROM download_telemetry_consent c WHERE c.owner=NEW.owner_id AND c.enabled=1) BEGIN
          INSERT INTO download_observations(owner,resource,state,stamp,reason) VALUES(NEW.owner_id,'data:'||NEW.id,NEW.status,NEW.updated_at,coalesce(NEW.error,'')); END;").map_err(storage)?;
    }
    if exists("job_events"){
        // On upgrade, preserve queued events but do not invent historical
        // attempts from tasks that predate this collector revision.
        db.execute("INSERT OR IGNORE INTO download_collector_cursors SELECT owner,coalesce((SELECT max(rowid) FROM job_events),0) FROM download_telemetry_consent",[]).map_err(storage)?;
    }
    Ok(())
}
pub(crate) fn initialize_for_business(db:&Connection){
    let timeout:i64=db.query_row("PRAGMA busy_timeout",[],|r|r.get(0)).unwrap_or(5000);
    let _=db.busy_timeout(std::time::Duration::from_millis(25));
    let result=schema(db);
    let _=db.busy_timeout(std::time::Duration::from_millis(timeout.max(0)as u64));
    if let Err(error)=result{eprintln!("GeoD download collector unavailable: {}",error.code);}
}
/// Enrol before the first owned task, independent of frontend mounting or clicks.
/// Existing explicit opt-outs remain disabled. No historical task is replayed.
pub(crate) fn initialize_for_owner(db:&Connection,owner:&str){
    let timeout:i64=db.query_row("PRAGMA busy_timeout",[],|r|r.get(0)).unwrap_or(5000);
    let _=db.busy_timeout(std::time::Duration::from_millis(25));
    initialize_for_business(db);
    if let Err(error)=default_policy(db,owner){eprintln!("GeoD diagnostic defaults unavailable: {}",error.code);}
    let _=db.busy_timeout(std::time::Duration::from_millis(timeout.max(0)as u64));
}
fn default_policy(db:&Connection,owner:&str)->Result<(),AppError>{
    let at=Utc::now().to_rfc3339();
    db.execute("UPDATE download_telemetry_consent SET preference_source='explicit' WHERE owner=?1 AND preference_source='legacy' AND notice_version>=2",[owner]).map_err(storage)?;
    db.execute("INSERT OR IGNORE INTO download_telemetry_consent(owner,enabled,since,diagnostic_consent,notice_version,diagnostic_since,preference_source) VALUES(?1,1,?2,1,3,?2,'default')",params![owner,at]).map_err(storage)?;
    // Before notice v2 the detail switch did not exist. A v2 decline is an
    // actual user choice and must not be replaced by this default migration.
    db.execute("UPDATE download_telemetry_consent SET diagnostic_consent=1,diagnostic_since=?2,notice_version=3,preference_source='default' WHERE owner=?1 AND enabled=1 AND notice_version<2",params![owner,at]).map_err(storage)?;
    let last:i64=db.query_row("SELECT coalesce(max(rowid),0) FROM job_events",[],|r|r.get(0)).unwrap_or(0);
    db.execute("INSERT OR IGNORE INTO download_collector_cursors VALUES(?1,?2)",params![owner,last]).map_err(storage)?;
    Ok(())
}
fn migrate_legacy_preference(db:&Connection,owner:&str,legacy_optout:bool)->Result<(),AppError>{
    let preference:Option<(bool,i64,String)>=db.query_row("SELECT enabled,notice_version,preference_source FROM download_telemetry_consent WHERE owner=?1",[owner],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(storage)?;
    if let Some((_,version,source))=preference{
        if source=="explicit"{return Ok(());}
        if legacy_optout{
            db.execute("UPDATE download_telemetry_consent SET enabled=0,diagnostic_consent=0,diagnostic_since=NULL,notice_version=3,preference_source='explicit' WHERE owner=?1",[owner]).map_err(storage)?;
        }else if version<2&&source=="legacy"{
            let at=Utc::now().to_rfc3339();
            db.execute("UPDATE download_telemetry_consent SET enabled=1,since=?2,diagnostic_consent=1,diagnostic_since=?2,notice_version=3,preference_source='default' WHERE owner=?1",params![owner,at]).map_err(storage)?;
        }
    }Ok(())
}
fn terminal(state: &str) -> bool {
    matches!(
        state,
        "completed" | "partial" | "failed" | "cancelled" | "interrupted"
    )
}
fn active(state: &str) -> bool {
    matches!(
        state,
        "queued" | "downloading" | "processing" | "verifying" | "paused" | "cancelling"
    )
}
fn duration(start: &str, end: &str) -> &'static str {
    let elapsed = chrono::DateTime::parse_from_rfc3339(start)
        .ok()
        .zip(chrono::DateTime::parse_from_rfc3339(end).ok())
        .map(|(s, e)| (e - s).num_seconds());
    match elapsed {
        Some(0..=9) => "under_10s",
        Some(10..=59) => "10-60s",
        Some(60..=299) => "1-5m",
        Some(300..=1799) => "5-30m",
        Some(1800..) => "30m+",
        _ => "unknown",
    }
}
fn failure_reason(reason:&str)->&'static str {
    let r=reason.to_uppercase();
    if ["NETWORK","TIMEOUT","网络","超时"].iter().any(|v|r.contains(v)){"network"}
    else if ["AUTH","401","403","授权","认证"].iter().any(|v|r.contains(v)){"auth"}
    else if ["DISK","SPACE","磁盘","空间不足"].iter().any(|v|r.contains(v)){"disk"}
    else if ["PERMISSION","ACCESS_DENIED","权限","拒绝访问"].iter().any(|v|r.contains(v)){"permission"}
    else if ["CHECKSUM","VERIFY","MISMATCH","校验","不匹配","TIFF 的像元"].iter().any(|v|r.contains(v)){"verification"}
    else if ["RASTER_EXPORT_INVALID","SOURCE_","HTTP ","PROVIDER","提供方"].iter().any(|v|r.contains(v)){"provider"}
    else if ["PROCESSING","REPROJECT","处理","转换","投影"].iter().any(|v|r.contains(v)){"processing"}
    else if ["BACKGROUND_","COMPANION","后台启动"].iter().any(|v|r.contains(v)){"backend"}
    else{"unknown"}
}
fn enqueue(
    db: &Connection,
    owner: &str,
    attempt: &str,
    state: &str,
    stamp: &str,
    start: &str,
    reason: &str,
    kind: &str,
    diagnostic: Option<Value>,
) -> Result<(), AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let reason = if state == "partial" {
        "missing_tiles"
    } else if state == "cancelled" {
        "cancelled"
    } else if state == "failed" {
        failure_reason(reason)
    } else {
        "none"
    };
    let body = json!({"event_id":id,"attempt_id":attempt,"occurred_at":stamp,"state":state,"duration":if state=="started"{"unknown"}else{duration(start,stamp)},"reason":reason});
    let mut body=body;body["download_kind"]=json!(if ["imagery","vector","online","tiles3d","raster"].contains(&kind){kind}else{"unknown"});
    let grant:Option<(bool,i64,Option<String>)>=db.query_row("SELECT diagnostic_consent,notice_version,diagnostic_since FROM download_telemetry_consent WHERE owner=?1",[owner],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(storage)?;
    let authorized=grant.as_ref().is_some_and(|(enabled,_,since)|*enabled&&since.as_ref().and_then(|s|chrono::DateTime::parse_from_rfc3339(s).ok()).zip(chrono::DateTime::parse_from_rfc3339(stamp).ok()).is_some_and(|(a,b)|b>=a));
    let status=if authorized{if diagnostic.is_some(){"available"}else{"not_available"}}else{match grant{Some((true,_,_))=>"not_authorized_at_event",Some((false,version,_))if version<2=>"consent_pending",_=>"consent_disabled"}};
    body["client_version"]=json!(env!("CARGO_PKG_VERSION"));body["diagnostic_status"]=json!(status);body["diagnostic"]=if authorized{diagnostic.unwrap_or(Value::Null)}else{Value::Null};
    db.execute(
        "INSERT INTO download_outbox(id,owner,body) VALUES(?1,?2,?3)",
        params![id, owner, body.to_string()],
    )
    .map_err(storage)?;
    Ok(())
}
fn reconcile_imagery(db:&Connection)->Result<(),AppError>{
    let exists:bool=db.query_row("SELECT count(*)=3 FROM sqlite_master WHERE type='table' AND name IN ('jobs','job_events','imagery_plan_owners')",[],|r|r.get(0)).map_err(storage)?;
    if !exists{return Ok(());}
    let owners={let mut q=db.prepare("SELECT c.owner,c.since,x.event_rowid FROM download_telemetry_consent c JOIN download_collector_cursors x ON x.owner=c.owner WHERE c.enabled=1").map_err(storage)?;let rows=q.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).map_err(storage)?.collect::<Result<Vec<_>,_>>().map_err(storage)?;rows};
    for(owner,since,cursor)in owners{
        let rows={let mut q=db.prepare("SELECT e.rowid,e.job_id,e.seq,e.body,(SELECT json_extract(p.body,'$.state') FROM job_events p WHERE p.job_id=e.job_id AND p.seq<e.seq ORDER BY p.seq DESC LIMIT 1) FROM job_events e JOIN jobs j ON j.job_id=e.job_id JOIN imagery_plan_owners o ON o.plan_id=j.plan_id WHERE o.owner_id=?1 AND e.rowid>?2 ORDER BY e.rowid LIMIT 1000").map_err(storage)?;let rows=q.query_map(params![owner,cursor],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?))).map_err(storage)?.collect::<Result<Vec<_>,_>>().map_err(storage)?;rows};
        for(rowid,job,seq,body,previous)in rows{
            if let Ok(value)=serde_json::from_str::<Value>(&body){
                if let(Some(state),Some(stamp))=(value["state"].as_str(),value["occurredAt"].as_str()){
                    let after_consent=chrono::DateTime::parse_from_rfc3339(stamp).ok().zip(chrono::DateTime::parse_from_rfc3339(&since).ok()).is_some_and(|(a,b)|a>=b);
                    if after_consent&&previous.as_deref()!=Some(state){db.execute("INSERT OR IGNORE INTO download_observations(owner,resource,state,stamp,event_seq) SELECT ?1,?2,?3,?4,?5 WHERE NOT EXISTS(SELECT 1 FROM download_observation_receipts WHERE owner=?1 AND resource=?2 AND event_seq=?5)",params![owner,format!("imagery:{job}"),state,stamp,seq]).map_err(storage)?;}
                }
            }
            db.execute("UPDATE download_collector_cursors SET event_rowid=?2 WHERE owner=?1",params![owner,rowid]).map_err(storage)?;
        }
    }Ok(())
}
fn collect(db: &mut Connection) -> Result<(), AppError> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage)?;
    let observations = {
        let mut q=tx.prepare("SELECT o.seq,o.owner,o.resource,o.state,o.stamp,o.reason,o.event_seq FROM download_observations o JOIN download_telemetry_consent c ON c.owner=o.owner AND c.enabled=1 ORDER BY o.seq LIMIT 1000").map_err(storage)?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                ))
            })
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        rows
    };
    for (seq, owner, resource, state, stamp, reason,event_seq) in observations {
        if let Some(native_seq)=event_seq{
            let fresh=tx.execute("INSERT OR IGNORE INTO download_observation_receipts VALUES(?1,?2,?3)",params![owner,resource,native_seq]).map_err(storage)?;
            if fresh==0{tx.execute("DELETE FROM download_observations WHERE seq=?1",[seq]).map_err(storage)?;continue;}
        }
        let (kind,reason,diagnostic)=if let Some(id)=resource.strip_prefix("imagery:"){
            let native:Option<String>=if let Some(event_seq)=event_seq{tx.query_row("SELECT body FROM job_events WHERE job_id=?1 AND seq=?2",params![id,event_seq],|r|r.get(0)).optional().unwrap_or(None)}else{tx.query_row("SELECT body FROM job_events WHERE job_id=?1 AND json_extract(body,'$.state')=?2 ORDER BY seq DESC LIMIT 1",params![id,state],|r|r.get(0)).optional().unwrap_or(None)};
            let value=native.and_then(|s|serde_json::from_str::<Value>(&s).ok());
            let error=value.as_ref().and_then(|v|v["errorCode"].as_str().map(String::from));
            let diagnostic=value.and_then(|v|v.get("diagnostic").filter(|v|v.is_object()).cloned());
            ("imagery".to_owned(),error.unwrap_or(reason),diagnostic)
        }else{
            let kind:Option<String>=tx.query_row("SELECT kind FROM data_download_tasks WHERE id=?1 AND owner_id=?2",params![resource.strip_prefix("data:").unwrap_or(""),owner],|r|r.get(0)).optional().unwrap_or(None);
            (kind.unwrap_or_else(||"unknown".into()),reason,None)
        };
        if active(&state) || terminal(&state) {
            let previous:Option<(String,String,String)>=tx.query_row("SELECT attempt,state,started FROM download_attempts WHERE owner=?1 AND resource=?2",params![owner,resource],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(storage)?;
            let new_attempt = previous
                .as_ref()
                .is_none_or(|(_, s, _)| terminal(s) && active(&state));
            let (attempt, start, old) = if new_attempt {
                (
                    uuid::Uuid::new_v4().to_string(),
                    if terminal(&state){String::new()}else{stamp.clone()},
                    String::new(),
                )
            } else {
                let (a, s, t) = previous.unwrap();
                (a, t, s)
            };
            if new_attempt {
                enqueue(&tx, &owner, &attempt, "started", &stamp, &start, "",&kind,diagnostic.clone())?;
            }
            if terminal(&state) && !terminal(&old) {
                enqueue(
                    &tx,
                    &owner,
                    &attempt,
                    if state == "interrupted" {
                        "failed"
                    } else {
                        &state
                    },
                    &stamp,
                    &start,
                    &reason,
                    &kind,
                    diagnostic,
                )?;
            }
            tx.execute("INSERT INTO download_attempts(owner,resource,attempt,state,started) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(owner,resource) DO UPDATE SET attempt=excluded.attempt,state=excluded.state,started=excluded.started",params![owner,resource,attempt,state,start]).map_err(storage)?;
        }
        tx.execute("DELETE FROM download_observations WHERE seq=?1", [seq])
            .map_err(storage)?;
    }
    tx.commit().map_err(storage)
}
#[tauri::command]
pub(crate) async fn download_telemetry_set(
    app: AppHandle,
    enabled: bool,
    account_id: String,
    diagnostics:Option<bool>,
) -> Result<Value, AppError> {
    tauri::async_runtime::spawn_blocking(move||set_consent(&app,enabled,account_id,diagnostics)).await.map_err(|_|storage("collector thread"))?
}
fn set_consent(app:&AppHandle,enabled:bool,account_id:String,diagnostics:Option<bool>)->Result<Value,AppError>{
    let owner = services::current_user_id(&app.state::<services::ServiceState>())
        .map_err(|e| workspace_error(e.code, e.message))?;
    if owner != account_id {
        return Err(workspace_error("ACCOUNT_CHANGED", "统计设置账号已切换"));
    }
    let state = app.state::<AppState>();
    let db = Connection::open(&state.db_path).map_err(storage)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(storage)?;
    schema(&db)?;
    db.execute("INSERT INTO download_telemetry_consent(owner,enabled,since) VALUES(?1,?2,?3) ON CONFLICT(owner) DO UPDATE SET enabled=excluded.enabled,since=CASE WHEN enabled=excluded.enabled THEN since ELSE excluded.since END",params![owner,enabled,Utc::now().to_rfc3339()]).map_err(storage)?;
    if let Some(detail)=diagnostics{db.execute("UPDATE download_telemetry_consent SET notice_version=3,diagnostic_consent=?2,diagnostic_since=CASE WHEN ?2=0 THEN NULL WHEN diagnostic_consent=1 THEN diagnostic_since ELSE ?3 END WHERE owner=?1",params![owner,enabled&&detail,Utc::now().to_rfc3339()]).map_err(storage)?;}else if !enabled{db.execute("UPDATE download_telemetry_consent SET diagnostic_consent=0,diagnostic_since=NULL,notice_version=3 WHERE owner=?1",[&owner]).map_err(storage)?;}
    db.execute("UPDATE download_telemetry_consent SET notice_ack_version=3 WHERE owner=?1",[&owner]).map_err(storage)?;
    db.execute("UPDATE download_telemetry_consent SET preference_source='explicit',notice_version=3 WHERE owner=?1",[&owner]).map_err(storage)?;
    let last:i64=db.query_row("SELECT coalesce(max(rowid),0) FROM job_events",[],|r|r.get(0)).unwrap_or(0);
    db.execute("INSERT OR IGNORE INTO download_collector_cursors VALUES(?1,?2)",params![owner,last]).map_err(storage)?;
    if !enabled {
        for table in [
            "download_observations",
            "download_outbox",
            "download_attempts",
            "download_collector_cursors",
            "download_observation_receipts",
        ] {
            db.execute(&format!("DELETE FROM {table} WHERE owner=?1"), [&owner])
                .map_err(storage)?;
        }
    }
    Ok(json!({"enabled":enabled,"collector":"native-background","schemaVersion":1}))
}
pub(crate) fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        let _ = tick(&app);
        std::thread::sleep(std::time::Duration::from_secs(5));
    });
}
fn safe_transport(code:&str)->&'static str {
    if code.contains("AUTH")||code.contains("ACCOUNT")||code.contains("LOGIN"){"auth"}
    else if code.contains("NETWORK")||code.contains("TIMEOUT")||code.contains("UNAVAILABLE")||code=="GATEWAY_ERROR"{"network"}
    else if code.contains("EVENT")||code.contains("RECEIPT")||code.contains("SCHEMA"){"schema"}
    else{"unknown"}
}
pub(crate) fn diagnostic_snapshot(db:&Connection,owner:&str)->rusqlite::Result<Value>{
    let enabled:Option<bool>=db.query_row("SELECT enabled FROM download_telemetry_consent WHERE owner=?1",[owner],|r|r.get(0)).optional()?;
    let details:Option<(bool,i64)>=db.query_row("SELECT diagnostic_consent,notice_version FROM download_telemetry_consent WHERE owner=?1",[owner],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let queued:i64=db.query_row("SELECT count(*) FROM download_outbox WHERE owner=?1",[owner],|r|r.get(0))?;
    let observations:i64=db.query_row("SELECT count(*) FROM download_observations WHERE owner=?1",[owner],|r|r.get(0))?;
    let attempts:i64=db.query_row("SELECT count(*) FROM download_attempts WHERE owner=?1",[owner],|r|r.get(0))?;
    let transport:Option<(Option<String>,Option<String>,Option<String>)>=db.query_row("SELECT last_attempt,last_delivery,last_error FROM download_transport_state WHERE owner=?1",[owner],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (last_attempt,last_delivery,last_error)=transport.unwrap_or_default();
    let health:Option<(String,Option<String>)>=db.query_row("SELECT last_tick,last_error FROM download_collector_health WHERE owner=?1",[owner],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let collector_error=health.as_ref().and_then(|(_,e)|e.as_deref());
    let reason=if enabled!=Some(true){"consent_disabled"}else if collector_error.is_some(){"collector_unavailable"}else if queued>0&&last_error.is_some(){match last_error.as_deref(){Some("auth")=>"transport_auth",Some("network")=>"transport_network",Some("schema")=>"transport_schema",_=>"transport_other"}}else if queued>0||observations>0{"queued"}else if last_delivery.is_some(){"reported"}else{"no_download_observed"};
    let notice_ack:Option<i64>=db.query_row("SELECT notice_ack_version FROM download_telemetry_consent WHERE owner=?1",[owner],|r|r.get(0)).optional()?;
    Ok(json!({"enabled":enabled.unwrap_or(false),"hasConsentRecord":enabled.is_some(),"diagnosticsEnabled":details.is_some_and(|(v,_)|v),"needsConsentReview":false,"noticePending":notice_ack.is_some_and(|v|v<3),"reason":reason,"queuedEvents":queued,"pendingObservations":observations,"observedAttempts":attempts,"observedAttemptsMeaning":"resources with a retained latest attempt, not a historical attempt total","lastAttemptAt":last_attempt,"lastDeliveryAt":last_delivery,"lastErrorCategory":last_error,"collector":"native-background","collectorLastTick":health.as_ref().map(|(t,_)|t),"collectorError":collector_error,"schemaVersion":1}))
}
pub(crate) fn diagnostics(app:&AppHandle,owner:&str)->Result<Value,AppError>{
    diagnostics_policy(app,owner,None)
}
fn diagnostics_policy(app:&AppHandle,owner:&str,legacy_optout:Option<bool>)->Result<Value,AppError>{
    let state=app.state::<AppState>();let db=Connection::open(&state.db_path).map_err(storage)?;
    db.busy_timeout(std::time::Duration::from_secs(2)).map_err(storage)?;schema(&db)?;default_policy(&db,owner)?;
    if let Some(value)=legacy_optout{migrate_legacy_preference(&db,owner,value)?;}
    diagnostic_snapshot(&db,owner).map_err(storage)
}
#[tauri::command]
pub(crate) async fn download_telemetry_status(app:AppHandle,account_id:String,legacy_optout:Option<bool>)->Result<Value,AppError>{
    tauri::async_runtime::spawn_blocking(move||status(&app,account_id,legacy_optout)).await.map_err(|_|storage("collector thread"))?
}
fn status(app:&AppHandle,account_id:String,legacy_optout:Option<bool>)->Result<Value,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|workspace_error(e.code,e.message))?;
    if owner!=account_id{return Err(workspace_error("ACCOUNT_CHANGED","下载统计账号已切换"));}
    diagnostics_policy(app,&owner,legacy_optout)
}
#[tauri::command]
pub(crate) async fn download_telemetry_acknowledge(app:AppHandle,account_id:String)->Result<Value,AppError>{
    tauri::async_runtime::spawn_blocking(move||{
        let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|workspace_error(e.code,e.message))?;
        if owner!=account_id{return Err(workspace_error("ACCOUNT_CHANGED","统计设置账号已切换"));}
        let state=app.state::<AppState>();let db=Connection::open(&state.db_path).map_err(storage)?;schema(&db)?;default_policy(&db,&owner)?;
        db.execute("UPDATE download_telemetry_consent SET notice_ack_version=3 WHERE owner=?1",[&owner]).map_err(storage)?;
        diagnostic_snapshot(&db,&owner).map_err(storage)
    }).await.map_err(|_|storage("collector thread"))?
}
fn tick(app: &AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let mut db = Connection::open(&state.db_path).map_err(storage)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(storage)?;
    schema(&db)?;
    let service = app.state::<services::ServiceState>();
    let owner =
        services::current_user_id(&service).map_err(|e| workspace_error(e.code, e.message))?;
    default_policy(&db,&owner)?;
    let collected=reconcile_imagery(&db).and_then(|_|collect(&mut db));
    let category=collected.as_ref().err().map(|e|e.code);
    db.execute("INSERT INTO download_collector_health VALUES(?1,?2,?3) ON CONFLICT(owner) DO UPDATE SET last_tick=excluded.last_tick,last_error=excluded.last_error WHERE coalesce(last_error,'')<>coalesce(excluded.last_error,'') OR julianday(excluded.last_tick)-julianday(last_tick)>30.0/86400.0",params![owner,Utc::now().to_rfc3339(),category]).map_err(storage)?;
    collected?;
    let enabled: bool = db
        .query_row(
            "SELECT enabled FROM download_telemetry_consent WHERE owner=?1",
            [&owner],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage)?
        .unwrap_or(false);
    if !enabled {
        return Ok(());
    }
    flush(&service,&mut db,&owner)
}
fn flush(service:&services::ServiceState,db:&mut Connection,owner:&str)->Result<(),AppError>{
    let batch = {
        let mut q = db
            .prepare("SELECT id,body FROM download_outbox WHERE owner=?1 ORDER BY rowid LIMIT 20")
            .map_err(storage)?;
        let rows = q
            .query_map([&owner], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        rows
    };
    if batch.is_empty() {
        return Ok(());
    }
    let events = batch
        .iter()
        .map(|(_, body)| serde_json::from_str::<Value>(body).map_err(storage))
        .collect::<Result<Vec<_>, _>>()?;
    db.execute("INSERT INTO download_transport_state(owner,last_attempt) VALUES(?1,?2) ON CONFLICT(owner) DO UPDATE SET last_attempt=excluded.last_attempt",params![owner,Utc::now().to_rfc3339()]).map_err(storage)?;
    let receipt = services::send_download_events(service, owner, json!(events)).map_err(|e|{
        let _=db.execute("UPDATE download_transport_state SET last_error=?2 WHERE owner=?1",params![owner,safe_transport(e.code)]);
        workspace_error(e.code,e.message)
    })?;
    if receipt["accepted"].as_u64().unwrap_or(0) + receipt["duplicates"].as_u64().unwrap_or(0)
        != batch.len() as u64
        || (receipt["download_detail_version"].as_u64().unwrap_or(0)>=3 && {
            let expected=batch.iter().filter(|(_,body)|serde_json::from_str::<Value>(body).ok().is_some_and(|v|v["diagnostic"].is_object())).count() as u64;
            receipt["diagnostics"]["accepted"].as_u64().unwrap_or(0)+receipt["diagnostics"]["duplicates"].as_u64().unwrap_or(0)!=expected
        })
    {
        let _=db.execute("UPDATE download_transport_state SET last_error='schema' WHERE owner=?1",[&owner]);
        return Err(workspace_error(
            "TELEMETRY_RECEIPT",
            "统计回执未确认，稍后重试",
        ));
    }
    for (id, _) in batch {
        db.execute(
            "DELETE FROM download_outbox WHERE owner=?1 AND id=?2",
            params![owner, id],
        )
        .map_err(storage)?;
    }
    db.execute("UPDATE download_transport_state SET last_delivery=?2,last_error=NULL WHERE owner=?1",params![owner,Utc::now().to_rfc3339()]).map_err(storage)?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn default_reporting_is_ready_without_a_frontend_choice_and_disclosure_does_not_gate_it(){
        let mut db=Connection::open_in_memory().unwrap();schema(&db).unwrap();default_policy(&db,"fresh").unwrap();
        let state=diagnostic_snapshot(&db,"fresh").unwrap();assert_eq!(state["enabled"],true);assert_eq!(state["diagnosticsEnabled"],true);assert_eq!(state["noticePending"],true);
        db.execute("INSERT INTO download_observations(owner,resource,state,stamp,reason) VALUES('fresh','data:new','failed',?1,'SOURCE_NETWORK')",[Utc::now().to_rfc3339()]).unwrap();collect(&mut db).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM download_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        db.execute("UPDATE download_telemetry_consent SET notice_ack_version=3 WHERE owner='fresh'",[]).unwrap();default_policy(&db,"fresh").unwrap();assert_eq!(diagnostic_snapshot(&db,"fresh").unwrap()["noticePending"],false);
    }
    #[test]fn default_migration_preserves_explicit_optouts_and_does_not_seed_historical_attempts(){
        let db=Connection::open_in_memory().unwrap();schema(&db).unwrap();
        db.execute_batch("CREATE TABLE job_events(body TEXT);INSERT INTO job_events VALUES('{}');INSERT INTO download_telemetry_consent(owner,enabled,since,diagnostic_consent,notice_version) VALUES('off',0,'old',0,2),('basic-only',1,'old',0,2),('legacy',1,'old',0,1)").unwrap();
        for owner in["off","basic-only","legacy"]{default_policy(&db,owner).unwrap();}
        assert_eq!(diagnostic_snapshot(&db,"off").unwrap()["enabled"],false);assert_eq!(diagnostic_snapshot(&db,"basic-only").unwrap()["diagnosticsEnabled"],false);assert_eq!(diagnostic_snapshot(&db,"legacy").unwrap()["diagnosticsEnabled"],true);
        assert_eq!(db.query_row("SELECT min(event_rowid) FROM download_collector_cursors",[],|r|r.get::<_,i64>(0)).unwrap(),1);assert_eq!(db.query_row("SELECT count(*) FROM download_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]fn old_automatic_false_migrates_without_clicks_but_identifiable_optouts_stay_off(){
        let db=Connection::open_in_memory().unwrap();schema(&db).unwrap();
        db.execute_batch("INSERT INTO download_telemetry_consent(owner,enabled,since) VALUES('automatic',0,'old'),('legacy-optout',0,'old');INSERT INTO download_telemetry_consent(owner,enabled,since,diagnostic_consent,notice_version) VALUES('explicit-v2',0,'old',0,2)").unwrap();
        for owner in["automatic","legacy-optout","explicit-v2"]{default_policy(&db,owner).unwrap();}
        migrate_legacy_preference(&db,"automatic",false).unwrap();migrate_legacy_preference(&db,"legacy-optout",true).unwrap();migrate_legacy_preference(&db,"explicit-v2",false).unwrap();
        assert_eq!(diagnostic_snapshot(&db,"automatic").unwrap()["diagnosticsEnabled"],true);assert_eq!(diagnostic_snapshot(&db,"legacy-optout").unwrap()["enabled"],false);assert_eq!(diagnostic_snapshot(&db,"explicit-v2").unwrap()["enabled"],false);
        db.execute("UPDATE download_telemetry_consent SET enabled=0,diagnostic_consent=0,preference_source='explicit' WHERE owner='automatic'",[]).unwrap();default_policy(&db,"automatic").unwrap();migrate_legacy_preference(&db,"automatic",false).unwrap();assert_eq!(diagnostic_snapshot(&db,"automatic").unwrap()["enabled"],false);
    }
    #[test]fn outcome_reasons_retain_processing_provider_permission_and_verification_without_uploading_details(){
        for (detail,expected) in [("原始栅格处理返回无效结果","processing"),("SOURCE_NETWORK","network"),("SOURCE_HTTP HTTP 500","provider"),("CHECKSUM_MISMATCH private.tif","verification"),("ACCESS_DENIED","permission"),("BACKGROUND_UNAVAILABLE","backend"),("no diagnostic","unknown")]{assert_eq!(failure_reason(detail),expected);}
    }
    #[test]fn diagnostics_separate_disabled_no_download_queue_transport_failure_and_confirmed_receipt(){
        let db=Connection::open_in_memory().unwrap();schema(&db).unwrap();
        assert_eq!(diagnostic_snapshot(&db,"a").unwrap()["reason"],"consent_disabled");
        db.execute("INSERT INTO download_telemetry_consent(owner,enabled,since) VALUES('a',1,'now')",[]).unwrap();
        assert_eq!(diagnostic_snapshot(&db,"a").unwrap()["reason"],"no_download_observed");
        enqueue(&db,"a","opaque-attempt","started","now","now","","imagery",None).unwrap();
        assert_eq!(diagnostic_snapshot(&db,"a").unwrap()["reason"],"queued");
        db.execute("INSERT INTO download_transport_state VALUES('a','now',NULL,'network')",[]).unwrap();
        assert_eq!(diagnostic_snapshot(&db,"a").unwrap()["reason"],"transport_network");
        assert_eq!(diagnostic_snapshot(&db,"a").unwrap()["queuedEvents"],1);
        assert_eq!(diagnostic_snapshot(&db,"b").unwrap()["queuedEvents"],0);
        assert!(!diagnostic_snapshot(&db,"a").unwrap().to_string().contains("opaque-attempt"));
        db.execute("DELETE FROM download_outbox WHERE owner='a'",[]).unwrap();db.execute("UPDATE download_transport_state SET last_delivery='later',last_error=NULL WHERE owner='a'",[]).unwrap();
        assert_eq!(diagnostic_snapshot(&db,"a").unwrap()["reason"],"reported");
    }
    #[test] fn imagery_failures_use_native_error_and_keep_anonymous_kind_without_resource_ids(){
        let mut db=Connection::open_in_memory().unwrap();schema(&db).unwrap();
        db.execute_batch("CREATE TABLE job_events(job_id TEXT,seq INTEGER,body TEXT);INSERT INTO job_events VALUES('private-job',1,'{\"errorCode\":\"SOURCE_NETWORK\"}');INSERT INTO download_telemetry_consent(owner,enabled,since) VALUES('owner',1,'now');INSERT INTO download_observations(owner,resource,state,stamp) VALUES('owner','imagery:private-job','downloading','2026-10-18T00:00:00Z'),('owner','imagery:private-job','failed','2026-10-18T00:01:00Z');").unwrap();
        db.execute("UPDATE job_events SET body=json_set(body,'$.state','failed')",[]).unwrap();
        collect(&mut db).unwrap();let body:String=db.query_row("SELECT body FROM download_outbox WHERE json_extract(body,'$.state')='failed'",[],|r|r.get(0)).unwrap();
        assert!(!body.contains("private-job"));let value:Value=serde_json::from_str(&body).unwrap();assert_eq!(value["download_kind"],"imagery");assert_eq!(value["reason"],"network");
    }
    fn imagery_fixture()->Connection{
        let db=Connection::open_in_memory().unwrap();schema(&db).unwrap();
        db.execute_batch("CREATE TABLE jobs(job_id TEXT PRIMARY KEY,plan_id TEXT,state TEXT,version INTEGER);CREATE TABLE job_events(job_id TEXT,seq INTEGER,body TEXT);CREATE TABLE imagery_plan_owners(plan_id TEXT,owner_id TEXT);INSERT INTO imagery_plan_owners VALUES('p','qa');").unwrap();
        schema(&db).unwrap();
        db.execute("INSERT INTO download_telemetry_consent(owner,enabled,since,diagnostic_consent,notice_version,diagnostic_since) VALUES('qa',1,'2026-10-17T00:00:00Z',1,2,'2026-10-17T00:00:00Z')",[]).unwrap();
        db.execute("INSERT INTO download_collector_cursors VALUES('qa',0)",[]).unwrap();db
    }
    fn fixture_event(db:&Connection,seq:i64,state:&str,code:Option<&str>){
        let mut diagnostic=geod_core::acquisition_diagnostic::AcquisitionDiagnostic::default();diagnostic.phase=if state=="completed"{"completed"}else{"base_download"}.into();if let Some(code)=code{diagnostic.fail(code,None,None);}
        if seq==1{db.execute("INSERT INTO jobs VALUES('native-job','p',?1,?2)",params![state,seq]).unwrap();}else{db.execute("UPDATE jobs SET state=?1,version=?2 WHERE job_id='native-job'",params![state,seq]).unwrap();}
        let body=json!({"state":state,"errorCode":code,"occurredAt":"2026-10-18T00:00:00Z","diagnostic":diagnostic});
        db.execute("INSERT INTO job_events VALUES('native-job',?1,?2)",params![seq,body.to_string()]).unwrap();
    }
    #[test]fn durable_event_sequence_keeps_the_failed_attempt_separate_from_a_later_success(){
        let mut db=imagery_fixture();
        for(seq,state,code)in [(1,"queued",None),(2,"downloading",None),(3,"failed",Some("SOURCE_NETWORK")),(4,"queued",None),(5,"downloading",None),(6,"completed",None)]{fixture_event(&db,seq,state,code);}
        reconcile_imagery(&db).unwrap();collect(&mut db).unwrap();
        let failed:String=db.query_row("SELECT body FROM download_outbox WHERE json_extract(body,'$.state')='failed'",[],|r|r.get(0)).unwrap();let failed:Value=serde_json::from_str(&failed).unwrap();assert_eq!(failed["reason"],"network");assert_eq!(failed["diagnostic"]["error_code"],"SOURCE_NETWORK");
        let complete:String=db.query_row("SELECT body FROM download_outbox WHERE json_extract(body,'$.state')='completed'",[],|r|r.get(0)).unwrap();assert_eq!(serde_json::from_str::<Value>(&complete).unwrap()["diagnostic"]["phase"],"completed");
        reconcile_imagery(&db).unwrap();collect(&mut db).unwrap();assert_eq!(db.query_row("SELECT count(*) FROM download_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),4);
    }
    #[test]fn persisted_fast_jobs_are_collected_without_a_frontend_poll_or_working_triggers(){
        let mut db=imagery_fixture();db.execute_batch("DROP TRIGGER download_imagery_insert;DROP TRIGGER download_imagery_update;").unwrap();
        fixture_event(&db,1,"queued",None);fixture_event(&db,2,"downloading",None);fixture_event(&db,3,"completed",None);
        reconcile_imagery(&db).unwrap();collect(&mut db).unwrap();assert_eq!(db.query_row("SELECT count(*) FROM download_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        reconcile_imagery(&db).unwrap();collect(&mut db).unwrap();assert_eq!(db.query_row("SELECT count(*) FROM download_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    }
    #[test]fn old_basic_consent_does_not_silently_authorize_details_or_fake_a_duration(){
        let db=Connection::open_in_memory().unwrap();schema(&db).unwrap();db.execute("INSERT INTO download_telemetry_consent(owner,enabled,since) VALUES('qa',1,'2026-10-17T00:00:00Z')",[]).unwrap();
        enqueue(&db,"qa","attempt-one","failed","2026-10-18T00:00:00Z","","SOURCE_NETWORK","imagery",Some(json!({"private":"not-authorized"}))).unwrap();
        let body:String=db.query_row("SELECT body FROM download_outbox",[],|r|r.get(0)).unwrap();let value:Value=serde_json::from_str(&body).unwrap();assert!(value["diagnostic"].is_null());assert_eq!(value["diagnostic_status"],"consent_pending");assert_eq!(value["duration"],"unknown");assert!(!body.contains("not-authorized"));
    }
    #[test]
    fn durable_retry_and_account_isolation() {
        let mut db = Connection::open_in_memory().unwrap();
        schema(&db).unwrap();
        db.execute(
            "INSERT INTO download_telemetry_consent(owner,enabled,since) VALUES('a',1,'now')",
            [],
        )
        .unwrap();
        for state in ["queued", "downloading", "completed", "queued", "failed"] {
            db.execute("INSERT INTO download_observations(owner,resource,state,stamp) VALUES('a','data:test',?1,'2026-10-16T10:00:00Z')",[state]).unwrap();
        }
        db.execute("INSERT INTO download_observations(owner,resource,state,stamp) VALUES('b','data:other','completed','2026-10-16T10:00:00Z')",[]).unwrap();
        collect(&mut db).unwrap();
        collect(&mut db).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM download_outbox", [], |r| r
                .get::<_, i32>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM download_outbox WHERE owner='b'",
                [],
                |r| r.get::<_, i32>(0)
            )
            .unwrap(),
            0
        );
        let body: String = db
            .query_row("SELECT body FROM download_outbox LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert!(!body.contains("data:test"));
        assert!(!body.contains("resource"));
    }
}

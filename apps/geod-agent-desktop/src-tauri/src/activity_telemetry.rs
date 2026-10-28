//! Optional account-scoped activity. Never sends prompts, provider/model names,
//! channel URLs, credentials, conversation IDs or native generation IDs.
use crate::{ai_channels::AiChannels, services, workspace_error, AppError};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
fn storage<T>(_: T) -> AppError {
    workspace_error("ACTIVITY_STORAGE", "使用统计暂不可用，任务不受影响")
}
pub(crate) fn schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS activity_consent(owner TEXT PRIMARY KEY,enabled INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS activity_outbox(owner TEXT NOT NULL,resource TEXT NOT NULL,state TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner,resource,state)); CREATE TABLE IF NOT EXISTS activity_seen(owner TEXT NOT NULL,resource TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner,resource,state)); CREATE TABLE IF NOT EXISTS activity_status_state(owner TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner,kind));")
}
fn enabled(db: &Connection, owner: &str) -> rusqlite::Result<bool> {
    Ok(db
        .query_row(
            "SELECT enabled FROM activity_consent WHERE owner=?1",
            [owner],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(false))
}
fn reason(code: &str) -> &'static str {
    let s = code.to_uppercase();
    if s.contains("RATE_LIMIT") {
        "rate_limit"
    } else if s.contains("AUTH") || s.contains("CREDENTIAL") {
        "auth"
    } else if s.contains("NETWORK") || s.contains("TIMEOUT") || s.contains("CONNECT") {
        "network"
    } else if s.contains("CONTEXT") || s.contains("TOKEN_LIMIT") {
        "context"
    } else if s.contains("PROVIDER") || s.contains("UPSTREAM") {
        "provider"
    } else {
        "unknown"
    }
}
fn enqueue(
    db: &Connection,
    owner: &str,
    resource: &str,
    state: &str,
    kind: &str,
    value: &Value,
) -> rusqlite::Result<()> {
    if !enabled(db, owner)? {
        return Ok(());
    }
    let known = value["usageKnown"] == true
        && value["inputTokens"]
            .as_u64()
            .is_some_and(|n| n <= 1_000_000_000_000)
        && value["outputTokens"]
            .as_u64()
            .is_some_and(|n| n <= 1_000_000_000_000);
    let id = uuid::Uuid::new_v4().to_string();
    let body = json!({"event_id":id,"kind":kind,"state":state,"reason":if kind=="download_status"{value["reason"].as_str().unwrap_or("collector_unavailable")}else if ["failed","interrupted"].contains(&state){reason(value["errorCode"].as_str().unwrap_or(""))}else{"none"},"occurred_at":Utc::now().to_rfc3339(),"usage_known":known,"input_tokens":if known{value["inputTokens"].clone()}else{Value::Null},"output_tokens":if known{value["outputTokens"].clone()}else{Value::Null}});
    // Both tables are updated in one transaction by the caller. A delivered
    // generation stays seen so reconciliation cannot count it a second time.
    let fresh = db.execute(
        "INSERT OR IGNORE INTO activity_seen VALUES(?1,?2,?3)",
        params![owner, resource, state],
    )?;
    if fresh > 0 {
        db.execute(
            "INSERT INTO activity_outbox VALUES(?1,?2,?3,?4,?5)",
            params![owner, resource, state, id, body.to_string()],
        )?;
    }
    Ok(())
}
pub(crate) fn record_generation(
    db: &Connection,
    owner: &str,
    value: &Value,
) -> rusqlite::Result<()> {
    schema(db)?;
    if value["billingScope"] != "personal" {
        return Ok(());
    }
    let Some(id) = value["generationId"].as_str().filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let state = match value["state"].as_str() {
        Some("streaming" | "pending") => "started",
        Some("settled") => "completed",
        Some("failed") => "failed",
        Some("interrupted" | "cancelled") => "interrupted",
        _ => return Ok(()),
    };
    let tx = db.unchecked_transaction()?;
    enqueue(&tx, owner, id, state, "personal_model", value)?;
    tx.commit()
}
fn set(db: &Connection, owner: &str, on: bool) -> rusqlite::Result<()> {
    schema(db)?;
    let tx = db.unchecked_transaction()?;
    tx.execute("INSERT INTO activity_consent VALUES(?1,?2) ON CONFLICT(owner) DO UPDATE SET enabled=excluded.enabled",params![owner,on])?;
    if !on {
        tx.execute("DELETE FROM activity_outbox WHERE owner=?1", [owner])?;
        tx.execute("DELETE FROM activity_seen WHERE owner=?1", [owner])?;
        tx.execute("DELETE FROM activity_status_state WHERE owner=?1",[owner])?;
    }
    tx.commit()
}
#[tauri::command]
pub(crate) fn agent_activity_set(
    app: AppHandle,
    account_id: String,
    enabled: bool,
) -> Result<Value, AppError> {
    let owner = services::current_user_id(&app.state::<services::ServiceState>())
        .map_err(|e| workspace_error(e.code, e.message))?;
    if owner != account_id {
        return Err(workspace_error("ACCOUNT_CHANGED", "统计设置账号已切换"));
    }
    let db = app.state::<AiChannels>().db().map_err(storage)?;
    set(&db, &owner, enabled).map_err(storage)?;
    Ok(json!({"enabled":enabled,"schemaVersion":1}))
}
pub(crate) fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let session = uuid::Uuid::new_v4().to_string();
        loop {
            let _ = tick(&app, &session);
            std::thread::sleep(std::time::Duration::from_secs(15));
        }
    });
}
fn record_download_status(db:&Connection,owner:&str,value:&Value)->rusqlite::Result<()> {
    if !enabled(db,owner)?{return Ok(());}
    let reason=value["reason"].as_str().filter(|s|matches!(*s,"consent_disabled"|"no_download_observed"|"queued"|"reported"|"transport_auth"|"transport_network"|"transport_schema"|"transport_other"|"collector_unavailable")).unwrap_or("collector_unavailable");
    let previous:Option<String>=db.query_row("SELECT digest FROM activity_status_state WHERE owner=?1 AND kind='download_status'",[owner],|r|r.get(0)).optional()?;
    if previous.as_deref()==Some(reason){return Ok(());}
    let state=if reason=="reported"{"completed"}else if reason.starts_with("transport_")||reason=="collector_unavailable"{"failed"}else{"started"};
    enqueue(db,owner,&format!("download-status:{}",uuid::Uuid::new_v4()),state,"download_status",&json!({"reason":reason}))?;
    db.execute("INSERT INTO activity_status_state VALUES(?1,'download_status',?2) ON CONFLICT(owner,kind) DO UPDATE SET digest=excluded.digest",params![owner,reason])?;
    Ok(())
}
fn tick(app: &AppHandle, session: &str) -> Result<(), AppError> {
    let service = app.state::<services::ServiceState>();
    let owner =
        services::current_user_id(&service).map_err(|e| workspace_error(e.code, e.message))?;
    let db = app.state::<AiChannels>().db().map_err(storage)?;
    schema(&db).map_err(storage)?;
    if !enabled(&db, &owner).map_err(storage)? {
        return Ok(());
    }
    let supports_diagnostics=services::download_diagnostics_supported(&service);
    let download_status=if supports_diagnostics{Some(crate::download_telemetry::diagnostics(app,&owner).unwrap_or_else(|_|json!({"reason":"collector_unavailable"})))}else{None};
    {
        let tx = db.unchecked_transaction().map_err(storage)?;
        enqueue(&tx, &owner, "first-observed-client", "started", "app_first_seen", &Value::Null).map_err(storage)?;
        enqueue(&tx, &owner, session, "started", "app_session", &Value::Null).map_err(storage)?;
        if let Some(diagnostic)=download_status {record_download_status(&tx,&owner,&diagnostic).map_err(storage)?;}
        tx.commit().map_err(storage)?;
    }
    let batch = {
        let mut q = db
            .prepare("SELECT id,body FROM activity_outbox WHERE owner=?1 AND (?2 OR json_extract(body,'$.kind')<>'download_status') ORDER BY rowid LIMIT 20")
            .map_err(storage)?;
        let rows = q
            .query_map(params![owner,supports_diagnostics], |r| {
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
    // Never hold a database write lock during HTTP: model execution must not
    // wait on analytics transport. An already in-flight batch may finish after
    // disable; disable clears pending rows and prevents the next send.
    if !enabled(&db, &owner).map_err(storage)? {
        return Ok(());
    }
    let receipt = services::send_activity_events(&service, &owner, json!(events))
        .map_err(|e| workspace_error(e.code, e.message))?;
    if receipt["accepted"].as_u64().unwrap_or(0) + receipt["duplicates"].as_u64().unwrap_or(0)
        != batch.len() as u64
    {
        return Err(workspace_error("ACTIVITY_RECEIPT", "使用统计稍后重试"));
    }
    let tx = db.unchecked_transaction().map_err(storage)?;
    for (id, _) in batch {
        tx.execute(
            "DELETE FROM activity_outbox WHERE owner=?1 AND id=?2",
            params![owner, id],
        )
        .map_err(storage)?;
    }
    tx.commit().map_err(storage)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn download_diagnostic_requires_activity_consent_and_records_only_state_changes(){
        let db=Connection::open_in_memory().unwrap();schema(&db).unwrap();let off=json!({"reason":"consent_disabled","privatePath":"private","source":"secret"});
        record_download_status(&db,"a",&off).unwrap();assert_eq!(db.query_row("SELECT count(*) FROM activity_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        set(&db,"a",true).unwrap();record_download_status(&db,"a",&off).unwrap();record_download_status(&db,"a",&off).unwrap();
        record_download_status(&db,"a",&json!({"reason":"reported"})).unwrap();record_download_status(&db,"a",&off).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM activity_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),3);
        let body:String=db.query_row("SELECT body FROM activity_outbox LIMIT 1",[],|r|r.get(0)).unwrap();assert!(!body.contains("private")&&!body.contains("secret"));
        assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["reason"],"consent_disabled");
    }
    #[test]
    fn first_observation_requires_consent_and_is_locally_deduplicated() {
        let db=Connection::open_in_memory().unwrap();schema(&db).unwrap();
        enqueue(&db,"a","first-observed-client","started","app_first_seen",&Value::Null).unwrap();
        assert_eq!(db.query_row("SELECT count(*) FROM activity_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        set(&db,"a",true).unwrap();
        for _ in 0..2 {enqueue(&db,"a","first-observed-client","started","app_first_seen",&Value::Null).unwrap();}
        assert_eq!(db.query_row("SELECT count(*) FROM activity_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    #[test]
    fn outbox_survives_restart_and_disabling_one_account_preserves_the_other() {
        let path =
            std::env::temp_dir().join(format!("geod-activity-{}.sqlite", uuid::Uuid::new_v4()));
        let v = json!({"generationId":"local-id","billingScope":"personal","state":"settled","usageKnown":false});
        {
            let db = Connection::open(&path).unwrap();
            set(&db, "a", true).unwrap();
            set(&db, "b", true).unwrap();
            record_generation(&db, "a", &v).unwrap();
            record_generation(&db, "b", &v).unwrap();
        }
        {
            let db = Connection::open(&path).unwrap();
            schema(&db).unwrap();
            record_generation(&db, "a", &v).unwrap();
            assert_eq!(
                db.query_row("SELECT count(*) FROM activity_outbox", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                2
            );
            set(&db, "a", false).unwrap();
            assert_eq!(
                db.query_row("SELECT owner FROM activity_outbox", [], |r| r
                    .get::<_, String>(0))
                    .unwrap(),
                "b"
            );
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn consent_dedup_privacy_and_account_isolation() {
        let db = Connection::open_in_memory().unwrap();
        schema(&db).unwrap();
        let v = json!({"generationId":"secret-native-id","billingScope":"personal","state":"settled","usageKnown":true,"inputTokens":123,"outputTokens":4,"result":"private prompt","channelId":"secret-channel","model":"private-model"});
        record_generation(&db, "a", &v).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM activity_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        set(&db, "a", true).unwrap();
        record_generation(&db, "a", &v).unwrap();
        record_generation(&db, "a", &v).unwrap();
        record_generation(&db, "b", &v).unwrap();
        let body: String = db
            .query_row("SELECT body FROM activity_outbox", [], |r| r.get(0))
            .unwrap();
        assert!(!body.contains("private"));
        assert!(!body.contains("secret"));
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap()["input_tokens"],
            123
        );
        db.execute("DELETE FROM activity_outbox", []).unwrap();
        record_generation(&db, "a", &v).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM activity_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let mut v = v.clone();
        v["state"] = json!("failed");
        v["usageKnown"] = json!(false);
        v["errorCode"] = json!("PROVIDER_STREAM_INCOMPLETE");
        record_generation(&db, "a", &v).unwrap();
        let body: String = db
            .query_row("SELECT body FROM activity_outbox", [], |r| r.get(0))
            .unwrap();
        let v: Value = serde_json::from_str(&body).unwrap();
        assert!(v["input_tokens"].is_null());
        assert_eq!(v["reason"], "provider");
        set(&db, "a", false).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM activity_outbox", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

//! Consent-scoped, durable download outcome outbox. No filenames, geometry,
//! credential values or native task IDs leave this device.
use crate::{services, workspace_error, AppError, AppState};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn storage(_: impl std::fmt::Display) -> AppError {
    workspace_error("TELEMETRY_STORAGE", "下载统计暂不可用，下载不受影响")
}
pub(crate) fn schema(db: &Connection) -> Result<(), AppError> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS download_telemetry_consent(owner TEXT PRIMARY KEY,enabled INTEGER NOT NULL,since TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS download_observations(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,resource TEXT NOT NULL,state TEXT NOT NULL,stamp TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS download_attempts(owner TEXT NOT NULL,resource TEXT NOT NULL,attempt TEXT NOT NULL,state TEXT NOT NULL,started TEXT NOT NULL,PRIMARY KEY(owner,resource));
      CREATE TABLE IF NOT EXISTS download_outbox(id TEXT PRIMARY KEY,owner TEXT NOT NULL,body TEXT NOT NULL);").map_err(storage)?;
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
        db.execute_batch("CREATE TRIGGER IF NOT EXISTS download_imagery_insert AFTER INSERT ON jobs WHEN EXISTS(SELECT 1 FROM imagery_plan_owners o JOIN download_telemetry_consent c ON c.owner=o.owner_id WHERE o.plan_id=NEW.plan_id AND c.enabled=1) BEGIN
          INSERT INTO download_observations(owner,resource,state,stamp) SELECT owner_id,'imagery:'||NEW.job_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM imagery_plan_owners WHERE plan_id=NEW.plan_id; END;
          CREATE TRIGGER IF NOT EXISTS download_imagery_update AFTER UPDATE OF state ON jobs WHEN OLD.state<>NEW.state AND EXISTS(SELECT 1 FROM imagery_plan_owners o JOIN download_telemetry_consent c ON c.owner=o.owner_id WHERE o.plan_id=NEW.plan_id AND c.enabled=1) BEGIN
          INSERT INTO download_observations(owner,resource,state,stamp) SELECT owner_id,'imagery:'||NEW.job_id,NEW.state,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM imagery_plan_owners WHERE plan_id=NEW.plan_id; END;").map_err(storage)?;
    }
    if exists("data_download_tasks") {
        db.execute_batch("CREATE TRIGGER IF NOT EXISTS download_data_update AFTER UPDATE OF status ON data_download_tasks WHEN OLD.status<>NEW.status AND EXISTS(SELECT 1 FROM download_telemetry_consent c WHERE c.owner=NEW.owner_id AND c.enabled=1) BEGIN
          INSERT INTO download_observations(owner,resource,state,stamp,reason) VALUES(NEW.owner_id,'data:'||NEW.id,NEW.status,NEW.updated_at,coalesce(NEW.error,'')); END;").map_err(storage)?;
    }
    Ok(())
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
fn enqueue(
    db: &Connection,
    owner: &str,
    attempt: &str,
    state: &str,
    stamp: &str,
    start: &str,
    reason: &str,
    kind: &str,
) -> Result<(), AppError> {
    let id = uuid::Uuid::new_v4().to_string();
    let reason = if state == "partial" {
        "missing_tiles"
    } else if state == "cancelled" {
        "cancelled"
    } else if state == "failed" {
        let r = reason.to_uppercase();
        if r.contains("NETWORK") || r.contains("TIMEOUT") || r.contains("网络") || r.contains("超时") {
            "network"
        } else if r.contains("AUTH") {
            "auth"
        } else if r.contains("DISK") || r.contains("SPACE") {
            "disk"
        } else {
            "unknown"
        }
    } else {
        "none"
    };
    let body = json!({"event_id":id,"attempt_id":attempt,"occurred_at":stamp,"state":state,"duration":if state=="started"{"unknown"}else{duration(start,stamp)},"reason":reason});
    let mut body=body;body["download_kind"]=json!(if ["imagery","vector","online","tiles3d"].contains(&kind){kind}else{"unknown"});
    db.execute(
        "INSERT INTO download_outbox(id,owner,body) VALUES(?1,?2,?3)",
        params![id, owner, body.to_string()],
    )
    .map_err(storage)?;
    Ok(())
}
fn collect(db: &mut Connection) -> Result<(), AppError> {
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(storage)?;
    let observations = {
        let mut q=tx.prepare("SELECT o.seq,o.owner,o.resource,o.state,o.stamp,o.reason FROM download_observations o JOIN download_telemetry_consent c ON c.owner=o.owner AND c.enabled=1 ORDER BY o.seq LIMIT 1000").map_err(storage)?;
        let rows = q
            .query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(storage)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage)?;
        rows
    };
    for (seq, owner, resource, state, stamp, reason) in observations {
        let (kind,reason)=if let Some(id)=resource.strip_prefix("imagery:"){
            let native:Option<String>=tx.query_row("SELECT body FROM job_events WHERE job_id=?1 ORDER BY seq DESC LIMIT 1",[id],|r|r.get(0)).optional().unwrap_or(None);
            let error=native.and_then(|s|serde_json::from_str::<Value>(&s).ok()).and_then(|v|v["errorCode"].as_str().map(String::from));
            ("imagery".to_owned(),error.unwrap_or(reason))
        }else{
            let kind:Option<String>=tx.query_row("SELECT kind FROM data_download_tasks WHERE id=?1 AND owner_id=?2",params![resource.strip_prefix("data:").unwrap_or(""),owner],|r|r.get(0)).optional().unwrap_or(None);
            (kind.unwrap_or_else(||"unknown".into()),reason)
        };
        if active(&state) || terminal(&state) {
            let previous:Option<(String,String,String)>=tx.query_row("SELECT attempt,state,started FROM download_attempts WHERE owner=?1 AND resource=?2",params![owner,resource],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(storage)?;
            let new_attempt = previous
                .as_ref()
                .is_none_or(|(_, s, _)| terminal(s) && active(&state));
            let (attempt, start, old) = if new_attempt {
                (
                    uuid::Uuid::new_v4().to_string(),
                    stamp.clone(),
                    String::new(),
                )
            } else {
                let (a, s, t) = previous.unwrap();
                (a, t, s)
            };
            if new_attempt {
                enqueue(&tx, &owner, &attempt, "started", &stamp, &start, "",&kind)?;
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
pub(crate) fn download_telemetry_set(
    app: AppHandle,
    enabled: bool,
    account_id: String,
) -> Result<Value, AppError> {
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
    if !enabled {
        for table in [
            "download_observations",
            "download_outbox",
            "download_attempts",
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
fn tick(app: &AppHandle) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let mut db = Connection::open(&state.db_path).map_err(storage)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(storage)?;
    schema(&db)?;
    collect(&mut db)?;
    let service = app.state::<services::ServiceState>();
    let owner =
        services::current_user_id(&service).map_err(|e| workspace_error(e.code, e.message))?;
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
    let receipt = services::send_download_events(&service, &owner, json!(events))
        .map_err(|e| workspace_error(e.code, e.message))?;
    if receipt["accepted"].as_u64().unwrap_or(0) + receipt["duplicates"].as_u64().unwrap_or(0)
        != batch.len() as u64
    {
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
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn imagery_failures_use_native_error_and_keep_anonymous_kind_without_resource_ids(){
        let mut db=Connection::open_in_memory().unwrap();schema(&db).unwrap();
        db.execute_batch("CREATE TABLE job_events(job_id TEXT,seq INTEGER,body TEXT);INSERT INTO job_events VALUES('private-job',1,'{\"errorCode\":\"SOURCE_NETWORK\"}');INSERT INTO download_telemetry_consent VALUES('owner',1,'now');INSERT INTO download_observations(owner,resource,state,stamp) VALUES('owner','imagery:private-job','downloading','2026-10-18T00:00:00Z'),('owner','imagery:private-job','failed','2026-10-18T00:01:00Z');").unwrap();
        collect(&mut db).unwrap();let body:String=db.query_row("SELECT body FROM download_outbox WHERE json_extract(body,'$.state')='failed'",[],|r|r.get(0)).unwrap();
        assert!(!body.contains("private-job"));let value:Value=serde_json::from_str(&body).unwrap();assert_eq!(value["download_kind"],"imagery");assert_eq!(value["reason"],"network");
    }
    #[test]
    fn durable_retry_and_account_isolation() {
        let mut db = Connection::open_in_memory().unwrap();
        schema(&db).unwrap();
        db.execute(
            "INSERT INTO download_telemetry_consent VALUES('a',1,'now')",
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

//! Persistent AI schedules executed by the windowless native companion.
use crate::{
    background_runtime, codex_runtime, headless_tools, read_workspace, services, workspace_error,
    AppError, AppState,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
pub(crate) static GATE: Mutex<()> = Mutex::new(());
pub(crate) static ACTIVE: AtomicBool = AtomicBool::new(false);
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSchedule {
    schedule_id: String,
    owner_id: String,
    conversation_id: String,
    name: String,
    prompt: String,
    history: Value,
    enabled: bool,
    next_run_at: DateTime<Utc>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    initial_next_run_at: Option<DateTime<Utc>>,
    repeat_seconds: Option<u32>,
    created_at: DateTime<Utc>,
    #[serde(default)]
    model_route: Option<crate::ai_channels::RouteSnapshot>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiRun {
    run_id: String,
    schedule_id: String,
    owner_id: String,
    conversation_id: String,
    name: String,
    scheduled_at: DateTime<Utc>,
    state: String,
    attempt: u32,
    result: Option<Value>,
    error: Option<Value>,
    started_at: Option<DateTime<Utc>>,
    finished_at: Option<DateTime<Utc>>,
    #[serde(default)]
    model_route: Option<crate::ai_channels::RouteSnapshot>,
}
fn database(app: &AppHandle) -> Result<Connection, AppError> {
    let path = app
        .state::<AppState>()
        .workspace_dir
        .join("agent-ai-schedules.sqlite");
    let connection = Connection::open(path).map_err(storage)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(storage)?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(storage)?;
    connection.execute_batch("CREATE TABLE IF NOT EXISTS ai_schedules(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation TEXT NOT NULL,enabled INTEGER NOT NULL,next_at INTEGER NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ai_runs(id TEXT PRIMARY KEY,schedule TEXT NOT NULL,owner TEXT NOT NULL,conversation TEXT NOT NULL,state TEXT NOT NULL,scheduled_at INTEGER NOT NULL,body TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ai_due ON ai_schedules(owner,enabled,next_at);
        CREATE TABLE IF NOT EXISTS ai_events(run TEXT NOT NULL,seq INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(run,seq));").map_err(storage)?;
    Ok(connection)
}
fn storage(_: rusqlite::Error) -> AppError {
    workspace_error("AI_SCHEDULE_STORAGE", "AI 定时任务记录暂不可用")
}
fn owner(app: &AppHandle) -> Result<String, AppError> {
    services::current_user_id(&app.state()).map_err(|e| workspace_error(e.code, e.message))
}
fn get<T: serde::de::DeserializeOwned>(
    connection: &Connection,
    table: &str,
    id: &str,
    owner: &str,
) -> Result<T, AppError> {
    let body: Option<String> = connection
        .query_row(
            &format!("SELECT body FROM {table} WHERE id=?1 AND owner=?2"),
            params![id, owner],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage)?;
    serde_json::from_str(
        &body.ok_or_else(|| workspace_error("AI_SCHEDULE_NOT_FOUND", "当前账号没有此记录"))?,
    )
    .map_err(|_| workspace_error("AI_SCHEDULE_STORAGE", "任务记录无效"))
}
fn save_run(connection: &Connection, run: &AiRun) -> Result<(), AppError> {
    connection
        .execute(
            "UPDATE ai_runs SET state=?1,body=?2 WHERE id=?3 AND owner=?4",
            params![
                run.state,
                serde_json::to_string(run).unwrap(),
                run.run_id,
                run.owner_id
            ],
        )
        .map_err(storage)?;
    Ok(())
}
fn event(app: &AppHandle, run: &str, value: &Value) -> Result<(), AppError> {
    // Heartbeats/repeated deltas do not grow the ledger. Completed items retain
    // actual reasoning/tool/command output, final text and authoritative usage.
    if matches!(value["type"].as_str(), Some("heartbeat"))
        || value["method"]
            .as_str()
            .is_some_and(|s| s.ends_with("/delta"))
    {
        return Ok(());
    }
    let text = serde_json::to_string(value).unwrap();
    if text.len() > 2 * 1024 * 1024 {
        return Err(workspace_error(
            "AI_EVENT_LIMIT",
            "单项执行记录超过保存上限",
        ));
    }
    let connection = database(app)?;
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM ai_events WHERE run=?1", [run], |r| {
            r.get(0)
        })
        .map_err(storage)?;
    if count >= 2000 {
        return Err(workspace_error("AI_EVENT_LIMIT", "本次执行记录超过上限"));
    }
    connection.execute("INSERT INTO ai_events(run,seq,body) VALUES (?1,(SELECT COALESCE(MAX(seq),0)+1 FROM ai_events WHERE run=?1),?2)",params![run,text]).map_err(storage)?;
    Ok(())
}
#[tauri::command]
pub(crate) fn ai_schedules_create(
    app: AppHandle,
    conversation_id: String,
    name: String,
    prompt: String,
    next_run_at: DateTime<Utc>,
    repeat_seconds: Option<u32>,
    execution_id: String,
    history: Option<Value>,
) -> Result<AiSchedule, AppError> {
    let owner = owner(&app)?;
    read_workspace(&app, &app.state(), &app.state(), &conversation_id)?;
    if name.trim().is_empty()
        || name.chars().count() > 120
        || prompt.trim().is_empty()
        || prompt.len() > 60000
        || execution_id.len() > 200
        || execution_id.is_empty()
        || repeat_seconds.is_some_and(|s| !(60..=31536000).contains(&s))
    {
        return Err(workspace_error(
            "AI_SCHEDULE_INVALID",
            "请核对名称、指令、开始时间和重复频率",
        ));
    }
    let history = history.unwrap_or(json!([]));
    if !history.is_array() || serde_json::to_vec(&history).unwrap().len() > 2 * 1024 * 1024 {
        return Err(workspace_error(
            "AI_HISTORY_INVALID",
            "会话上下文过长或格式无效",
        ));
    }
    use sha2::{Digest, Sha256};
    let id = format!(
        "ai-{:x}",
        Sha256::digest(format!("{owner}:{conversation_id}:{execution_id}").as_bytes())
    );
    let mut db = database(&app)?;
    let transaction = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    if let Ok(existing) = get::<AiSchedule>(&transaction, "ai_schedules", &id, &owner) {
        if existing.conversation_id != conversation_id
            || existing.name != name.trim()
            || existing.prompt != prompt.trim()
            || existing.initial_next_run_at.unwrap_or(existing.next_run_at) != next_run_at
            || existing.repeat_seconds != repeat_seconds
            || existing.history != history
        {
            return Err(workspace_error(
                "AI_IDEMPOTENCY_CONFLICT",
                "相同执行标识对应了不同的定时指令",
            ));
        }
        return Ok(existing);
    }
    if next_run_at < Utc::now() || next_run_at > Utc::now() + chrono::Duration::days(366) {
        return Err(workspace_error("AI_SCHEDULE_INVALID", "开始时间无效"));
    }
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM ai_schedules WHERE owner=?1 AND enabled=1",
            [&owner],
            |r| r.get(0),
        )
        .map_err(storage)?;
    if count >= 100 {
        return Err(workspace_error("AI_SCHEDULE_LIMIT", "请先暂停部分定时任务"));
    }
    let schedule = AiSchedule {
        model_route: Some(crate::ai_channels::inherit(&app,&owner,&conversation_id).map_err(|e|workspace_error(e.code,e.message))?),
        schedule_id: id,
        owner_id: owner,
        conversation_id,
        name: name.trim().into(),
        prompt: prompt.trim().into(),
        history,
        enabled: true,
        next_run_at,
        initial_next_run_at: Some(next_run_at),
        repeat_seconds,
        created_at: Utc::now(),
    };
    transaction.execute("INSERT OR IGNORE INTO ai_schedules(id,owner,conversation,enabled,next_at,body) VALUES (?1,?2,?3,1,?4,?5)",params![schedule.schedule_id,schedule.owner_id,schedule.conversation_id,schedule.next_run_at.timestamp(),serde_json::to_string(&schedule).unwrap()]).map_err(storage)?;
    transaction.commit().map_err(storage)?;
    get(
        &db,
        "ai_schedules",
        &schedule.schedule_id,
        &schedule.owner_id,
    )
}
#[tauri::command]
pub(crate) fn ai_schedules_list(
    app: AppHandle,
    conversation_id: String,
) -> Result<Value, AppError> {
    let owner = owner(&app)?;
    let db = database(&app)?;
    let read = |table: &str, order: &str| -> Result<Vec<Value>, AppError> {
        let mut statement=db.prepare(&format!("SELECT body FROM {table} WHERE owner=?1 AND conversation=?2 ORDER BY {order} LIMIT 100")).map_err(storage)?;
        let rows = statement
            .query_map(params![owner, conversation_id], |r| r.get::<_, String>(0))
            .map_err(storage)?;
        rows.map(|s| {
            serde_json::from_str(&s.map_err(storage)?)
                .map_err(|_| workspace_error("AI_SCHEDULE_STORAGE", "记录无效"))
        })
        .collect()
    };
    Ok(
        json!({"schedules":read("ai_schedules","next_at")?,"runs":read("ai_runs","scheduled_at DESC,id DESC")?,"windowRequired":false}),
    )
}
#[tauri::command]
pub(crate) fn ai_schedules_set_enabled(
    app: AppHandle,
    schedule_id: String,
    enabled: bool,
    next_run_at: Option<DateTime<Utc>>,
) -> Result<AiSchedule, AppError> {
    let owner = owner(&app)?;
    let db = database(&app)?;
    let mut s: AiSchedule = get(&db, "ai_schedules", &schedule_id, &owner)?;
    if let Some(next) = next_run_at {
        if next < Utc::now() || next > Utc::now() + chrono::Duration::days(366) {
            return Err(workspace_error("AI_SCHEDULE_INVALID", "开始时间无效"));
        }
        s.next_run_at = next;
    }
    if enabled && s.repeat_seconds.is_none() && s.next_run_at < Utc::now() {
        return Err(workspace_error(
            "AI_SCHEDULE_INVALID",
            "再次运行需设置新的开始时间",
        ));
    }
    s.enabled = enabled;
    db.execute(
        "UPDATE ai_schedules SET enabled=?1,next_at=?2,body=?3 WHERE id=?4 AND owner=?5",
        params![
            enabled,
            s.next_run_at.timestamp(),
            serde_json::to_string(&s).unwrap(),
            s.schedule_id,
            owner
        ],
    )
    .map_err(storage)?;
    Ok(s)
}
#[tauri::command]
pub(crate) fn ai_schedules_run_events(app: AppHandle, run_id: String) -> Result<Value, AppError> {
    let owner = owner(&app)?;
    let db = database(&app)?;
    let run: AiRun = get(&db, "ai_runs", &run_id, &owner)?;
    let mut q = db
        .prepare("SELECT body FROM ai_events WHERE run=?1 ORDER BY seq LIMIT 2000")
        .map_err(storage)?;
    let rows = q
        .query_map([run_id], |r| r.get::<_, String>(0))
        .map_err(storage)?;
    let events: Vec<Value> = rows
        .map(|s| {
            serde_json::from_str(&s.map_err(storage)?)
                .map_err(|_| workspace_error("AI_SCHEDULE_STORAGE", "执行记录无效"))
        })
        .collect::<Result<_, _>>()?;
    Ok(json!({"run":run,"events":events}))
}
#[tauri::command]
pub(crate) fn ai_schedules_cancel_run(app: AppHandle, run_id: String) -> Result<AiRun, AppError> {
    let owner = owner(&app)?;
    let _gate = GATE.lock().unwrap();
    let db = database(&app)?;
    let mut run: AiRun = get(&db, "ai_runs", &run_id, &owner)?;
    if matches!(run.state.as_str(), "succeeded" | "failed" | "cancelled") {
        return Ok(run);
    }
    run.state = "cancelled".into();
    run.finished_at = Some(Utc::now());
    save_run(&db, &run)?;
    let _ = codex_runtime::send_command(
        app.state::<codex_runtime::CodexState>().inner(),
        &owner,
        &run_id,
        json!({"type":"interrupt"}),
    );
    Ok(run)
}
#[tauri::command]
pub(crate) fn ai_schedules_retry_run(app: AppHandle, run_id: String) -> Result<AiRun, AppError> {
    let owner = owner(&app)?;
    let _gate = GATE.lock().unwrap();
    let db = database(&app)?;
    let mut run: AiRun = get(&db, "ai_runs", &run_id, &owner)?;
    if !matches!(
        run.state.as_str(),
        "failed" | "waiting_input" | "interrupted"
    ) {
        return Err(workspace_error(
            "AI_RUN_CONFLICT",
            "仅失败、需要输入或中断的执行可以重试",
        ));
    }
    run.state = "queued".into();
    run.error = None;
    run.result = None;
    run.finished_at = None;
    save_run(&db, &run)?;
    Ok(run)
}
fn claim(app: &AppHandle, owner: &str) -> Result<Option<(AiSchedule, AiRun)>, AppError> {
    let mut db = database(app)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    let pending:Option<String>=tx.query_row("SELECT body FROM ai_runs WHERE owner=?1 AND state='queued' ORDER BY scheduled_at LIMIT 1",[owner],|r|r.get(0)).optional().map_err(storage)?;
    let (schedule, mut run) = if let Some(body) = pending {
        let run: AiRun = serde_json::from_str(&body).unwrap();
        (
            get::<AiSchedule>(&tx, "ai_schedules", &run.schedule_id, owner)?,
            run,
        )
    } else {
        let body:Option<String>=tx.query_row("SELECT s.body FROM ai_schedules s WHERE owner=?1 AND enabled=1 AND next_at<=?2 AND NOT EXISTS (SELECT 1 FROM ai_runs r WHERE r.schedule=s.id AND r.state IN ('queued','running','waiting_input','interrupted')) ORDER BY next_at LIMIT 1",params![owner,Utc::now().timestamp()],|r|r.get(0)).optional().map_err(storage)?;
        let Some(body) = body else {
            return Ok(None);
        };
        let mut schedule: AiSchedule = serde_json::from_str(&body).unwrap();
        let run = AiRun {
            model_route: schedule.model_route.clone().or_else(||Some(crate::ai_channels::RouteSnapshot::hosted(owner))),
            run_id: Uuid::new_v4().to_string(),
            schedule_id: schedule.schedule_id.clone(),
            owner_id: owner.into(),
            conversation_id: schedule.conversation_id.clone(),
            name: schedule.name.clone(),
            scheduled_at: schedule.next_run_at,
            state: "queued".into(),
            attempt: 0,
            result: None,
            error: None,
            started_at: None,
            finished_at: None,
        };
        if let Some(seconds) = schedule.repeat_seconds {
            let elapsed = (Utc::now().timestamp() - schedule.next_run_at.timestamp())
                / i64::from(seconds)
                + 1;
            schedule.next_run_at += chrono::Duration::seconds(elapsed * i64::from(seconds));
        } else {
            schedule.enabled = false;
        }
        tx.execute(
            "UPDATE ai_schedules SET enabled=?1,next_at=?2,body=?3 WHERE id=?4",
            params![
                schedule.enabled,
                schedule.next_run_at.timestamp(),
                serde_json::to_string(&schedule).unwrap(),
                schedule.schedule_id
            ],
        )
        .map_err(storage)?;
        tx.execute("INSERT INTO ai_runs(id,schedule,owner,conversation,state,scheduled_at,body) VALUES (?1,?2,?3,?4,'queued',?5,?6)",params![run.run_id,run.schedule_id,run.owner_id,run.conversation_id,run.scheduled_at.timestamp(),serde_json::to_string(&run).unwrap()]).map_err(storage)?;
        (schedule, run)
    };
    run.state = "running".into();
    run.attempt += 1;
    run.started_at = Some(Utc::now());
    save_run(&tx, &run)?;
    tx.commit().map_err(storage)?;
    Ok(Some((schedule, run)))
}
fn recover(app: &AppHandle) -> Result<(), AppError> {
    let db = database(app)?;
    let mut q = db
        .prepare("SELECT body FROM ai_runs WHERE state='running'")
        .map_err(storage)?;
    let rows = q
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(storage)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(storage)?;
    drop(q);
    for body in rows {
        let mut run: AiRun = serde_json::from_str(&body).unwrap();
        run.state = "interrupted".into();
        run.finished_at = Some(Utc::now());
        run.error = Some(
            json!({"code":"BACKGROUND_INTERRUPTED","message":"后台意外退出；请核对执行记录后重试，已启动的下载单独恢复"}),
        );
        save_run(&db, &run)?;
    }
    Ok(())
}
pub(crate) fn start(app: AppHandle) {
    std::thread::spawn(move || {
        if recover(&app).is_err() {
            eprintln!("AI schedule recovery unavailable");
        }
        loop {
            std::thread::sleep(Duration::from_secs(1));
            if background_runtime::STOPPING.load(Ordering::Acquire) {
                continue;
            }
            let Ok(owner) = owner(&app) else {
                continue;
            };
            let claimed = {
                let _gate = GATE.lock().unwrap();
                if background_runtime::STOPPING.load(Ordering::Acquire) {
                    continue;
                }
                let result = claim(&app, &owner);
                if matches!(&result, Ok(Some(_))) {
                    ACTIVE.store(true, Ordering::Release);
                }
                result
            };
            let Ok(Some((schedule, run))) = claimed else {
                continue;
            };
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                execute_run(&app, schedule, run)
            }));
            ACTIVE.store(false, Ordering::Release);
            if outcome.is_err() {
                eprintln!("AI scheduled turn failed unexpectedly");
                let _ = recover(&app);
            }
        }
    });
}
fn execute_run(app: &AppHandle, schedule: AiSchedule, mut run: AiRun) {
    let needs_input = Arc::new(AtomicBool::new(false));
    let blocked = Arc::clone(&needs_input);
    let callback_app = app.clone();
    let callback_run = run.clone();
    let started = std::time::Instant::now();
    let sink: codex_runtime::EventSink = Arc::new(move |value| {
        let failure = |code, message| services::ServiceError {
            code,
            message: String::from(message),
        };
        if started.elapsed() > Duration::from_secs(600) {
            return Err(failure(
                "AI_RUN_TIMEOUT",
                "定时执行超过十分钟，请检查记录后继续",
            ));
        }
        let actual =
            owner(&callback_app).map_err(|_| failure("AUTH_REQUIRED", "账号连接已失效"))?;
        if actual != callback_run.owner_id {
            return Err(failure("AI_OWNER_CHANGED", "账号已切换，执行已停止"));
        }
        let current: AiRun = get(
            &database(&callback_app).map_err(|_| failure("AI_SCHEDULE_STORAGE", "记录不可用"))?,
            "ai_runs",
            &callback_run.run_id,
            &actual,
        )
        .map_err(|_| failure("AI_SCHEDULE_STORAGE", "执行记录不可用"))?;
        if current.state == "cancelled" {
            return Err(failure("AI_RUN_CANCELLED", "执行已取消"));
        }
        event(&callback_app, &callback_run.run_id, &value).map_err(|e| services::ServiceError {
            code: e.code,
            message: e.message,
        })?;
        if value["type"] == "request" {
            blocked.store(true, Ordering::Release);
            return Err(failure(
                "AI_USER_INPUT_REQUIRED",
                "执行需要人工输入或确认，请打开运行记录",
            ));
        }
        if value["type"]=="pluginHookMcpResult"&&matches!(value["error"].as_str(),Some("APPROVAL_REQUIRED"|"USER_INPUT_REQUIRED"|"VIEW_REQUIRED")){blocked.store(true,Ordering::Release);}
        if value["type"] == "tool" {
            let request = value.clone();
            let tool = request["tool"].as_str().unwrap_or("");
            let args = request["arguments"].clone();
            let key = format!(
                "ai:{}:{}",
                callback_run.run_id,
                request["callId"].as_str().unwrap_or("")
            );
            let result = tauri::async_runtime::block_on(headless_tools::execute(
                &callback_app,
                &callback_run.conversation_id,
                tool,
                args,
                &key,
            ));
            let result = match result {
                Ok(value) => value,
                Err(e) => json!({"error":{"code":e.code,"message":e.message}}),
            };
            // Some tools return a structured error as an ordinary value. The
            // scheduler must retain its required-input state in either form.
            if matches!(result["error"]["code"].as_str(), Some("APPROVAL_REQUIRED" | "USER_INPUT_REQUIRED" | "VIEW_REQUIRED")) {
                blocked.store(true, Ordering::Release);
            }
            event(&callback_app,&callback_run.run_id,&json!({"type":"toolResult","tool":tool,"callId":request["callId"],"result":result})).map_err(|e|services::ServiceError{code:e.code,message:e.message})?;
            codex_runtime::send_command(
                callback_app.state::<codex_runtime::CodexState>().inner(),
                &actual,
                &callback_run.run_id,
                json!({"type":"response","requestId":request["requestId"],"value":{"result":result}}),
            )?;
        }
        Ok(())
    });
    let prompt = if run.attempt > 1 {
        format!("上次定时执行中断或失败。这次由用户点击重试。先核对现有成果及工具记录，避免重复已完成的操作。\n{}",schedule.prompt)
    } else {
        schedule.prompt
    };
    let result = tauri::async_runtime::block_on(codex_runtime::run_turn(
        app.clone(),
        app.state::<codex_runtime::CodexState>().inner(),
        run.run_id.clone(),
        run.conversation_id.clone(),
        prompt,
        schedule.history,
        sink,
        None,
        true,
        Some(schedule.schedule_id),
        run.model_route.clone().or(schedule.model_route).or_else(||Some(crate::ai_channels::RouteSnapshot::hosted(&run.owner_id))),
    ));
    let _gate = GATE.lock().unwrap();
    let Ok(db) = database(app) else {
        return;
    };
    let Ok(current) = get::<AiRun>(&db, "ai_runs", &run.run_id, &run.owner_id) else {
        return;
    };
    if current.state == "cancelled" {
        return;
    }
    run.finished_at = Some(Utc::now());
    run.state = if needs_input.load(Ordering::Acquire) {
        "waiting_input".into()
    } else {
        match &result {
            Ok(value) if value["status"] == "completed" => "succeeded".into(),
            _ => "failed".into(),
        }
    };
    match result {
        Ok(value) => {
            run.result = Some(value);
        }
        Err(e) => {
            run.error = Some(json!({"code":e.code,"message":e.message}));
        }
    }
    let _ = save_run(&db, &run);
}

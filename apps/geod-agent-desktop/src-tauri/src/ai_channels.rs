//! Account-owned model channels. Only this process reads secrets and sends HTTP.
use crate::{codex_runtime, services};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use services::ServiceError;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use zeroize::Zeroizing;

#[derive(Clone)]
pub(crate) struct AiChannels {
    root: PathBuf,
    active: Arc<Mutex<HashMap<String, (String, RouteSnapshot)>>>,
    gate: Arc<Mutex<()>>,
}
impl AiChannels {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            active: Arc::new(Mutex::new(HashMap::new())),
            gate: Arc::new(Mutex::new(())),
        }
    }
    pub(crate) fn db(&self) -> Result<Connection, ServiceError> {
        fs::create_dir_all(&self.root)
            .map_err(|_| error("AI_CHANNEL_STORAGE", "模型配置目录不可用"))?;
        let db = Connection::open(self.root.join("channels.sqlite")).map_err(storage)?;
        db.busy_timeout(Duration::from_secs(10)).map_err(storage)?;
        db.execute_batch("PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS channels(owner TEXT,id TEXT,body TEXT,PRIMARY KEY(owner,id));
          CREATE TABLE IF NOT EXISTS credential_versions(owner TEXT,channel TEXT,reference TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS selections(owner TEXT,conversation TEXT,channel TEXT,model TEXT,PRIMARY KEY(owner,conversation));
          CREATE TABLE IF NOT EXISTS generations(owner TEXT,id TEXT,body TEXT,pid INTEGER,updated INTEGER,PRIMARY KEY(owner,id));").map_err(storage)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS active_routes(owner TEXT,run TEXT PRIMARY KEY,conversation TEXT,body TEXT,pid INTEGER,created INTEGER);").map_err(storage)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS sponsored_catalog(owner TEXT PRIMARY KEY,body TEXT,updated_at TEXT);").map_err(storage)?;
        Ok(db)
    }
}
fn storage(_: rusqlite::Error) -> ServiceError {
    error("AI_CHANNEL_STORAGE", "模型配置记录不可用")
}
fn error(code: &'static str, message: impl Into<String>) -> ServiceError {
    ServiceError {
        code,
        message: message.into(),
    }
}
fn owner(app: &AppHandle) -> Result<String, ServiceError> {
    services::current_user_id(&app.state())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Model {
    pub id: String,
    pub name: String,
    pub context_window: u32,
    pub max_output_tokens: u32,
    #[serde(default = "text_input")]
    pub input_modalities: Vec<String>,
    #[serde(default)]
    pub thinking: Option<String>,
}
fn text_input() -> Vec<String> {
    vec!["text".into()]
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Channel {
    id: String,
    name: String,
    base_url: String,
    protocol: String,
    enabled: bool,
    models: Vec<Model>,
    credential_ref: String,
    revision: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChannelDraft {
    id: Option<String>,
    name: String,
    base_url: String,
    protocol: String,
    enabled: bool,
    models: Vec<Model>,
    // Transient IPC only. Never Serialize or Debug this type.
    api_key: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RouteSnapshot {
    pub owner_id: String,
    pub billing_scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<Channel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Model>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    sponsor:Option<crate::sponsored_channels::SponsorRoute>,
}
impl RouteSnapshot {
    pub(crate) fn hosted(owner: &str) -> Self {
        Self {
            owner_id: owner.into(),
            billing_scope: "hosted".into(),
            channel: None,
            model: None,
            sponsor:None,
        }
    }
    pub(crate) fn is_personal(&self) -> bool {
        self.billing_scope == "personal" && self.channel.is_some()
    }
    pub(crate) fn sponsored(owner:&str,sponsor:crate::sponsored_channels::SponsorRoute,model:Model)->Self{Self{owner_id:owner.into(),billing_scope:"sponsored".into(),channel:None,model:Some(model),sponsor:Some(sponsor)}}
    pub(crate) fn is_sponsored(&self)->bool{self.billing_scope=="sponsored"&&self.sponsor.is_some()&&self.model.is_some()}
    pub(crate) fn sponsor_request(&self)->Option<Value>{self.sponsor.as_ref().filter(|_|self.is_sponsored()).map(|sponsor|json!({"providerId":sponsor.id,"revision":sponsor.revision,"modelId":self.model.as_ref().unwrap().id}))}
    pub(crate) fn capabilities(&self) -> Value {
        if self.is_sponsored(){let sponsor=self.sponsor.as_ref().unwrap();let model=self.model.as_ref().unwrap();return json!({"model":model.id,"contextWindow":model.context_window,"contextWindowSource":"gatewayConfigured","maxOutputTokens":model.max_output_tokens,"reasoning":matches!(model.thinking.as_deref(),Some("enabled"|"adaptive")),"inputModalities":model.input_modalities,"protocol":sponsor.protocol,"providerName":sponsor.name,"billingScope":"sponsored","channelId":format!("sponsor:{}",sponsor.id),"channelRevision":sponsor.revision});}
        let channel = self.channel.as_ref().unwrap();
        let model = self.model.as_ref().unwrap();
        json!({"model":model.id,"contextWindow":model.context_window,"contextWindowSource":"channelConfiguration","reasoning":matches!(model.thinking.as_deref(),Some("enabled"|"adaptive")),"inputModalities":model.input_modalities,"protocol":channel.protocol,"providerName":channel.name,"billingScope":"personal","channelId":channel.id,"channelRevision":channel.revision})
    }
    fn adapter_snapshot(&self) -> Value {
        let c = self.channel.as_ref().unwrap();
        let m = self.model.as_ref().unwrap();
        json!({"id":c.id,"name":c.name,"baseUrl":c.base_url,"protocol":c.protocol,"model":m.id,"credentialRef":c.credential_ref,"contextWindow":m.context_window,"maxOutputTokens":m.max_output_tokens,"inputModalities":m.input_modalities,"thinking":m.thinking,"billingScope":"personal"})
    }
}
fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn endpoint(input: &str) -> Result<String, ServiceError> {
    let url = reqwest::Url::parse(input.trim())
        .map_err(|_| error("AI_CHANNEL_URL", "请输入完整的 API 基础地址"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(error(
            "AI_CHANNEL_URL",
            "基础地址不能包含密钥、查询参数或账号密码",
        ));
    }
    let local = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err(error(
            "AI_CHANNEL_URL",
            "在线服务使用 HTTPS；本机服务可使用 HTTP",
        ));
    }
    if url.host_str().is_none()
        || url.path().ends_with("/chat/completions")
        || url.path().ends_with("/responses")
        || url.path().ends_with("/messages")
        || url.path().ends_with(":generateContent")
        || url.path().ends_with(":streamGenerateContent")
        || input.len() > 2048
    {
        return Err(error(
            "AI_CHANNEL_URL",
            "填写 API 基础地址，例如 https://api.example.com/v1",
        ));
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
fn validate(draft: &ChannelDraft) -> Result<String, ServiceError> {
    if !valid_text(&draft.name, 120)
        || !valid_protocol(&draft.protocol)
        || draft.models.is_empty()
        || draft.models.len() > 100
    {
        return Err(error(
            "AI_CHANNEL_INVALID",
            "请填写渠道名称、接口类型和至少一个模型",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for m in &draft.models {
        if !valid_text(&m.id, 160)
            || !valid_text(&m.name, 160)
            || !ids.insert(&m.id)
            || !(16000..=4_000_000).contains(&m.context_window)
            || m.max_output_tokens < 128
            || m.max_output_tokens >= m.context_window
            || m.max_output_tokens > 131072
            || !m.input_modalities.contains(&"text".into())
            || m.input_modalities.len() > 2
            || m.input_modalities
                .iter()
                .any(|s| !matches!(s.as_str(), "text" | "image"))
            || m.thinking
                .as_ref()
                .is_some_and(|s| !matches!(s.as_str(), "enabled" | "disabled" | "adaptive") || (s=="adaptive" && draft.protocol!="anthropic"))
            || (draft.protocol=="anthropic" && m.thinking.as_deref()==Some("enabled") && m.max_output_tokens<=1024)
        {
            return Err(error(
                "AI_MODEL_INVALID",
                "请核对模型 ID、上下文、输出上限和输入能力",
            ));
        }
    }
    endpoint(&draft.base_url)
}
fn vault(state: &AiChannels, reference: &str) -> Result<keyring::Entry, ServiceError> {
    keyring::Entry::new(
        "GeoD-AI-channels",
        &format!(
            "{:x}:{reference}",
            Sha256::digest(state.root.to_string_lossy().as_bytes())
        ),
    )
    .map_err(|_| error("AI_KEY_STORAGE", "本机凭据不可用"))
}
fn load_channel(db: &Connection, owner: &str, id: &str) -> Result<Channel, ServiceError> {
    let text: Option<String> = db
        .query_row(
            "SELECT body FROM channels WHERE owner=? AND id=?",
            params![owner, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage)?;
    serde_json::from_str(
        &text.ok_or_else(|| error("AI_CHANNEL_MISSING", "渠道已被删除，请选择可用模型"))?,
    )
    .map_err(|_| error("AI_CHANNEL_STORAGE", "渠道配置损坏"))
}
fn public_channel(channel: &Channel) -> Value {
    json!({"id":channel.id,"name":channel.name,"baseUrl":channel.base_url,"protocol":channel.protocol,"enabled":channel.enabled,"models":channel.models,"keyConfigured":!channel.credential_ref.is_empty(),"revision":channel.revision,"billingScope":"personal"})
}
fn resolve(
    db: &Connection,
    owner: &str,
    channel_id: &str,
    model_id: &str,
) -> Result<RouteSnapshot, ServiceError> {
    if channel_id == "hosted" {
        return Ok(RouteSnapshot::hosted(owner));
    }
    if let Some(id)=channel_id.strip_prefix("sponsor:"){return crate::sponsored_channels::resolve(db,owner,id,model_id);}
    let channel = load_channel(db, owner, channel_id)?;
    if !channel.enabled {
        return Err(error("AI_CHANNEL_DISABLED", "该渠道已停用，请选择其他模型"));
    }
    let model = channel
        .models
        .iter()
        .find(|m| m.id == model_id)
        .cloned()
        .ok_or_else(|| error("AI_MODEL_MISSING", "所选模型已被移除，请重新选择"))?;
    Ok(RouteSnapshot {
        owner_id: owner.into(),
        billing_scope: "personal".into(),
        channel: Some(channel),
        model: Some(model),
        sponsor:None,
    })
}
pub(crate) fn selected(
    app: &AppHandle,
    owner: &str,
    conversation: &str,
) -> Result<RouteSnapshot, ServiceError> {
    let state = app.state::<AiChannels>();
    let _gate = state.gate.lock().unwrap();
    let db = state.db()?;
    selection(&db, owner, conversation)
}
pub(crate) fn remember(
    app: &AppHandle,
    conversation: &str,
    route: &RouteSnapshot,
) -> Result<(), ServiceError> {
    let state = app.state::<AiChannels>();
    let sponsor_channel=route.sponsor.as_ref().map(|sponsor|format!("sponsor:{}",sponsor.id));
    let channel = sponsor_channel.as_deref().unwrap_or_else(||route
        .channel
        .as_ref()
        .map(|c| c.id.as_str())
        .unwrap_or("hosted"));
    let model = route
        .model
        .as_ref()
        .map(|m| m.id.as_str())
        .unwrap_or("hosted");
    state
        .db()?
        .execute(
            "INSERT OR REPLACE INTO selections VALUES(?,?,?,?)",
            params![route.owner_id, conversation, channel, model],
        )
        .map_err(storage)?;
    Ok(())
}
fn selection(
    db: &Connection,
    owner: &str,
    conversation: &str,
) -> Result<RouteSnapshot, ServiceError> {
    let row: Option<(String, String)> = db
        .query_row(
            "SELECT channel,model FROM selections WHERE owner=? AND conversation=?",
            params![owner, conversation],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(storage)?;
    let (channel, model) = if let Some(row) = row {
        row
    } else {
        let row: Option<(String, String)> = db
            .query_row(
                "SELECT channel,model FROM selections WHERE owner=? AND conversation='default'",
                [owner],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let row = row.unwrap_or(("hosted".into(), "hosted".into()));
        db.execute(
            "INSERT OR IGNORE INTO selections VALUES (?,?,?,?)",
            params![owner, conversation, row.0, row.1],
        )
        .map_err(storage)?;
        row
    };
    resolve(db, owner, &channel, &model)
}
pub(crate) fn inherit(
    app: &AppHandle,
    owner: &str,
    conversation: &str,
) -> Result<RouteSnapshot, ServiceError> {
    let state = app.state::<AiChannels>();
    let route = state
        .active
        .lock()
        .unwrap()
        .values()
        .find(|(c, r)| c == conversation && r.owner_id == owner)
        .map(|(_, r)| r.clone());
    if let Some(route) = route {
        return Ok(route);
    }
    // The desktop and companion are separate processes. A native-only registry
    // carries the parent's immutable route across their authenticated IPC.
    let db = state.db()?;
    let mut stmt=db.prepare("SELECT body,pid,created FROM active_routes WHERE owner=? AND conversation=? ORDER BY created DESC").map_err(storage)?;
    let rows = stmt
        .query_map(params![owner, conversation], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(storage)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(storage)?;
    for (body, pid, created) in rows {
        if process_alive(pid) && chrono::Utc::now().timestamp() - created < 900 {
            let route: RouteSnapshot = serde_json::from_str(&body)
                .map_err(|_| error("AI_CHANNEL_STORAGE", "父任务渠道不可读"))?;
            if route.owner_id == owner {
                return Ok(route);
            }
        }
    }
    selected(app, owner, conversation)
}
pub(crate) struct RouteGuard {
    state: AiChannels,
    run: String,
}
impl Drop for RouteGuard {
    fn drop(&mut self) {
        self.state.active.lock().unwrap().remove(&self.run);
        if let Ok(db) = self.state.db() {
            let _ = db.execute(
                "DELETE FROM active_routes WHERE run=? AND pid=?",
                params![self.run, std::process::id()],
            );
        }
    }
}
pub(crate) fn bind(
    app: &AppHandle,
    run: &str,
    conversation: &str,
    route: &RouteSnapshot,
) -> Result<RouteGuard, ServiceError> {
    let state = app.state::<AiChannels>().inner().clone();
    state
        .db()?
        .execute(
            "INSERT OR REPLACE INTO active_routes VALUES(?,?,?,?,?,?)",
            params![
                route.owner_id,
                run,
                conversation,
                serde_json::to_string(route).unwrap(),
                std::process::id(),
                chrono::Utc::now().timestamp()
            ],
        )
        .map_err(storage)?;
    state
        .active
        .lock()
        .unwrap()
        .insert(run.into(), (conversation.into(), route.clone()));
    Ok(RouteGuard {
        state,
        run: run.into(),
    })
}
fn secret(
    state: &AiChannels,
    owner: &str,
    route: &RouteSnapshot,
) -> Result<Zeroizing<String>, ServiceError> {
    if route.owner_id != owner || !route.is_personal() {
        return Err(error("AI_CHANNEL_OWNER", "模型渠道不属于当前账号"));
    }
    let c = route.channel.as_ref().unwrap();
    let db = state.db()?;
    if !load_channel(&db, owner, &c.id)?.enabled {
        return Err(error(
            "AI_CHANNEL_DISABLED",
            "原渠道已停用，任务保留原配置，未切换模型",
        ));
    }
    let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM credential_versions WHERE owner=? AND channel=? AND reference=?)",params![owner,c.id,c.credential_ref],|r|r.get(0)).map_err(storage)?;
    if !exists {
        return Err(error("AI_KEY_MISSING", "原渠道凭据已删除，请重新配置任务"));
    }
    vault(state, &c.credential_ref)?
        .get_password()
        .map(Zeroizing::new)
        .map_err(|_| error("AI_KEY_MISSING", "此渠道的本机密钥不可用，请重新填写"))
}
#[tauri::command]
pub(crate) fn ai_channels_list(app: AppHandle) -> Result<Value, ServiceError> {
    let owner = owner(&app)?;
    let state = app.state::<AiChannels>();
    let db = state.db()?;
    let mut stmt = db
        .prepare("SELECT body FROM channels WHERE owner=? ORDER BY rowid")
        .map_err(storage)?;
    let channels: Vec<Value> = stmt
        .query_map([&owner], |r| r.get::<_, String>(0))
        .map_err(storage)?
        .map(|r| {
            r.map_err(storage)
                .and_then(|s| {
                    serde_json::from_str::<Channel>(&s)
                        .map_err(|_| error("AI_CHANNEL_STORAGE", "渠道配置不可读"))
                })
                .map(|c| public_channel(&c))
        })
        .collect::<Result<_, _>>()?;
    let default: Option<(String, String)> = db
        .query_row(
            "SELECT channel,model FROM selections WHERE owner=? AND conversation='default'",
            [&owner],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(storage)?;
    let mut stmt=db.prepare("SELECT json_extract(body,'$.channelId'),json_extract(body,'$.selectedModel'),SUM(json_extract(body,'$.inputTokens')),SUM(json_extract(body,'$.outputTokens')),COUNT(*),SUM(CASE WHEN json_extract(body,'$.usageKnown')=1 THEN 0 ELSE 1 END) FROM generations WHERE owner=? AND json_extract(body,'$.state')='settled' GROUP BY 1,2").map_err(storage)?;
    let usage=stmt.query_map([&owner],|r|Ok(json!({"channelId":r.get::<_,String>(0)?,"model":r.get::<_,String>(1)?,"inputTokens":r.get::<_,Option<i64>>(2)?,"outputTokens":r.get::<_,Option<i64>>(3)?,"requests":r.get::<_,i64>(4)?,"unknownUsageRequests":r.get::<_,i64>(5)?}))).map_err(storage)?.collect::<rusqlite::Result<Vec<_>>>().map_err(storage)?;
    let (sponsors,sponsors_updated_at)=crate::sponsored_channels::cached(&db,&owner)?;
    Ok(
        json!({"channels":channels,"sponsors":sponsors,"sponsorsUpdatedAt":sponsors_updated_at,"default":{"channelId":default.as_ref().map(|r|r.0.as_str()).unwrap_or("hosted"),"modelId":default.as_ref().map(|r|r.1.as_str()).unwrap_or("hosted")},"usage":usage}),
    )
}
#[tauri::command]
pub(crate) fn ai_channel_save(app: AppHandle, draft: ChannelDraft) -> Result<Value, ServiceError> {
    let base_url = validate(&draft)?;
    let owner = owner(&app)?;
    let state = app.state::<AiChannels>();
    let _gate = state.gate.lock().unwrap();
    let mut db = state.db()?;
    let old = draft
        .id
        .as_ref()
        .map(|id| load_channel(&db, &owner, id))
        .transpose()?;
    let id = old
        .as_ref()
        .map(|c| c.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let api_key = Zeroizing::new(draft.api_key.unwrap_or_default());
    if api_key.len() > 16384 || api_key.contains(['\r', '\n', '\0']) {
        return Err(error("AI_KEY_INVALID", "密钥格式无效"));
    }
    let fresh = !api_key.trim().is_empty();
    let reference = if fresh {
        uuid::Uuid::new_v4().to_string()
    } else {
        old.as_ref()
            .map(|c| c.credential_ref.clone())
            .ok_or_else(|| error("AI_KEY_REQUIRED", "请填写此渠道的 API Key"))?
    };
    let channel = Channel {
        id,
        name: draft.name.trim().into(),
        base_url,
        protocol: draft.protocol,
        enabled: draft.enabled,
        models: draft.models,
        credential_ref: reference.clone(),
        revision: uuid::Uuid::new_v4().to_string(),
    };
    if fresh {
        vault(&state, &reference)?
            .set_password(api_key.trim())
            .map_err(|_| error("AI_KEY_STORAGE", "保存系统凭据失败，渠道未更新"))?;
    }
    let saved = (|| {
        let tx = db.transaction().map_err(storage)?;
        tx.execute(
            "INSERT OR REPLACE INTO channels VALUES(?,?,?)",
            params![owner, channel.id, serde_json::to_string(&channel).unwrap()],
        )
        .map_err(storage)?;
        if fresh {
            tx.execute(
                "INSERT INTO credential_versions VALUES(?,?,?)",
                params![owner, channel.id, reference],
            )
            .map_err(storage)?;
        }
        tx.commit().map_err(storage)
    })();
    if saved.is_err() && fresh {
        let _ = vault(&state, &reference)?.delete_credential();
    }
    saved?;
    Ok(public_channel(&channel))
}
#[tauri::command]
pub(crate) fn ai_channel_remove(app: AppHandle, channel_id: String) -> Result<(), ServiceError> {
    let owner = owner(&app)?;
    let state = app.state::<AiChannels>();
    let _gate = state.gate.lock().unwrap();
    let mut db = state.db()?;
    load_channel(&db, &owner, &channel_id)?;
    let mut stmt = db
        .prepare("SELECT reference FROM credential_versions WHERE owner=? AND channel=?")
        .map_err(storage)?;
    let refs = stmt
        .query_map(params![owner, channel_id], |r| r.get::<_, String>(0))
        .map_err(storage)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(storage)?;
    drop(stmt);
    for reference in refs {
        match vault(&state, &reference)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(_) => return Err(error("AI_KEY_STORAGE", "系统凭据删除失败，请重试")),
        }
    }
    let tx = db.transaction().map_err(storage)?;
    tx.execute(
        "DELETE FROM channels WHERE owner=? AND id=?",
        params![owner, channel_id],
    )
    .map_err(storage)?;
    tx.execute(
        "DELETE FROM credential_versions WHERE owner=? AND channel=?",
        params![owner, channel_id],
    )
    .map_err(storage)?;
    // Saved tasks retain their original snapshot and fail explicitly. No fallback.
    tx.execute(
        "DELETE FROM selections WHERE owner=? AND conversation='default' AND channel=?",
        params![owner, channel_id],
    )
    .map_err(storage)?;
    tx.commit().map_err(storage)
}
#[tauri::command]
pub(crate) fn ai_model_select(
    app: AppHandle,
    conversation_id: String,
    channel_id: String,
    model_id: String,
) -> Result<Value, ServiceError> {
    let owner = owner(&app)?;
    let state = app.state::<AiChannels>();
    if conversation_id != "default" && uuid::Uuid::parse_str(&conversation_id).is_err() {
        return Err(error("AI_CHANNEL_INVALID", "会话标识无效"));
    }
    let _gate = state.gate.lock().unwrap();
    let db = state.db()?;
    resolve(&db, &owner, &channel_id, &model_id)?;
    db.execute(
        "INSERT OR REPLACE INTO selections VALUES(?,?,?,?)",
        params![owner, conversation_id, channel_id, model_id],
    )
    .map_err(storage)?;
    Ok(json!({"channelId":channel_id,"modelId":model_id}))
}
#[tauri::command]
pub(crate) fn ai_model_selection(
    app: AppHandle,
    conversation_id: String,
    existing_conversation: Option<bool>,
) -> Result<Value, ServiceError> {
    let owner = owner(&app)?;
    let state = app.state::<AiChannels>();
    let _gate = state.gate.lock().unwrap();
    let db = state.db()?;
    if uuid::Uuid::parse_str(&conversation_id).is_err() {
        return Err(error("AI_CHANNEL_INVALID", "会话标识无效"));
    }
    if existing_conversation == Some(true) {
        db.execute(
            "INSERT OR IGNORE INTO selections VALUES(?,?,'hosted','hosted')",
            params![owner, conversation_id],
        )
        .map_err(storage)?;
    }
    // Preserve missing/disabled selection in the UI so the user can repair it.
    let _ = selection(&db, &owner, &conversation_id);
    let row: (String, String) = db
        .query_row(
            "SELECT channel,model FROM selections WHERE owner=? AND conversation=?",
            params![owner, conversation_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(storage)?;
    Ok(json!({"channelId":row.0,"modelId":row.1}))
}
fn http_client(base: &str) -> Result<reqwest::Client, ServiceError> {
    let proxy = crate::network::proxy_for(base)
        .map_err(|_| error("NETWORK_SETTINGS_ERROR", "请检查网络与代理设置"))?;
    crate::network::apply(
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(180))
            .connect_timeout(Duration::from_secs(20)),
        proxy.as_deref(),
    )
    .map_err(|_| error("NETWORK_SETTINGS_ERROR", "代理设置无效"))?
    .build()
    .map_err(|_| error("PROVIDER_UNAVAILABLE", "模型连接初始化失败"))
}
fn auth_header(key: &str) -> Result<reqwest::header::HeaderValue, ServiceError> {
    let mut header = reqwest::header::HeaderValue::from_str(&format!("Bearer {key}"))
        .map_err(|_| error("AI_KEY_INVALID", "密钥格式无效"))?;
    header.set_sensitive(true);
    Ok(header)
}
fn valid_protocol(protocol:&str)->bool {matches!(protocol,"chatCompletions"|"responses"|"anthropic"|"gemini")}
fn provider_auth(request:reqwest::RequestBuilder,protocol:&str,key:&str)->Result<reqwest::RequestBuilder,ServiceError>{
    if matches!(protocol,"anthropic"|"gemini") {
        let mut value=reqwest::header::HeaderValue::from_str(key).map_err(|_|error("AI_KEY_INVALID","密钥格式无效"))?;value.set_sensitive(true);
        return Ok(if protocol=="anthropic" {request.header("x-api-key",value).header("anthropic-version","2023-06-01")}else{request.header("x-goog-api-key",value)});
    }
    Ok(request.header(reqwest::header::AUTHORIZATION,auth_header(key)?))
}
fn provider_url(base:&str,protocol:&str,model:&str)->Result<String,ServiceError>{
    if protocol=="gemini"{
        let mut url=reqwest::Url::parse(&format!("{base}/models/")).map_err(|_|error("AI_CHANNEL_URL","接口地址无效"))?;
        url.path_segments_mut().map_err(|_|error("AI_CHANNEL_URL","接口地址无效"))?.pop_if_empty().push(&format!("{}:streamGenerateContent",model.strip_prefix("models/").unwrap_or(model)));
        url.query_pairs_mut().append_pair("alt","sse");Ok(url.to_string())
    }else {Ok(format!("{base}/{}",match protocol{"responses"=>"responses","anthropic"=>"messages",_=>"chat/completions"}))}
}
fn provider_failure(code: &str, status: Option<u64>) -> ServiceError {
    match (code, status) {
        (_, Some(401 | 403)) => error(
            "AI_KEY_REJECTED",
            "服务拒绝认证，请检查此渠道的 API Key 和访问权限",
        ),
        (_, Some(404)) => error(
            "AI_ENDPOINT_NOT_FOUND",
            "接口不存在，请检查基础地址和接口类型",
        ),
        (_, Some(429)) => error(
            "AI_PROVIDER_LIMIT",
            "服务方限流或额度不足，请检查该渠道账户",
        ),
        ("PROVIDER_CANCELLED", _) => error(
            "PROVIDER_CANCELLED",
            "模型请求已停止；服务方可能仍记录已处理用量",
        ),
        ("PROVIDER_TIMEOUT", _) => error("PROVIDER_TIMEOUT", "模型服务响应超时，请重试"),
        ("CHANNEL_IMAGE_UNSUPPORTED", _) => error(
            "CHANNEL_IMAGE_UNSUPPORTED",
            "此模型未配置图片输入能力，请换用支持图片的模型",
        ),
        ("CHANNEL_THINKING_BUDGET",_)=>error("AI_MODEL_INVALID","此接口的思考模式需要输出上限大于 1024，请调整模型配置"),
        ("CHANNEL_THOUGHT_STATE_INVALID",_)=>error("AI_HISTORY_INVALID","模型历史签名记录不可读，请从新会话重试"),
        ("PROVIDER_CONTENT_BLOCKED",_)=>error("AI_PROVIDER_BLOCKED","服务方未返回可用回答，请调整请求或选择其他模型"),
        ("PROVIDER_CONTENT_UNSUPPORTED"|"PROVIDER_TOOL_STREAM_INVALID",_)=>error("AI_PROVIDER_FORMAT","服务返回了当前接口不支持的内容格式，请检查模型或接口类型"),
        ("PROVIDER_OUTPUT_TRUNCATED", _) => error(
            "PROVIDER_OUTPUT_TRUNCATED",
            "输出达到此模型的上限，请提高输出上限或缩小任务",
        ),
        ("PROVIDER_STREAM_INCOMPLETE" | "PROVIDER_RESPONSE_FAILED", _) => error(
            "PROVIDER_STREAM_INCOMPLETE",
            "模型响应未完整结束，未确认工具执行",
        ),
        (_, Some(s)) => error(
            "PROVIDER_HTTP_ERROR",
            format!("模型服务返回 HTTP {s}，请核对配置"),
        ),
        _ => error(
            "PROVIDER_UNAVAILABLE",
            "模型服务暂不可用，请核对连接、接口类型和模型配置",
        ),
    }
}
#[tauri::command]
pub(crate) async fn ai_channel_models(
    app: AppHandle,
    channel_id: String,
) -> Result<Value, ServiceError> {
    let owner = owner(&app)?;
    let state = app.state::<AiChannels>().inner().clone();
    let channel = load_channel(&state.db()?, &owner, &channel_id)?;
    let route = RouteSnapshot {
        owner_id: owner.clone(),
        billing_scope: "personal".into(),
        model: channel.models.first().cloned(),
        channel: Some(channel.clone()),
        sponsor:None,
    };
    let key = secret(&state, &owner, &route)?;
    model_catalog(&channel.base_url, &channel.protocol, &key).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Probe {
    base_url: String,
    api_key: Option<String>,
    channel_id: Option<String>,
    #[serde(default)]
    protocol: Option<String>,
}
#[tauri::command]
pub(crate) async fn ai_channel_probe(app: AppHandle, probe: Probe) -> Result<Value, ServiceError> {
    let base = endpoint(&probe.base_url)?;
    let protocol=probe.protocol.as_deref().unwrap_or("chatCompletions");
    if !valid_protocol(protocol){return Err(error("AI_CHANNEL_INVALID","接口类型无效"));}
    let owner = owner(&app)?;
    let state = app.state::<AiChannels>().inner().clone();
    let key = if let Some(key) = probe.api_key.filter(|s| !s.trim().is_empty()) {
        if key.len() > 16384 || key.contains(['\r', '\n', '\0']) {
            return Err(error("AI_KEY_INVALID", "密钥格式无效"));
        }
        Zeroizing::new(key)
    } else {
        let id = probe.channel_id.ok_or_else(|| {
            error(
                "AI_KEY_REQUIRED",
                "先填写此渠道的 API Key，即可读取模型目录",
            )
        })?;
        let channel = load_channel(&state.db()?, &owner, &id)?;
        let route = RouteSnapshot {
            owner_id: owner.clone(),
            billing_scope: "personal".into(),
            model: channel.models.first().cloned(),
            channel: Some(channel),
            sponsor:None,
        };
        secret(&state, &owner, &route)?
    };
    model_catalog(&base, protocol, &key).await
}
async fn model_catalog(base: &str, protocol:&str, key: &str) -> Result<Value, ServiceError> {
    let request=http_client(base)?.get(format!("{base}/models")).timeout(Duration::from_secs(30));
    let mut response = provider_auth(request,protocol,key)?
        .send()
        .await
        .map_err(|_| provider_failure("PROVIDER_UNAVAILABLE", None))?;
    if !response.status().is_success() {
        return Err(provider_failure(
            "PROVIDER_MODELS_HTTP_ERROR",
            Some(response.status().as_u16().into()),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| provider_failure("PROVIDER_UNAVAILABLE", None))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(error("PROVIDER_MODELS_INVALID", "模型目录过大"));
        }
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            "PROVIDER_MODELS_INVALID",
            "服务未返回兼容的模型目录；可以手动填写模型 ID",
        )
    })?;
    let models = value[if protocol=="gemini"{"models"}else{"data"}]
        .as_array()
        .ok_or_else(|| {
            error(
                "PROVIDER_MODELS_INVALID",
                "服务未提供模型目录；可以手动填写模型 ID",
            )
        })?
        .iter()
        .filter(|v| protocol!="gemini" || v["supportedGenerationMethods"].as_array().is_none_or(|methods|methods.iter().any(|method|method=="generateContent"||method=="streamGenerateContent")))
        .filter_map(|v| v[if protocol=="gemini"{"name"}else{"id"}].as_str())
        .map(|id|if protocol=="gemini"{id.strip_prefix("models/").unwrap_or(id)}else{id})
        .filter(|s| valid_text(s, 160))
        .take(1000)
        .map(|s| json!({"id":s}))
        .collect::<Vec<_>>();
    Ok(json!({"models":models,"catalogueReadable":true}))
}
fn save_generation(state: &AiChannels, owner: &str, value: &Value) -> Result<(), ServiceError> {
    state
        .db()?
        .execute(
            "INSERT OR REPLACE INTO generations VALUES(?,?,?,?,?)",
            params![
                owner,
                value["generationId"].as_str().unwrap_or(""),
                value.to_string(),
                std::process::id(),
                chrono::Utc::now().timestamp()
            ],
        )
        .map_err(storage)?;
    Ok(())
}
pub(crate) fn generation_get(
    app: &AppHandle,
    owner: &str,
    id: &str,
) -> Result<Option<Value>, ServiceError> {
    let state = app.state::<AiChannels>();
    let db = state.db()?;
    let row: Option<(String, u32, i64)> = db
        .query_row(
            "SELECT body,pid,updated FROM generations WHERE owner=? AND id=?",
            params![owner, id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(storage)?;
    let Some((text, pid, updated)) = row else {
        return Ok(None);
    };
    let mut value: Value = serde_json::from_str(&text)
        .map_err(|_| error("AI_CHANNEL_STORAGE", "模型请求记录不可读"))?;
    if value["state"] == "streaming"
        && (!process_alive(pid) || chrono::Utc::now().timestamp() - updated > 240)
    {
        value["state"] = json!("failed");
        value["errorCode"] = json!("PROVIDER_INTERRUPTED");
        save_generation(&state, owner, &value)?;
    }
    Ok(Some(value))
}
#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    unsafe {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut status = 0;
        let ok = GetExitCodeProcess(handle, &mut status) != 0;
        CloseHandle(handle);
        ok && status == 259
    }
}
#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
    PathBuf::from(format!("/proc/{pid}")).exists()
}
fn prepare_worker(state: &AiChannels) -> Result<PathBuf, ServiceError> {
    // Versioned immutable files prevent another native process rewriting a module
    // while a generation is importing it. Sources are shipped in this binary.
    let source = include_str!("../provider-worker.mjs");
    let adapter = include_str!("../../../../packages/codex-protocol/provider-adapter.mjs");
    let contract = include_str!("../../../../packages/codex-protocol/codex-contract.mjs");
    let native=include_str!("../../../../packages/codex-protocol/provider-native.mjs");
    let provider_error=include_str!("../../../../packages/codex-protocol/provider-error.mjs");
    let root = state.root.join("protocol").join(format!(
        "{:x}",
        Sha256::digest(format!("{source}{adapter}{contract}{native}{provider_error}"))
    ));
    fs::create_dir_all(&root).map_err(|_| error("AI_CHANNEL_STORAGE", "接口适配层准备失败"))?;
    for (name, text) in [
        ("provider-worker.mjs", source),
        ("provider-adapter.mjs", adapter),
        ("codex-contract.mjs", contract),
        ("provider-native.mjs", native),
        ("provider-error.mjs", provider_error),
    ] {
        let path = root.join(name);
        if !path.is_file() {
            fs::write(path, text).map_err(|_| error("AI_CHANNEL_STORAGE", "接口适配层准备失败"))?;
        }
    }
    Ok(root.join("provider-worker.mjs"))
}
type WorkerInput = Arc<tokio::sync::Mutex<tokio::process::ChildStdin>>;
async fn write_worker(input: &WorkerInput, value: &Value) -> Result<(), ServiceError> {
    let mut line = value.to_string();
    line.push('\n');
    input
        .lock()
        .await
        .write_all(line.as_bytes())
        .await
        .map_err(|_| error("PROVIDER_UNAVAILABLE", "接口适配进程已退出"))
}
async fn transport(
    base: String,
    protocol: String,
    model: String,
    key: Zeroizing<String>,
    body: Value,
    input: WorkerInput,
    ack: Arc<tokio::sync::Semaphore>,
) -> Result<(), ServiceError> {
    let url=provider_url(&base,&protocol,&model)?;
    let mut response = provider_auth(http_client(&base)?.post(url),&protocol,&key)?
        .json(&body)
        .send()
        .await
        .map_err(|_| provider_failure("PROVIDER_UNAVAILABLE", None))?;
    let content = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    write_worker(
        &input,
        &json!({"type":"headers","status":response.status().as_u16(),"contentType":content}),
    )
    .await?;
    if !response.status().is_success() {
        return Ok(());
    }
    let mut total = 0usize;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| provider_failure("PROVIDER_UNAVAILABLE", None))?
    {
        total += chunk.len();
        if total > 64 * 1024 * 1024 {
            return Err(error("PROVIDER_STREAM_INVALID", "响应超过接口容量"));
        }
        write_worker(
            &input,
            &json!({"type":"chunk","data":STANDARD.encode(chunk)}),
        )
        .await?;
        let permit = ack
            .acquire()
            .await
            .map_err(|_| error("PROVIDER_UNAVAILABLE", "流式传输已结束"))?;
        permit.forget();
    }
    write_worker(&input, &json!({"type":"end"})).await
}
pub(crate) fn generate(
    app: &AppHandle,
    route: &RouteSnapshot,
    generation_id: &str,
    conversation: &str,
    request: Value,
    cancel: Arc<AtomicBool>,
    mut on_event: impl FnMut(&str, &Value),
) -> Result<Value, ServiceError> {
    let owner = owner(app)?;
    let state = app.state::<AiChannels>().inner().clone();
    let mut record = json!({"generationId":generation_id,"conversationId":conversation,"state":"streaming","errorCode":null,"result":null,"billingScope":"personal","channelId":route.channel.as_ref().unwrap().id,"selectedModel":route.model.as_ref().unwrap().id,"channelRevision":route.channel.as_ref().unwrap().revision,"inputTokens":null,"outputTokens":null,"usageKnown":false});
    save_generation(&state, &owner, &record)?;
    let result = (|| {
        let key = secret(&state, &owner, route)?;
        let worker = prepare_worker(&state)?;
        let (_, node) = codex_runtime::command_dependencies(app)?;
        tauri::async_runtime::block_on(async {
            let mut command = tokio::process::Command::new(node);
            command
                .arg(worker)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .env_clear();
            for name in ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"] {
                if let Some(v) = std::env::var_os(name) {
                    command.env(name, v);
                }
            }
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            let mut child = command
                .spawn()
                .map_err(|_| error("PROVIDER_UNAVAILABLE", "接口适配进程无法启动"))?;
            #[cfg(windows)]
            let _tree = codex_runtime::ProcessTree::attach_handle(child.raw_handle().unwrap())
                .map_err(|_| error("PROVIDER_UNAVAILABLE", "接口适配进程无法管理"))?;
            let input = Arc::new(tokio::sync::Mutex::new(child.stdin.take().unwrap()));
            let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
            write_worker(&input,&json!({"type":"start","snapshot":route.adapter_snapshot(),"request":request,"generationId":generation_id})).await?;
            let ack = Arc::new(tokio::sync::Semaphore::new(0));
            let mut http = None;
            let mut key = Some(key);
            let mut timer = tokio::time::interval(Duration::from_millis(100));
            let started = std::time::Instant::now();
            let result = loop {
                tokio::select! {
                    _=timer.tick()=>{if cancel.load(Ordering::Acquire){break Err(provider_failure("PROVIDER_CANCELLED",None));}if started.elapsed()>Duration::from_secs(180){break Err(provider_failure("PROVIDER_TIMEOUT",None));}},
                    line=lines.next_line()=>{
                        let Ok(Some(line))=line else{break Err(provider_failure("PROVIDER_STREAM_INCOMPLETE",None));};
                        if line.len()>48*1024*1024{break Err(error("PROVIDER_STREAM_INVALID","接口适配响应过大"));}
                        let Ok(value)=serde_json::from_str::<Value>(&line)else{break Err(provider_failure("PROVIDER_STREAM_INCOMPLETE",None));};
                        match value["type"].as_str(){
                            Some("http")=>{
                                let Some(key)=key.take()else{break Err(error("PROVIDER_STREAM_INVALID","接口适配请求重复"));};
                                let channel=route.channel.as_ref().unwrap();let body=value["body"].clone();
                                let model=route.model.as_ref().unwrap();
                                let valid=if channel.protocol=="gemini"{body["contents"].is_array()&&body["generationConfig"]["maxOutputTokens"]==model.max_output_tokens&&body["model"].is_null()}else{body["model"]==model.id&&body["stream"]==true&&body[if channel.protocol=="responses"{"max_output_tokens"}else{"max_tokens"}]==model.max_output_tokens};
                                if !valid{break Err(error("PROVIDER_STREAM_INVALID","接口适配请求与所选模型不一致"));}
                                let model=model.id.clone();
                                let base=channel.base_url.clone();let protocol=channel.protocol.clone();let input=input.clone();let a=ack.clone();
                                http=Some(tokio::spawn(async move{if transport(base,protocol,model,key,body,input.clone(),a).await.is_err(){let _=write_worker(&input,&json!({"type":"error"})).await;}}));
                            },
                            Some("ack")=>ack.add_permits(1),
                            Some("delta")=>on_event(if value["part"]=="reasoning"{"reasoning_delta"}else{"content_delta"},&json!({"text":value["text"]})),
                            Some("wire")=>on_event("wire",&value),
                            Some("result")=>break Ok(value["generation"].clone()),
                            Some("failed")=>break Err(provider_failure(value["code"].as_str().unwrap_or("PROVIDER_UNAVAILABLE"),value["status"].as_u64())),
                            _=>break Err(error("PROVIDER_STREAM_INVALID","接口适配返回无效事件")),
                        }
                    }
                }
            };
            if let Some(http) = http {
                http.abort();
                let _ = http.await;
            }
            let _ = child.kill().await;
            let _ = child.wait().await;
            result
        })
    })();
    match result {
        Ok(mut value) => {
            value["conversationId"] = json!(conversation);
            value["result"]["role"] = json!("assistant");
            value["errorCode"] = Value::Null;
            value["channelRevision"] = record["channelRevision"].clone();
            save_generation(&state, &owner, &value)?;
            Ok(value)
        }
        Err(cause) => {
            record["state"] = json!("failed");
            record["errorCode"] = json!(cause.code);
            save_generation(&state, &owner, &record)?;
            Err(cause)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn draft() -> ChannelDraft {
        ChannelDraft {
            id: None,
            name: "测试".into(),
            base_url: "https://api.example.com/v1".into(),
            protocol: "responses".into(),
            enabled: true,
            models: vec![Model {
                id: "model".into(),
                name: "Model".into(),
                context_window: 128000,
                max_output_tokens: 4096,
                input_modalities: text_input(),
                thinking: None,
            }],
            api_key: None,
        }
    }
    #[test]
    fn endpoints_and_capabilities_are_explicit() {
        let mut d = draft();
        assert!(validate(&d).is_ok());
        for url in [
            "http://api.example.com",
            "https://key@api.example.com",
            "https://api.example.com?key=secret",
            "https://api.example.com/v1/responses",
        ] {
            d.base_url = url.into();
            assert!(validate(&d).is_err());
        }
        d.base_url = "http://127.0.0.1:8080/v1".into();
        assert!(validate(&d).is_ok());
        d.models[0].max_output_tokens = 128000;
        assert!(validate(&d).is_err());
    }
    #[test]
    fn native_protocol_headers_paths_and_thinking_are_explicit(){
        for protocol in ["chatCompletions","responses","anthropic","gemini"]{
            let mut d=draft();d.protocol=protocol.into();assert!(validate(&d).is_ok());
            let request=provider_auth(reqwest::Client::new().get("https://example.test/v1/models"),protocol,"fixture-secret").unwrap().build().unwrap();
            let header=match protocol{"anthropic"=>"x-api-key","gemini"=>"x-goog-api-key",_=>"authorization"};assert!(request.headers()[header].is_sensitive());
            if matches!(protocol,"anthropic"|"gemini"){assert!(!request.headers().contains_key("authorization"));}
            d.models[0].thinking=Some("adaptive".into());assert_eq!(validate(&d).is_ok(),protocol=="anthropic");
        }
        assert_eq!(provider_url("https://example.test/v1","anthropic","model").unwrap(),"https://example.test/v1/messages");
        let url=reqwest::Url::parse(&provider_url("https://example.test/v1beta","gemini","models/gemini-fixture").unwrap()).unwrap();
        assert_eq!(url.path(),"/v1beta/models/gemini-fixture:streamGenerateContent");assert_eq!(url.query(),Some("alt=sse"));
        let unusual=reqwest::Url::parse(&provider_url("https://example.test/v1beta","gemini","https://other.test/model?key=value").unwrap()).unwrap();
        assert_eq!(unusual.host_str(),Some("example.test"));assert_eq!(unusual.query(),Some("alt=sse"));
    }
    #[test]
    fn snapshots_are_account_owned_and_defaults_do_not_rewrite_conversations() {
        let root = tempfile::tempdir().unwrap();
        let state = AiChannels::new(root.path().to_owned());
        let db = state.db().unwrap();
        let d = draft();
        let channel = Channel {
            id: "one".into(),
            name: d.name,
            base_url: d.base_url,
            protocol: d.protocol,
            enabled: true,
            models: d.models,
            credential_ref: "reference-only".into(),
            revision: "r1".into(),
        };
        db.execute(
            "INSERT INTO channels VALUES(?,?,?)",
            params!["a", "one", serde_json::to_string(&channel).unwrap()],
        )
        .unwrap();
        db.execute(
            "INSERT INTO selections VALUES('a','default','one','model')",
            [],
        )
        .unwrap();
        let snap = selection(&db, "a", "conversation").unwrap();
        assert!(snap.is_personal());
        db.execute(
            "UPDATE selections SET channel='hosted',model='hosted' WHERE conversation='default'",
            [],
        )
        .unwrap();
        assert!(selection(&db, "a", "conversation").unwrap().is_personal());
        assert!(!selection(&db, "a", "new").unwrap().is_personal());
        assert!(resolve(&db, "b", "one", "model").is_err());
        assert_eq!(snap.adapter_snapshot()["credentialRef"], "reference-only");
        assert!(public_channel(&channel).get("credentialRef").is_none());
    }
}

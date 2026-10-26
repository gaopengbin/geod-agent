//! Credential values stay in Windows Credential Manager and in worker memory.
use crate::{open_store, workspace_error, AppError, AppState};
use chrono::Utc;
use geod_core::imagery::{AuthenticationMode, HttpSource, RuntimeToken, SourceAuthentication};
use geod_task_engine::SourceDescriptor;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CredentialInput {
    pub mode: Option<AuthenticationMode>,
    pub parameter: Option<String>,
    pub token: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Readiness {
    pub source_id: String,
    pub state: &'static str,
    pub ready: bool,
    pub revision: String,
    pub error_code: Option<&'static str>,
}

fn credential_state(auth: Option<&SourceAuthentication>, read: impl FnOnce() -> Result<String, keyring::Error>) -> (&'static str, Option<&'static str>) {
    let Some(auth) = auth else { return ("ready", None); };
    if auth.version == "pending" { return ("missing", Some("SOURCE_CREDENTIAL_REQUIRED")); }
    match read() {
        Ok(token) if !token.trim().is_empty() && token_valid(&token).is_ok() => ("ready", None),
        Ok(_) | Err(keyring::Error::NoEntry) => ("missing", Some("SOURCE_CREDENTIAL_REQUIRED")),
        Err(_) => ("unavailable", Some("SOURCE_CREDENTIAL_UNAVAILABLE")),
    }
}

pub(crate) fn readiness(state: &AppState, endpoint: &HttpSource) -> Result<Readiness, AppError> {
    verify_binding(state, endpoint)?;
    let (status, error_code) = credential_state(endpoint.authentication.as_ref(), || {
        match endpoint.authentication.as_ref().and_then(|a| entry(state, &a.credential_ref).ok()) {
            Some(entry) => entry.get_password(),
            None => Err(keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("Credential store unavailable")))),
        }
    });
    Ok(Readiness { source_id: endpoint.id.clone(), state: status, ready: status == "ready",
        revision: format!("{:x}", Sha256::digest(format!("{}:{status}", endpoint.authentication.as_ref().map(|a| a.version.as_str()).unwrap_or("public")))), error_code })
}

pub(crate) fn assert_ready(state: &AppState, endpoint: &HttpSource) -> Result<(), AppError> {
    let status = readiness(state, endpoint)?;
    match status.error_code {
        Some("SOURCE_CREDENTIAL_REQUIRED") => Err(workspace_error("SOURCE_CREDENTIAL_REQUIRED", "请先在本机补全此图源的 Key/Token，保存后继续原任务；无需降低分辨率或重复确认范围")),
        Some(_) => Err(workspace_error("SOURCE_CREDENTIAL_UNAVAILABLE", "已保存的图源凭据暂时无法读取，请重新保存认证后继续原任务")),
        None => Ok(()),
    }
}

pub(crate) fn model_catalog(state: &AppState) -> Result<Value, AppError> {
    let mut sources = Vec::new();
    let store=open_store(state)?;
    for descriptor in store.list_sources()? {
        if let Some(source) = store.get_registered_source(&descriptor.id)? {
            let status = readiness(state, &source.endpoint)?;
            sources.push(json!({"id":descriptor.id,"name":descriptor.display_name,"minZoom":descriptor.min_zoom,"maxZoom":descriptor.max_zoom,"attribution":descriptor.attribution,"ready":status.ready,"credentialState":status.state,"credentialRevision":status.revision,"errorCode":status.error_code}));
        }
    }
    let presets=crate::source_creator::raster_presets()?;
    Ok(json!({"sources":sources,"availablePresets":presets,"catalogScope":"registered_sources_and_map_tile_presets","onlineSearchScope":"ArcGIS public image and map services","next":"没有已登记图源不代表没有下载能力。availablePresets 已含真实完整技术参数，可直接用 source_configure 配置匹配的栅格预设；无需猜测地址或反复探索。ready=false 时使用返回的本机认证入口；不要降低缩放或索要聊天中的密钥。需要其他科学影像时发现对应连接，不能把普通底图宣称为某年原始影像。"}))
}

pub(crate) fn policy_snapshot(state: &AppState, imagery: &Value) -> Value {
    let read = || -> Result<Value, AppError> {
        let store = open_store(state)?;
        let mut sources = serde_json::Map::new();
        for descriptor in store.list_sources()? {
            if let Some(source) = store.get_registered_source(&descriptor.id)? {
                sources.insert(descriptor.id, serde_json::to_value(readiness(state, &source.endpoint)?).unwrap());
            }
        }
        let mut plans = serde_json::Map::new();
        for task in imagery["tasks"].as_array().into_iter().flatten() {
            if let Some(id) = task["planId"].as_str() {
                if let Some(plan) = store.get_plan(id)? {
                    let mut ids=vec![plan.plan.spec.source_id];
                    ids.extend(plan.plan.spec.export_options.unwrap_or_default().overlay_sources.into_iter().map(|s|s.source_id));
                    plans.insert(id.into(),json!(ids));
                }
            }
        }
        Ok(json!({"available":true,"sources":sources,"plans":plans}))
    };
    read().unwrap_or_else(|_| json!({"available":false,"sources":{},"plans":{}}))
}

fn entry(state: &AppState, reference: &str) -> Result<Entry, AppError> {
    if Uuid::parse_str(reference).is_err() { return Err(workspace_error("INVALID_SOURCE_AUTH", "图源凭证引用无效")); }
    let scope = format!("{:x}", Sha256::digest(state.db_path.to_string_lossy().as_bytes()));
    Entry::new("GeoD-Agent-source-tokens", &format!("{}:{reference}", &scope[..20]))
        .map_err(|_| workspace_error("SOURCE_CREDENTIAL_STORE", "无法打开本机凭证存储"))
}

fn origin(endpoint: &HttpSource) -> Result<String, AppError> {
    endpoint.request_origins()?.into_iter().next()
        .ok_or_else(|| workspace_error("INVALID_SOURCE", "图源网址无效"))
}

fn token_valid(token: &str) -> Result<(), AppError> {
    if token.len() > 4096 || token.chars().any(char::is_control) {
        return Err(workspace_error("INVALID_SOURCE_AUTH", "Token 格式无效，请检查换行或空格"));
    }
    Ok(())
}

// A caller cannot attach another source's credential reference to an endpoint.
fn verify_binding(state: &AppState, endpoint: &HttpSource) -> Result<(), AppError> {
    if let Some(auth) = &endpoint.authentication {
        let stored = open_store(state)?.get_registered_source(&endpoint.id)?;
        if stored.as_ref().and_then(|source| source.endpoint.authentication.as_ref()) != Some(auth)
            || auth.origin != origin(endpoint)? {
            return Err(workspace_error("INVALID_SOURCE_AUTH", "图源凭证与此连接不匹配，请重新填写 Token"));
        }
    }
    Ok(())
}

pub(crate) fn save(state: &AppState, mut endpoint: HttpSource, min_zoom: u8, max_zoom: u8,
    replace: bool, credential: Option<CredentialInput>) -> Result<SourceDescriptor, AppError> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = GATE.get_or_init(|| Mutex::new(())).lock().map_err(|_| workspace_error("SOURCE_CREDENTIAL_STORE", "凭证存储暂不可用"))?;
    let mut store = open_store(state)?;
    let old = store.get_registered_source(&endpoint.id)?.and_then(|source| source.endpoint.authentication);
    let mut new_secret = None;
    if let Some(input) = credential {
        if let Some(mode) = input.mode {
            let parameter = input.parameter.filter(|name| !name.is_empty()).unwrap_or_else(|| match mode {
                AuthenticationMode::QueryToken => "token".into(), AuthenticationMode::BearerToken => "Authorization".into(), AuthenticationMode::HeaderToken => "X-API-Key".into(),
            });
            let target = origin(&endpoint)?;
            let token = input.token.unwrap_or_default().trim().to_owned();
            token_valid(&token)?;
            endpoint.authentication = if token.is_empty() && old.as_ref().is_some_and(|auth| auth.mode == mode && auth.parameter == parameter && auth.origin == target) {
                old.clone()
            } else {
                let reference = Uuid::new_v4().to_string();
                if !token.is_empty() { new_secret = Some((reference.clone(), token)); }
                Some(SourceAuthentication { mode, parameter, origin: target, credential_ref: reference,
                    version: if new_secret.is_some() { Uuid::new_v4().to_string() } else { "pending".into() } })
            };
        } else { endpoint.authentication = None; }
    } else { verify_binding(state, &endpoint)?; }
    endpoint.runtime_token = None;
    endpoint.validate_configuration()?;
    if let Some((reference, token)) = &new_secret {
        entry(state, reference)?.set_password(token).map_err(|_| workspace_error("SOURCE_CREDENTIAL_STORE", "Token 未能保存到本机凭证存储"))?;
    }
    let result = store.save_source(endpoint.clone(), min_zoom, max_zoom, replace, Utc::now()).map_err(AppError::from);
    if result.is_err() {
        if let Some((reference, _)) = new_secret { let _ = entry(state, &reference)?.delete_credential(); }
    } else if let Some(old) = old {
        if endpoint.authentication.as_ref().map(|auth| &auth.credential_ref) != Some(&old.credential_ref) {
            if let Ok(entry) = entry(state, &old.credential_ref) { let _ = entry.delete_credential(); }
        }
    }
    result
}

pub(crate) fn resolve(state: &AppState, endpoint: &mut HttpSource) -> Result<(), AppError> {
    verify_binding(state, endpoint)?;
    if let Some(auth) = &endpoint.authentication {
        let token = entry(state, &auth.credential_ref)?.get_password().map_err(|cause| if matches!(cause,keyring::Error::NoEntry) {
            workspace_error("SOURCE_CREDENTIAL_REQUIRED", "此图源需要 Key/Token，请在图源管理中填写后再试")
        } else { workspace_error("SOURCE_CREDENTIAL_UNAVAILABLE", "已保存的图源凭据无法读取，请在图源认证入口重新保存后继续") })?;
        token_valid(&token)?;
        endpoint.runtime_token = Some(RuntimeToken(token));
    }
    Ok(())
}

#[cfg(test)]
mod readiness_tests {
    use super::*;
    fn auth(version: &str) -> SourceAuthentication { SourceAuthentication { mode: AuthenticationMode::QueryToken, parameter:"tk".into(), origin:"https://example.test".into(), credential_ref:Uuid::new_v4().to_string(), version:version.into() } }
    #[test]
    fn pending_credentials_are_not_reported_as_configured_or_read_from_the_vault() {
        assert_eq!(credential_state(Some(&auth("pending")), || panic!("pending must not read the vault")), ("missing",Some("SOURCE_CREDENTIAL_REQUIRED")));
    }
    #[test]
    fn missing_and_unreadable_credentials_have_distinct_recovery_conditions() {
        assert_eq!(credential_state(Some(&auth("saved")), || Err(keyring::Error::NoEntry)), ("missing",Some("SOURCE_CREDENTIAL_REQUIRED")));
        assert_eq!(credential_state(Some(&auth("saved")), || Err(keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("locked"))))), ("unavailable",Some("SOURCE_CREDENTIAL_UNAVAILABLE")));
        assert_eq!(credential_state(Some(&auth("saved")), || Ok("fixture-only".into())), ("ready",None));
    }
}

pub(crate) fn preview(state: &AppState, endpoint: &mut HttpSource, input: Option<CredentialInput>) -> Result<(), AppError> {
    match input {
        Some(input) => match input.mode {
            None => { endpoint.authentication = None; endpoint.runtime_token = None; },
            Some(mode) => {
                let parameter = input.parameter.unwrap_or_else(|| if mode == AuthenticationMode::BearerToken { "Authorization".into() } else { "token".into() });
                let token = input.token.unwrap_or_default().trim().to_owned();
                if token.is_empty() {
                    if endpoint.authentication.as_ref().is_some_and(|auth| auth.mode == mode && auth.parameter == parameter && auth.origin == origin(endpoint).unwrap_or_default()) { resolve(state, endpoint)?; }
                    else { return Err(workspace_error("SOURCE_CREDENTIAL_REQUIRED", "请先填写 Key/Token 再预览")); }
                } else {
                    token_valid(&token)?;
                    endpoint.authentication = Some(SourceAuthentication { mode, parameter, credential_ref: Uuid::new_v4().to_string(), version: "preview".into(), origin: origin(endpoint)? });
                    endpoint.runtime_token = Some(RuntimeToken(token));
                }
            },
        },
        None => resolve(state, endpoint)?,
    }
    endpoint.validate_configuration()?;
    Ok(())
}

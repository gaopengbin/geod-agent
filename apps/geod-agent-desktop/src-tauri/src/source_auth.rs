//! Credential values stay in Windows Credential Manager and in worker memory.
use crate::{open_store, workspace_error, AppError, AppState};
use chrono::Utc;
use geod_core::imagery::{AuthenticationMode, HttpSource, RuntimeToken, SourceAuthentication};
use geod_task_engine::SourceDescriptor;
use keyring::Entry;
use serde::Deserialize;
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
        let token = entry(state, &auth.credential_ref)?.get_password().map_err(|_| workspace_error("SOURCE_CREDENTIAL_REQUIRED", "此图源需要 Key/Token，请在图源管理中填写后再试"))?;
        token_valid(&token)?;
        endpoint.runtime_token = Some(RuntimeToken(token));
    }
    Ok(())
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

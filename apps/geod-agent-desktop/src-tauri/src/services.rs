use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use reqwest::{blocking::Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceError {
    code: &'static str,
    message: String,
}
fn error(code: &'static str, message: &str) -> ServiceError {
    ServiceError {
        code,
        message: message.into(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub identity_origin: String,
    pub gateway_origin: String,
}
#[derive(Default)]
struct Flow {
    pending: bool,
    error: Option<String>,
}
pub struct ServiceState {
    config_path: PathBuf,
    flow: Arc<Mutex<Flow>>,
    credential_lock: Arc<Mutex<()>>,
}
impl ServiceState {
    pub fn new(config_path: PathBuf) -> Self {
        Self {
            config_path,
            flow: Arc::new(Mutex::new(Flow::default())),
            credential_lock: Arc::new(Mutex::new(())),
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    state: &'static str,
    user_id: Option<String>,
    error: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Tokens {
    identity_origin: String,
    access_token: String,
    refresh_token: String,
    user_id: String,
    access_expires_at: u64,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    user_id: String,
    expires_in: u64,
}
fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn entry() -> Result<Entry, ServiceError> {
    Entry::new("dev.geod-agent.desktop", "geod-oauth")
        .map_err(|_| error("CREDENTIAL_STORE", "无法访问系统凭据库"))
}
fn read_tokens() -> Result<Option<Tokens>, ServiceError> {
    let value = match entry()?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(_) => return Err(error("CREDENTIAL_STORE", "读取系统凭据失败")),
    };
    serde_json::from_str(&value)
        .map(Some)
        .map_err(|_| error("CREDENTIAL_STORE", "系统凭据格式错误"))
}
fn write_tokens(tokens: &Tokens) -> Result<(), ServiceError> {
    entry()?
        .set_password(
            &serde_json::to_string(tokens)
                .map_err(|_| error("CREDENTIAL_STORE", "凭据编码失败"))?,
        )
        .map_err(|_| error("CREDENTIAL_STORE", "保存系统凭据失败"))
}
fn delete_tokens() -> Result<(), ServiceError> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(error("CREDENTIAL_STORE", "移除系统凭据失败")),
    }
}
fn validate_origin(raw: &str) -> Result<String, ServiceError> {
    let url = Url::parse(raw).map_err(|_| error("INVALID_SERVICE_URL", "请输入有效的服务地址"))?;
    let local = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && local))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(error(
            "INVALID_SERVICE_URL",
            "服务地址必须是 HTTPS，或本机回环 HTTP",
        ));
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}
fn validate_config(config: ServiceConfig) -> Result<ServiceConfig, ServiceError> {
    Ok(ServiceConfig {
        identity_origin: validate_origin(&config.identity_origin)?,
        gateway_origin: validate_origin(&config.gateway_origin)?,
    })
}
fn load_config(path: &PathBuf) -> Result<ServiceConfig, ServiceError> {
    let value = fs::read_to_string(path)
        .map_err(|_| error("SERVICE_NOT_CONFIGURED", "请先设置 GeoD 身份和模型服务地址"))?;
    let config: ServiceConfig = serde_json::from_str(&value)
        .map_err(|_| error("SERVICE_NOT_CONFIGURED", "服务配置损坏"))?;
    validate_config(config)
}
fn client() -> Result<Client, ServiceError> {
    Client::builder()
        .timeout(Duration::from_secs(55))
        .build()
        .map_err(|_| error("NETWORK_ERROR", "网络客户端初始化失败"))
}
fn token_response(value: TokenResponse, identity_origin: String) -> Result<Tokens, ServiceError> {
    if value.access_token.len() != 43
        || value.refresh_token.len() != 43
        || value.user_id.is_empty()
        || value.expires_in == 0
    {
        return Err(error("INVALID_TOKEN_RESPONSE", "身份服务返回了无效授权"));
    }
    Ok(Tokens {
        identity_origin,
        access_token: value.access_token,
        refresh_token: value.refresh_token,
        user_id: value.user_id,
        access_expires_at: unix_seconds() + value.expires_in,
    })
}
fn get_access_token(state: &ServiceState, config: &ServiceConfig) -> Result<String, ServiceError> {
    let _guard = state
        .credential_lock
        .lock()
        .expect("credential mutex poisoned");
    let mut tokens = read_tokens()?.ok_or_else(|| error("AUTH_REQUIRED", "请先登录 GeoD"))?;
    if tokens.identity_origin != config.identity_origin {
        return Err(error("AUTH_REQUIRED", "请重新登录 GeoD"));
    }
    if tokens.access_expires_at > unix_seconds() + 30 {
        return Ok(tokens.access_token);
    }
    let response = client()?
        .post(format!("{}/api/geod/oauth/token", config.identity_origin))
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", "geod-agent-desktop"),
            ("refresh_token", tokens.refresh_token.as_str()),
        ])
        .send()
        .map_err(|_| error("IDENTITY_UNAVAILABLE", "GeoD 身份服务暂时不可达"))?;
    if !response.status().is_success() {
        if response.status().is_client_error() {
            delete_tokens()?;
        }
        return Err(error("AUTH_EXPIRED", "GeoD 授权已失效，请重新登录"));
    }
    let refreshed: TokenResponse = response
        .json()
        .map_err(|_| error("INVALID_TOKEN_RESPONSE", "身份服务返回了无效授权"))?;
    tokens = token_response(refreshed, config.identity_origin.clone())?;
    write_tokens(&tokens)?;
    Ok(tokens.access_token)
}

#[tauri::command]
pub fn service_config_get(
    state: State<'_, ServiceState>,
) -> Result<Option<ServiceConfig>, ServiceError> {
    if !state.config_path.exists() {
        return Ok(None);
    }
    load_config(&state.config_path).map(Some)
}
#[tauri::command]
pub fn service_config_set(
    state: State<'_, ServiceState>,
    config: ServiceConfig,
) -> Result<ServiceConfig, ServiceError> {
    if state.flow.lock().expect("flow mutex poisoned").pending {
        return Err(error("AUTH_IN_PROGRESS", "请先完成当前登录流程"));
    }
    let normalized = validate_config(config)?;
    let _guard = state
        .credential_lock
        .lock()
        .expect("credential mutex poisoned");
    if read_tokens()?.is_some() {
        return Err(error("AUTH_ACTIVE", "请先退出当前 GeoD 账号"));
    }
    fs::write(
        &state.config_path,
        serde_json::to_vec_pretty(&normalized)
            .map_err(|_| error("SERVICE_CONFIG", "服务配置编码失败"))?,
    )
    .map_err(|_| error("SERVICE_CONFIG", "保存服务配置失败"))?;
    Ok(normalized)
}
#[tauri::command]
pub fn auth_status(state: State<'_, ServiceState>) -> Result<AuthStatus, ServiceError> {
    let flow = state.flow.lock().expect("flow mutex poisoned");
    if flow.pending {
        return Ok(AuthStatus {
            state: "waiting",
            user_id: None,
            error: None,
        });
    }
    let last_error = flow.error.clone();
    drop(flow);
    let config = match load_config(&state.config_path) {
        Ok(config) => config,
        Err(_) => {
            return Ok(AuthStatus {
                state: "unconfigured",
                user_id: None,
                error: last_error,
            })
        }
    };
    let _guard = state
        .credential_lock
        .lock()
        .expect("credential mutex poisoned");
    if let Some(tokens) = read_tokens()? {
        if tokens.identity_origin == config.identity_origin {
            return Ok(AuthStatus {
                state: "connected",
                user_id: Some(tokens.user_id),
                error: None,
            });
        }
    }
    Ok(AuthStatus {
        state: "disconnected",
        user_id: None,
        error: last_error,
    })
}

fn send_page(stream: &mut std::net::TcpStream, success: bool) {
    let message = if success {
        "GeoD 授权成功，可以返回桌面应用。"
    } else {
        "GeoD 授权失败，请返回桌面应用重试。"
    };
    let body = format!("<!doctype html><meta charset=\"utf-8\"><title>GeoD Agent</title><body style=\"font:16px system-ui;padding:48px\"><h1>{message}</h1></body>");
    let status = if success { "200 OK" } else { "400 Bad Request" };
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}", body.len());
}
fn complete_flow(
    listener: TcpListener,
    expected_state: String,
    verifier: String,
    redirect_uri: String,
    config: ServiceConfig,
    flow: Arc<Mutex<Flow>>,
    credential_lock: Arc<Mutex<()>>,
) {
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut completed = false;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buffer = [0_u8; 8192];
                let length = match stream.read(&mut buffer) {
                    Ok(length) => length,
                    Err(_) => continue,
                };
                let request = String::from_utf8_lossy(&buffer[..length]);
                let first = request.lines().next().unwrap_or("");
                let host = request
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find_map(|(name, value)| {
                        name.eq_ignore_ascii_case("host").then_some(value.trim())
                    })
                    .unwrap_or("");
                let expected_host = redirect_uri
                    .strip_prefix("http://")
                    .and_then(|part| part.split('/').next())
                    .unwrap_or("");
                let target = first
                    .strip_prefix("GET ")
                    .and_then(|rest| rest.split_once(' '))
                    .map(|(target, _)| target);
                let parsed = target
                    .and_then(|target| Url::parse(&format!("http://{expected_host}{target}")).ok());
                let valid = parsed.as_ref().is_some_and(|url| {
                    url.path() == "/oauth/callback"
                        && url
                            .query_pairs()
                            .any(|(key, value)| key == "state" && value == expected_state)
                }) && host == expected_host
                    && request.contains("HTTP/1.1");
                if !valid {
                    send_page(&mut stream, false);
                    continue;
                }
                let code = parsed
                    .unwrap()
                    .query_pairs()
                    .find(|(key, _)| key == "code")
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_default();
                let outcome = (|| -> Result<(), ServiceError> {
                    if code.len() != 43
                        || !code
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                    {
                        return Err(error("INVALID_CODE", "授权码无效"));
                    }
                    let response = client()?
                        .post(format!("{}/api/geod/oauth/token", config.identity_origin))
                        .form(&[
                            ("grant_type", "authorization_code"),
                            ("client_id", "geod-agent-desktop"),
                            ("redirect_uri", redirect_uri.as_str()),
                            ("code", code.as_str()),
                            ("code_verifier", verifier.as_str()),
                        ])
                        .send()
                        .map_err(|_| error("IDENTITY_UNAVAILABLE", "GeoD 身份服务暂时不可达"))?;
                    if !response.status().is_success() {
                        return Err(error("INVALID_GRANT", "GeoD 授权码验证失败"));
                    }
                    let value: TokenResponse = response
                        .json()
                        .map_err(|_| error("INVALID_TOKEN_RESPONSE", "身份服务响应无效"))?;
                    let tokens = token_response(value, config.identity_origin.clone())?;
                    let _guard = credential_lock.lock().expect("credential mutex poisoned");
                    write_tokens(&tokens)
                })();
                send_page(&mut stream, outcome.is_ok());
                let mut current = flow.lock().expect("flow mutex poisoned");
                current.pending = false;
                current.error = outcome.err().map(|error| error.message);
                completed = true;
                break;
            }
            Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100))
            }
            Err(_) => break,
        }
    }
    if !completed {
        let mut current = flow.lock().expect("flow mutex poisoned");
        current.pending = false;
        current.error = Some("登录等待已超时，请重试".into());
    }
}

#[tauri::command]
pub fn auth_begin(
    app: AppHandle,
    state: State<'_, ServiceState>,
) -> Result<AuthStatus, ServiceError> {
    let config = load_config(&state.config_path)?;
    {
        let _guard = state
            .credential_lock
            .lock()
            .expect("credential mutex poisoned");
        if read_tokens()?.is_some() {
            return Err(error("AUTH_ACTIVE", "请先退出当前 GeoD 账号"));
        }
    }
    {
        let flow = state.flow.lock().expect("flow mutex poisoned");
        if flow.pending {
            return Err(error("AUTH_IN_PROGRESS", "登录窗口已经打开"));
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| error("CALLBACK_UNAVAILABLE", "无法建立本机授权回调"))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| error("CALLBACK_UNAVAILABLE", "无法建立本机授权回调"))?;
    let port = listener
        .local_addr()
        .map_err(|_| error("CALLBACK_UNAVAILABLE", "无法取得本机回调地址"))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth/callback");
    let verifier = format!(
        "{}{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    );
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let nonce = Uuid::new_v4().simple().to_string();
    let mut url = Url::parse(&format!(
        "{}/api/geod/oauth/authorize",
        config.identity_origin
    ))
    .map_err(|_| error("INVALID_SERVICE_URL", "身份服务地址无效"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", "geod-agent-desktop")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", "geod:agent")
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &nonce);
    {
        let mut flow = state.flow.lock().expect("flow mutex poisoned");
        flow.pending = true;
        flow.error = None;
    }
    let flow = Arc::clone(&state.flow);
    let credential_lock = Arc::clone(&state.credential_lock);
    thread::spawn(move || {
        complete_flow(
            listener,
            nonce,
            verifier,
            redirect_uri,
            config,
            flow,
            credential_lock,
        )
    });
    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
        let mut flow = state.flow.lock().expect("flow mutex poisoned");
        flow.pending = false;
        flow.error = Some("无法打开系统浏览器".into());
        return Err(error("BROWSER_UNAVAILABLE", "无法打开系统浏览器"));
    }
    Ok(AuthStatus {
        state: "waiting",
        user_id: None,
        error: None,
    })
}
#[tauri::command]
pub fn auth_logout(state: State<'_, ServiceState>) -> Result<AuthStatus, ServiceError> {
    if state.flow.lock().expect("flow mutex poisoned").pending {
        return Err(error("AUTH_IN_PROGRESS", "请先完成当前登录流程"));
    }
    let config = load_config(&state.config_path)?;
    let _guard = state
        .credential_lock
        .lock()
        .expect("credential mutex poisoned");
    if let Some(tokens) = read_tokens()? {
        if tokens.identity_origin == config.identity_origin {
            let _ = client().and_then(|client| {
                client
                    .post(format!("{}/api/geod/oauth/revoke", config.identity_origin))
                    .form(&[
                        ("client_id", "geod-agent-desktop"),
                        ("token", tokens.refresh_token.as_str()),
                    ])
                    .send()
                    .map(|_| ())
                    .map_err(|_| error("IDENTITY_UNAVAILABLE", "GeoD 身份服务暂时不可达"))
            });
        }
    }
    delete_tokens()?;
    Ok(AuthStatus {
        state: "disconnected",
        user_id: None,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_origins_require_https_or_loopback() {
        assert_eq!(
            validate_origin("https://geod.example.com/").unwrap(),
            "https://geod.example.com"
        );
        assert_eq!(
            validate_origin("http://127.0.0.1:3000").unwrap(),
            "http://127.0.0.1:3000"
        );
        assert!(validate_origin("http://example.com").is_err());
        assert!(validate_origin("https://example.com/path").is_err());
        assert!(validate_origin("https://user:password@example.com").is_err());
    }
}

fn gateway_call(
    state: &ServiceState,
    path: &str,
    body: Option<Value>,
) -> Result<Value, ServiceError> {
    let config = load_config(&state.config_path)?;
    let token = get_access_token(state, &config)?;
    let client = client()?;
    let request = if let Some(body) = body {
        client
            .post(format!("{}{path}", config.gateway_origin))
            .json(&body)
    } else {
        client.get(format!("{}{path}", config.gateway_origin))
    };
    let response = request
        .bearer_auth(token)
        .send()
        .map_err(|_| error("GATEWAY_UNAVAILABLE", "GeoD Agent 模型服务暂时不可达"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .map_err(|_| error("GATEWAY_RESPONSE", "模型服务响应无效"))?;
    if !status.is_success() {
        let code = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("GATEWAY_ERROR");
        return Err(error(
            "GATEWAY_ERROR",
            match code {
                "QUOTA_EXCEEDED" => "模型额度不足，请查看用量",
                "UNAUTHORIZED" => "GeoD 登录已失效，请重新登录",
                "UPSTREAM_UNKNOWN" => "模型请求状态待核对，请查看任务记录",
                "UPSTREAM_REJECTED" => "模型服务拒绝了请求",
                _ => "模型请求失败，请稍后重试",
            },
        ));
    }
    Ok(value)
}
#[tauri::command]
pub async fn agent_generate(
    state: State<'_, ServiceState>,
    generation_id: String,
    conversation_id: String,
    messages: Value,
) -> Result<Value, ServiceError> {
    let state = Arc::new(ServiceState {
        config_path: state.config_path.clone(),
        flow: Arc::clone(&state.flow),
        credential_lock: Arc::clone(&state.credential_lock),
    });
    tauri::async_runtime::spawn_blocking(move || gateway_call(&state, "/api/agent/generations", Some(json!({ "generationId": generation_id, "conversationId": conversation_id, "messages": messages })))).await
        .map_err(|_| error("GATEWAY_ERROR", "模型请求线程中断"))?
}
#[tauri::command]
pub async fn agent_usage(state: State<'_, ServiceState>) -> Result<Value, ServiceError> {
    let state = Arc::new(ServiceState {
        config_path: state.config_path.clone(),
        flow: Arc::clone(&state.flow),
        credential_lock: Arc::clone(&state.credential_lock),
    });
    tauri::async_runtime::spawn_blocking(move || gateway_call(&state, "/api/agent/usage", None))
        .await
        .map_err(|_| error("GATEWAY_ERROR", "用量查询线程中断"))?
}
#[tauri::command]
pub async fn agent_generation_get(
    state: State<'_, ServiceState>,
    generation_id: String,
) -> Result<Value, ServiceError> {
    if generation_id.len() < 8
        || generation_id.len() > 80
        || !generation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(error("INVALID_GENERATION", "模型请求编号无效"));
    }
    let state = Arc::new(ServiceState {
        config_path: state.config_path.clone(),
        flow: Arc::clone(&state.flow),
        credential_lock: Arc::clone(&state.credential_lock),
    });
    tauri::async_runtime::spawn_blocking(move || {
        gateway_call(
            &state,
            &format!("/api/agent/generations/{generation_id}"),
            None,
        )
    })
    .await
    .map_err(|_| error("GATEWAY_ERROR", "模型请求查询线程中断"))?
}

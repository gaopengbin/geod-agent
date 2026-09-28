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
fn credential_account(identity_origin: &str) -> String {
    if identity_origin == "https://geod.laogao.xyz" {
        "geod-oauth".into()
    } else {
        format!(
            "geod-oauth-{:x}",
            Sha256::digest(identity_origin.as_bytes())
        )
    }
}
fn entry(identity_origin: &str) -> Result<Entry, ServiceError> {
    Entry::new(
        "dev.geod-agent.desktop",
        &credential_account(identity_origin),
    )
    .map_err(|_| error("CREDENTIAL_STORE", "无法访问系统凭据库"))
}
fn read_tokens(identity_origin: &str) -> Result<Option<Tokens>, ServiceError> {
    let value = match entry(identity_origin)?.get_password() {
        Ok(value) => value,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(_) => return Err(error("CREDENTIAL_STORE", "读取系统凭据失败")),
    };
    serde_json::from_str(&value)
        .map(Some)
        .map_err(|_| error("CREDENTIAL_STORE", "系统凭据格式错误"))
}
fn write_tokens(tokens: &Tokens) -> Result<(), ServiceError> {
    entry(&tokens.identity_origin)?
        .set_password(
            &serde_json::to_string(tokens)
                .map_err(|_| error("CREDENTIAL_STORE", "凭据编码失败"))?,
        )
        .map_err(|_| error("CREDENTIAL_STORE", "保存系统凭据失败"))
}
fn delete_tokens(identity_origin: &str) -> Result<(), ServiceError> {
    match entry(identity_origin)?.delete_credential() {
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
    let config: ServiceConfig = match fs::read_to_string(path) {
        Ok(value) => serde_json::from_str(&value)
            .map_err(|_| error("SERVICE_NOT_CONFIGURED", "服务配置损坏"))?,
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
            let identity_origin = std::env::var("GEOD_AGENT_IDENTITY_ORIGIN")
                .ok()
                .or_else(|| option_env!("GEOD_AGENT_IDENTITY_ORIGIN").map(str::to_string))
                .unwrap_or_else(|| "https://geod.laogao.xyz".to_string());
            let gateway_origin = std::env::var("GEOD_AGENT_GATEWAY_ORIGIN")
                .ok()
                .or_else(|| option_env!("GEOD_AGENT_GATEWAY_ORIGIN").map(str::to_string))
                .unwrap_or_else(|| "https://geod.laogao.xyz".to_string());
            ServiceConfig {
                identity_origin,
                gateway_origin,
            }
        }
        Err(_) => return Err(error("SERVICE_NOT_CONFIGURED", "读取服务配置失败")),
    };
    validate_config(config)
}
fn client(origin: &str) -> Result<Client, ServiceError> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(55));
    #[cfg(windows)]
    if Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]" | "::1"))
    {
        if let Some(proxy) = crate::windows_user_proxy() {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|_| error("NETWORK_ERROR", "网络客户端初始化失败"))
}
fn ensure_identity_available(origin: &str) -> Result<(), ServiceError> {
    let response = client(origin)?
        .get(format!("{origin}/api/geod/oauth/authorize"))
        .timeout(Duration::from_secs(8))
        .send()
        .map_err(|_| error("IDENTITY_UNAVAILABLE", "GeoD 账号授权服务暂时不可达"))?;
    let status = response.status();
    if status.is_server_error() {
        return Err(error("IDENTITY_UNAVAILABLE", "GeoD 账号授权服务暂时不可达"));
    }
    let value: Value = response
        .json()
        .map_err(|_| error("IDENTITY_UNAVAILABLE", "GeoD 账号授权接口尚未上线"))?;
    if status != reqwest::StatusCode::BAD_REQUEST
        || value.pointer("/error/code").and_then(Value::as_str) != Some("INVALID_OAUTH_REQUEST")
    {
        return Err(error("IDENTITY_UNAVAILABLE", "GeoD 账号授权接口尚未上线"));
    }
    Ok(())
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
    let mut tokens = read_tokens(&config.identity_origin)?
        .ok_or_else(|| error("AUTH_REQUIRED", "请先登录 GeoD"))?;
    if tokens.identity_origin != config.identity_origin {
        return Err(error("AUTH_REQUIRED", "请重新登录 GeoD"));
    }
    if tokens.access_expires_at > unix_seconds() + 30 {
        return Ok(tokens.access_token);
    }
    let response = client(&config.identity_origin)?
        .post(format!("{}/api/geod/oauth/token", config.identity_origin))
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", "geod-agent-desktop"),
            ("refresh_token", tokens.refresh_token.as_str()),
        ])
        .send()
        .map_err(|_| error("IDENTITY_UNAVAILABLE", "GeoD 身份服务暂时不可达"))?;
    if !response.status().is_success() {
        if matches!(
            response.status(),
            reqwest::StatusCode::BAD_REQUEST
                | reqwest::StatusCode::UNAUTHORIZED
                | reqwest::StatusCode::FORBIDDEN
        ) {
            delete_tokens(&config.identity_origin)?;
            return Err(error("AUTH_EXPIRED", "GeoD 授权已失效，请重新登录"));
        }
        return Err(error("IDENTITY_UNAVAILABLE", "GeoD 身份服务暂时不可达"));
    }
    let refreshed: TokenResponse = response
        .json()
        .map_err(|_| error("INVALID_TOKEN_RESPONSE", "身份服务返回了无效授权"))?;
    tokens = token_response(refreshed, config.identity_origin.clone())?;
    write_tokens(&tokens)?;
    Ok(tokens.access_token)
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
    let tokens = {
        let _guard = state
            .credential_lock
            .lock()
            .expect("credential mutex poisoned");
        read_tokens(&config.identity_origin)?
    };
    if let Some(tokens) = tokens {
        if tokens.identity_origin == config.identity_origin {
            let refresh_error = if tokens.access_expires_at <= unix_seconds() + 30 {
                match get_access_token(&state, &config) {
                    Ok(_) => None,
                    Err(cause) if cause.code == "AUTH_EXPIRED" || cause.code == "AUTH_REQUIRED" => {
                        return Ok(AuthStatus {
                            state: "disconnected",
                            user_id: None,
                            error: Some(cause.message),
                        });
                    }
                    Err(cause) => Some(cause.message),
                }
            } else {
                None
            };
            return Ok(AuthStatus {
                state: "connected",
                user_id: Some(tokens.user_id),
                error: refresh_error,
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
fn read_callback_headers(reader: &mut impl Read) -> Option<String> {
    let mut buffer = [0_u8; 8192];
    let mut length = 0;
    while length < buffer.len() {
        let read = reader.read(&mut buffer[length..]).ok()?;
        if read == 0 {
            return None;
        }
        length += read;
        if let Some(end) = buffer[..length]
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
        {
            return Some(String::from_utf8_lossy(&buffer[..end + 4]).into_owned());
        }
    }
    None
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
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let request = match read_callback_headers(&mut stream) {
                    Some(request) => request,
                    None => {
                        send_page(&mut stream, false);
                        continue;
                    }
                };
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
                    let response = client(&config.identity_origin)?
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
        if read_tokens(&config.identity_origin)?.is_some() {
            return Err(error("AUTH_ACTIVE", "请先退出当前 GeoD 账号"));
        }
    }
    {
        let flow = state.flow.lock().expect("flow mutex poisoned");
        if flow.pending {
            return Err(error("AUTH_IN_PROGRESS", "登录窗口已经打开"));
        }
    }
    ensure_identity_available(&config.identity_origin)?;
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
    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
        let mut flow = state.flow.lock().expect("flow mutex poisoned");
        flow.pending = false;
        flow.error = Some("无法打开系统浏览器".into());
        return Err(error("BROWSER_UNAVAILABLE", "无法打开系统浏览器"));
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
    if let Some(tokens) = read_tokens(&config.identity_origin)? {
        if tokens.identity_origin == config.identity_origin {
            let _ = client(&config.identity_origin).and_then(|client| {
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
    delete_tokens(&config.identity_origin)?;
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

    #[test]
    fn local_test_login_does_not_share_the_production_credential() {
        assert_eq!(credential_account("https://geod.laogao.xyz"), "geod-oauth");
        let first = credential_account("http://127.0.0.1:41001");
        let second = credential_account("http://127.0.0.1:41002");
        assert_ne!(first, "geod-oauth");
        assert_ne!(first, second);
        assert_eq!(first, credential_account("http://127.0.0.1:41001"));
    }

    #[test]
    fn login_preflight_requires_the_geod_oauth_route() {
        for (status, body, available) in [
            (
                "400 Bad Request",
                r#"{"error":{"code":"INVALID_OAUTH_REQUEST"}}"#,
                true,
            ),
            ("404 Not Found", "<html>Not found</html>", false),
            ("503 Service Unavailable", "<html>Unavailable</html>", false),
            (
                "400 Bad Request",
                r#"{"error":{"code":"WRONG_ENDPOINT"}}"#,
                false,
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 2048];
                let count = stream.read(&mut request).unwrap();
                assert!(String::from_utf8_lossy(&request[..count])
                    .starts_with("GET /api/geod/oauth/authorize "));
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            });
            assert_eq!(ensure_identity_available(&origin).is_ok(), available);
            server.join().unwrap();
        }
    }

    #[test]
    fn credentials_are_not_sent_to_redirect_targets() {
        let redirect = TcpListener::bind("127.0.0.1:0").unwrap();
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let redirect_url = format!("http://{}", redirect.local_addr().unwrap());
        let target_url = format!("http://{}", target.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = redirect.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).unwrap();
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: {target_url}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let response = client(&redirect_url)
            .unwrap()
            .post(redirect_url)
            .bearer_auth("test-secret")
            .send()
            .unwrap();
        server.join().unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::FOUND);
        assert!(
            matches!(target.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
        );
    }

    #[test]
    fn callback_headers_can_arrive_in_fragments() {
        struct Fragments<'a>(&'a [u8]);
        impl Read for Fragments<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let count = self.0.len().min(buffer.len()).min(3);
                buffer[..count].copy_from_slice(&self.0[..count]);
                self.0 = &self.0[count..];
                Ok(count)
            }
        }
        let request =
            b"GET /oauth/callback?code=abc HTTP/1.1\r\nHost: 127.0.0.1:12345\r\n\r\nextra";
        assert_eq!(
            read_callback_headers(&mut Fragments(request)).as_deref(),
            Some("GET /oauth/callback?code=abc HTTP/1.1\r\nHost: 127.0.0.1:12345\r\n\r\n")
        );
    }
}

fn gateway_call(
    state: &ServiceState,
    path: &str,
    body: Option<Value>,
) -> Result<Value, ServiceError> {
    let config = load_config(&state.config_path)?;
    let token = get_access_token(state, &config)?;
    let client = client(&config.gateway_origin)?;
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

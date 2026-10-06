use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use keyring::Entry;
use reqwest::{blocking::Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;
pub mod credit_history;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
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
#[derive(Debug, Default)]
struct Flow {
    pending: bool,
    error: Option<String>,
}
#[derive(Debug)]
struct FlowReservation {
    flow: Arc<Mutex<Flow>>,
    transferred: bool,
}
impl FlowReservation {
    fn acquire(flow: &Arc<Mutex<Flow>>) -> Result<Self, ServiceError> {
        let mut current = flow.lock().expect("flow mutex poisoned");
        if current.pending {
            return Err(error("AUTH_IN_PROGRESS", "GeoD 登录流程已在进行"));
        }
        current.pending = true;
        current.error = None;
        Ok(Self {
            flow: Arc::clone(flow),
            transferred: false,
        })
    }

    fn fail(&mut self, message: &str) {
        let mut current = self.flow.lock().expect("flow mutex poisoned");
        current.pending = false;
        current.error = Some(message.into());
        self.transferred = true;
    }

    fn transfer(mut self) {
        self.transferred = true;
    }
}
impl Drop for FlowReservation {
    fn drop(&mut self) {
        if !self.transferred {
            self.fail("登录准备失败，请重试");
        }
    }
}
#[derive(Clone)]
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

pub fn current_user_id(state: &ServiceState) -> Result<String, ServiceError> {
    let config = load_config(&state.config_path)?;
    let _ = get_access_token(state, &config)?;
    let tokens = read_tokens(&config.identity_origin)?
        .ok_or_else(|| error("AUTH_REQUIRED", "请先登录 GeoD"))?;
    Ok(tokens.user_id)
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
    let mut config: ServiceConfig = match fs::read_to_string(path) {
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
    // A development preview can use a local gateway while keeping the real login.
    #[cfg(debug_assertions)]
    if let Ok(origin) = std::env::var("GEOD_AGENT_DEV_GATEWAY_ORIGIN") {
        let url = reqwest::Url::parse(&origin).map_err(|_| error("SERVICE_NOT_CONFIGURED", "本地网关地址无效"))?;
        if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") { return Err(error("SERVICE_NOT_CONFIGURED", "开发网关必须运行在本机")); }
        config.gateway_origin = origin;
    }
    validate_config(config)
}
fn client(origin: &str) -> Result<Client, ServiceError> {
    let proxy = crate::network::proxy_for(origin)
        .map_err(|_| error("NETWORK_SETTINGS_ERROR", "网络代理设置无效，请在设置中检查"))?;
    let builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(55));
    crate::network::apply_blocking(builder, proxy.as_deref())
        .map_err(|_| error("NETWORK_SETTINGS_ERROR", "网络代理设置无效，请在设置中检查"))?
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
    // The desktop and its detached background share the same rotating token.
    // Serialize refresh across processes, then reread the current vault value.
    let refresh_lock = fs::OpenOptions::new().create(true).read(true).write(true)
        .open(state.config_path.with_extension("credentials.lock"))
        .map_err(|_| error("CREDENTIAL_STORE", "无法取得本机授权锁"))?;
    fs2::FileExt::lock_exclusive(&refresh_lock)
        .map_err(|_| error("CREDENTIAL_STORE", "无法取得本机授权锁"))?;
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
    let mut reservation = FlowReservation::acquire(&state.flow)?;
    if let Err(cause) = ensure_identity_available(&config.identity_origin) {
        reservation.fail(&cause.message);
        return Err(cause);
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
    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
        reservation.fail("无法打开系统浏览器");
        return Err(error("BROWSER_UNAVAILABLE", "无法打开系统浏览器"));
    }
    let flow = Arc::clone(&state.flow);
    let credential_lock = Arc::clone(&state.credential_lock);
    thread::Builder::new()
        .name("geod-oauth-callback".into())
        .spawn(move || {
            complete_flow(
                listener,
                nonce,
                verifier,
                redirect_uri,
                config,
                flow,
                credential_lock,
            )
        })
        .map_err(|_| {
            reservation.fail("无法等待本机授权回调");
            error("CALLBACK_UNAVAILABLE", "无法等待本机授权回调")
        })?;
    reservation.transfer();
    Ok(AuthStatus {
        state: "waiting",
        user_id: None,
        error: None,
    })
}
#[tauri::command]
pub fn auth_logout(app: AppHandle, state: State<'_, ServiceState>) -> Result<AuthStatus, ServiceError> {
    use tauri::Manager;
    app.state::<crate::codex_runtime::CodexState>().shutdown();
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
    fn payment_checkout_stays_on_the_declared_provider_and_fixture_boundary(){
        let checkout=|url:&str,environment:&str,fixture:bool|json!({"checkoutUrl":url,"order":{"environment":environment},"fixture":fixture});
        assert!(payment_checkout_url(&checkout("https://openapi.alipay.com/gateway.do?sign=signed","production",false),"https://geod.laogao.xyz").is_ok());
        assert!(payment_checkout_url(&checkout("https://openapi-sandbox.dl.alipaydev.com/gateway.do","sandbox",false),"https://geod.laogao.xyz").is_ok());
        for url in ["https://openapi.alipay.com.evil.example/gateway.do","https://u:p@openapi.alipay.com/gateway.do","https://openapi.alipay.com/gateway.do#part","http://openapi.alipay.com/gateway.do","https://openapi.alipay.com:8443/gateway.do"]{
            assert!(payment_checkout_url(&checkout(url,"production",false),"https://geod.laogao.xyz").is_err());
        }
        assert!(payment_checkout_url(&checkout("http://127.0.0.1:43210/gateway.do","fixture",true),"https://geod.laogao.xyz").is_err());
        assert!(payment_checkout_url(&checkout("http://127.0.0.1:43210/gateway.do","fixture",true),"http://127.0.0.1:43124").is_ok());
        assert!(payment_checkout_url(&checkout("http://example.com/gateway.do","fixture",true),"http://127.0.0.1:43124").is_err());
        assert!(payment_checkout_url(&checkout("https://openapi.alipay.com/gateway.do","unknown",false),"https://geod.laogao.xyz").is_err());
    }
    #[test]
    fn payment_errors_preserve_uncertainty_and_do_not_render_an_object(){
        let cause=gateway_response_error(reqwest::StatusCode::BAD_GATEWAY,"/v1/payments/orders/GDA000/refund",&json!({"error":{"code":"PAYMENT_PROVIDER_UNCERTAIN","message":"private provider diagnostics"}}));
        assert_eq!(cause.code,"PAYMENT_PROVIDER_UNCERTAIN");assert!(!cause.message.contains("private"));
        assert_eq!(gateway_response_error(reqwest::StatusCode::NOT_FOUND,"/v1/payments/status",&json!({"error":"NOT_FOUND"})).code,"PAYMENT_UNAVAILABLE");
        assert!(payment_order_id("GDA0123456789abcdef0123456789abcdef"));assert!(!payment_order_id("GDA../orders"));assert!(!payment_order_id("GDA0123456789ABCDEF0123456789abcdef"));
    }

    #[test]
    fn optional_payment_status_handles_a_real_proxy_html_404_without_hiding_other_errors(){
        for (path,status,body,expected) in [
            ("/v1/payments/status","404 Not Found","<html>Not found</html>","PAYMENT_UNAVAILABLE"),
            ("/v1/payments/status","200 OK","<html>Not JSON</html>","GATEWAY_RESPONSE"),
            ("/v1/payments/history/usage?limit=20","404 Not Found","<html>Not found</html>","PAYMENT_HISTORY_UNAVAILABLE"),
            ("/v1/payments/history/usage","401 Unauthorized",r#"{"error":"UNAUTHORIZED"}"#,"AUTH_REQUIRED"),
            ("/v1/payments/orders/GDA000","404 Not Found","<html>Not found</html>","GATEWAY_RESPONSE"),
            ("/v1/payments/status","401 Unauthorized",r#"{"error":"UNAUTHORIZED"}"#,"AUTH_REQUIRED"),
        ] {
            let listener=TcpListener::bind("127.0.0.1:0").unwrap();
            let origin=format!("http://{}",listener.local_addr().unwrap());
            let server=thread::spawn(move||{
                let (mut stream,_)=listener.accept().unwrap();let mut request=[0_u8;2048];stream.read(&mut request).unwrap();
                write!(stream,"HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            });
            let response=reqwest::blocking::Client::builder().no_proxy().timeout(std::time::Duration::from_secs(5)).build().unwrap().get(format!("{origin}{path}")).send().unwrap();
            assert_eq!(gateway_json_response(response,path).unwrap_err().code,expected);
            server.join().unwrap();
        }
    }

    #[test]
    fn authorization_reservation_rejects_parallel_starts_and_releases_failed_preflight() {
        let flow = Arc::new(Mutex::new(Flow::default()));
        let reservation = FlowReservation::acquire(&flow).unwrap();
        let competing = Arc::clone(&flow);
        let duplicate = thread::spawn(move || FlowReservation::acquire(&competing).err().unwrap());
        assert_eq!(duplicate.join().unwrap().code, "AUTH_IN_PROGRESS");
        drop(reservation);
        assert!(!flow.lock().unwrap().pending);

        let mut retry = FlowReservation::acquire(&flow).unwrap();
        retry.fail("GeoD 授权接口尚未上线");
        drop(retry);
        let current = flow.lock().unwrap();
        assert!(!current.pending);
        assert_eq!(current.error.as_deref(), Some("GeoD 授权接口尚未上线"));
    }

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

    #[cfg(windows)]
    #[test]
    fn expired_local_login_refreshes_silently_and_survives_state_recreation() {
        struct CredentialCleanup(String,PathBuf);
        impl Drop for CredentialCleanup {
            fn drop(&mut self) {
                let _ = delete_tokens(&self.0);
                let _ = fs::remove_file(self.1.with_extension("credentials.lock"));
            }
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let config_path=std::env::temp_dir().join(format!("geod-credential-refresh-{}.json",Uuid::new_v4()));
        let cleanup = CredentialCleanup(origin.clone(),config_path.clone());
        let old_refresh = "r".repeat(43);
        write_tokens(&Tokens {
            identity_origin: origin.clone(),
            access_token: "a".repeat(43),
            refresh_token: old_refresh.clone(),
            user_id: "isolated-refresh-test".into(),
            access_expires_at: unix_seconds().saturating_sub(1),
        })
        .unwrap();
        let new_access = "b".repeat(43);
        let server_access = new_access.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..count])
                .starts_with("POST /api/geod/oauth/token "));
            let response = serde_json::json!({
                "access_token": server_access,
                "refresh_token": "s".repeat(43),
                "user_id": "isolated-refresh-test",
                "expires_in": 3600,
            })
            .to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        });
        let config = ServiceConfig {
            identity_origin: origin.clone(),
            gateway_origin: origin.clone(),
        };
        let first_state = ServiceState::new(config_path.clone());
        assert_eq!(get_access_token(&first_state, &config).unwrap(), new_access);
        server.join().unwrap();
        let persisted = read_tokens(&origin).unwrap().unwrap();
        assert_eq!(persisted.refresh_token, "s".repeat(43));
        let restarted_state = ServiceState::new(config_path);
        assert_eq!(
            get_access_token(&restarted_state, &config).unwrap(),
            new_access
        );
        drop(cleanup);
        assert!(read_tokens(&origin).unwrap().is_none());
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

    #[test]
    fn absent_generation_can_be_replayed_with_its_original_id() {
        let missing = gateway_status_error(
            reqwest::StatusCode::NOT_FOUND,
            "/api/agent/generations/generation-01",
            "NOT_FOUND",
        );
        assert_eq!(missing.code, "GENERATION_NOT_FOUND");
        assert_eq!(
            gateway_status_error(
                reqwest::StatusCode::NOT_FOUND,
                "/api/agent/usage",
                "NOT_FOUND"
            )
            .code,
            "GATEWAY_ERROR"
        );
    }

    #[test]
    fn sponsored_optional_endpoint_distinguishes_legacy_from_authentication_and_network_failures() {
        let missing=gateway_status_error(reqwest::StatusCode::NOT_FOUND,"/api/agent/sponsors","NOT_FOUND");
        assert_eq!(sponsor_catalogue_result(Err(missing)).unwrap(),json!({"sponsors":[]}));
        for (status,code) in [(reqwest::StatusCode::UNAUTHORIZED,"UNAUTHORIZED"),(reqwest::StatusCode::BAD_GATEWAY,"UPSTREAM_UNAVAILABLE")] {
            let original=gateway_status_error(status,"/api/agent/sponsors",code);
            let expected=original.code;
            assert_eq!(sponsor_catalogue_result(Err(original)).unwrap_err().code,expected);
        }
        let public=json!({"sponsors":[{"id":"current"}]});
        assert_eq!(sponsor_catalogue_result(Ok(public.clone())).unwrap(),public);
    }

    #[test]
    fn quota_rejection_is_distinct_from_an_unknown_request() {
        for path in ["/api/agent/generations", "/api/agent/generations/stream"] {
            let rejected = gateway_response_error(
                reqwest::StatusCode::TOO_MANY_REQUESTS,
                path,
                &json!({"error":"QUOTA_EXCEEDED","remainingTokens":12951}),
            );
            assert_eq!(rejected.code, "QUOTA_EXCEEDED");
            assert!(rejected.message.contains("12.95K"));
            assert!(rejected.message.contains("请求未提交"));
        }
        // Unknown upstream outcomes must retain their recovery record.
        assert_eq!(gateway_response_error(
            reqwest::StatusCode::BAD_GATEWAY,
            "/api/agent/generations/stream",
            &json!({"error":"UPSTREAM_UNKNOWN"}),
        ).code, "GATEWAY_ERROR");
        assert_eq!(gateway_response_error(
            reqwest::StatusCode::BAD_GATEWAY,
            "/api/agent/generations/stream",
            &json!({"error":"QUOTA_EXCEEDED"}),
        ).code, "GATEWAY_ERROR");
    }
}

fn gateway_status_error(status: reqwest::StatusCode, path: &str, code: &str) -> ServiceError {
    if path.starts_with("/v1/payments") {
        if path.starts_with("/v1/payments/history/") {
            let cash = path.starts_with("/v1/payments/history/orders") || path.starts_with("/v1/payments/history/refunds");
            if status==reqwest::StatusCode::NOT_FOUND || code=="PAYMENT_HISTORY_UNAVAILABLE" {return error("PAYMENT_HISTORY_UNAVAILABLE",if cash {"当前服务尚未开放完整支付记录，仅显示最近记录"} else {"当前服务尚未开放完整用量记录，可查看最近记录"});}
            if code=="PAYMENT_HISTORY_INVALID" {return error("PAYMENT_HISTORY_INVALID",if cash {"支付记录筛选无效，请重新查询"} else {"用量筛选无效，请重新查询"});}
            if code=="PAYMENT_STATEMENT_TOO_LARGE" {return error("PAYMENT_STATEMENT_TOO_LARGE","导出过大，请缩小时间范围后重试");}
            if !["AUTH_REQUIRED","UNAUTHORIZED"].contains(&code) {return error("PAYMENT_HISTORY_ERROR",if cash {"支付记录查询未完成，请重试"} else {"用量查询未完成，请重试"});}
        }
        if status==reqwest::StatusCode::NOT_FOUND&&code=="NOT_FOUND" {return error("PAYMENT_UNAVAILABLE","当前服务尚未开放支付，现有测试模式不受影响");}
        return match code {
            "UNAUTHORIZED"|"AUTH_REQUIRED"=>error("AUTH_REQUIRED","GeoD 登录已失效，请重新登录"),
            "PAYMENT_DISABLED"=>error("PAYMENT_DISABLED","支付尚未开放，当前无需充值"),
            "PAYMENT_PROVIDER_UNCERTAIN"=>error("PAYMENT_PROVIDER_UNCERTAIN","付款或退款结果尚未确认，请查询原订单，不要重复下单"),
            "PAYMENT_ORDER_NOT_PAYABLE"=>error("PAYMENT_ORDER_NOT_PAYABLE","此订单暂不可继续支付，请查询原订单状态"),
            "PAYMENT_ORDER_NOT_FOUND"=>error("PAYMENT_ORDER_NOT_FOUND","未找到当前账号的订单"),
            "PAYMENT_REFUND_REVIEW_REQUIRED"=>error("PAYMENT_REFUND_REVIEW_REQUIRED","此订单的退款需要人工复核"),
            "PAYMENT_REFUND_USED"=>error("PAYMENT_REFUND_USED","此笔余额已使用，退款需要人工复核"),
            "PAYMENT_REFUND_BUSY"=>error("PAYMENT_REFUND_BUSY","有模型请求正在使用此笔余额，请等待请求结束后重试"),
            "PAYMENT_DAILY_LIMIT"=>error("PAYMENT_DAILY_LIMIT","当前支付服务暂不能创建新订单，请稍后再试"),
            "PAYMENT_IDEMPOTENCY_CONFLICT"=>error("PAYMENT_IDEMPOTENCY_CONFLICT","该下单请求已用于其他商品，请刷新订单列表"),
            _=>error("PAYMENT_ERROR","支付操作未完成，请刷新原订单核对状态"),
        };
    }
    if code=="BILLING_INSUFFICIENT_CREDIT" {return error("BILLING_INSUFFICIENT_CREDIT","可用 AI 余额不足以预留本次模型请求，请查看余额与订阅；本次未提交给模型");}
    let sponsored=match code {"SPONSOR_QUOTA_EXCEEDED"=>Some("此赞助渠道的可用额度不足，请选择其他渠道"),"SPONSOR_CHANGED"=>Some("赞助渠道配置已更新，请刷新列表并重新选择模型"),"SPONSOR_DISABLED"=>Some("赞助渠道已停用，请选择其他模型"),"SPONSOR_NOT_STARTED"=>Some("赞助活动尚未开始，请稍后使用或选择其他模型"),"SPONSOR_ENDED"=>Some("赞助活动已结束，请选择其他模型"),"SPONSOR_UNAVAILABLE"=>Some("赞助渠道不可用，请刷新列表或选择其他模型"),"SPONSOR_MODEL_MISSING"=>Some("赞助模型已移除，请选择其他模型"),"SPONSOR_IMAGE_UNSUPPORTED"=>Some("此赞助渠道暂不支持图片，请选择支持图片的模型"),_=>None};
    if let Some(message)=sponsored{return error(match code{"SPONSOR_QUOTA_EXCEEDED"=>"SPONSOR_QUOTA_EXCEEDED","SPONSOR_CHANGED"=>"SPONSOR_CHANGED","SPONSOR_DISABLED"=>"SPONSOR_DISABLED","SPONSOR_NOT_STARTED"=>"SPONSOR_NOT_STARTED","SPONSOR_ENDED"=>"SPONSOR_ENDED","SPONSOR_MODEL_MISSING"=>"SPONSOR_MODEL_MISSING","SPONSOR_IMAGE_UNSUPPORTED"=>"SPONSOR_IMAGE_UNSUPPORTED",_=>"SPONSOR_UNAVAILABLE"},message);}
    if path=="/api/agent/sponsors"&&status==reqwest::StatusCode::NOT_FOUND{return error("SPONSOR_CATALOG_UNAVAILABLE","赞助渠道暂未开放");}
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS && code == "QUOTA_EXCEEDED" {
        return error("QUOTA_EXCEEDED", "当前模型额度不足以覆盖单次请求的预留额度；本次请求未提交给模型。");
    }
    if status == reqwest::StatusCode::NOT_FOUND
        && path.starts_with("/api/agent/generations/")
        && code == "NOT_FOUND"
    {
        return error(
            "GENERATION_NOT_FOUND",
            "模型请求尚未到达服务端，可用原请求编号重试",
        );
    }
    error(
        "GATEWAY_ERROR",
        match code {
            "QUOTA_EXCEEDED" => "模型额度不足，请查看用量",
            "UNAUTHORIZED" => "GeoD 登录已失效，请重新登录",
            "UPSTREAM_UNKNOWN" => "模型请求状态待核对，请查看任务记录",
            "UPSTREAM_REJECTED" => "模型服务拒绝了请求",
            _ => "模型请求失败，请稍后重试",
        },
    )
}

fn gateway_response_error(status: reqwest::StatusCode, path: &str, value: &Value) -> ServiceError {
    let code = value.get("error").and_then(|value|value.as_str().or_else(||value.get("code").and_then(Value::as_str))).unwrap_or("GATEWAY_ERROR");
    let mut cause = gateway_status_error(status, path, code);
    if cause.code == "QUOTA_EXCEEDED" {
        if let Some(remaining) = value.get("remainingTokens").and_then(Value::as_u64) {
            cause.message = format!("请求未提交：当前可用模型额度 {:.2}K，未达到单次请求的预留要求。此前的工具结果已保留。", remaining as f64 / 1000.0);
        }
    }
    cause
}

fn gateway_call(
    state: &ServiceState,
    path: &str,
    body: Option<Value>,
) -> Result<Value, ServiceError> {
    let config = load_config(&state.config_path)?;
    let token = get_access_token(state, &config)?;
    // The development model proxy uses an isolated ledger identity. Notices
    // remain attached to the real GeoD account when that proxy is selected.
    let messages_origin = cfg!(debug_assertions) && path.starts_with("/api/agent/messages")
        && config.identity_origin=="https://geod.laogao.xyz"
        && Url::parse(&config.gateway_origin).ok().is_some_and(|url|matches!(url.host_str(),Some("127.0.0.1"|"localhost"|"[::1]")));
    let origin=if messages_origin {"https://geod.laogao.xyz"} else {&config.gateway_origin};
    let client = client(origin)?;
    let request = if let Some(body) = body {
        client
            .post(format!("{origin}{path}"))
            .json(&body)
    } else {
        client.get(format!("{origin}{path}"))
    };
    let response = request
        .bearer_auth(token)
        .send()
        .map_err(|_| error("GATEWAY_UNAVAILABLE", "GeoD Agent 模型服务暂时不可达"))?;
    gateway_json_response(response,path)
}
fn gateway_json_response(response:reqwest::blocking::Response,path:&str)->Result<Value,ServiceError>{
    let status=response.status();
    if status==reqwest::StatusCode::NOT_FOUND && path.starts_with("/api/agent/messages") {
        return Err(error("MESSAGES_UNAVAILABLE", "消息服务暂不可用，请稍后重试。"));
    }
    // Optional status routes may be absent at the reverse proxy itself, which
    // returns HTML rather than the gateway's JSON. Other responses stay strict.
    if status==reqwest::StatusCode::NOT_FOUND&&(path=="/v1/payments/status"||path.starts_with("/v1/payments/history/")){
        return Err(gateway_status_error(status,path,"NOT_FOUND"));
    }
    let value:Value=response.json().map_err(|_|error("GATEWAY_RESPONSE","模型服务响应无效"))?;
    if !status.is_success(){return Err(gateway_response_error(status,path,&value));}
    Ok(value)
}
fn gateway_stream_call(
    state: &ServiceState,
    generation_id: String,
    conversation_id: String,
    messages: Value,
    events: Channel<Value>,
) -> Result<Value, ServiceError> {
    let body = json!({ "generationId": generation_id, "conversationId": conversation_id, "messages": messages });
    gateway_stream_body(state, "/api/agent/generations/stream", body, |event, value| {
        let _ = events.send(json!({ "type": event, "data": value }));
    })
}

pub(crate) fn codex_capabilities(state: &ServiceState) -> Result<Value, ServiceError> {
    gateway_call(state, "/api/agent/capabilities", None)
}
fn sponsor_catalogue_result(result:Result<Value,ServiceError>)->Result<Value,ServiceError>{
    match result {
        // An authenticated legacy gateway without this optional endpoint has no sponsors.
        Err(error) if error.code=="SPONSOR_CATALOG_UNAVAILABLE"=>Ok(json!({"sponsors":[]})),
        other=>other,
    }
}
pub(crate) fn sponsor_catalogue(state:&ServiceState)->Result<Value,ServiceError>{sponsor_catalogue_result(gateway_call(state,"/api/agent/sponsors",None))}

pub(crate) fn codex_generate(state: &ServiceState, generation_id: &str, conversation_id: &str, request: Value, on_event: impl FnMut(&str, &Value)) -> Result<Value, ServiceError> {
    codex_generate_sponsored(state,generation_id,conversation_id,request,None,on_event)
}
pub(crate) fn codex_generate_sponsored(state:&ServiceState,generation_id:&str,conversation_id:&str,request:Value,sponsor:Option<Value>,on_event:impl FnMut(&str,&Value))->Result<Value,ServiceError>{let mut body=json!({"generationId":generation_id,"conversationId":conversation_id,"request":request});if let Some(sponsor)=sponsor{body["sponsor"]=sponsor;}gateway_stream_body(state,"/api/agent/codex/generations/stream",body,on_event)}

fn gateway_stream_body(state: &ServiceState, path: &str, body: Value, mut on_event: impl FnMut(&str, &Value)) -> Result<Value, ServiceError> {
    let config = load_config(&state.config_path)?;
    let token = get_access_token(state, &config)?;
    let response = client(&config.gateway_origin)?
        .post(format!("{}{path}", config.gateway_origin))
        .timeout(Duration::from_secs(180))
        .bearer_auth(token)
        .json(&body)
        .send()
        .map_err(|_| error("GATEWAY_UNAVAILABLE", "GeoD Agent 模型服务暂时不可达"))?;
    let status = response.status();
    let streaming = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    if !streaming {
        if status == reqwest::StatusCode::NOT_FOUND && path == "/api/agent/generations/stream" {
            return gateway_call(state, "/api/agent/generations", Some(body));
        }
        let value: Value = response.json().map_err(|_| error("GATEWAY_RESPONSE", "模型服务响应无效"))?;
        if !status.is_success() {
            return Err(gateway_response_error(status, path, &value));
        }
        return Ok(value);
    }
    if !status.is_success() { return Err(error("GATEWAY_ERROR", "模型流式请求失败")); }
    let mut reader = BufReader::new(response);
    let mut line = String::new();
    let mut event = String::new();
    let mut data = String::new();
    let mut result = None;
    loop {
        line.clear();
        let count = reader.read_line(&mut line).map_err(|_| error("GATEWAY_RESPONSE", "模型流式响应中断，可检查请求状态"))?;
        if count == 0 { break; }
        if line == "\n" || line == "\r\n" {
            if !event.is_empty() && !data.is_empty() {
                let value: Value = serde_json::from_str(data.trim_end()).map_err(|_| error("GATEWAY_RESPONSE", "模型流式事件无效"))?;
                if event == "generation" { result = Some(value.clone()); }
                if event == "error" { return Err(error("GATEWAY_ERROR", value["error"].as_str().unwrap_or("模型流式请求失败，可检查请求状态"))); }
                on_event(&event, &value);
            }
            event.clear(); data.clear();
        } else if let Some(value) = line.strip_prefix("event: ") {
            event = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("data: ") {
            if data.len() + value.len() > 4_000_000 { return Err(error("GATEWAY_RESPONSE", "模型流式事件过大")); }
            data.push_str(value);
        }
    }
    result.ok_or_else(|| error("GATEWAY_RESPONSE", "模型流式响应未完成，可检查请求状态"))
}

#[cfg(test)]
pub(crate) fn creator_test_generation(state: &ServiceState, conversation_id: &str, messages: Value) -> Result<Value, ServiceError> {
    gateway_call(state, "/api/agent/generations", Some(json!({
        "generationId": Uuid::new_v4().to_string(), "conversationId": conversation_id, "messages": messages
    })))
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
pub async fn agent_generate_stream(
    state: State<'_, ServiceState>,
    generation_id: String,
    conversation_id: String,
    messages: Value,
    events: Channel<Value>,
) -> Result<Value, ServiceError> {
    let state = Arc::new(ServiceState {
        config_path: state.config_path.clone(),
        flow: Arc::clone(&state.flow),
        credential_lock: Arc::clone(&state.credential_lock),
    });
    tauri::async_runtime::spawn_blocking(move || gateway_stream_call(&state, generation_id, conversation_id, messages, events))
        .await.map_err(|_| error("GATEWAY_ERROR", "模型流式请求线程中断"))?
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
pub async fn agent_payment_snapshot(state: State<'_, ServiceState>) -> Result<Value, ServiceError> {
    let state=state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||{
        let status=match gateway_call(&state,"/v1/payments/status",None){
            Ok(value)=>value,
            Err(cause) if cause.code=="PAYMENT_UNAVAILABLE"=>{
                let usage=gateway_call(&state,"/api/agent/usage",None)?;
                return Ok(json!({"status":{"candidate":true,"available":false,"checkoutEnabled":false,"environment":"disabled","fixture":false,
                    "billingMode":if usage.get("quotaEnforced")==Some(&Value::Bool(false)){"unlimited-test"}else{"token-quota"},"products":[]},"wallet":null}));
            },
            Err(cause)=>return Err(cause),
        };
        let wallet=gateway_call(&state,"/v1/payments/wallet",None)?;
        Ok(json!({"status":status,"wallet":wallet}))
    }).await.map_err(|_|error("PAYMENT_ERROR","支付查询线程中断"))?
}

#[tauri::command]
pub async fn agent_messages_list(app: AppHandle, state: State<'_, ServiceState>) -> Result<Value, ServiceError> {
    let state=state.inner().clone();
    let version=app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move||gateway_call(&state,&format!("/api/agent/messages?clientVersion={version}"),None))
        .await.map_err(|_|error("MESSAGES_UNAVAILABLE","消息服务暂不可用，请稍后重试。"))?
}

#[tauri::command]
pub fn agent_message_open_link(app: AppHandle, url: String) -> Result<(), ServiceError> {
    let parsed=Url::parse(&url).map_err(|_|error("MESSAGES_LINK","消息链接不可用。"))?;
    if parsed.scheme()!="https" || !parsed.username().is_empty() || parsed.password().is_some() || url.len()>2000 {
        return Err(error("MESSAGES_LINK","消息链接不可用。"));
    }
    app.opener().open_url(parsed.as_str(),None::<&str>).map_err(|_|error("MESSAGES_LINK","消息链接不可用。"))
}

#[tauri::command]
pub async fn agent_messages_read(app: AppHandle, state: State<'_, ServiceState>, account_id: String, message_ids: Vec<String>) -> Result<Value, ServiceError> {
    if message_ids.is_empty() || message_ids.len()>100 || message_ids.iter().any(|id|id.len()>100||id.is_empty()||!id.bytes().all(|byte|byte.is_ascii_alphanumeric()||byte==b'_'||byte==b'-')) {
        return Err(error("MESSAGES_INVALID","消息标识不可读。"));
    }
    let state=state.inner().clone();
    let version=app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move||gateway_call(&state,"/api/agent/messages/read",Some(json!({"accountId":account_id,"clientVersion":version,"messageIds":message_ids}))))
        .await.map_err(|_|error("MESSAGES_UNAVAILABLE","消息服务暂不可用，请稍后重试。"))?
}
fn payment_order_id(value:&str)->bool{value.len()==35&&value.starts_with("GDA")&&value[3..].bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c))}
fn payment_checkout_url(value:&Value,gateway_origin:&str)->Result<Url,ServiceError>{
    let url=Url::parse(value.get("checkoutUrl").and_then(Value::as_str).unwrap_or(""))
        .map_err(|_|error("PAYMENT_CHECKOUT_INVALID","收银台地址无效"))?;
    let environment=value.get("order").and_then(|order|order.get("environment")).and_then(Value::as_str);
    let valid=url.username().is_empty()&&url.password().is_none()&&url.fragment().is_none()&&url.path()=="/gateway.do"&&
        match environment{
            Some("production")=>url.scheme()=="https"&&url.host_str()==Some("openapi.alipay.com")&&url.port_or_known_default()==Some(443),
            Some("sandbox")=>url.scheme()=="https"&&url.host_str()==Some("openapi-sandbox.dl.alipaydev.com")&&url.port_or_known_default()==Some(443),
            Some("fixture")=>cfg!(debug_assertions)&&value.get("fixture")==Some(&Value::Bool(true))&&
                Url::parse(gateway_origin).is_ok_and(|origin|origin.scheme()=="http"&&origin.host_str()==Some("127.0.0.1"))&&
                url.scheme()=="http"&&url.host_str()==Some("127.0.0.1"),
            _=>false,
        };
    if valid{Ok(url)}else{Err(error("PAYMENT_CHECKOUT_INVALID","收银台地址与支付环境不匹配"))}
}
#[tauri::command]
pub async fn agent_payment_action(app:AppHandle,state:State<'_,ServiceState>,action:String,order_id:Option<String>,product_id:Option<String>,request_key:Option<String>)->Result<Value,ServiceError>{
    let state=state.inner().clone();
    tauri::async_runtime::spawn_blocking(move||{
        let (path,body)=if action=="create"{
            let product=product_id.filter(|value|!value.is_empty()&&value.len()<=160).ok_or_else(||error("PAYMENT_INPUT_INVALID","请选择支付方案"))?;
            let request=request_key.filter(|value|!value.is_empty()&&value.len()<=160).ok_or_else(||error("PAYMENT_INPUT_INVALID","缺少下单请求编号"))?;
            ("/v1/payments/orders".to_owned(),json!({"productId":product,"requestKey":request}))
        }else{
            if !["checkout","refresh","cancel","refund"].contains(&action.as_str()){return Err(error("PAYMENT_INPUT_INVALID","支付操作无效"));}
            let id=order_id.filter(|value|payment_order_id(value)).ok_or_else(||error("PAYMENT_INPUT_INVALID","订单编号无效"))?;
            (format!("/v1/payments/orders/{id}/{action}"),json!({}))
        };
        let result=gateway_call(&state,&path,Some(body))?;
        if action=="checkout"{
            let config=load_config(&state.config_path)?;
            let url=payment_checkout_url(&result,&config.gateway_origin)?;
            app.opener().open_url(url.as_str(),None::<&str>).map_err(|_|error("PAYMENT_BROWSER_FAILED","无法打开收银台，可从原订单继续支付"))?;
            return Ok(json!({"opened":true,"order":result.get("order"),"fixture":result.get("fixture")}));
        }
        Ok(result)
    }).await.map_err(|_|error("PAYMENT_ERROR","支付操作线程中断"))?
}
#[tauri::command]
pub async fn agent_events(state: State<'_, ServiceState>, account_id: String, events: Value) -> Result<Value, ServiceError> {
    let state = Arc::new(ServiceState {
        config_path: state.config_path.clone(),
        flow: Arc::clone(&state.flow),
        credential_lock: Arc::clone(&state.credential_lock),
    });
    tauri::async_runtime::spawn_blocking(move || gateway_call(&state, "/api/agent/events", Some(json!({
        "schema_version": 1, "accountId": account_id, "events": events
    })))).await.map_err(|_| error("GATEWAY_ERROR", "Telemetry transport interrupted"))?
}
#[tauri::command]
pub async fn agent_generation_get(
    app: tauri::AppHandle,
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
    let owner=current_user_id(&state)?;
    if let Some(value)=crate::ai_channels::generation_get(&app,&owner,&generation_id)?{return Ok(value);}
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

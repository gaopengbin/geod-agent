use super::{client, current_user_id, error, get_access_token, load_config, ServiceError, ServiceState};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{io::Read, time::Duration};
use tauri::State;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Avatar { Preset { id: String }, Upload { version: String } }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireProfile { account_id: String, email: String, nickname: Option<String>, avatar: Option<Avatar> }
#[derive(Deserialize)]
struct ProfileResponse { profile: WireProfile }
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfile { account_id: String, email: String, nickname: Option<String>, avatar: Option<Avatar>, avatar_data_url: Option<String> }

fn response_status(response: &reqwest::blocking::Response) -> Result<(), ServiceError> {
    if matches!(response.status().as_u16(), 401 | 403) { return Err(error("AUTH_REQUIRED", "请重新登录 GeoD")); }
    if !response.status().is_success() { return Err(error("PROFILE_UNAVAILABLE", "账号资料暂未同步，请稍后重试")); }
    Ok(())
}
fn read_profile(origin: &str, token: &str, account_id: &str) -> Result<AccountProfile, ServiceError> {
    let http = client(origin)?;
    let response = http.get(format!("{origin}/api/account/session")).bearer_auth(token)
        .timeout(Duration::from_secs(10)).send().map_err(|_| error("PROFILE_UNAVAILABLE", "账号资料暂未同步，请稍后重试"))?;
    response_status(&response)?;
    let mut bytes = Vec::new();
    response.take(16_385).read_to_end(&mut bytes).map_err(|_| error("PROFILE_RESPONSE", "账号资料响应无效"))?;
    if bytes.len() > 16_384 { return Err(error("PROFILE_RESPONSE", "账号资料响应无效")); }
    let profile: WireProfile = serde_json::from_slice::<ProfileResponse>(&bytes)
        .map_err(|_| error("PROFILE_RESPONSE", "账号资料响应无效"))?.profile;
    if profile.account_id != account_id { return Err(error("ACCOUNT_CHANGED", "账号已切换，请重试")); }
    if profile.email.len() > 254 || profile.email.chars().any(char::is_control) {
        return Err(error("PROFILE_RESPONSE", "账号资料响应无效"));
    }
    if profile.nickname.as_ref().is_some_and(|name| name.chars().count() > 40 || name.chars().any(char::is_control) || name.trim() != name || name.is_empty()) {
        return Err(error("PROFILE_RESPONSE", "账号昵称响应无效"));
    }
    let mut avatar_data_url = None;
    if let Some(Avatar::Upload { version }) = &profile.avatar {
        if uuid::Uuid::parse_str(version).is_err() { return Err(error("PROFILE_RESPONSE", "账号头像版本无效")); }
        let response = http.get(format!("{origin}/api/account/avatar")).query(&[("v", version)])
            .bearer_auth(token).timeout(Duration::from_secs(10)).send()
            .map_err(|_| error("PROFILE_UNAVAILABLE", "头像暂未同步，请稍后重试"))?;
        if response.status() != reqwest::StatusCode::NOT_FOUND {
            response_status(&response)?;
            if response.headers().get("content-type").and_then(|v| v.to_str().ok()).map(|v| v.split(';').next().unwrap_or("").trim()) != Some("image/webp") {
                return Err(error("PROFILE_RESPONSE", "账号头像响应无效"));
            }
            let mut image = Vec::new();
            response.take(524_289).read_to_end(&mut image).map_err(|_| error("PROFILE_RESPONSE", "账号头像响应无效"))?;
            if image.len() > 524_288 || !image.starts_with(b"RIFF") || image.get(8..12) != Some(b"WEBP") {
                return Err(error("PROFILE_RESPONSE", "账号头像响应无效"));
            }
            let (width, height) = image::ImageReader::with_format(std::io::Cursor::new(&image), image::ImageFormat::WebP)
                .into_dimensions().map_err(|_| error("PROFILE_RESPONSE", "账号头像响应无效"))?;
            if width == 0 || height == 0 || width > 512 || height > 512 { return Err(error("PROFILE_RESPONSE", "账号头像尺寸无效")); }
            avatar_data_url = Some(format!("data:image/webp;base64,{}", STANDARD.encode(image)));
        }
    } else if let Some(Avatar::Preset { id }) = &profile.avatar {
        if !["summit", "orbit", "globe", "coast", "terrain", "compass"].contains(&id.as_str()) {
            return Err(error("PROFILE_RESPONSE", "账号头像预设无效"));
        }
    }
    Ok(AccountProfile { account_id: profile.account_id, email: profile.email, nickname: profile.nickname, avatar: profile.avatar, avatar_data_url })
}

pub async fn account_profile(state: State<'_, ServiceState>, account_id: String) -> Result<AccountProfile, ServiceError> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = load_config(&state.config_path)?;
        let token = get_access_token(&state, &config)?;
        if current_user_id(&state)? != account_id { return Err(error("ACCOUNT_CHANGED", "账号已切换，请重试")); }
        let profile = read_profile(&config.identity_origin, &token, &account_id)?;
        if current_user_id(&state)? != account_id { return Err(error("ACCOUNT_CHANGED", "账号已切换，请重试")); }
        Ok(profile)
    }).await.map_err(|_| error("PROFILE_UNAVAILABLE", "账号资料同步中断，请重试"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, net::TcpListener, thread};
    fn fixture(responses: Vec<(u16, &'static str, Vec<u8>)>) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            for (index, (status, content_type, body)) in responses.into_iter().enumerate() {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0_u8; 4096];
                let count = stream.read(&mut request).unwrap();
                let headers = String::from_utf8_lossy(&request[..count]).to_lowercase();
                assert!(headers.starts_with(if index == 0 { "get /api/account/session " } else { "get /api/account/avatar?v=" }));
                assert!(headers.contains("authorization: bearer test-only-profile-token\r\n"));
                assert!(!headers.contains("cookie:"));
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
                let _ = stream.write_all(&body);
            }
        });
        (origin, server)
    }
    fn profile(avatar: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "profile": { "accountId": "profile-owner", "email": "profile@example.test", "avatar": avatar } })).unwrap()
    }
    #[test]
    fn account_profile_preset_and_upload_use_bearer_without_browser_cookie() {
        let (origin, server) = fixture(vec![(200, "application/json", profile(serde_json::json!({"kind":"preset", "id":"coast"})))]);
        let result = read_profile(&origin, "test-only-profile-token", "profile-owner").unwrap();
        assert!(result.avatar_data_url.is_none()); server.join().unwrap();
        let mut bytes = Vec::new();
        image::codecs::webp::WebPEncoder::new_lossless(&mut bytes).encode(&[0_u8; 30 * 30 * 4], 30, 30, image::ExtendedColorType::Rgba8).unwrap();
        let (origin, server) = fixture(vec![(200, "application/json", profile(serde_json::json!({"kind":"upload", "version":"c0b137d7-d6ce-4c64-a45c-f6743e7b0609"}))), (200, "image/webp", bytes)]);
        let result = read_profile(&origin, "test-only-profile-token", "profile-owner").unwrap();
        assert!(result.avatar_data_url.unwrap().starts_with("data:image/webp;base64,")); server.join().unwrap();
    }
    #[test]
    fn account_profile_nickname_is_optional_bounded_and_preserves_unicode() {
        for (nickname, valid) in [(serde_json::Value::Null, true), (serde_json::json!("老高 🌍"), true), (serde_json::json!("🌍".repeat(40)), true), (serde_json::json!("a".repeat(41)), false), (serde_json::json!("a\nb"), false), (serde_json::json!(" padded "), false)] {
            let body = serde_json::to_vec(&serde_json::json!({"profile":{"accountId":"profile-owner","email":"profile@example.test","nickname":nickname,"avatar":null}})).unwrap();
            let (origin, server) = fixture(vec![(200, "application/json", body)]);
            let result = read_profile(&origin, "test-only-profile-token", "profile-owner");
            assert_eq!(result.is_ok(), valid);
            if valid { assert_eq!(serde_json::to_value(result.unwrap()).unwrap()["nickname"], nickname); }
            server.join().unwrap();
        }
    }
    #[test]
    fn account_profile_rejects_another_owner_legacy_response_and_unauthorized_access() {
        for (status, body, account, code) in [
            (200, profile(serde_json::Value::Null), "another-owner", "ACCOUNT_CHANGED"),
            (200, br#"{"user":null}"#.to_vec(), "profile-owner", "PROFILE_RESPONSE"),
            (401, b"unauthorized".to_vec(), "profile-owner", "AUTH_REQUIRED"),
            (302, Vec::new(), "profile-owner", "PROFILE_UNAVAILABLE"),
            (200, vec![b' '; 16_385], "profile-owner", "PROFILE_RESPONSE"),
        ] {
            let (origin, server) = fixture(vec![(status, "application/json", body)]);
            assert_eq!(read_profile(&origin, "test-only-profile-token", account).unwrap_err().code, code);
            server.join().unwrap();
        }
    }
    #[test]
    fn account_profile_avatar_payloads_are_bounded_and_missing_upload_has_fallback() {
        for (status, content_type, bytes, expected) in [
            (200, "text/html", b"html".to_vec(), Some("PROFILE_RESPONSE")),
            (200, "image/webp", b"invalid".to_vec(), Some("PROFILE_RESPONSE")),
            (200, "image/webp", vec![0_u8; 524_289], Some("PROFILE_RESPONSE")),
            (404, "text/html", b"missing".to_vec(), None),
        ] {
            let (origin, server) = fixture(vec![(200, "application/json", profile(serde_json::json!({"kind":"upload", "version":"c0b137d7-d6ce-4c64-a45c-f6743e7b0609"}))), (status, content_type, bytes)]);
            let result = read_profile(&origin, "test-only-profile-token", "profile-owner");
            match expected { Some(code) => assert_eq!(result.unwrap_err().code, code), None => assert!(result.unwrap().avatar_data_url.is_none()) }
            server.join().unwrap();
        }
    }
}

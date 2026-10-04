use reqwest::{ClientBuilder, Proxy, Url};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::OnceLock};

static SETTINGS_FILE: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProxyMode {
    #[default]
    Auto,
    Manual,
    Direct,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSettings {
    pub mode: ProxyMode,
    pub manual_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    pub settings: NetworkSettings,
    pub effective_proxy: Option<String>,
    pub source: &'static str,
}

pub fn initialize(path: PathBuf) {
    let _ = SETTINGS_FILE.set(path);
}

pub fn read() -> Result<NetworkSettings, String> {
    let Some(path) = SETTINGS_FILE.get() else {
        return Ok(NetworkSettings::default());
    };
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "网络设置文件损坏".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(NetworkSettings::default())
        }
        Err(error) => Err(format!("读取网络设置失败：{error}")),
    }
}

pub fn save(mut settings: NetworkSettings) -> Result<NetworkStatus, String> {
    settings.manual_url = settings
        .manual_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(validate_proxy_url)
        .transpose()?;
    if settings.mode == ProxyMode::Manual && settings.manual_url.is_none() {
        return Err("请填写 HTTP 代理地址，例如 http://127.0.0.1:10808".into());
    }
    let status = status_for(settings.clone())?;
    let path = SETTINGS_FILE.get().ok_or("网络设置尚未初始化")?;
    fs::write(
        path,
        serde_json::to_vec(&settings).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("保存网络设置失败：{error}"))?;
    Ok(status)
}

pub fn status() -> Result<NetworkStatus, String> {
    status_for(read()?)
}

pub fn status_for(settings: NetworkSettings) -> Result<NetworkStatus, String> {
    let (effective_proxy, source) = resolve(&settings, "https://tigerweb.geo.census.gov/")?;
    Ok(NetworkStatus {
        settings,
        effective_proxy,
        source,
    })
}

pub fn proxy_for(origin: &str) -> Result<Option<String>, String> {
    resolve(&read()?, origin).map(|(proxy, _)| proxy)
}

pub fn resolve(
    settings: &NetworkSettings,
    origin: &str,
) -> Result<(Option<String>, &'static str), String> {
    let target = Url::parse(origin).map_err(|_| "网络请求地址无效")?;
    if matches!(target.host_str(), Some("localhost" | "127.0.0.1" | "::1")) {
        return Ok((None, "本机直连"));
    }
    match settings.mode {
        ProxyMode::Direct => Ok((None, "直连")),
        ProxyMode::Manual => Ok((
            Some(validate_proxy_url(
                settings.manual_url.as_deref().ok_or("请填写代理地址")?,
            )?),
            "手动代理",
        )),
        ProxyMode::Auto => {
            if let Some(proxy) = windows_system_proxy() {
                return Ok((Some(proxy), "Windows 系统代理"));
            }
            for key in [
                "HTTPS_PROXY",
                "https_proxy",
                "ALL_PROXY",
                "all_proxy",
                "HTTP_PROXY",
                "http_proxy",
            ] {
                if let Ok(value) = std::env::var(key) {
                    if let Ok(proxy) = validate_proxy_url(&value) {
                        return Ok((Some(proxy), "环境变量代理"));
                    }
                }
            }
            Ok((None, "未检测到代理，直连"))
        }
    }
}

pub fn apply(builder: ClientBuilder, proxy_url: Option<&str>) -> Result<ClientBuilder, String> {
    let builder = builder.no_proxy();
    match proxy_url {
        Some(url) => Ok(builder.proxy(Proxy::all(url).map_err(|_| "代理地址不可用")?)),
        None => Ok(builder),
    }
}

pub fn apply_blocking(
    builder: reqwest::blocking::ClientBuilder,
    proxy_url: Option<&str>,
) -> Result<reqwest::blocking::ClientBuilder, String> {
    let builder = builder.no_proxy();
    match proxy_url {
        Some(url) => Ok(builder.proxy(Proxy::all(url).map_err(|_| "代理地址不可用")?)),
        None => Ok(builder),
    }
}

fn validate_proxy_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    let value = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = Url::parse(&value).map_err(|_| "代理地址无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("请填写不含账号、密码和路径的 HTTP 代理地址（含端口）".into());
    }
    Ok(format!(
        "{}://{}:{}",
        url.scheme(),
        url.host_str().unwrap(),
        url.port().unwrap()
    ))
}

#[cfg(windows)]
fn windows_system_proxy() -> Option<String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let settings = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    if settings.get_value::<u32, _>("ProxyEnable").ok()? == 0 {
        return None;
    }
    let configured: String = settings.get_value("ProxyServer").ok()?;
    configured
        .split(';')
        .find_map(|entry| entry.strip_prefix("https="))
        .or_else(|| configured.split(';').find(|entry| !entry.contains('=')))
        .and_then(|server| validate_proxy_url(server).ok())
}

#[cfg(not(windows))]
fn windows_system_proxy() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_proxy_is_a_plain_origin_and_loopback_stays_local() {
        let manual = NetworkSettings {
            mode: ProxyMode::Manual,
            manual_url: Some("127.0.0.1:10808".into()),
        };
        assert_eq!(
            resolve(&manual, "https://example.com")
                .unwrap()
                .0
                .as_deref(),
            Some("http://127.0.0.1:10808")
        );
        assert_eq!(
            resolve(&manual, "https://tiles.example.com/{z}/{x}/{y}.png")
                .unwrap()
                .0
                .as_deref(),
            Some("http://127.0.0.1:10808")
        );
        assert_eq!(resolve(&manual, "http://127.0.0.1:9115").unwrap().0, None);
        assert!(validate_proxy_url("http://user:password@127.0.0.1:10808").is_err());
        assert!(validate_proxy_url("http://127.0.0.1:10808/path").is_err());
    }

    #[test]
    fn direct_mode_ignores_system_and_environment_proxy() {
        let direct = NetworkSettings {
            mode: ProxyMode::Direct,
            manual_url: None,
        };
        assert_eq!(resolve(&direct, "https://example.com").unwrap().0, None);
    }
}

//! User supplied MCP process and HTTP credentials never enter tool metadata.
use crate::AppError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Secret {
    pub headers: BTreeMap<String, String>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Metadata {
    pub owner: String,
    pub command: Option<String>,
    pub header_names: Vec<String>,
    pub env_names: Vec<String>,
    pub argument_count: usize,
    #[serde(default)]
    pub oauth: bool,
    #[serde(default)]
    pub runtime: crate::mcp_runtime_config::Settings,
}

fn error(code: &'static str, message: &str) -> AppError {
    AppError { code, message: message.into() }
}
fn entry(path: &Path, id: &str) -> Result<keyring::Entry, AppError> {
    keyring::Entry::new("GeoD-private-MCP", &format!("{:x}:{id}", Sha256::digest(path.to_string_lossy().as_bytes())))
        .map_err(|_| error("MCP_CREDENTIAL_FAILED", "无法访问 MCP 本机凭据"))
}
pub(crate) fn save(path: &Path, id: &str, secret: &Secret) -> Result<(), AppError> {
    let bytes = serde_json::to_string(secret).map_err(|_| error("MCP_CONFIG_INVALID", "MCP 配置无效"))?;
    if bytes.len() > 48 * 1024 { return Err(error("MCP_CONFIG_INVALID", "MCP 参数与凭据合计不能超过 48 KiB")); }
    entry(path,id)?.set_password(&bytes).map_err(|_| error("MCP_CREDENTIAL_FAILED", "无法保存 MCP 本机凭据"))
}
pub(crate) fn load(path: &Path, id: &str) -> Result<Secret, AppError> {
    let value = entry(path,id)?.get_password().map_err(|_| error("MCP_CREDENTIAL_FAILED", "MCP 凭据缺失，请重新添加连接器"))?;
    serde_json::from_str(&value).map_err(|_| error("MCP_CREDENTIAL_FAILED", "MCP 凭据不可读，请重新添加连接器"))
}
pub(crate) fn remove(path: &Path, id: &str) -> Result<(), AppError> {
    match entry(path,id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(error("MCP_CREDENTIAL_FAILED", "无法删除 MCP 本机凭据")),
    }
}
pub(crate) fn headers(secret: &Secret) -> Result<reqwest_mcp::header::HeaderMap, AppError> {
    use reqwest_mcp::header::{HeaderMap, HeaderName, HeaderValue};
    if secret.headers.len() > 20 || secret.headers.iter().map(|(k,v)|k.len()+v.len()).sum::<usize>() > 16*1024 {
        return Err(error("MCP_CONFIG_INVALID", "请求头过多或过长"));
    }
    let mut result=HeaderMap::new();
    for (name,value) in &secret.headers {
        let name=HeaderName::from_bytes(name.as_bytes()).map_err(|_|error("MCP_CONFIG_INVALID","请求头名称无效"))?;
        if matches!(name.as_str(),"host"|"connection"|"content-length"|"transfer-encoding"|"upgrade"|"proxy-authorization"|"content-type"|"accept"|"mcp-session-id"|"mcp-protocol-version") {
            return Err(error("MCP_CONFIG_INVALID","此请求头由 MCP 协议管理"));
        }
        let mut value=HeaderValue::from_str(value).map_err(|_|error("MCP_CONFIG_INVALID","请求头内容无效"))?;
        value.set_sensitive(true);
        if result.insert(name,value).is_some() {return Err(error("MCP_CONFIG_INVALID","请求头名称不能重复"));}
    }
    Ok(result)
}
pub(crate) fn validate(command: Option<&str>, secret: &Secret) -> Result<(),AppError> {
    headers(secret)?;
    if let Some(command)=command {
        if command.trim().is_empty() || command.len()>4096 || command.contains(['\0','\n','\r']) {
            return Err(error("MCP_CONFIG_INVALID","请输入本机可执行程序，不要包含参数或换行"));
        }
        // Executable plus argument array: never interpret user input as shell text.
        if Path::new(command).extension().and_then(|v|v.to_str()).is_some_and(|v|matches!(v.to_ascii_lowercase().as_str(),"cmd"|"bat"|"ps1")) && !crate::mcp_process::package_manager_shim(command) {
            return Err(error("MCP_CONFIG_INVALID","请选择可执行程序；脚本请通过 node、python 等运行器及参数数组启动"));
        }
        if !secret.headers.is_empty() {return Err(error("MCP_CONFIG_INVALID","本机 MCP 使用环境变量认证，无需 HTTP 请求头"));}
    } else if !secret.args.is_empty() || !secret.env.is_empty() {return Err(error("MCP_CONFIG_INVALID","HTTP MCP 不使用本机参数或环境变量"));}
    if secret.args.len()>128 || secret.env.len()>50 || secret.args.iter().any(|v|v.len()>8192 || v.contains('\0')) {
        return Err(error("MCP_CONFIG_INVALID","本机 MCP 参数过多、过长或含无效字符"));
    }
    for (name,value) in &secret.env {
        if name.is_empty() || name.len()>256 || name.contains(['=','\0']) || value.contains('\0') {
            return Err(error("MCP_CONFIG_INVALID","环境变量名称或内容无效"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_headers_and_shell_scripts_are_not_configurable() {
        let mut secret=Secret::default();
        secret.headers.insert("Host".into(),"other-server".into());
        assert!(headers(&secret).is_err());
        secret.headers.clear();
        secret.headers.insert("X-Key".into(),"one\r\nAuthorization: two".into());
        assert!(headers(&secret).is_err());
        secret.headers.clear();
        assert!(validate(Some("server.cmd"),&secret).is_err());
        assert_eq!(validate(Some("npx.cmd"),&secret).is_ok(),cfg!(windows));
        secret.args=vec!["a file.js".into(),"$(a); & b".into()];
        assert!(validate(Some("node"),&secret).is_ok());
    }
}

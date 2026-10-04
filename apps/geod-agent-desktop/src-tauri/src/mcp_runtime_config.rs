//! Native-only MCP launch settings. Environment references never export their values.
use crate::{mcp_credentials::Secret, AppError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::{Path, PathBuf}, time::{Duration, Instant}};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Settings {
    pub cwd: Option<String>,
    pub env_vars: Vec<String>,
    pub env_http_headers: BTreeMap<String, String>,
    pub bearer_token_env_var: Option<String>,
    pub startup_timeout_sec: Option<f64>,
    pub tool_timeout_sec: Option<f64>,
    pub enabled_tools: Option<Vec<String>>,
    pub disabled_tools: Vec<String>,
}

fn invalid(message: &str) -> AppError { AppError { code: "MCP_CONFIG_INVALID", message: message.into() } }
fn duration(value: f64) -> Result<Duration, AppError> {
    let result=Duration::try_from_secs_f64(value).map_err(|_|invalid("MCP 超时须为正数秒"))?;
    if result.is_zero() || Instant::now().checked_add(result).is_none() {return Err(invalid("MCP 超时须为有效的正数秒"));}
    Ok(result)
}
fn env_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() || name.len()>256 || name.contains(['=', '\0', '\r', '\n']) || name.eq_ignore_ascii_case("GEOD_CODEX_BRIDGE_TOKEN") {
        return Err(invalid("MCP 环境变量引用名称无效"));
    }
    Ok(())
}
impl Settings {
    pub(crate) fn from_plugin(config: &Value, stdio: bool) -> Result<Self, AppError> {
        let mut mapped=serde_json::Map::new();
        for (source,target) in [("cwd","cwd"),("env_http_headers","envHttpHeaders"),("bearer_token_env_var","bearerTokenEnvVar"),("startup_timeout_sec","startupTimeoutSec"),("tool_timeout_sec","toolTimeoutSec"),("enabled_tools","enabledTools"),("disabled_tools","disabledTools")] {
            if let Some(value)=config.get(source).filter(|value|!value.is_null()) {mapped.insert(target.into(),value.clone());}
        }
        if !mapped.contains_key("startupTimeoutSec") {
            if let Some(value)=config.get("startup_timeout_ms").filter(|value|!value.is_null()) {
                let ms=value.as_u64().ok_or_else(||invalid("MCP startup_timeout_ms 须为正整数"))?;
                mapped.insert("startupTimeoutSec".into(),Value::from(ms as f64/1000.));
            }
        }
        if let Some(value)=config.get("env_vars").filter(|value|!value.is_null()) {
            let entries=value.as_array().ok_or_else(||invalid("MCP env_vars 须为数组"))?;
            let mut names=Vec::new();
            for entry in entries {
                let name=if let Some(name)=entry.as_str(){name}else{
                    let object=entry.as_object().ok_or_else(||invalid("MCP env_vars 须包含名称或本机来源对象"))?;
                    if object.keys().any(|key|!matches!(key.as_str(),"name"|"source")) {return Err(invalid("MCP 环境变量引用含未知字段"));}
                    if let Some(source)=object.get("source") {
                        if !source.is_null() && source.as_str()!=Some("local") {return Err(AppError{code:"PLUGIN_COMPONENT_UNSUPPORTED",message:"此桌面应用仅支持本机环境变量来源".into()});}
                    }
                    object.get("name").and_then(Value::as_str).ok_or_else(||invalid("MCP 环境变量引用缺少名称"))?
                };
                if !names.iter().any(|old|old==name) {names.push(name.to_owned());}
            }
            mapped.insert("envVars".into(),serde_json::to_value(names).unwrap());
        }
        let settings:Self=serde_json::from_value(Value::Object(mapped)).map_err(|_|invalid("MCP 运行配置类型无效"))?;
        settings.validate(stdio)?;
        Ok(settings)
    }
    pub(crate) fn validate(&self, stdio: bool) -> Result<(), AppError> {
        if let Some(cwd)=&self.cwd {
            if cwd.trim().is_empty() || cwd.len()>4096 || cwd.contains(['\0','\r','\n']) {return Err(invalid("MCP 工作目录无效"));}
        }
        if self.env_vars.len()>50 || self.env_http_headers.len()>20 {return Err(invalid("MCP 环境变量引用过多"));}
        for name in self.env_vars.iter().chain(self.env_http_headers.values()).chain(self.bearer_token_env_var.iter()) {env_name(name)?;}
        // Validate names and protocol-owned headers before resolving any secret values.
        crate::mcp_credentials::headers(&Secret{headers:self.env_http_headers.keys().map(|key|(key.clone(),"validation".into())).collect(),..Secret::default()})?;
        if stdio && (!self.env_http_headers.is_empty() || self.bearer_token_env_var.is_some()) {return Err(invalid("本机 MCP 不使用 HTTP 认证变量"));}
        if !stdio && (self.cwd.is_some() || !self.env_vars.is_empty()) {return Err(invalid("HTTP MCP 不使用工作目录或本机环境变量列表"));}
        for seconds in self.startup_timeout_sec.iter().chain(self.tool_timeout_sec.iter()) {duration(*seconds)?;}
        for tools in self.enabled_tools.iter().chain(std::iter::once(&self.disabled_tools)) {
            if tools.len()>1000 || tools.iter().any(|name|name.is_empty()||name.len()>256||name.contains(['\0','\r','\n'])) {return Err(invalid("MCP 工具筛选列表无效"));}
        }
        Ok(())
    }
    pub(crate) fn startup_timeout(&self, fallback: u64) -> Duration {
        self.startup_timeout_sec.and_then(|v|duration(v).ok()).unwrap_or_else(||Duration::from_secs(fallback))
    }
    pub(crate) fn discovery_timeout(&self, elapsed: Duration) -> Duration {
        self.startup_timeout_sec.and_then(|v|duration(v).ok()).map(|budget|budget.saturating_sub(elapsed)).unwrap_or_else(||Duration::from_secs(20))
    }
    pub(crate) fn tool_timeout(&self, interactive: bool) -> Duration {
        self.tool_timeout_sec.and_then(|v|duration(v).ok()).unwrap_or_else(||Duration::from_secs(if interactive{900}else{120}))
    }
    pub(crate) fn allows_tool(&self, name: &str) -> bool {
        self.enabled_tools.as_ref().is_none_or(|tools|tools.iter().any(|tool|tool==name)) && !self.disabled_tools.iter().any(|tool|tool==name)
    }
    pub(crate) fn directory(&self, workspace: &Path) -> Result<PathBuf, AppError> {
        let directory=self.cwd.as_ref().map_or_else(||workspace.to_path_buf(),|cwd|workspace.join(cwd));
        if !directory.is_dir() {return Err(AppError{code:"MCP_WORKDIR_MISSING",message:"MCP 工作目录不存在，请检查插件配置".into()});}
        Ok(directory)
    }
    pub(crate) fn apply_environment(&self, command: &mut tokio::process::Command, secret: &Secret) {
        command.env_clear();
        for name in ["PATH","SYSTEMROOT","WINDIR","TEMP","TMP","LOCALAPPDATA","APPDATA","USERPROFILE","HOMEDRIVE","HOMEPATH","PROGRAMFILES","PROGRAMFILES(X86)","PROGRAMDATA","PATHEXT"].iter().copied().chain(self.env_vars.iter().map(String::as_str)) {
            if let Some(value)=std::env::var_os(name) {command.env(name,value);}
        }
        command.envs(&secret.env);
    }
    pub(crate) fn headers(&self, secret: &Secret) -> Result<reqwest_mcp::header::HeaderMap, AppError> {
        let mut headers=secret.headers.clone();
        for (name,variable) in &self.env_http_headers {
            let value=std::env::var(variable).map_err(|_|AppError{code:"MCP_ENV_REQUIRED",message:format!("MCP 需要本机环境变量 {variable}，请配置后重新启动应用")})?;
            headers.retain(|key,_|!key.eq_ignore_ascii_case(name));headers.insert(name.clone(),value);
        }
        if let Some(variable)=&self.bearer_token_env_var {
            let value=std::env::var(variable).ok().filter(|v|!v.is_empty()).ok_or_else(||AppError{code:"MCP_ENV_REQUIRED",message:format!("MCP 需要本机环境变量 {variable}，请配置后重新启动应用")})?;
            headers.retain(|key,_|!key.eq_ignore_ascii_case("Authorization"));headers.insert("Authorization".into(),format!("Bearer {value}"));
        }
        crate::mcp_credentials::headers(&Secret{headers,..Secret::default()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn plugin_transport_settings_and_tool_policy_are_validated() {
        let config=json!({"cwd":"${PLUGIN_ROOT}/server","env_vars":["PATH",{"name":"TEMP","source":"local"},"PATH"],"startup_timeout_ms":350,"tool_timeout_sec":0.25,"enabled_tools":["read","hidden"],"disabled_tools":["hidden"]});
        let settings=Settings::from_plugin(&config,true).unwrap();
        assert_eq!(settings.env_vars,["PATH","TEMP"]);assert_eq!(settings.startup_timeout(60),Duration::from_millis(350));
        assert!(settings.allows_tool("read"));assert!(!settings.allows_tool("hidden"));assert!(!settings.allows_tool("write"));
        assert_eq!(settings.discovery_timeout(Duration::from_millis(200)),Duration::from_millis(150));
        assert_eq!(settings.discovery_timeout(Duration::from_secs(2)),Duration::ZERO);
        assert!(Settings::from_plugin(&config,false).is_err());
        assert_eq!(Settings::from_plugin(&json!({"env_vars":[{"name":"TOKEN","source":"remote"}]}),true).err().unwrap().code,"PLUGIN_COMPONENT_UNSUPPORTED");
        for config in [json!({"startup_timeout_sec":0}),json!({"tool_timeout_sec":-1}),json!({"env_http_headers":{"Host":"TOKEN"}}),json!({"bearer_token_env_var":"GEOD_CODEX_BRIDGE_TOKEN"})] {assert!(Settings::from_plugin(&config,false).is_err());}
        assert!(!Settings::from_plugin(&json!({"enabled_tools":[]}),false).unwrap().allows_tool("anything"));
        let omitted=Settings::from_plugin(&json!({"env_http_headers":null,"disabled_tools":null,"startup_timeout_ms":null}),false).unwrap();assert!(omitted.allows_tool("read"));
        assert_eq!(Settings::from_plugin(&json!({"env_vars":[{"name":"PATH","source":null}]}),true).unwrap().env_vars,["PATH"]);
    }
    #[test]
    fn old_metadata_defaults_and_named_environment_are_native_only() {
        let metadata:crate::mcp_credentials::Metadata=serde_json::from_value(json!({"owner":"alice","command":"node","headerNames":[],"envNames":[],"argumentCount":1})).unwrap();
        assert_eq!(metadata.runtime.tool_timeout(false),Duration::from_secs(120));
        let settings=Settings::from_plugin(&json!({"env_vars":["PATH"]}),true).unwrap();
        let mut command=tokio::process::Command::new("node");settings.apply_environment(&mut command,&Secret{env:BTreeMap::from([("TEMP".into(),"explicit override".into())]),..Secret::default()});
        let variables:Vec<_>=command.as_std().get_envs().collect();
        assert!(variables.iter().any(|(name,value)|*name=="PATH" && value.is_some()));
        assert!(variables.iter().any(|(name,value)|*name=="TEMP"&&*value==Some(std::ffi::OsStr::new("explicit override"))));
        assert!(!variables.iter().any(|(name,_)|*name=="GEOD_CODEX_BRIDGE_TOKEN"));
        let dir=tempfile::tempdir().unwrap();assert_eq!(settings.directory(dir.path()).unwrap(),dir.path());
        assert!(Settings{cwd:Some("missing".into()),..Settings::default()}.directory(dir.path()).is_err());
    }
}

use crate::{services, AppError, AppState, WorkspacePermission};
use rmcp::{
    model::CallToolRequestParams,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, State};
use uuid::Uuid;
pub(crate) mod plugin_package;
pub(crate) mod plugin_marketplace;
pub(crate) mod plugin_hooks;
pub(crate) mod plugin_apps;

pub(crate) struct ExtensionState {
    path: PathBuf,
    write_lock: Mutex<()>,
    runtime_root: Option<PathBuf>,
}

impl ExtensionState {
    #[cfg(test)]
    pub(crate) fn new(path: PathBuf) -> Self { Self::with_runtime(path,None) }

    pub(crate) fn with_runtime(path: PathBuf, runtime_root: Option<PathBuf>) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
            runtime_root,
        }
    }

    fn load(&self) -> Result<ExtensionStore, AppError> {
        let mut store = if self.path.exists() {
            let bytes = fs::read(&self.path)
                .map_err(|_| error("EXTENSIONS_READ_FAILED", "无法读取本机扩展设置"))?;
            serde_json::from_slice(&bytes)
                .map_err(|_| error("EXTENSIONS_INVALID", "本机扩展设置已损坏"))?
        } else { ExtensionStore::default() };
        let mut builtin = source_creator_skill()?;
        if let Some(saved) = store.skills.iter_mut().find(|item| item.id == builtin.id) {
            builtin.enabled = saved.enabled;
            *saved = builtin;
        } else { store.skills.push(builtin); }
        Ok(store)
    }

    pub(crate) fn source_creator_enabled(&self) -> Result<bool, AppError> {
        Ok(self.load()?.skills.iter().any(|item| item.id == SOURCE_CREATOR_ID && item.enabled))
    }

    pub(crate) fn oauth_target(&self,id:&str,owner:&str)->Result<(PathBuf,String),AppError>{
        let store=self.load()?;
        let connector=store.connectors.iter().find(|item|item.id==id).ok_or_else(||error("MCP_NOT_FOUND","未找到此 MCP 连接器"))?;
        if connector.transport!=ConnectorTransport::Http{return Err(error("MCP_AUTH_INVALID","浏览器授权用于在线 MCP 服务"));}
        if store.connector_settings.get(id).is_some_and(|settings|settings.owner!=owner){return Err(error("MCP_NOT_FOUND","未找到当前账号的 MCP 连接器"));}
        Ok((self.path.clone(),connector.url.clone()))
    }
    pub(crate) fn activate_oauth(&self,id:&str,owner:&str,enabled:bool)->Result<(),AppError>{
        self.oauth_target(id,owner)?;
        let previous=if self.load()?.connector_settings.contains_key(id){Some(crate::mcp_credentials::load(&self.path,id)?)}else{None};
        let mut secret=previous.clone().unwrap_or_default();
        secret.headers.retain(|name,_|!name.eq_ignore_ascii_case("authorization"));
        let result=self.update(|store|{
            if !store.connectors.iter().any(|item|item.id==id){return Err(error("MCP_NOT_FOUND","此连接器已移除"));}
            let settings=store.connector_settings.entry(id.into()).or_insert(crate::mcp_credentials::Metadata{owner:owner.into(),command:None,header_names:vec![],env_names:vec![],argument_count:0,oauth:false,runtime:Default::default()});
            if settings.owner!=owner{return Err(error("MCP_NOT_FOUND","未找到当前账号的 MCP 连接器"));}
            crate::mcp_credentials::save(&self.path,id,&secret)?;
            settings.oauth=enabled;settings.header_names=secret.headers.keys().cloned().collect();
            if enabled{settings.header_names.push("Authorization (OAuth)".into());}
            Ok(())
        });
        if let Err(cause)=result {
            if cause.code!="MCP_NOT_FOUND" {if let Some(previous)=previous {let _=crate::mcp_credentials::save(&self.path,id,&previous);}else{let _=crate::mcp_credentials::remove(&self.path,id);}}
            return Err(cause);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn codex_bundle(&self, home: &Path) -> Result<Value, AppError> {
        self.export_bundle(home, None)
    }
    pub(crate) fn codex_bundle_owned(&self, home: &Path, owner: &str) -> Result<Value, AppError> {
        self.export_bundle(home, Some(owner))
    }
    fn export_bundle(&self, home: &Path, owner: Option<&str>) -> Result<Value, AppError> {
        let store = visible_to(self.load()?, owner);
        let root = home.join("skills");
        fs::create_dir_all(&root).map_err(|_| error("SKILL_IMPORT_FAILED", "无法准备 Skill 运行目录"))?;
        // This account-specific directory only contains copies exported by GeoD.
        for entry in fs::read_dir(&root).map_err(|_| error("SKILL_IMPORT_FAILED", "无法读取 Skill 运行目录"))? {
            let entry = entry.map_err(|_| error("SKILL_IMPORT_FAILED", "无法读取 Skill 运行目录"))?;
            if !store.skills.iter().any(|skill| skill.enabled && entry.file_name() == skill.name.as_str()) {
                let metadata = fs::symlink_metadata(entry.path()).map_err(|_| error("SKILL_IMPORT_FAILED", "无法读取 Skill 运行目录"))?;
                if metadata.is_dir() && !metadata.file_type().is_symlink() { fs::remove_dir_all(entry.path()).map_err(|_| error("SKILL_IMPORT_FAILED", "无法停用 Skill"))?; }
            }
        }
        for skill in store.skills.iter().filter(|skill| skill.enabled) {
            let folder = root.join(&skill.name);
            if folder.exists() { fs::remove_dir_all(&folder).map_err(|_| error("SKILL_IMPORT_FAILED", "无法更新 Skill"))?; }
            fs::create_dir_all(&folder).map_err(|_| error("SKILL_IMPORT_FAILED", "无法准备 Skill"))?;
            fs::write(folder.join("SKILL.md"), plugin_package::runtime_skill_content(self,&store,skill)?).map_err(|_| error("SKILL_IMPORT_FAILED", "无法准备 Skill"))?;
            for (relative, bytes) in &skill.files {
                validate_bundle_path(relative)?;
                let destination = folder.join(relative);
                if let Some(parent) = destination.parent() { fs::create_dir_all(parent).map_err(|_| error("SKILL_IMPORT_FAILED", "无法准备 Skill 资源"))?; }
                fs::write(destination, bytes).map_err(|_| error("SKILL_IMPORT_FAILED", "无法准备 Skill 资源"))?;
            }
        }
        // Private services use GeoD's native dispatcher; Codex receives neither
        // headers nor process arguments/environment in its config or prompt.
        let servers: Vec<Value> = store.connectors.iter().filter(|item| item.enabled && item.transport == ConnectorTransport::Http && !store.connector_settings.contains_key(&item.id))
            .map(|item| serde_json::json!({"name":format!("geod_{}", item.id.replace('-', "_")),"url":item.url})).collect();
        Ok(serde_json::json!({"skillDirectories":[],"selectedSkills":[],"mcpServers":servers,"pluginHooks":plugin_hooks::export(self,&store)?}))
    }

    fn update(
        &self,
        change: impl FnOnce(&mut ExtensionStore) -> Result<(), AppError>,
    ) -> Result<ExtensionStore, AppError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| error("EXTENSIONS_LOCK_FAILED", "扩展设置暂时不可写"))?;
        let file_lock=fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(self.path.with_extension("lock"))
            .map_err(|_|error("EXTENSIONS_LOCK_FAILED","扩展设置暂时不可写"))?;
        fs2::FileExt::lock_exclusive(&file_lock).map_err(|_|error("EXTENSIONS_LOCK_FAILED","扩展设置暂时不可写"))?;
        let mut store = self.load()?;
        change(&mut store)?;
        let bytes = serde_json::to_vec_pretty(&store)
            .map_err(|_| error("EXTENSIONS_INVALID", "扩展设置无法保存"))?;
        let temporary=self.path.with_extension(format!("{}.tmp",Uuid::new_v4()));
        fs::write(&temporary,bytes).map_err(|_|error("EXTENSIONS_WRITE_FAILED","无法保存本机扩展设置"))?;
        if fs::rename(&temporary,&self.path).is_err(){let _=fs::remove_file(&temporary);return Err(error("EXTENSIONS_WRITE_FAILED","无法更新本机扩展设置"));}
        Ok(store)
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionStore {
    skills: Vec<Skill>,
    connectors: Vec<Connector>,
    #[serde(default)]
    mcp_calls: Vec<McpCallRecord>,
    #[serde(default)]
    connector_settings: BTreeMap<String, crate::mcp_credentials::Metadata>,
    #[serde(default)]
    skill_owners: BTreeMap<String, String>,
    #[serde(default)]
    plugins: Vec<plugin_package::Record>,
    #[serde(default)]
    plugin_marketplaces: Vec<plugin_marketplace::Record>,
}

fn visible_to(mut store: ExtensionStore, owner: Option<&str>) -> ExtensionStore {
    store.skills.retain(|s|store.skill_owners.get(&s.id).is_none_or(|o|Some(o.as_str())==owner));
    store.connectors.retain(|c|store.connector_settings.get(&c.id).is_none_or(|s|Some(s.owner.as_str())==owner));
    store.plugins.retain(|p|Some(p.owner.as_str())==owner);
    store.plugin_marketplaces.retain(|p|Some(p.owner.as_str())==owner);
    store
}
fn check_skill_owner(store: &ExtensionStore, id: &str, owner: &str) -> Result<(),AppError> {
    if store.skill_owners.get(id).is_some_and(|o|o!=owner) {return Err(error("SKILL_NOT_FOUND","未找到当前账号的 Skill"));}
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpCallRecord {
    execution_id: String,
    fingerprint: String,
    result: Option<Value>,
    #[serde(default)]
    owner: Option<String>,
}

const MCP_RESULT_PAGE_CHARS: usize = 7_000;
const MCP_RESULT_MAX_BYTES: usize = 512 * 1024;

fn mcp_result_page(value: &Value, execution_id: &str, offset: usize) -> Result<Value, AppError> {
    if value.get("truncated").and_then(Value::as_bool) == Some(true) {
        return Ok(serde_json::json!({
            "error": "MCP_LEGACY_RESULT_TRUNCATED",
            "message": "旧版客户端只保存了截断内容，请发起一次新的查询",
        }));
    }
    let serialized = serde_json::to_string(value)
        .map_err(|_| error("MCP_RESULT_INVALID", "MCP 结果无法序列化"))?;
    if serialized.len() > MCP_RESULT_MAX_BYTES {
        return Ok(serde_json::json!({
            "error": "MCP_RESULT_TOO_LARGE",
            "bytes": serialized.len(),
            "limitBytes": MCP_RESULT_MAX_BYTES,
        }));
    }
    let total = serialized.chars().count();
    if offset > total {
        return Err(error("INVALID_MCP_RESULT_OFFSET", "MCP 结果读取位置超出范围"));
    }
    if offset == 0 && total <= MCP_RESULT_PAGE_CHARS {
        return Ok(value.clone());
    }
    let content = serialized
        .chars()
        .skip(offset)
        .take(MCP_RESULT_PAGE_CHARS)
        .collect::<String>();
    let next = offset + content.chars().count();
    Ok(serde_json::json!({
        "paged": true,
        "executionId": execution_id,
        "offset": offset,
        "totalChars": total,
        "content": content,
        "nextOffset": (next < total).then_some(next),
        "complete": next == total,
    }))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Skill {
    id: String,
    name: String,
    description: String,
    content: String,
    enabled: bool,
    #[serde(default)]
    source_url: Option<String>,
    #[serde(default)]
    content_sha256: Option<String>,
    #[serde(default)]
    files: BTreeMap<String, Vec<u8>>,
}

pub(crate) const SOURCE_CREATOR_ID: &str = "builtin-source-creator";
fn source_creator_skill() -> Result<Skill, AppError> {
    let mut skill = parse_skill_document(include_str!("../../skills/geod-source-creator/SKILL.md").into(), Some("geod-source-creator"))?;
    skill.id = SOURCE_CREATOR_ID.into();
    skill.enabled = true;
    skill.content_sha256 = Some(format!("{:x}", Sha256::digest(skill.content.as_bytes())));
    Ok(skill)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connector {
    id: String,
    name: String,
    url: String,
    enabled: bool,
    #[serde(default)]
    transport: ConnectorTransport,
}

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ConnectorTransport {
    #[default]
    Http,
    GdalStdio,
    Stdio,
}

struct LocalWorkspace {
    directory: PathBuf,
    permission: WorkspacePermission,
}

const GDAL_TOOLS: &[&str] = &[
    "raster_info", "raster_stats", "raster_convert", "raster_reproject",
    "vector_info", "vector_convert", "vector_clip", "vector_buffer", "vector_simplify",
    "vector_reproject",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegistryItem {
    name: String,
    title: String,
    description: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillSummary {
    id: String,
    name: String,
    description: String,
    enabled: bool,
    source_url: Option<String>,
    content_sha256: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OnlineSkillCandidate {
    id: String,
    name: String,
    source: String,
    installs: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillSourceCandidate {
    id: String,
    name: String,
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSkillStage {
    id: String,
    name: String,
    description: String,
    source_url: String,
    content_sha256: String,
    enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceSkillCandidate {
    name: String,
    description: String,
    relative_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExtensionOverview {
    skills: Vec<SkillSummary>,
    connectors: Vec<Value>,
    registered_apps: Vec<Value>,
}

fn overview(store: ExtensionStore) -> ExtensionOverview {
    ExtensionOverview {
        registered_apps: plugin_apps::overview(&store),
        skills: store
            .skills
            .into_iter()
            .map(|skill| SkillSummary {
                id: skill.id,
                name: skill.name,
                description: skill.description,
                enabled: skill.enabled,
                source_url: skill.source_url,
                content_sha256: skill.content_sha256,
            })
            .collect(),
        connectors: store.connectors.into_iter().map(|connector| {
            let mut value=serde_json::to_value(&connector).unwrap_or_default();
            if let Some(settings)=store.connector_settings.get(&connector.id) {
                value["command"]=serde_json::json!(settings.command);
                value["headerNames"]=serde_json::json!(settings.header_names);
                value["envNames"]=serde_json::json!(settings.env_names);
                value["argumentCount"]=serde_json::json!(settings.argument_count);
                value["private"]=Value::Bool(true);
                value["oauth"]=Value::Bool(settings.oauth);
                value["runtime"]=serde_json::json!(settings.runtime);
            }
            value
        }).collect(),
    }
}
fn scoped_overview(store:ExtensionStore,owner:Option<&str>)->ExtensionOverview {overview(visible_to(store,owner))}

fn error(code: &'static str, message: &str) -> AppError {
    AppError {
        code,
        message: message.to_owned(),
    }
}

fn parse_skill(path: &str) -> Result<Skill, AppError> {
    let selected = PathBuf::from(path);
    let file = if selected.is_dir() {
        selected.join("SKILL.md")
    } else {
        selected
    };
    if file.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
        return Err(error(
            "INVALID_SKILL",
            "请选择 Skill 文件夹或其中的 SKILL.md",
        ));
    }
    if fs::metadata(&file)
        .map_err(|_| error("INVALID_SKILL", "无法读取 SKILL.md"))?
        .len()
        > 64 * 1024
    {
        return Err(error("INVALID_SKILL", "SKILL.md 不能超过 64 KiB"));
    }
    let bytes = fs::read(&file).map_err(|_| error("INVALID_SKILL", "无法读取 SKILL.md"))?;
    let content =
        String::from_utf8(bytes).map_err(|_| error("INVALID_SKILL", "SKILL.md 必须采用 UTF-8"))?;
    let folder = file
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str());
    let mut skill = parse_skill_document(content, folder)?;
    collect_skill_files(file.parent().ok_or_else(|| error("INVALID_SKILL", "Skill 路径无效"))?, &mut skill.files)?;
    Ok(skill)
}

fn validate_bundle_path(path: &str) -> Result<(), AppError> {
    if path.is_empty() || path.contains('\\') || path.contains(':') || path.len() > 400 || Path::new(path).components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(error("INVALID_SKILL", "Skill 资源路径无效"));
    }
    Ok(())
}

fn collect_skill_files(root: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> Result<(), AppError> {
    let mut pending = vec![root.to_path_buf()]; let mut total = 0;
    while let Some(folder) = pending.pop() {
        for entry in fs::read_dir(folder).map_err(|_| error("INVALID_SKILL", "无法读取 Skill 资源"))? {
            let entry = entry.map_err(|_| error("INVALID_SKILL", "无法读取 Skill 资源"))?;
            if matches!(entry.file_name().to_str(), Some(".git" | "node_modules" | "__pycache__")) { continue; }
            let meta = fs::symlink_metadata(entry.path()).map_err(|_| error("INVALID_SKILL", "无法读取 Skill 资源"))?;
            if meta.file_type().is_symlink() { return Err(error("INVALID_SKILL", "Skill 资源不能包含符号链接")); }
            if meta.is_dir() { pending.push(entry.path()); continue; }
            let relative = entry.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            validate_bundle_path(&relative)?;
            if relative == "SKILL.md" { continue; }
            if files.len() >= 256 || meta.len() > 4 * 1024 * 1024 || total + meta.len() > 16 * 1024 * 1024 { return Err(error("SKILL_TOO_LARGE", "Skill 资源超过 256 个文件或 16 MiB")); }
            total += meta.len(); files.insert(relative, fs::read(entry.path()).map_err(|_| error("INVALID_SKILL", "无法读取 Skill 资源"))?);
        }
    }
    Ok(())
}

fn parse_skill_document(content: String, expected_folder: Option<&str>) -> Result<Skill, AppError> {
    if content.len() > 64 * 1024 {
        return Err(error("INVALID_SKILL", "SKILL.md 不能超过 64 KiB"));
    }
    let rest = content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
        .ok_or_else(|| error("INVALID_SKILL", "SKILL.md 缺少 YAML 元信息"))?;
    let (frontmatter, body) = rest
        .split_once("\n---")
        .ok_or_else(|| error("INVALID_SKILL", "SKILL.md 缺少元信息结束标记"))?;
    let meta: serde_yaml::Value = serde_yaml::from_str(frontmatter)
        .map_err(|_| error("INVALID_SKILL", "SKILL.md 元信息格式无效"))?;
    let name = meta
        .get("name")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let description = meta
        .get("description")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let valid_name = name.len() <= 64
        && !name.is_empty()
        && !name.starts_with('-')
        && !name.ends_with('-')
        && !name.contains("--")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    let folder_matches = expected_folder.is_none_or(|folder| folder == name);
    if !valid_name
        || !folder_matches
        || description.is_empty()
        || description.len() > 1024
        || body.trim().is_empty()
    {
        return Err(error(
            "INVALID_SKILL",
            "Skill 的名称、描述或正文不符合 Agent Skills 格式",
        ));
    }
    Ok(Skill {
        id: Uuid::new_v4().to_string(),
        name: name.to_owned(),
        description: description.to_owned(),
        content,
        enabled: false,
        source_url: None,
        content_sha256: None,
        files: BTreeMap::new(),
    })
}

pub(crate) fn workspace_skills(root: &Path) -> Result<Vec<WorkspaceSkillCandidate>, AppError> {
    let root =
        fs::canonicalize(root).map_err(|_| error("WORKSPACE_READ_FAILED", "无法读取当前工作区"))?;
    let mut pending = vec![(root.clone(), 0usize)];
    let mut candidates = Vec::new();
    let mut scanned = 0usize;
    while let Some((folder, depth)) = pending.pop() {
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(_) if depth > 0 => continue,
            Err(_) => return Err(error("WORKSPACE_READ_FAILED", "无法读取当前工作区")),
        };
        for entry in entries.flatten() {
            scanned += 1;
            if scanned > 1000 || candidates.len() >= 30 {
                break;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if !fs::canonicalize(entry.path()).is_ok_and(|path| path.starts_with(&root)) {
                continue;
            }
            if kind.is_file() && entry.file_name() == "SKILL.md" {
                if let Ok(skill) = parse_skill(&entry.path().to_string_lossy()) {
                    if let Ok(relative) = folder.strip_prefix(&root) {
                        candidates.push(WorkspaceSkillCandidate {
                            name: skill.name,
                            description: skill.description,
                            relative_path: relative.to_string_lossy().into_owned(),
                        });
                    }
                }
            } else if kind.is_dir() && depth < 3 {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !matches!(
                    name.as_ref(),
                    ".git" | "node_modules" | "target" | "dist" | "build" | ".next"
                ) {
                    pending.push((entry.path(), depth + 1));
                }
            }
        }
        if scanned > 1000 || candidates.len() >= 30 {
            break;
        }
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(candidates)
}

#[cfg(test)]
pub(crate) fn import_workspace_skill(
    state: &ExtensionState,
    root: &Path,
    relative_path: &str,
) -> Result<ExtensionOverview, AppError> {
    import_workspace_skill_owned(state, root, relative_path, None)
}
pub(crate) fn import_workspace_skill_owned(
    state: &ExtensionState, root: &Path, relative_path: &str, owner: Option<&str>,
) -> Result<ExtensionOverview, AppError> {
    let relative = Path::new(relative_path);
    if relative_path.is_empty()
        || relative_path.len() > 240
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(error("WORKSPACE_DENIED", "Skill 必须位于当前工作区内"));
    }
    let root =
        fs::canonicalize(root).map_err(|_| error("WORKSPACE_READ_FAILED", "无法读取当前工作区"))?;
    let folder = fs::canonicalize(root.join(relative))
        .map_err(|_| error("WORKSPACE_READ_FAILED", "无法读取工作区 Skill"))?;
    if !folder.starts_with(&root) || folder == root {
        return Err(error("WORKSPACE_DENIED", "Skill 必须位于当前工作区内"));
    }
    let skill = parse_skill(&folder.to_string_lossy())?;
    Ok(scoped_overview(state.update(|store| {
        if store.skills.iter().any(|item| item.name == skill.name && store.skill_owners.get(&item.id).is_none_or(|o|Some(o.as_str())==owner)) {
            return Err(error("SKILL_EXISTS", "此 Skill 已导入"));
        }
        if let Some(owner)=owner {store.skill_owners.insert(skill.id.clone(),owner.into());}
        store.skills.push(skill);
        Ok(())
    })?, owner))
}

pub(crate) fn valid_mcp_url(raw: &str) -> Result<(), AppError> {
    let url = reqwest::Url::parse(raw).map_err(|_| error("INVALID_MCP_URL", "MCP 地址无效"))?;
    let host = url.host_str().unwrap_or("");
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || host.is_empty()
        || !(url.scheme() == "https"
            || url.scheme() == "http"
                && matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1"))
    {
        return Err(error(
            "INVALID_MCP_URL",
            "仅支持 HTTPS 或本机 HTTP 的 MCP 地址，且地址不能包含凭证",
        ));
    }
    Ok(())
}

pub(crate) fn http_client(origin: &str) -> Result<reqwest_mcp::Client, AppError> {
    let proxy = crate::network::proxy_for(origin)
        .map_err(|_| error("MCP_PROXY_INVALID", "无法读取网络代理设置"))?;
    let mut builder = reqwest_mcp::Client::builder()
        .no_proxy()
        .redirect(reqwest_mcp::redirect::Policy::none())
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(20));
    if let Some(url) = proxy {
        builder = builder.proxy(
            reqwest_mcp::Proxy::all(&url)
                .map_err(|_| error("MCP_PROXY_INVALID", "MCP 代理地址无效"))?,
        );
    }
    builder
        .build()
        .map_err(|_| error("MCP_CONNECT_FAILED", "无法初始化 MCP 网络连接"))
}

fn catalog_parts(id: &str) -> Option<(&str, &str, &str)> {
    let parts = id.split('/').collect::<Vec<_>>();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.len() > 100
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        })
    {
        return None;
    }
    Some((parts[0], parts[1], parts[2]))
}

fn safe_skill_url(raw: &str) -> Result<reqwest_mcp::Url, AppError> {
    if raw.len() > 2048 || raw.contains("/../") || raw.contains("/./") {
        return Err(error("INVALID_SKILL_URL", "Skill 链接无效"));
    }
    let url =
        reqwest_mcp::Url::parse(raw).map_err(|_| error("INVALID_SKILL_URL", "Skill 链接无效"))?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || host.is_empty()
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_some()
        || host.parse::<std::net::IpAddr>().is_ok()
        || host == "localhost"
        || host.ends_with(".local")
        || host.ends_with(".localhost")
        || host.ends_with(".internal")
        || url.path().contains('%')
    {
        return Err(error(
            "INVALID_SKILL_URL",
            "仅允许不含凭证、查询参数的公开 HTTPS Skill 链接",
        ));
    }
    Ok(url)
}

enum RemoteSource {
    Catalog {
        owner: String,
        repo: String,
        name: String,
    },
    Direct(String),
    Repository {
        owner: String,
        repo: String,
    },
}

fn remote_source(raw: &str) -> Result<RemoteSource, AppError> {
    if let Some((owner, repo, name)) = catalog_parts(raw) {
        return Ok(RemoteSource::Catalog {
            owner: owner.into(),
            repo: repo.into(),
            name: name.into(),
        });
    }
    let url = safe_skill_url(raw)?;
    let host = url.host_str().unwrap_or("");
    let parts = url
        .path_segments()
        .map(|items| items.filter(|part| !part.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if matches!(host, "skills.sh" | "www.skills.sh") && parts.len() == 3 {
        let id = parts.join("/");
        let Some((owner, repo, name)) = catalog_parts(&id) else {
            return Err(error("INVALID_SKILL_URL", "Skill 商店链接无效"));
        };
        return Ok(RemoteSource::Catalog {
            owner: owner.into(),
            repo: repo.into(),
            name: name.into(),
        });
    }
    if host == "github.com" && parts.len() >= 2 {
        let (owner, repo) = (parts[0], parts[1]);
        if catalog_parts(&format!("{owner}/{repo}/skill")).is_none() {
            return Err(error("INVALID_SKILL_URL", "GitHub 仓库链接无效"));
        }
        if parts.len() == 2 {
            return Ok(RemoteSource::Repository {
                owner: owner.into(),
                repo: repo.into(),
            });
        }
        if parts.len() >= 5 && matches!(parts[2], "blob" | "tree") {
            let mut path = parts[4..].join("/");
            if parts[2] == "tree" && !path.ends_with("/SKILL.md") {
                path.push_str("/SKILL.md");
            }
            if !path.ends_with("/SKILL.md") && path != "SKILL.md" {
                return Err(error(
                    "INVALID_SKILL_URL",
                    "请提供具体的 SKILL.md 或 Skill 文件夹链接",
                ));
            }
            return Ok(RemoteSource::Direct(format!(
                "https://raw.githubusercontent.com/{owner}/{repo}/{}/{path}",
                parts[3]
            )));
        }
    }
    if parts.last() != Some(&"SKILL.md") {
        return Err(error(
            "INVALID_SKILL_URL",
            "请提供 Skill 页面、GitHub 仓库或 SKILL.md 链接",
        ));
    }
    Ok(RemoteSource::Direct(url.to_string()))
}

async fn limited_body(
    mut response: reqwest_mcp::Response,
    limit: usize,
) -> Result<Vec<u8>, AppError> {
    if !response.status().is_success() {
        return Err(error(
            "SKILL_SOURCE_UNAVAILABLE",
            "Skill 来源不可用或文件已删除",
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(error("SKILL_TOO_LARGE", "远程 Skill 文件超过大小限制"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error("SKILL_SOURCE_UNAVAILABLE", "读取 Skill 来源失败"))?
    {
        if bytes.len() + chunk.len() > limit {
            return Err(error("SKILL_TOO_LARGE", "远程 Skill 文件超过大小限制"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn github_skill_paths(owner: &str, repo: &str) -> Result<(String, Vec<String>), AppError> {
    let client = http_client("https://api.github.com/")?;
    let commit_url = format!("https://api.github.com/repos/{owner}/{repo}/commits/HEAD");
    let commit_response = client
        .get(commit_url)
        .header("User-Agent", "GeoD-Agent")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| error("SKILL_SOURCE_UNAVAILABLE", "无法读取 GitHub 仓库版本"))?;
    let commit: Value =
        serde_json::from_slice(&limited_body(commit_response, 256 * 1024).await?)
            .map_err(|_| error("SKILL_SOURCE_INVALID", "GitHub 返回了无效的仓库版本"))?;
    let sha = commit
        .get("sha")
        .and_then(Value::as_str)
        .filter(|sha| sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| error("SKILL_SOURCE_INVALID", "GitHub 仓库版本无效"))?
        .to_owned();
    let url = format!("https://api.github.com/repos/{owner}/{repo}/git/trees/{sha}?recursive=1");
    let response = client
        .get(url)
        .header("User-Agent", "GeoD-Agent")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| error("SKILL_SOURCE_UNAVAILABLE", "无法读取 GitHub Skill 仓库"))?;
    let payload: Value = serde_json::from_slice(&limited_body(response, 2 * 1024 * 1024).await?)
        .map_err(|_| error("SKILL_SOURCE_INVALID", "GitHub 返回了无效的仓库目录"))?;
    if payload.get("truncated").and_then(Value::as_bool) == Some(true) {
        return Err(error(
            "SKILL_SOURCE_TOO_LARGE",
            "仓库目录过大，请提供具体 SKILL.md 链接",
        ));
    }
    let paths = payload
        .get("tree")
        .and_then(Value::as_array)
        .ok_or_else(|| error("SKILL_SOURCE_INVALID", "仓库目录中没有文件列表"))?;
    Ok((
        sha,
        paths
            .iter()
            .filter_map(|row| {
                let path = row.get("path")?.as_str()?;
                if row.get("type")?.as_str()? != "blob"
                    || !(path == "SKILL.md" || path.ends_with("/SKILL.md"))
                    || path.contains('%')
                    || path.contains('?')
                    || path.contains('#')
                    || path.contains("..")
                    || path.len() > 400
                {
                    return None;
                }
                Some(path.to_owned())
            })
            .take(100)
            .collect(),
    ))
}

async fn fetch_skill_document(url: &str) -> Result<String, AppError> {
    let url = safe_skill_url(url)?;
    if url.path_segments().and_then(|mut parts| parts.next_back()) != Some("SKILL.md") {
        return Err(error("INVALID_SKILL_URL", "链接必须指向 SKILL.md"));
    }
    let client = http_client(url.as_str())?;
    let response = client
        .get(url)
        .header(
            "Accept",
            "text/plain, text/markdown, application/octet-stream",
        )
        .send()
        .await
        .map_err(|_| error("SKILL_SOURCE_UNAVAILABLE", "无法下载 SKILL.md"))?;
    let bytes = limited_body(response, 64 * 1024).await?;
    String::from_utf8(bytes).map_err(|_| error("INVALID_SKILL", "远程 SKILL.md 必须采用 UTF-8"))
}

async fn github_skill_bundle(url: &str) -> Result<Option<(String, String, BTreeMap<String, Vec<u8>>)>, AppError> {
    let parsed = safe_skill_url(url)?;
    if parsed.host_str() != Some("raw.githubusercontent.com") { return Ok(None); }
    let parts: Vec<_> = parsed.path_segments().unwrap().collect();
    if parts.len() < 4 { return Err(error("INVALID_SKILL_URL", "GitHub Skill 路径无效")); }
    let (owner, repo, reference) = (parts[0], parts[1], parts[2]);
    let client = http_client("https://api.github.com/")?;
    let commit: Value = serde_json::from_slice(&limited_body(client.get(format!("https://api.github.com/repos/{owner}/{repo}/commits/{reference}")).header("User-Agent", "GeoD-Agent").send().await.map_err(|_| error("SKILL_SOURCE_UNAVAILABLE", "无法固定 Skill 仓库版本"))?, 256 * 1024).await?).map_err(|_| error("SKILL_SOURCE_INVALID", "Skill 仓库版本无效"))?;
    let sha = commit["sha"].as_str().filter(|sha| sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())).ok_or_else(|| error("SKILL_SOURCE_INVALID", "Skill 仓库版本无效"))?;
    let path = parts[3..].join("/");
    let prefix = path.strip_suffix("SKILL.md").ok_or_else(|| error("INVALID_SKILL_URL", "Skill 链接必须指向 SKILL.md"))?;
    let source = format!("https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}");
    let content = fetch_skill_document(&source).await?;
    let response = client.get(format!("https://api.github.com/repos/{owner}/{repo}/git/trees/{sha}?recursive=1")).header("User-Agent", "GeoD-Agent").send().await.map_err(|_| error("SKILL_SOURCE_UNAVAILABLE", "无法读取 Skill 资源目录"))?;
    let tree: Value = serde_json::from_slice(&limited_body(response, 8 * 1024 * 1024).await?).map_err(|_| error("SKILL_SOURCE_INVALID", "Skill 资源目录无效"))?;
    if tree["truncated"] == true { return Err(error("SKILL_SOURCE_TOO_LARGE", "Skill 资源目录不完整")); }
    let entries = tree["tree"].as_array().ok_or_else(|| error("SKILL_SOURCE_INVALID", "Skill 资源目录无效"))?;
    let raw_client = http_client(&source)?; let mut files = BTreeMap::new(); let mut total = 0;
    for entry in entries {
        let Some(path) = entry["path"].as_str().filter(|path| path.starts_with(prefix)) else { continue; };
        if entry["type"] != "blob" { continue; }
        let relative = &path[prefix.len()..];
        if relative == "SKILL.md" { continue; }
        validate_bundle_path(relative)?;
        if entry["mode"] == "120000" { return Err(error("INVALID_SKILL", "Skill 资源不能包含符号链接")); }
        let bytes = limited_body(raw_client.get(format!("https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}")).send().await.map_err(|_| error("SKILL_SOURCE_UNAVAILABLE", "无法获取 Skill 资源"))?, 4 * 1024 * 1024).await?;
        total += bytes.len();
        if files.len() >= 256 || total > 16 * 1024 * 1024 { return Err(error("SKILL_TOO_LARGE", "Skill 资源超过 256 个文件或 16 MiB")); }
        files.insert(relative.into(), bytes);
    }
    Ok(Some((source, content, files)))
}

#[tauri::command]
pub(crate) async fn skill_catalog_search(
    query: String,
) -> Result<Vec<OnlineSkillCandidate>, AppError> {
    let query = query.trim();
    if query.len() < 2 || query.len() > 80 {
        return Ok(Vec::new());
    }
    let client = http_client("https://skills.sh/")?;
    let response = client
        .get("https://skills.sh/api/search")
        .query(&[("q", query), ("limit", "12")])
        .send()
        .await
        .map_err(|_| error("SKILL_CATALOG_UNAVAILABLE", "Skill 网络目录暂时不可用"))?;
    let payload: Value = serde_json::from_slice(&limited_body(response, 256 * 1024).await?)
        .map_err(|_| error("SKILL_CATALOG_INVALID", "Skill 网络目录返回了无效数据"))?;
    Ok(payload
        .get("skills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?;
            let (owner, repo, _slug) = catalog_parts(id)?;
            let name = row.get("name")?.as_str()?;
            if name.len() > 100 || name.is_empty() {
                return None;
            }
            Some(OnlineSkillCandidate {
                id: id.into(),
                name: name.into(),
                source: format!("{owner}/{repo}"),
                installs: row.get("installs").and_then(Value::as_u64),
            })
        })
        .take(12)
        .collect())
}

#[tauri::command]
pub(crate) async fn skill_source_inspect(
    url: String,
) -> Result<Vec<SkillSourceCandidate>, AppError> {
    match remote_source(&url)? {
        RemoteSource::Catalog { owner, repo, name } => Ok(vec![SkillSourceCandidate {
            id: format!("{owner}/{repo}/{name}"),
            name,
            source: format!("{owner}/{repo}"),
        }]),
        RemoteSource::Direct(url) => Ok(vec![SkillSourceCandidate {
            name: url.rsplit('/').nth(1).unwrap_or("SKILL.md").into(),
            source: url.clone(),
            id: url,
        }]),
        RemoteSource::Repository { owner, repo } => {
            let (sha, paths) = github_skill_paths(&owner, &repo).await?;
            Ok(paths
                .into_iter()
                .take(30)
                .map(|path| {
                    let name = path.rsplit('/').nth(1).unwrap_or("root").to_owned();
                    let id =
                        format!("https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}");
                    SkillSourceCandidate {
                        id,
                        name,
                        source: format!("{owner}/{repo}"),
                    }
                })
                .collect())
        }
    }
}

#[tauri::command]
pub(crate) async fn skill_remote_stage(
    state: State<'_, ExtensionState>,
    services: State<'_, services::ServiceState>,
    source: String,
) -> Result<RemoteSkillStage, AppError> {
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    stage_remote_owned(&state, source, Some(&owner)).await
}

#[cfg(test)]
async fn stage_remote_with_state(
    state: &ExtensionState,
    source: String,
) -> Result<RemoteSkillStage, AppError> {
    stage_remote_owned(state, source, None).await
}
async fn stage_remote_owned(state:&ExtensionState,source:String,owner:Option<&str>)->Result<RemoteSkillStage,AppError>{
    let (source_url, content, expected_name) = match remote_source(&source)? {
        RemoteSource::Direct(url) => {
            let content = fetch_skill_document(&url).await?;
            (url, content, None)
        }
        RemoteSource::Repository { .. } => {
            return Err(error(
                "SKILL_NEEDS_SELECTION",
                "仓库可能包含多个 Skill，请先列出并选择一个",
            ))
        }
        RemoteSource::Catalog { owner, repo, name } => {
            let (sha, mut paths) = github_skill_paths(&owner, &repo).await?;
            paths.sort_by_key(|path| {
                let folder = path.rsplit('/').nth(1).unwrap_or("");
                if folder == name {
                    0
                } else if name.contains(folder) || folder.contains(&name) {
                    1
                } else {
                    2
                }
            });
            let mut found = None;
            for path in paths.into_iter().take(20) {
                let url = format!("https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{path}");
                let Ok(content) = fetch_skill_document(&url).await else {
                    continue;
                };
                let Ok(skill) = parse_skill_document(content.clone(), None) else {
                    continue;
                };
                if skill.name == name {
                    found = Some((url, content));
                    break;
                }
            }
            let (url, content) = found.ok_or_else(|| {
                error(
                    "SKILL_SOURCE_STALE",
                    "目录条目与当前仓库不一致，未找到对应 SKILL.md",
                )
            })?;
            (url, content, Some(name))
        }
    };
    let (source_url, content, files) = github_skill_bundle(&source_url).await?.unwrap_or((source_url, content, BTreeMap::new()));
    let mut skill = parse_skill_document(content, None)?;
    skill.files = files;
    if expected_name.is_some_and(|name| skill.name != name) {
        return Err(error("SKILL_SOURCE_MISMATCH", "Skill 名称与目录条目不一致"));
    }
    let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&(&skill.content, &skill.files)).map_err(|_| error("INVALID_SKILL", "Skill 内容无效"))?));
    skill.source_url = Some(source_url.clone());
    skill.content_sha256 = Some(hash.clone());
    let mut chosen = None;
    state.update(|store| {
        if let Some(existing) = store.skills.iter().find(|item| item.name == skill.name && store.skill_owners.get(&item.id).is_none_or(|o|Some(o.as_str())==owner)) {
            if existing.source_url.as_deref() != Some(&source_url)
                || existing.content_sha256.as_deref() != Some(&hash)
            {
                return Err(error(
                    "SKILL_CONFLICT",
                    "同名 Skill 已存在，来源或内容不同，请先核对",
                ));
            }
            chosen = Some(existing.clone());
        } else {
            chosen = Some(skill.clone());
            if let Some(owner)=owner{store.skill_owners.insert(skill.id.clone(),owner.into());}
            store.skills.push(skill);
        }
        Ok(())
    })?;
    let skill = chosen.ok_or_else(|| error("SKILL_IMPORT_FAILED", "无法保存远程 Skill"))?;
    Ok(RemoteSkillStage {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source_url,
        content_sha256: hash,
        enabled: skill.enabled,
    })
}

#[tauri::command]
pub(crate) fn skill_preview(
    state: State<'_, ExtensionState>,
    services: State<'_, services::ServiceState>,
    id: String,
) -> Result<String, AppError> {
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    visible_to(state.load()?,Some(&owner))
        .skills
        .into_iter()
        .find(|item| item.id == id)
        .map(|item| item.content)
        .ok_or_else(|| error("SKILL_NOT_FOUND", "未找到该 Skill"))
}

#[tauri::command]
pub(crate) fn extensions_list(
    state: State<'_, ExtensionState>,
    services: State<'_, services::ServiceState>,
) -> Result<ExtensionOverview, AppError> {
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    Ok(overview(visible_to(state.load()?,Some(&owner))))
}

#[tauri::command]
pub(crate) fn skill_import(
    state: State<'_, ExtensionState>,
    services: State<'_, services::ServiceState>,
    path: String,
) -> Result<ExtensionOverview, AppError> {
    let skill = parse_skill(&path)?;
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    Ok(scoped_overview(state.update(|store| {
        if store.skills.iter().any(|item| item.name == skill.name && store.skill_owners.get(&item.id).is_none_or(|o|o==&owner)) {
            return Err(error("SKILL_EXISTS", "此 Skill 已导入"));
        }
        store.skill_owners.insert(skill.id.clone(),owner.clone());store.skills.push(skill);
        Ok(())
    })?,Some(&owner)))
}

#[tauri::command]
pub(crate) fn skill_set_enabled(
    state: State<'_, ExtensionState>,
    services: State<'_, services::ServiceState>,
    id: String,
    enabled: bool,
) -> Result<ExtensionOverview, AppError> {
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    Ok(scoped_overview(state.update(|store| {
        check_skill_owner(store,&id,&owner)?;
        let skill = store
            .skills
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| error("SKILL_NOT_FOUND", "未找到该 Skill"))?;
        skill.enabled = enabled;
        Ok(())
    })?,Some(&owner)))
}

#[tauri::command]
pub(crate) fn skill_remove(state: State<'_, ExtensionState>, services:State<'_,services::ServiceState>, id: String) -> Result<ExtensionOverview, AppError> {
    if id == SOURCE_CREATOR_ID { return Err(error("BUILTIN_SKILL", "内置技能可以停用")); }
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    Ok(scoped_overview(state.update(|store| { check_skill_owner(store,&id,&owner)?;store.skills.retain(|skill| skill.id != id);store.skill_owners.remove(&id); Ok(()) })?,Some(&owner)))
}

#[tauri::command]
pub(crate) fn skill_read(
    state: State<'_, ExtensionState>,
    services: State<'_, services::ServiceState>,
    name: String,
) -> Result<String, AppError> {
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    let store=visible_to(state.load()?,Some(&owner));
    let skill=store.skills.iter().find(|item|item.enabled&&item.name==name).ok_or_else(||error("SKILL_NOT_ENABLED","此 Skill 未启用"))?;
    plugin_package::runtime_skill_content(&state,&store,skill)
}

#[tauri::command]
pub(crate) fn mcp_add(
    state: State<'_, ExtensionState>,
    services: State<'_, services::ServiceState>,
    name: String,
    url: String,
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<BTreeMap<String,String>>,
    headers: Option<BTreeMap<String,String>>,
    runtime: Option<crate::mcp_runtime_config::Settings>,
) -> Result<ExtensionOverview, AppError> {
    let name = name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(error(
            "INVALID_MCP_NAME",
            "连接器名称不能为空且不能超过 80 字符",
        ));
    }
    let command=command.map(|v|v.trim().to_owned());
    let runtime=runtime.unwrap_or_default();runtime.validate(command.is_some())?;
    let secret=crate::mcp_credentials::Secret{args:args.unwrap_or_default(),env:env.unwrap_or_default(),headers:headers.unwrap_or_default()};
    crate::mcp_credentials::validate(command.as_deref(),&secret)?;
    if command.is_none() {valid_mcp_url(&url)?;} else if !url.is_empty() {return Err(error("MCP_CONFIG_INVALID","本机 MCP 不使用服务网址"));}
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    let id=Uuid::new_v4().to_string();
    let private=command.is_some() || !secret.headers.is_empty() || runtime.env_http_headers.len()>0 || runtime.bearer_token_env_var.is_some() || runtime.startup_timeout_sec.is_some() || runtime.tool_timeout_sec.is_some() || runtime.enabled_tools.is_some() || !runtime.disabled_tools.is_empty();
    if private {crate::mcp_credentials::save(&state.path,&id,&secret)?;}
    let result=state.update(|store| {
        if command.is_none() && store.connectors.iter().any(|item| item.url == url && store.connector_settings.get(&item.id).is_none_or(|settings|settings.owner==owner)) {
            return Err(error("MCP_EXISTS", "此 MCP 地址已添加"));
        }
        store.connectors.push(Connector {
            id: id.clone(),
            name: name.to_owned(),
            url,
            enabled: false,
            transport: if command.is_some(){ConnectorTransport::Stdio}else{ConnectorTransport::Http},
        });
        if private {store.connector_settings.insert(id.clone(),crate::mcp_credentials::Metadata{owner:owner.clone(),command,header_names:secret.headers.keys().cloned().collect(),env_names:secret.env.keys().cloned().collect(),argument_count:secret.args.len(),oauth:false,runtime});}
        Ok(())
    });
    if result.is_err() && private {let _=crate::mcp_credentials::remove(&state.path,&id);}
    Ok(scoped_overview(result?,Some(&owner)))
}

#[tauri::command]
pub(crate) async fn mcp_remove(app:AppHandle,state:State<'_,ExtensionState>,services:State<'_,services::ServiceState>,id:String)->Result<ExtensionOverview,AppError> {
    use tauri::Manager;
    use rmcp::transport::auth::CredentialStore;
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    let snapshot=state.load()?;
    if !snapshot.connectors.iter().any(|item|item.id==id) {return Err(error("MCP_NOT_FOUND","未找到该 MCP 连接器"));}
    if let Some(settings)=snapshot.connector_settings.get(&id) {
        if settings.owner!=owner {return Err(error("MCP_NOT_FOUND","未找到该 MCP 连接器"));}
    }
    app.state::<crate::mcp_oauth::OAuthState>().abort_connector(&id,&owner)?;
    let vault=crate::mcp_oauth::VaultStore{path:state.path.clone(),id:id.clone()};
    let _guard=vault.acquire_refresh_guard().await.map_err(|_|error("MCP_AUTH_BUSY","授权正在更新，请稍后再操作"))?;
    let updated=state.update(|store|{
        if store.connector_settings.get(&id).is_some_and(|settings|settings.owner!=owner){return Err(error("MCP_NOT_FOUND","未找到该 MCP 连接器"));}
        crate::mcp_credentials::remove(&state.path,&id)?;
        store.connectors.retain(|item|item.id!=id);store.connector_settings.remove(&id);Ok(())
    })?;
    vault.clear().await.map_err(|_|error("MCP_CREDENTIAL_FAILED","连接器已移除，授权凭据清理失败"))?;
    Ok(scoped_overview(updated,Some(&owner)))
}

#[tauri::command]
pub(crate) fn mcp_add_gdal(
    state: State<'_, ExtensionState>,
    services:State<'_,services::ServiceState>,
) -> Result<ExtensionOverview, AppError> {
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    Ok(scoped_overview(state.update(|store| {
        if store.connectors.iter().any(|item| item.transport == ConnectorTransport::GdalStdio) {
            return Err(error("MCP_EXISTS", "本机 GDAL 已添加"));
        }
        store.connectors.push(Connector {
            id: Uuid::new_v4().to_string(),
            name: "GDAL 格式转换".to_owned(),
            url: String::new(),
            enabled: false,
            transport: ConnectorTransport::GdalStdio,
        });
        Ok(())
    })?,Some(&owner)))
}

#[tauri::command]
pub(crate) fn mcp_set_enabled(
    state: State<'_, ExtensionState>,
    services: State<'_, services::ServiceState>,
    id: String,
    enabled: bool,
) -> Result<ExtensionOverview, AppError> {
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    Ok(scoped_overview(state.update(|store| {
        if store.connector_settings.get(&id).is_some_and(|settings|settings.owner!=owner) {return Err(error("MCP_NOT_FOUND","未找到该 MCP 连接器"));}
        let connector = store
            .connectors
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| error("MCP_NOT_FOUND", "未找到该 MCP 连接器"))?;
        connector.enabled = enabled;
        Ok(())
    })?,Some(&owner)))
}

#[tauri::command]
pub(crate) async fn mcp_registry_search(query: String) -> Result<Vec<RegistryItem>, AppError> {
    let query = query.trim();
    if query.len() < 2 || query.len() > 80 {
        return Ok(Vec::new());
    }
    let client = http_client("https://registry.modelcontextprotocol.io/")?;
    let response = client
        .get("https://registry.modelcontextprotocol.io/v0.1/servers")
        .query(&[("search", query), ("limit", "12")])
        .send()
        .await
        .map_err(|_| error("REGISTRY_UNAVAILABLE", "MCP Registry 暂时不可用"))?;
    if !response.status().is_success() {
        return Err(error("REGISTRY_UNAVAILABLE", "MCP Registry 查询失败"));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| error("REGISTRY_INVALID", "MCP Registry 返回了无效数据"))?;
    let results = payload
        .get("servers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(results
        .into_iter()
        .filter_map(|row| {
            let server = row.get("server")?;
            let remote = server.get("remotes")?.as_array()?.iter().find(|item| {
                item.get("type").and_then(Value::as_str) == Some("streamable-http")
                    && item
                        .get("headers")
                        .and_then(Value::as_array)
                        .is_none_or(|headers| {
                            headers.iter().all(|header| {
                                header.get("isRequired").and_then(Value::as_bool) != Some(true)
                            })
                        })
            })?;
            let url = remote.get("url")?.as_str()?;
            valid_mcp_url(url).ok()?;
            if reqwest::Url::parse(url).ok()?.scheme() != "https" {
                return None;
            }
            let name = server.get("name")?.as_str()?.to_owned();
            Some(RegistryItem {
                title: server
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or(&name)
                    .to_owned(),
                description: server
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(240)
                    .collect(),
                name,
                url: url.to_owned(),
            })
        })
        .collect())
}

fn connector(
    state: &ExtensionState,
    id: &str,
    require_enabled: bool,
) -> Result<Connector, AppError> {
    let found = state
        .load()?
        .connectors
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| error("MCP_NOT_FOUND", "未找到该 MCP 连接器"))?;
    if require_enabled && !found.enabled {
        return Err(error("MCP_NOT_ENABLED", "该 MCP 连接器未启用"));
    }
    if found.transport == ConnectorTransport::Http {
        valid_mcp_url(&found.url)?;
    }
    Ok(found)
}

fn local_workspace(
    app: &AppHandle,
    workspace_state: &AppState,
    services: &services::ServiceState,
    conversation_id: Option<&str>,
) -> Result<LocalWorkspace, AppError> {
    let id = conversation_id.ok_or_else(|| error("MCP_WORKSPACE_REQUIRED", "请先选择一个工作区对话"))?;
    let settings = crate::read_workspace(app, workspace_state, services, id)?;
    let directory = fs::canonicalize(settings.directory)
        .map_err(|_| error("MCP_WORKSPACE_INVALID", "当前对话的工作区文件夹无法访问"))?;
    if !directory.is_dir() {
        return Err(error("MCP_WORKSPACE_INVALID", "当前对话的工作区不是文件夹"));
    }
    Ok(LocalWorkspace { directory, permission: settings.permission })
}

fn validate_gdal_path(root: &Path, value: &str, output: bool) -> Result<(), AppError> {
    if value.is_empty() || value.contains("\0") || value.contains("://") {
        return Err(error("MCP_PATH_DENIED", "GDAL 只允许当前工作区中的本机文件"));
    }
    let raw = Path::new(value);
    let candidate = if raw.is_absolute() { raw.to_path_buf() } else { root.join(raw) };
    let actual = if output {
        if candidate.exists() {
            return Err(error("MCP_OUTPUT_EXISTS", "输出文件已存在，请选择新文件名"));
        }
        let parent = candidate.parent().ok_or_else(|| error("MCP_PATH_DENIED", "输出路径无效"))?;
        if !parent.is_dir() || candidate.file_name().is_none() {
            return Err(error("MCP_PATH_DENIED", "输出目录必须已存在于当前工作区"));
        }
        fs::canonicalize(parent).map_err(|_| error("MCP_PATH_DENIED", "无法检查输出目录"))?
    } else {
        let path = fs::canonicalize(candidate)
            .map_err(|_| error("MCP_INPUT_MISSING", "输入文件不存在或无法读取"))?;
        if !path.is_file() {
            return Err(error("MCP_PATH_DENIED", "输入必须是当前工作区中的文件"));
        }
        path
    };
    if !actual.starts_with(root) {
        return Err(error("MCP_PATH_DENIED", "GDAL 文件路径超出当前对话工作区"));
    }
    Ok(())
}

fn gdal_reprojection(tool_name: &str) -> bool {
    matches!(tool_name, "raster_reproject" | "vector_reproject")
}

fn validate_gdal_reflection_directory(root: &Path) -> Result<(), AppError> {
    for relative in [".preflight", ".preflight/justifications", ".preflight/justifications/crs_datum", ".preflight/justifications/resampling"] {
        let path = root.join(relative);
        if path.exists() {
            let actual = fs::canonicalize(&path)
                .map_err(|_| error("MCP_PATH_DENIED", "无法检查 GDAL 方法说明目录"))?;
            if !actual.starts_with(root) || !actual.is_dir() {
                return Err(error("MCP_PATH_DENIED", "GDAL 方法说明目录必须位于当前工作区"));
            }
        }
    }
    Ok(())
}

fn valid_epsg(value: &str) -> bool {
    value.strip_prefix("EPSG:").is_some_and(|code| {
        (3..=6).contains(&code.len()) && code.bytes().all(|byte| byte.is_ascii_digit())
            && code.parse::<u32>().is_ok_and(|number| number > 0)
    })
}

fn gdal_methodology_text<'a>(entry: &'a Value, key: &str) -> Result<&'a str, AppError> {
    entry.get(key).and_then(Value::as_str).map(str::trim)
        .filter(|text| !text.is_empty() && text.chars().count() <= 600)
        .ok_or_else(|| error("GDAL_METHODOLOGY_REQUIRED", "重投影需要说明选择依据、目标和已知取舍"))
}

fn gdal_justification(args: &Value, field: &str, method: &str) -> Result<Value, AppError> {
    let entry = args.get("methodology").and_then(|value| value.get(field))
        .ok_or_else(|| error("GDAL_METHODOLOGY_REQUIRED", "重投影需要 AI 提供坐标系及重采样方法的选择依据"))?;
    let intent = gdal_methodology_text(entry, "intent")?;
    let rationale = gdal_methodology_text(entry, "rationale")?;
    let tradeoffs = gdal_methodology_text(entry, "tradeoffs")?;
    let confidence = gdal_methodology_text(entry, "confidence")?;
    if !matches!(confidence, "low" | "medium" | "high") {
        return Err(error("GDAL_METHODOLOGY_REQUIRED", "方法说明的 confidence 必须为 low、medium 或 high"));
    }
    Ok(serde_json::json!({
        "intent": intent,
        "alternatives": [],
        "choice": { "method": method, "rationale": rationale, "tradeoffs": tradeoffs },
        "confidence": confidence,
    }))
}

fn gdal_reflection_steps(tool_name: &str, args: &Value) -> Result<Vec<Value>, AppError> {
    if !gdal_reprojection(tool_name) { return Ok(Vec::new()); }
    let dst_crs = args.get("dst_crs").and_then(Value::as_str)
        .filter(|value| valid_epsg(value))
        .ok_or_else(|| error("INVALID_MCP_ARGUMENTS", "重投影目标坐标系须使用 EPSG:代码"))?;
    if let Some(src_crs) = args.get("src_crs").filter(|value| !value.is_null()) {
        if !src_crs.as_str().is_some_and(valid_epsg) {
            return Err(error("INVALID_MCP_ARGUMENTS", "源坐标系须使用 EPSG:代码"));
        }
    }
    let mut steps = vec![serde_json::json!({
        "tool_name": tool_name, "domain": "crs_datum", "prompt_name": "justify_crs_selection",
        "prompt_args": { "dst_crs": dst_crs },
        "justification": gdal_justification(args, "crs", dst_crs)?,
    })];
    if tool_name == "raster_reproject" {
        let method = args.get("resampling").and_then(Value::as_str)
            .filter(|value| matches!(*value, "nearest" | "bilinear" | "cubic" | "cubic_spline" | "lanczos" | "average" | "mode" | "gauss"))
            .ok_or_else(|| error("INVALID_MCP_ARGUMENTS", "栅格重采样方法无效"))?;
        steps.push(serde_json::json!({
            "tool_name": tool_name, "domain": "resampling", "prompt_name": "justify_resampling_method",
            "prompt_args": { "method": method },
            "justification": gdal_justification(args, "resampling", method)?,
        }));
    }
    Ok(steps)
}

fn gdal_methodology_schema(raster: bool) -> Value {
    let reason = serde_json::json!({
        "type": "object", "additionalProperties": false,
        "properties": {
            "intent": { "type": "string", "description": "Property or user goal to preserve." },
            "rationale": { "type": "string", "description": "Why this exact choice fits the data and goal." },
            "tradeoffs": { "type": "string", "description": "Known distortion, artifacts, or limitations." },
            "confidence": { "type": "string", "enum": ["low", "medium", "high"] }
        },
        "required": ["intent", "rationale", "tradeoffs", "confidence"]
    });
    let mut properties = serde_json::json!({ "crs": reason });
    let mut required = vec!["crs"];
    if raster {
        properties["resampling"] = reason;
        required.push("resampling");
    }
    serde_json::json!({
        "type": "object", "additionalProperties": false,
        "description": "AI methodological reasoning, not user approval. Inspect the source first. Respect an explicit user CRS or method; ask only if a real concern needs resolution.",
        "properties": properties,
        "required": required,
    })
}

fn gdal_tool_schema(tool_name: &str, mut schema: Value) -> Value {
    if !gdal_reprojection(tool_name) { return schema; }
    if let Some(fields) = schema.as_object_mut() {
        if let Some(properties) = fields.get_mut("properties").and_then(Value::as_object_mut) {
            properties.insert("methodology".into(), gdal_methodology_schema(tool_name == "raster_reproject"));
            if tool_name == "raster_reproject" {
                if let Some(resampling) = properties.get_mut("resampling").and_then(Value::as_object_mut) {
                    resampling.insert("enum".into(), serde_json::json!(["nearest", "bilinear", "cubic", "cubic_spline", "lanczos", "average", "mode", "gauss"]));
                    resampling.insert("description".into(), Value::String("nearest preserves original pixel values; bilinear/cubic interpolate continuous data.".into()));
                }
                if let Some(output) = properties.get_mut("output").and_then(Value::as_object_mut) {
                    output.insert("description".into(), Value::String("New workspace file. Source driver is preserved: inspect with raster_info and match its format. For a different format use raster_convert as a separate step.".into()));
                }
            }
        }
        if let Some(required) = fields.get_mut("required").and_then(Value::as_array_mut) {
            required.push(Value::String("methodology".into()));
        }
    }
    schema
}

fn validate_gdal_call(tool_name: &str, args: &Value, workspace: &LocalWorkspace) -> Result<(), AppError> {
    if !GDAL_TOOLS.contains(&tool_name) {
        return Err(error("MCP_TOOL_NOT_ALLOWED", "本机 GDAL 尚未开放此工具"));
    }
    let source = args.get("uri").and_then(Value::as_str)
        .ok_or_else(|| error("INVALID_MCP_ARGUMENTS", "GDAL 工具需要输入文件 uri"))?;
    validate_gdal_path(&workspace.directory, source, false)?;
    if matches!(tool_name, "raster_convert" | "vector_convert" | "vector_clip" | "vector_buffer" | "vector_simplify" | "raster_reproject" | "vector_reproject") {
        if workspace.permission != WorkspacePermission::FullAccess {
            return Err(error("MCP_APPROVAL_REQUIRED", "GDAL 处理会写入工作区。请先在当前对话中确认完全访问权限"));
        }
        let output = args.get("output").and_then(Value::as_str)
            .ok_or_else(|| error("INVALID_MCP_ARGUMENTS", "GDAL 处理需要输出文件 output"))?;
        validate_gdal_path(&workspace.directory, output, true)?;
    }
    if tool_name == "vector_clip" {
        if let Some(mask) = args.get("mask").filter(|value| !value.is_null()) {
            let mask = mask.as_str().ok_or_else(|| error("INVALID_MCP_ARGUMENTS", "裁剪蒙版 mask 必须是工作区内的文件路径"))?;
            validate_gdal_path(&workspace.directory, mask, false)?;
        }
    }
    gdal_reflection_steps(tool_name, args)?;
    if gdal_reprojection(tool_name) { validate_gdal_reflection_directory(&workspace.directory)?; }
    Ok(())
}

fn scrub_gdal_metadata(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            fields.retain(|key, _| !matches!(key.as_str(), "path" | "uri" | "source_path" | "output_path"));
            for child in fields.values_mut() { scrub_gdal_metadata(child); }
        }
        Value::Array(items) => for child in items { scrub_gdal_metadata(child); },
        Value::String(text) if text.starts_with("file://") || Path::new(text).is_absolute() => {
            *text = "[本机文件]".to_owned();
        }
        _ => {}
    }
}

fn gdal_relative_path(root: &Path, path: &str) -> Option<String> {
    let raw = Path::new(path);
    let candidate = if raw.is_absolute() { raw.to_path_buf() } else { root.join(raw) };
    fs::canonicalize(candidate).ok()?
        .strip_prefix(root).ok()
        .map(|relative| relative.to_string_lossy().into_owned())
}

fn safe_gdal_result(raw: Value, tool_name: &str, args: &Value, workspace: &LocalWorkspace) -> Value {
    if raw.get("isError").and_then(Value::as_bool) == Some(true) {
        #[cfg(test)]
        eprintln!("GDAL test diagnostic for {tool_name}: {raw}");
        return serde_json::json!({
            "isError": true,
            "content": [{ "type": "text", "text": "GDAL 处理失败；请检查工作区文件、格式和参数" }],
        });
    }
    let mut data = raw.get("structuredContent").cloned().or_else(|| {
        raw.get("content")?.as_array()?.first()?.get("text")?.as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
    }).unwrap_or_else(|| serde_json::json!({ "status": "completed" }));
    scrub_gdal_metadata(&mut data);
    let source = args.get("uri").and_then(Value::as_str)
        .and_then(|path| gdal_relative_path(&workspace.directory, path));
    let output = args.get("output").and_then(Value::as_str)
        .and_then(|path| gdal_relative_path(&workspace.directory, path));
    let safe = serde_json::json!({ "tool": tool_name, "source": source, "output": output, "data": data });
    serde_json::json!({
        "isError": false,
        "content": [{ "type": "text", "text": safe.to_string() }],
        "structuredContent": safe,
    })
}

#[cfg(test)]
async fn connect(
    found: &Connector,
    workspace: Option<&LocalWorkspace>,
) -> Result<rmcp::service::RunningService<rmcp::RoleClient, crate::mcp_interaction::McpClient>, AppError> {
    connect_runtime(found,workspace,None,crate::mcp_credentials::Secret::default(),&crate::mcp_runtime_config::Settings::default(),None,None).await
}

async fn connect_owned(state:&ExtensionState, found:&Connector, workspace:Option<&LocalWorkspace>,owner:Option<&str>,interactive:Option<crate::mcp_interaction::InteractiveMcp>)->Result<rmcp::service::RunningService<rmcp::RoleClient,crate::mcp_interaction::McpClient>,AppError> {
    let settings=state.load()?.connector_settings.get(&found.id).cloned();
    let oauth=settings.as_ref().is_some_and(|settings|settings.oauth);
    let runtime=settings.as_ref().map(|settings|settings.runtime.clone()).unwrap_or_default();
    runtime.validate(found.transport==ConnectorTransport::Stdio)?;
    let path=state.path.clone();let id=found.id.clone();
    let command=settings.as_ref().and_then(|settings|settings.command.clone());
    let secret=if let Some(settings)=settings {
        if Some(settings.owner.as_str())!=owner {return Err(error("MCP_NOT_FOUND","未找到当前账号的 MCP 连接器"));}
        tauri::async_runtime::spawn_blocking(move||crate::mcp_credentials::load(&path,&id)).await
            .map_err(|_|error("MCP_CREDENTIAL_FAILED","读取 MCP 本机凭据失败"))??
    } else {crate::mcp_credentials::Secret::default()};
    if oauth {
        let manager=crate::mcp_oauth::manager(state.path.clone(),found.id.clone(),&found.url).await?;
        let mut builder=reqwest_mcp::Client::builder().no_proxy().redirect(reqwest_mcp::redirect::Policy::none()).connect_timeout(Duration::from_secs(20)).default_headers(runtime.headers(&secret)?);
        if let Some(proxy)=crate::network::proxy_for(&found.url).map_err(|_|error("MCP_PROXY_INVALID","MCP 代理配置无效"))?{builder=builder.proxy(reqwest_mcp::Proxy::all(proxy).map_err(|_|error("MCP_PROXY_INVALID","MCP 代理配置无效"))?);}
        let client=builder.build().map_err(|_|error("MCP_CONNECT_FAILED","MCP 网络连接无法准备"))?;
        let transport=StreamableHttpClientTransport::with_client(rmcp::transport::auth::AuthClient::new(client,manager),StreamableHttpClientTransportConfig::with_uri(found.url.as_str()));
        tokio::time::timeout(runtime.startup_timeout(40),crate::mcp_interaction::McpClient{interactive}.serve(transport)).await.map_err(|_|error("MCP_CONNECT_TIMEOUT","MCP 授权连接超时"))?
            .map_err(|_|error("MCP_AUTH_REQUIRED","MCP 授权失效或连接失败，请检查服务状态或重新授权"))
    }else{connect_runtime(found,workspace,command,secret,&runtime,interactive,state.runtime_root.as_deref()).await}
}

fn owned_runtime(state:&ExtensionState,id:&str,owner:Option<&str>)->Result<crate::mcp_runtime_config::Settings,AppError>{
    let settings=state.load()?.connector_settings.get(id).cloned();
    if settings.as_ref().is_some_and(|settings|Some(settings.owner.as_str())!=owner){return Err(error("MCP_NOT_FOUND","未找到当前账号的 MCP 连接器"));}
    Ok(settings.map(|settings|settings.runtime).unwrap_or_default())
}

async fn connect_runtime(found:&Connector,workspace:Option<&LocalWorkspace>,command:Option<String>,secret:crate::mcp_credentials::Secret,runtime:&crate::mcp_runtime_config::Settings,interactive:Option<crate::mcp_interaction::InteractiveMcp>,runtime_root:Option<&Path>)->Result<rmcp::service::RunningService<rmcp::RoleClient,crate::mcp_interaction::McpClient>,AppError> {
    match found.transport {
        ConnectorTransport::Http => {
            // Handshake/discovery/tool deadlines are enforced above the transport.
            // An unrelated fixed HTTP timeout must not truncate long tool calls.
            let proxy=crate::network::proxy_for(&found.url).map_err(|_|error("MCP_PROXY_INVALID","MCP 代理配置无效"))?;
            let mut builder=reqwest_mcp::Client::builder().no_proxy().redirect(reqwest_mcp::redirect::Policy::none())
                .pool_max_idle_per_host(0).connect_timeout(Duration::from_secs(20)).default_headers(runtime.headers(&secret)?);
            if let Some(proxy)=proxy {builder=builder.proxy(reqwest_mcp::Proxy::all(&proxy).map_err(|_|error("MCP_PROXY_INVALID","MCP 代理配置无效"))?);}
            let client=builder.build().map_err(|_|error("MCP_CONNECT_FAILED","无法创建 MCP 网络连接"))?;
            let transport = StreamableHttpClientTransport::with_client(
                client,
                StreamableHttpClientTransportConfig::with_uri(found.url.as_str()),
            );
            tokio::time::timeout(runtime.startup_timeout(35),crate::mcp_interaction::McpClient{interactive}.serve(transport)).await
                .map_err(|_|error("MCP_CONNECT_TIMEOUT","MCP 连接超时"))?
                .map_err(|_| error("MCP_CONNECT_FAILED", "无法连接 MCP 服务，请检查地址、认证与网络"))
        }
        ConnectorTransport::Stdio => {
            let workspace=workspace.ok_or_else(||error("MCP_WORKSPACE_REQUIRED","请先选择工作区对话"))?;
            let executable=command.ok_or_else(||error("MCP_CREDENTIAL_FAILED","本机 MCP 启动配置缺失，请重新添加"))?;
            crate::mcp_credentials::validate(Some(&executable),&secret)?;
            let directory=runtime.directory(&workspace.directory)?;
            let (mut command,node_directory)=crate::mcp_process::prepare_command(&executable,&secret.args,runtime_root,&directory)?;
            command.current_dir(directory);
            runtime.apply_environment(&mut command,&secret);
            crate::mcp_process::extend_runtime_path(&mut command,node_directory.as_deref())?;
            #[cfg(windows)] command.creation_flags(0x0800_0000);
            let transport=crate::mcp_process::ProcessTransport::spawn(&mut command).map_err(|_|error("MCP_PROCESS_FAILED","无法启动本机 MCP，请检查程序与参数"))?;
            tokio::time::timeout(runtime.startup_timeout(60),crate::mcp_interaction::McpClient{interactive}.serve(transport)).await
                .map_err(|_|error("MCP_CONNECT_TIMEOUT","本机 MCP 启动超时"))?
                .map_err(|_|error("MCP_PROCESS_FAILED","本机 MCP 握手失败，请检查程序是否提供 stdio MCP"))
        }
        ConnectorTransport::GdalStdio => {
            let workspace = workspace.ok_or_else(|| error("MCP_WORKSPACE_REQUIRED", "请先选择工作区对话"))?;
            let mut command = crate::python_runtime::command(include_str!("gdal_stdio.py"))?;
            command.current_dir(&workspace.directory)
                .env("GDAL_MCP_WORKSPACES", ".");
            let proxy = crate::network::proxy_for("https://pypi.org")
                .map_err(|_| error("MCP_PROXY_INVALID", "无法读取 GDAL 依赖下载的代理设置"))?;
            for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
                command.env_remove(key);
            }
            if let Some(proxy) = proxy {
                command.env("HTTP_PROXY", &proxy).env("HTTPS_PROXY", &proxy);
            }
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            let transport = crate::mcp_process::ProcessTransport::spawn(&mut command)
                .map_err(|_| error("GDAL_MCP_UNAVAILABLE", "无法启动内置 GDAL MCP，请修复应用运行环境"))?;
            tokio::time::timeout(Duration::from_secs(90), crate::mcp_interaction::McpClient{interactive}.serve(transport))
                .await
                .map_err(|_| error("GDAL_MCP_TIMEOUT", "GDAL MCP 启动超时"))?
                .map_err(|_| error("GDAL_MCP_UNAVAILABLE", "内置 GDAL MCP 启动失败，请检查运行环境"))
        }
    }
}

async fn call_gdal_reprojection(
    client: &rmcp::service::RunningService<rmcp::RoleClient, crate::mcp_interaction::McpClient>,
    tool_name: &str,
    upstream_arguments: serde_json::Map<String, Value>,
    arguments: &Value,
) -> Result<Value, AppError> {
    let steps = gdal_reflection_steps(tool_name, arguments)?;
    let mut stored_domains = Vec::new();
    for _ in 0..=steps.len() {
        let request = CallToolRequestParams::new(tool_name.to_owned()).with_arguments(upstream_arguments.clone());
        let response = client.call_tool(request).await
            .map_err(|_| error("MCP_RESULT_UNKNOWN", "GDAL 未确认重投影结果，已停止自动重试"))?;
        let response = serde_json::to_value(response)
            .map_err(|_| error("MCP_RESULT_UNKNOWN", "GDAL 重投影结果无法读取"))?;
        if response.get("isError").and_then(Value::as_bool) != Some(true) { return Ok(response); }
        let text = response.get("content").and_then(Value::as_array).map(|items| {
            items.iter().filter_map(|item| item.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")
        }).unwrap_or_default();
        // Retry only the pinned server's preflight rejection, which occurs before file processing.
        if !text.contains(&format!("Epistemic preflight required for '{tool_name}'")) { return Ok(response); }
        let step = steps.iter().find(|step| {
            let domain = step["domain"].as_str().unwrap_or_default();
            !stored_domains.contains(&domain.to_owned()) && text.contains(&format!("**Domain:** {domain}"))
        });
        let Some(step) = step else { return Ok(response); };
        let stored = client.call_tool(CallToolRequestParams::new("store_justification")
            .with_arguments(step.as_object().cloned().unwrap_or_default())).await
            .map_err(|_| error("GDAL_REFLECTION_FAILED", "GDAL 未能保存重投影方法说明"))?;
        let stored = serde_json::to_value(stored)
            .map_err(|_| error("GDAL_REFLECTION_FAILED", "GDAL 方法说明结果无法读取"))?;
        if stored.get("isError").and_then(Value::as_bool) == Some(true) { return Ok(stored); }
        stored_domains.push(step["domain"].as_str().unwrap_or_default().to_owned());
    }
    Err(error("GDAL_REFLECTION_FAILED", "GDAL 方法说明未能通过校验"))
}

#[tauri::command]
pub(crate) async fn mcp_tools(
    state: State<'_, ExtensionState>,
    app: AppHandle,
    workspace_state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    id: String,
    conversation_id: Option<String>,
) -> Result<Value, AppError> {
    let found = connector(&state, &id, false)?;
    let workspace = if matches!(found.transport,ConnectorTransport::GdalStdio|ConnectorTransport::Stdio) {
        Some(local_workspace(&app, &workspace_state, &services, conversation_id.as_deref())?)
    } else { None };
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    let runtime=owned_runtime(&state,&id,Some(&owner))?;
    let started=std::time::Instant::now();
    let client = connect_owned(&state,&found,workspace.as_ref(),Some(&owner),None).await?;
    let tools = tokio::time::timeout(runtime.discovery_timeout(started.elapsed()), client.list_all_tools()).await;
    let _ = tokio::time::timeout(Duration::from_secs(3), client.cancel()).await;
    let tools=tools
        .map_err(|_| error("MCP_LIST_TIMEOUT", "MCP 服务列出工具超时，请检查服务是否正常运行"))?
        .map_err(|_| error("MCP_LIST_FAILED", "MCP 服务未能列出工具"))?;
    if tools.len()>1000 {return Err(error("MCP_TOOL_LIMIT","此服务工具数量超过当前客户端容量，请使用拆分后的 MCP 服务"));}
    let list = tools.into_iter()
        .filter(|tool| found.transport != ConnectorTransport::GdalStdio || GDAL_TOOLS.contains(&tool.name.as_ref()))
        .filter(|tool| runtime.allows_tool(tool.name.as_ref()))
        .map(|tool| {
            let schema = serde_json::to_value(&tool.input_schema).unwrap_or_else(|_| serde_json::json!({ "type": "object" }));
            let schema = if found.transport == ConnectorTransport::GdalStdio {
                gdal_tool_schema(tool.name.as_ref(), schema)
            } else { schema };
            serde_json::json!({
                "name": tool.name, "description": tool.description, "inputSchema": schema,
            })
        }).collect::<Vec<_>>();
    Ok(serde_json::json!({ "connectorId": id, "name": found.name, "tools": list }))
}

#[tauri::command]
pub(crate) async fn mcp_call(
    state: State<'_, ExtensionState>,
    app: AppHandle,
    workspace_state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    id: String,
    tool_name: String,
    arguments: Value,
    execution_id: String,
    conversation_id: Option<String>,
    interactive:Option<bool>,
) -> Result<Value, AppError> {
    let found = connector(&state, &id, true)?;
    let workspace = if matches!(found.transport,ConnectorTransport::GdalStdio|ConnectorTransport::Stdio) {
        Some(local_workspace(&app, &workspace_state, &services, conversation_id.as_deref())?)
    } else { None };
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    let interaction=if interactive==Some(true){conversation_id.as_ref().map(|conversation|crate::mcp_interaction::InteractiveMcp{app:app.clone(),owner:owner.clone(),conversation:conversation.clone(),scope:execution_id.clone(),connector:found.name.clone()})}else{None};
    call_mcp_for_owner(&state,id,tool_name,arguments,execution_id,workspace.as_ref(),Some(&owner),interaction).await
}

#[tauri::command]
pub(crate) fn mcp_result_read(
    state: State<'_, ExtensionState>,
    services: State<'_, services::ServiceState>,
    execution_id: String,
    offset: usize,
) -> Result<Value, AppError> {
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;
    read_mcp_result_for_owner(&state,&execution_id,offset,Some(&owner))
}

#[cfg(test)]
fn read_mcp_result_with_state(state:&ExtensionState,execution_id:&str,offset:usize)->Result<Value,AppError> {
    read_mcp_result_for_owner(state,execution_id,offset,None)
}
fn read_mcp_result_for_owner(
    state: &ExtensionState,
    execution_id: &str,
    offset: usize,
    owner: Option<&str>,
) -> Result<Value, AppError> {
    let store = state.load()?;
    let record = store
        .mcp_calls
        .iter()
        .find(|item| item.execution_id == execution_id)
        .ok_or_else(|| error("MCP_RESULT_NOT_FOUND", "未找到此 MCP 调用结果"))?;
    if record.owner.as_deref().is_some_and(|record_owner|Some(record_owner)!=owner) {return Err(error("MCP_RESULT_NOT_FOUND","未找到当前账号的 MCP 调用结果"));}
    let result = record
        .result
        .as_ref()
        .ok_or_else(|| error("MCP_RESULT_UNKNOWN", "此 MCP 调用结果尚不明确"))?;
    mcp_result_page(result, execution_id, offset)
}

#[cfg(test)]
async fn call_mcp_with_state(state:&ExtensionState,id:String,tool_name:String,arguments:Value,execution_id:String,workspace:Option<&LocalWorkspace>)->Result<Value,AppError> {
    call_mcp_for_owner(state,id,tool_name,arguments,execution_id,workspace,None,None).await
}

async fn call_mcp_for_owner(
    state: &ExtensionState,
    id: String,
    tool_name: String,
    arguments: Value,
    execution_id: String,
    workspace: Option<&LocalWorkspace>,
    owner: Option<&str>,
    interactive:Option<crate::mcp_interaction::InteractiveMcp>,
) -> Result<Value, AppError> {
    if execution_id.is_empty()
        || execution_id.len() > 160
        || !execution_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
    {
        return Err(error("INVALID_MCP_EXECUTION", "MCP 调用编号无效"));
    }
    let found = connector(&state, &id, true)?;
    let runtime=owned_runtime(state,&id,owner)?;
    if !runtime.allows_tool(&tool_name){return Err(error("MCP_TOOL_DISABLED","此工具已在连接器配置中排除"));}
    if !arguments.is_object()
        || serde_json::to_vec(&arguments).map_or(true, |bytes| bytes.len() > 4096)
    {
        return Err(error(
            "INVALID_MCP_ARGUMENTS",
            "MCP 工具参数必须是 4 KiB 以内的对象",
        ));
    }
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&serde_json::json!({
                "connectorId": id,
                "toolName": tool_name,
                "arguments": arguments,
            }))
            .map_err(|_| error("INVALID_MCP_ARGUMENTS", "MCP 工具参数无效"))?
        )
    );
    if let Some(previous) = state
        .load()?
        .mcp_calls
        .into_iter()
        .find(|item| item.execution_id == execution_id)
    {
        if previous.owner.as_deref().is_some_and(|record_owner|Some(record_owner)!=owner) {return Err(error("MCP_RESULT_NOT_FOUND","未找到当前账号的 MCP 调用结果"));}
        if previous.fingerprint != fingerprint {
            return Err(error(
                "MCP_EXECUTION_CONFLICT",
                "MCP 调用编号对应的参数已改变",
            ));
        }
        return previous.result.ok_or_else(|| {
            error(
                "MCP_RESULT_UNKNOWN",
                "此 MCP 调用结果尚不明确，已停止自动重试",
            )
        }).and_then(|result| mcp_result_page(&result, &execution_id, 0));
    }
    if found.transport == ConnectorTransport::GdalStdio {
        let workspace = workspace.ok_or_else(|| error("MCP_WORKSPACE_REQUIRED", "请先选择工作区对话"))?;
        validate_gdal_call(&tool_name, &arguments, workspace)?;
    }
    let can_interact=interactive.is_some();
    let started=std::time::Instant::now();
    let client = connect_owned(state,&found,workspace,owner,interactive).await?;
    let available = tokio::time::timeout(runtime.discovery_timeout(started.elapsed()),client.list_all_tools()).await
        .map_err(|_|error("MCP_LIST_TIMEOUT","MCP 服务列出工具超时"))
        .and_then(|result|result.map_err(|_|error("MCP_LIST_FAILED", "MCP 服务未能列出工具")));
    let available=match available {Ok(tools)=>tools,Err(cause)=>{let _=tokio::time::timeout(Duration::from_secs(4),client.cancel()).await;return Err(cause);}};
    if !available.iter().any(|tool| tool.name == tool_name) {
        let _ = client.cancel().await;
        return Err(error("MCP_TOOL_NOT_FOUND", "该 MCP 服务未提供此工具"));
    }
    if found.transport == ConnectorTransport::GdalStdio && gdal_reprojection(&tool_name)
        && !available.iter().any(|tool| tool.name == "store_justification") {
        let _ = client.cancel().await;
        return Err(error("GDAL_REFLECTION_UNAVAILABLE", "GDAL 未提供重投影所需的方法说明工具"));
    }
    let mut cached = None;
    state.update(|store| {
        if let Some(previous) = store
            .mcp_calls
            .iter()
            .find(|item| item.execution_id == execution_id)
        {
            if previous.owner.as_deref().is_some_and(|record_owner|Some(record_owner)!=owner) {return Err(error("MCP_RESULT_NOT_FOUND","未找到当前账号的 MCP 调用结果"));}
            if previous.fingerprint != fingerprint {
                return Err(error(
                    "MCP_EXECUTION_CONFLICT",
                    "MCP 调用编号对应的参数已改变",
                ));
            }
            cached = Some(previous.result.clone().ok_or_else(|| {
                error(
                    "MCP_RESULT_UNKNOWN",
                    "此 MCP 调用结果尚不明确，已停止自动重试",
                )
            })?);
            return Ok(());
        }
        store.mcp_calls.push(McpCallRecord {
            execution_id: execution_id.clone(),
            fingerprint: fingerprint.clone(),
            result: None,
            owner: owner.map(str::to_owned),
        });
        Ok(())
    })?;
    if let Some(value) = cached {
        let _ = client.cancel().await;
        return mcp_result_page(&value, &execution_id, 0);
    }
    let mut upstream_arguments = arguments.as_object().cloned().unwrap_or_default();
    if found.transport == ConnectorTransport::GdalStdio && gdal_reprojection(&tool_name) {
        upstream_arguments.remove("methodology");
    }
    let result = tokio::time::timeout(runtime.tool_timeout(can_interact),async {
      if found.transport == ConnectorTransport::GdalStdio && gdal_reprojection(&tool_name) {
        call_gdal_reprojection(&client, &tool_name, upstream_arguments, &arguments).await
      } else {
        let request = CallToolRequestParams::new(tool_name.clone()).with_arguments(upstream_arguments);
        let result = client.call_tool(request).await
            .map_err(|cause|if cause.to_string().contains("MCP_USER_REQUIRED"){error("USER_INPUT_REQUIRED","连接器需要在前台对话中完成授权，请打开会话继续")}else{error("MCP_RESULT_UNKNOWN", "MCP 服务未确认调用结果，已停止自动重试")})?;
        serde_json::to_value(result)
            .map_err(|_| error("MCP_RESULT_UNKNOWN", "MCP 返回结果无法读取，已停止自动重试"))
      }
    }).await.map_err(|_|error("MCP_RESULT_UNKNOWN","MCP 调用超时，结果尚未确认；请核对服务状态"));
    let _ = tokio::time::timeout(Duration::from_secs(4),client.cancel()).await;
    let mut value = result??;
    if value["isError"]==true&&value["content"].as_array().is_some_and(|items|items.iter().any(|item|item["text"].as_str().is_some_and(|text|text.contains("MCP_USER_REQUIRED")||text.contains("Client does not support url elicitation")||text.contains("Client does not support form elicitation")))){return Err(error("USER_INPUT_REQUIRED","连接器需要在前台对话中完成授权，请打开会话继续"));}
    if found.transport == ConnectorTransport::GdalStdio {
        value = safe_gdal_result(value, &tool_name, &arguments,
            workspace.ok_or_else(|| error("MCP_WORKSPACE_REQUIRED", "缺少 GDAL 工作区"))?);
    }
    let output = mcp_result_page(&value, &execution_id, 0)?;
    state
        .update(|store| {
            let record = store
                .mcp_calls
                .iter_mut()
                .find(|item| item.execution_id == execution_id)
                .ok_or_else(|| error("MCP_RESULT_UNKNOWN", "MCP 调用记录丢失，已停止自动重试"))?;
            record.result = Some(if output.get("error").and_then(Value::as_str) == Some("MCP_RESULT_TOO_LARGE") {
                output.clone()
            } else {
                value.clone()
            });
            Ok(())
        })
        .map_err(|_| error("MCP_RESULT_UNKNOWN", "MCP 结果未能保存，已停止自动重试"))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_metadata_and_url_rules() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("geod-test");
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join("SKILL.md"),
            "---\nname: geod-test\ndescription: Helps with a test.\n---\n\nDo the test.\n",
        )
        .unwrap();
        let skill = parse_skill(folder.to_str().unwrap()).unwrap();
        assert_eq!(skill.name, "geod-test");
        assert!(valid_mcp_url("https://example.com/mcp").is_ok());
        assert!(valid_mcp_url("http://127.0.0.1:1234/mcp").is_ok());
        assert!(valid_mcp_url("http://example.com/mcp").is_err());
        assert!(valid_mcp_url("https://user:pass@example.com/mcp").is_err());
    }

    #[test]
    fn complete_skill_resources_are_copied_and_disabled_skills_are_removed() {
        let dir = tempfile::tempdir().unwrap(); let folder = dir.path().join("gis-test");
        fs::create_dir_all(folder.join("references")).unwrap(); fs::create_dir_all(folder.join("scripts")).unwrap();
        fs::write(folder.join("SKILL.md"), "---\nname: gis-test\ndescription: Inspect GIS data.\n---\nRead references/schema.json and run scripts/check.py.").unwrap();
        fs::write(folder.join("references/schema.json"), b"{\"crs\":4326}").unwrap();
        fs::write(folder.join("scripts/check.py"), b"print('real script')").unwrap();
        let mut skill = parse_skill(folder.to_str().unwrap()).unwrap(); skill.enabled = true;
        assert_eq!(skill.files.len(), 2);
        let id = skill.id.clone(); let state = ExtensionState::new(dir.path().join("extensions.json"));
        state.update(|store| { store.skills.push(skill); Ok(()) }).unwrap();
        let home = dir.path().join("account-home"); state.codex_bundle(&home).unwrap();
        assert_eq!(fs::read(home.join("skills/gis-test/references/schema.json")).unwrap(), b"{\"crs\":4326}");
        assert_eq!(fs::read(home.join("skills/gis-test/scripts/check.py")).unwrap(), b"print('real script')");
        state.update(|store| { store.skills.iter_mut().find(|skill| skill.id == id).unwrap().enabled = false; Ok(()) }).unwrap();
        state.codex_bundle(&home).unwrap(); assert!(!home.join("skills/gis-test").exists());
        assert!(validate_bundle_path("../outside").is_err()); assert!(validate_bundle_path("C:/outside").is_err());
    }

    #[test]
    fn gdal_paths_and_workspace_permission_are_checked_before_execution() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(root.path().join("input.geojson"), b"{}").unwrap();
        fs::write(outside.path().join("outside.geojson"), b"{}").unwrap();
        let workspace = LocalWorkspace {
            directory: fs::canonicalize(root.path()).unwrap(),
            permission: WorkspacePermission::ConfirmEach,
        };
        let input = serde_json::json!({ "uri": "input.geojson" });
        assert!(validate_gdal_call("vector_info", &input, &workspace).is_ok());
        assert!(validate_gdal_call("raster_stats", &input, &workspace).is_ok());
        assert_eq!(validate_gdal_call("vector_convert", &serde_json::json!({
            "uri": "input.geojson", "output": "output.gpkg"
        }), &workspace).unwrap_err().code, "MCP_APPROVAL_REQUIRED");
        assert_eq!(validate_gdal_call("vector_clip", &serde_json::json!({
            "uri": "input.geojson", "output": "clipped.geojson", "bounds": [0, 0, 1, 1]
        }), &workspace).unwrap_err().code, "MCP_APPROVAL_REQUIRED");
        let full = LocalWorkspace { permission: WorkspacePermission::FullAccess, ..workspace };
        assert!(validate_gdal_call("vector_convert", &serde_json::json!({
            "uri": "input.geojson", "output": "output.gpkg"
        }), &full).is_ok());
        for tool in ["vector_clip", "vector_buffer", "vector_simplify"] {
            assert!(validate_gdal_call(tool, &serde_json::json!({
                "uri": "input.geojson", "output": "new.geojson"
            }), &full).is_ok());
        }
        assert_eq!(validate_gdal_call("vector_clip", &serde_json::json!({
            "uri": "input.geojson", "output": "clipped.geojson",
            "mask": outside.path().join("outside.geojson").to_string_lossy()
        }), &full).unwrap_err().code, "MCP_PATH_DENIED");
        assert_eq!(validate_gdal_call("vector_info", &serde_json::json!({
            "uri": outside.path().join("outside.geojson").to_string_lossy()
        }), &full).unwrap_err().code, "MCP_PATH_DENIED");
        assert_eq!(validate_gdal_call("vector_convert", &serde_json::json!({
            "uri": "input.geojson", "output": outside.path().join("escaped.gpkg").to_string_lossy()
        }), &full).unwrap_err().code, "MCP_PATH_DENIED");
        assert_eq!(validate_gdal_call("vector_query", &input, &full).unwrap_err().code, "MCP_TOOL_NOT_ALLOWED");
    }

    #[test]
    #[ignore = "requires uvx and the pinned gdal-mcp package"]
    fn gdal_stdio_converts_real_geojson_to_geopackage() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.geojson");
        let output = dir.path().join("sample.gpkg");
        fs::write(&input, r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"test"},"geometry":{"type":"Point","coordinates":[116.4,39.9]}}]}"#).unwrap();
        let state = ExtensionState::new(dir.path().join("extensions.json"));
        state.update(|store| {
            store.connectors.push(Connector {
                id: "gdal-test".into(), name: "GDAL".into(), url: String::new(),
                enabled: true, transport: ConnectorTransport::GdalStdio,
            });
            Ok(())
        }).unwrap();
        let workspace = LocalWorkspace {
            directory: fs::canonicalize(dir.path()).unwrap(),
            permission: WorkspacePermission::FullAccess,
        };
        tauri::async_runtime::block_on(async {
            let result = call_mcp_with_state(&state, "gdal-test".into(), "vector_convert".into(),
                serde_json::json!({"uri": "sample.geojson", "output": "sample.gpkg"}),
                "gdal-test:convert".into(), Some(&workspace)).await.unwrap();
            assert!(!result.to_string().contains("\"isError\":true"), "{result}");
            assert_eq!(result["structuredContent"]["output"], "sample.gpkg");
            assert!(!result.to_string().contains(&workspace.directory.to_string_lossy().to_string()));
        });
        let bytes = fs::read(output).unwrap();
        assert!(bytes.starts_with(b"SQLite format 3\0"));
    }

    #[test]
    #[ignore = "requires uvx and the pinned gdal-mcp package"]
    fn gdal_stdio_converts_real_raster_to_geotiff() {
        let dir = tempfile::tempdir().unwrap();
        fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png"), dir.path().join("source.png")).unwrap();
        let state = ExtensionState::new(dir.path().join("extensions.json"));
        state.update(|store| {
            store.connectors.push(Connector {
                id: "gdal-raster-test".into(), name: "GDAL".into(), url: String::new(),
                enabled: true, transport: ConnectorTransport::GdalStdio,
            });
            Ok(())
        }).unwrap();
        let workspace = LocalWorkspace {
            directory: fs::canonicalize(dir.path()).unwrap(),
            permission: WorkspacePermission::FullAccess,
        };
        tauri::async_runtime::block_on(async {
            let result = call_mcp_with_state(&state, "gdal-raster-test".into(), "raster_convert".into(),
                serde_json::json!({"uri": "source.png", "output": "result.tif"}),
                "gdal-raster-test:convert".into(), Some(&workspace)).await.unwrap();
            assert!(!result.to_string().contains("\"isError\":true"), "{result}");
        });
        let bytes = fs::read(dir.path().join("result.tif")).unwrap();
        assert!(bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*"));
    }

    #[test]
    #[ignore = "requires uvx and the pinned gdal-mcp package"]
    fn gdal_stdio_clips_real_geojson_in_workspace() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("source.geojson"), r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"inside"},"geometry":{"type":"Point","coordinates":[0.5,0.5]}},{"type":"Feature","properties":{"name":"outside"},"geometry":{"type":"Point","coordinates":[5,5]}}]}"#).unwrap();
        let state = ExtensionState::new(dir.path().join("extensions.json"));
        state.update(|store| {
            store.connectors.push(Connector {
                id: "gdal-clip-test".into(), name: "GDAL".into(), url: String::new(),
                enabled: true, transport: ConnectorTransport::GdalStdio,
            });
            Ok(())
        }).unwrap();
        let workspace = LocalWorkspace {
            directory: fs::canonicalize(dir.path()).unwrap(),
            permission: WorkspacePermission::FullAccess,
        };
        tauri::async_runtime::block_on(async {
            let result = call_mcp_with_state(&state, "gdal-clip-test".into(), "vector_clip".into(),
                serde_json::json!({"uri": "source.geojson", "output": "clipped.geojson", "bounds": [0.0, 0.0, 1.0, 1.0]}),
                "gdal-clip-test:clip".into(), Some(&workspace)).await.unwrap();
            assert!(!result.to_string().contains("\"isError\":true"), "{result}");
            assert_eq!(result["structuredContent"]["output"], "clipped.geojson");
        });
        let output: Value = serde_json::from_slice(&fs::read(dir.path().join("clipped.geojson")).unwrap()).unwrap();
        assert_eq!(output["features"].as_array().unwrap().len(), 1);
        assert_eq!(output["features"][0]["properties"]["name"], "inside");
    }

    fn test_methodology() -> Value {
        serde_json::json!({
            "crs": { "intent": "Display on a web map", "rationale": "EPSG:3857 matches the requested web map projection", "tradeoffs": "Area and distance are distorted away from the equator", "confidence": "high" },
            "resampling": { "intent": "Preserve source pixel values", "rationale": "Nearest neighbour retains the original discrete pixel values", "tradeoffs": "Edges may appear blocky", "confidence": "high" }
        })
    }

    #[test]
    fn gdal_reprojection_checks_methodology_and_permissions() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("input.geojson"), b"{}").unwrap();
        let workspace = LocalWorkspace { directory: fs::canonicalize(dir.path()).unwrap(), permission: WorkspacePermission::FullAccess };
        let mut args = serde_json::json!({ "uri": "input.geojson", "output": "output.gpkg", "dst_crs": "EPSG:3857" });
        assert_eq!(validate_gdal_call("vector_reproject", &args, &workspace).unwrap_err().code, "GDAL_METHODOLOGY_REQUIRED");
        args["methodology"] = test_methodology();
        assert!(validate_gdal_call("vector_reproject", &args, &workspace).is_ok());
        fs::write(dir.path().join(".preflight"), b"not a directory").unwrap();
        assert_eq!(validate_gdal_call("vector_reproject", &args, &workspace).unwrap_err().code, "MCP_PATH_DENIED");
        fs::remove_file(dir.path().join(".preflight")).unwrap();
        args["dst_crs"] = Value::String("../projection.txt".into());
        assert_eq!(validate_gdal_call("vector_reproject", &args, &workspace).unwrap_err().code, "INVALID_MCP_ARGUMENTS");
        args["dst_crs"] = Value::String("EPSG:3857".into());
        let confirm = LocalWorkspace { permission: WorkspacePermission::ConfirmEach, ..workspace };
        assert_eq!(validate_gdal_call("vector_reproject", &args, &confirm).unwrap_err().code, "MCP_APPROVAL_REQUIRED");
        let schema = gdal_tool_schema("vector_reproject", serde_json::json!({ "type": "object", "properties": {}, "required": ["uri"] }));
        assert!(schema["required"].as_array().unwrap().contains(&Value::String("methodology".into())));
    }

    #[test]
    #[ignore = "requires uvx and the pinned gdal-mcp package"]
    fn gdal_stdio_reprojects_real_vector_and_raster() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("source.geojson"), r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"name":"test"},"geometry":{"type":"Point","coordinates":[116.4,39.9]}}]}"#).unwrap();
        fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png"), dir.path().join("source.png")).unwrap();
        fs::write(dir.path().join("source.pgw"), "0.0001\n0\n0\n-0.0001\n116.4\n39.9\n").unwrap();
        let state = ExtensionState::new(dir.path().join("extensions.json"));
        state.update(|store| {
            store.connectors.push(Connector { id: "gdal-reproject-test".into(), name: "GDAL".into(), url: String::new(), enabled: true, transport: ConnectorTransport::GdalStdio });
            Ok(())
        }).unwrap();
        let workspace = LocalWorkspace { directory: fs::canonicalize(dir.path()).unwrap(), permission: WorkspacePermission::FullAccess };
        tauri::async_runtime::block_on(async {
            let client = connect(&connector(&state, "gdal-reproject-test", true).unwrap(), Some(&workspace)).await.unwrap();
            let tools = client.list_tools(Default::default()).await.unwrap();
            assert_eq!(tools.tools.iter().filter(|tool| GDAL_TOOLS.contains(&tool.name.as_ref())).count(), 10);
            for tool in tools.tools.iter().filter(|tool| gdal_reprojection(tool.name.as_ref())) {
                let schema = gdal_tool_schema(tool.name.as_ref(), serde_json::to_value(&tool.input_schema).unwrap());
                assert!(schema.to_string().len() <= 4000, "schema too large for model discovery: {}", tool.name);
                assert!(schema["required"].as_array().unwrap().contains(&Value::String("methodology".into())));
            }
            client.cancel().await.unwrap();
            let args = serde_json::json!({ "uri": "source.geojson", "output": "projected.gpkg", "dst_crs": "EPSG:3857", "methodology": test_methodology() });
            let vector = call_mcp_with_state(&state, "gdal-reproject-test".into(), "vector_reproject".into(), args.clone(), "reproject:vector".into(), Some(&workspace)).await.unwrap();
            assert!(!vector.to_string().contains("\"isError\":true"), "{vector}");
            assert_eq!(vector["structuredContent"]["data"]["dst_crs"], "EPSG:3857");
            let bounds = &vector["structuredContent"]["data"]["bounds"];
            assert!((bounds[0].as_f64().unwrap() - 12_957_588.73).abs() < 1.0);
            assert!((bounds[1].as_f64().unwrap() - 4_851_421.18).abs() < 1.0);
            let replay = call_mcp_with_state(&state, "gdal-reproject-test".into(), "vector_reproject".into(), args, "reproject:vector".into(), Some(&workspace)).await.unwrap();
            assert_eq!(vector, replay);
            let converted = call_mcp_with_state(&state, "gdal-reproject-test".into(), "raster_convert".into(),
                serde_json::json!({ "uri": "source.png", "output": "source.tif" }),
                "reproject:raster-source".into(), Some(&workspace)).await.unwrap();
            assert!(!converted.to_string().contains("\"isError\":true"), "{converted}");
            let raster = call_mcp_with_state(&state, "gdal-reproject-test".into(), "raster_reproject".into(),
                serde_json::json!({ "uri": "source.tif", "output": "projected.tif", "src_crs": "EPSG:4326", "dst_crs": "EPSG:3857", "resampling": "nearest", "methodology": test_methodology() }),
                "reproject:raster".into(), Some(&workspace)).await.unwrap();
            assert!(!raster.to_string().contains("\"isError\":true"), "{raster}");
            assert_eq!(raster["structuredContent"]["data"]["dst_crs"], "EPSG:3857");
            assert_eq!(raster["structuredContent"]["data"]["resampling"], "nearest");
        });
        assert!(fs::read(dir.path().join("projected.gpkg")).unwrap().starts_with(b"SQLite format 3\0"));
        let raster = fs::read(dir.path().join("projected.tif")).unwrap();
        assert!(raster.starts_with(b"II*\0") || raster.starts_with(b"MM\0*"));
        assert!(dir.path().join(".preflight/justifications/crs_datum").is_dir());
        assert!(dir.path().join(".preflight/justifications/resampling").is_dir());
        let entries = fs::read_dir(dir.path().join(".preflight/justifications/crs_datum")).unwrap().collect::<Vec<_>>();
        assert_eq!(entries.len(), 1, "the same CRS justification is reused across processes and data types");
    }

    #[test]
    #[ignore = "requires the optional local DeepSeek test gateway and uvx"]
    fn gdal_reprojection_live_model() {
        let origin = std::env::var("GEOD_GDAL_LIVE_ORIGIN").expect("Start test/gdal-live-smoke.mjs");
        assert!(origin.starts_with("http://127.0.0.1:"));
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("source.geojson"), r#"{"type":"FeatureCollection","features":[{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[116.4,39.9]}}]}"#).unwrap();
        fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/32x32.png"), dir.path().join("source.png")).unwrap();
        fs::write(dir.path().join("source.pgw"), "0.0001\n0\n0\n-0.0001\n116.4\n39.9\n").unwrap();
        let state = ExtensionState::new(dir.path().join("extensions.json"));
        state.update(|store| {
            store.connectors.push(Connector { id: "gdal-live".into(), name: "GDAL".into(), url: String::new(), enabled: true, transport: ConnectorTransport::GdalStdio });
            Ok(())
        }).unwrap();
        let workspace = LocalWorkspace { directory: fs::canonicalize(dir.path()).unwrap(), permission: WorkspacePermission::FullAccess };
        tauri::async_runtime::block_on(async {
            let prepared = call_mcp_with_state(&state, "gdal-live".into(), "raster_convert".into(),
                serde_json::json!({ "uri": "source.png", "output": "source.tif" }), "live-fixture:raster".into(), Some(&workspace)).await.unwrap();
            assert!(!prepared.to_string().contains("\"isError\":true"));
            let http = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(60)).build().unwrap();
            let mut messages = vec![serde_json::json!({ "role": "user", "content": "把当前工作区的 source.geojson 和 source.tif 都重投影到 EPSG:3857，分别输出 projected.gpkg 和 projected.tif。栅格源坐标系是 EPSG:4326，保留原像素值。先检查源数据再执行，完成后根据实际结果报告。当前对话已允许完全访问，GDAL 连接器已经启用。" })];
            let mut used = Vec::new();
            let mut final_text = String::new();
            for round in 0..8 {
                let generation: Value = http.post(format!("{origin}/api/agent/generations"))
                    .bearer_auth("E".repeat(43))
                    .json(&serde_json::json!({ "generationId": format!("gdal-live-{round}"), "conversationId": "gdal-live", "messages": messages }))
                    .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
                assert_eq!(generation["state"], "settled", "{generation}");
                let result = &generation["result"];
                let calls = result["toolCalls"].as_array().unwrap();
                if calls.is_empty() { final_text = result["content"].as_str().unwrap_or_default().to_owned(); break; }
                messages.push(serde_json::json!({ "role": "assistant", "content": result["content"], "tool_calls": calls }));
                for call in calls {
                    let name = call["function"]["name"].as_str().unwrap();
                    let args: Value = serde_json::from_str(call["function"]["arguments"].as_str().unwrap()).unwrap();
                    let output = match name {
                        "workspace_status" => serde_json::json!({ "permission": "fullAccess", "workspaceSelected": true }),
                        "workspace_boundaries_list" => serde_json::json!({ "boundaries": [] }),
                        "sources_list" => serde_json::json!({ "sources": [] }),
                        "jobs_list" => serde_json::json!({ "jobs": [] }),
                        "workspace_gis_files_list" => serde_json::json!({ "files": [{ "relativePath": "source.geojson" }, { "relativePath": "source.tif" }] }),
                        "gdal_connect" => serde_json::json!({ "enabled": true, "connectorId": "gdal-live" }),
                        "extensions_list" => {
                            let client = connect(&connector(&state, "gdal-live", true).unwrap(), Some(&workspace)).await.unwrap();
                            let listed = client.list_tools(Default::default()).await.unwrap();
                            client.cancel().await.unwrap();
                            let tools = listed.tools.into_iter().filter(|tool| GDAL_TOOLS.contains(&tool.name.as_ref())).map(|tool| {
                                serde_json::json!({ "name": tool.name, "description": tool.description.as_ref().map(|description| description.chars().take(500).collect::<String>()), "inputSchema": gdal_tool_schema(tool.name.as_ref(), serde_json::to_value(&tool.input_schema).unwrap()) })
                            }).collect::<Vec<_>>();
                            serde_json::json!({ "skills": [], "connectors": [{ "connectorId": "gdal-live", "name": "GDAL", "toolCount": tools.len(), "tools": tools }] })
                        }
                        "mcp_call" => {
                            assert_eq!(args["connectorId"], "gdal-live");
                            let tool = args["toolName"].as_str().unwrap();
                            used.push(tool.to_owned());
                            let output = call_mcp_with_state(&state, "gdal-live".into(), tool.into(), args["arguments"].clone(), call["id"].as_str().unwrap().into(), Some(&workspace)).await
                                .unwrap_or_else(|cause| panic!("Native GDAL rejected {tool}: {} ({args})", cause.code));
                            assert!(!output.to_string().contains("\"isError\":true"), "{output}");
                            output
                        }
                        _ => panic!("Unexpected live test tool: {name}"),
                    };
                    messages.push(serde_json::json!({ "role": "tool", "tool_call_id": call["id"], "content": output.to_string() }));
                }
            }
            assert!(used.contains(&"vector_info".to_owned()), "source was not inspected: {used:?}");
            assert!(used.contains(&"vector_reproject".to_owned()), "reprojection was not called: {used:?}");
            assert!(used.contains(&"raster_info".to_owned()), "raster was not inspected: {used:?}");
            assert!(used.contains(&"raster_reproject".to_owned()), "raster reprojection was not called: {used:?}");
            assert!(!final_text.is_empty());
            assert!(fs::read(dir.path().join("projected.gpkg")).unwrap().starts_with(b"SQLite format 3\0"));
            let raster = fs::read(dir.path().join("projected.tif")).unwrap();
            assert!(raster.starts_with(b"II*\0") || raster.starts_with(b"MM\0*"));
            eprintln!("Real DeepSeek / native GDAL completed: {used:?}");
        });
    }

    #[test]
    fn imported_skill_is_saved_and_disabled_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("saved-skill");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("SKILL.md"), "---\nname: saved-skill\ndescription: Verifies Skill persistence.\n---\n\nRead instructions.\n").unwrap();
        let state = ExtensionState::new(dir.path().join("extensions.json"));
        let skill = parse_skill(folder.to_str().unwrap()).unwrap();
        state
            .update(|store| {
                store.skills.push(skill);
                Ok(())
            })
            .unwrap();
        let loaded = state.load().unwrap();
        let imported = loaded.skills.iter().find(|item| item.name == "saved-skill").unwrap();
        assert!(!imported.enabled);
        assert!(imported.content.contains("Read instructions."));
    }

    #[test]
    fn bundled_source_creator_preserves_enabled_preference() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("extensions.json");
        let state = ExtensionState::new(path.clone());
        assert!(state.source_creator_enabled().unwrap());
        let loaded = state.load().unwrap();
        let skill = loaded.skills.iter().find(|s| s.id == SOURCE_CREATOR_ID).unwrap();
        assert_eq!(skill.name,"geod-source-creator");
        assert!(skill.content.contains("inspect_source"));
        state.update(|store| { store.skills.iter_mut().find(|s|s.id == SOURCE_CREATOR_ID).unwrap().enabled = false; Ok(()) }).unwrap();
        assert!(!ExtensionState::new(path).source_creator_enabled().unwrap());
    }

    #[test]
    fn remote_skill_links_are_bounded_and_resolved() {
        assert!(matches!(
            remote_source("https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices"),
            Ok(RemoteSource::Catalog { .. })
        ));
        assert!(matches!(
            remote_source("https://github.com/vercel-labs/agent-skills"),
            Ok(RemoteSource::Repository { .. })
        ));
        assert!(matches!(remote_source("https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md"), Ok(RemoteSource::Direct(_))));
        assert!(matches!(
            remote_source("https://example.org/skills/geo/SKILL.md"),
            Ok(RemoteSource::Direct(_))
        ));
        for invalid in [
            "http://example.org/SKILL.md",
            "https://127.0.0.1/SKILL.md",
            "https://localhost/SKILL.md",
            "https://example.org/SKILL.md?token=secret",
            "https://example.org/other.md",
            "../../outside",
        ] {
            assert!(
                remote_source(invalid).is_err(),
                "unexpectedly accepted {invalid}"
            );
        }
        assert!(catalog_parts("owner/../skill").is_none());
    }

    #[test]
    #[ignore = "requires live skills.sh and GitHub access"]
    fn online_skill_search_and_stage_uses_actual_github_content() {
        tauri::async_runtime::block_on(async {
            let found = skill_catalog_search("vercel-react-best-practices".into())
                .await
                .unwrap();
            assert!(found
                .iter()
                .any(|item| item.id == "vercel-labs/agent-skills/vercel-react-best-practices"));
            let dir = tempfile::tempdir().unwrap();
            let state = ExtensionState::new(dir.path().join("extensions.json"));
            let staged = stage_remote_with_state(
                &state,
                "vercel-labs/agent-skills/vercel-react-best-practices".into(),
            )
            .await
            .unwrap();
            assert_eq!(staged.name, "vercel-react-best-practices");
            assert!(!staged.enabled);
            assert!(staged
                .source_url
                .starts_with("https://raw.githubusercontent.com/vercel-labs/agent-skills/"));
            assert_eq!(staged.source_url.split('/').nth(5).unwrap_or("").len(), 40);
            assert_eq!(staged.content_sha256.len(), 64);
            let saved = state.load().unwrap();
            assert_eq!(saved.skills.len(), 1);
            assert!(saved.skills[0].content.contains("React"));
            let candidates =
                skill_source_inspect("https://github.com/vercel-labs/agent-skills".into())
                    .await
                    .unwrap();
            assert!(candidates
                .iter()
                .any(|item| item.id.contains("react-best-practices/SKILL.md")));
            let again = stage_remote_with_state(
                &state,
                "vercel-labs/agent-skills/vercel-react-best-practices".into(),
            )
            .await
            .unwrap();
            assert_eq!(again.id, staged.id);
            let from_link = stage_remote_with_state(
                &state,
                "https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices".into(),
            )
            .await
            .unwrap();
            assert_eq!(from_link.id, staged.id);
            let from_file_url = stage_remote_with_state(&state, staged.source_url.clone())
                .await
                .unwrap();
            assert_eq!(from_file_url.id, staged.id);
        });
    }

    #[test]
    #[ignore = "requires live public geospatial MCP services"]
    fn public_geospatial_mcp_services_list_real_tools() {
        tauri::async_runtime::block_on(async {
            for (url, expected) in [
                ("https://api.humaps.org/mcp", "search_data_sources"),
                ("https://api.umbra-py.space/mcp", "search_catalog"),
            ] {
                let client = connect(&Connector {
                    id: "public-test".into(), name: "public test".into(), url: url.into(),
                    enabled: true, transport: ConnectorTransport::Http,
                }, None).await.unwrap();
                let tools = client.list_tools(Default::default()).await.unwrap();
                assert!(
                    tools.tools.iter().any(|tool| tool.name == expected),
                    "{url}"
                );
                let _ = client.cancel().await;
            }
        });
    }

    #[test]
    fn workspace_skill_discovery_and_import_reject_outside_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        let folder = root.join(".agents").join("skills").join("workspace-test");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("SKILL.md"), "---\nname: workspace-test\ndescription: Checks workspace discovery.\n---\n\nUse this Skill.\n").unwrap();
        let state = ExtensionState::new(dir.path().join("extensions.json"));
        let listed = workspace_skills(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "workspace-test");
        let relative = listed[0].relative_path.clone();
        assert_eq!(
            import_workspace_skill(&state, &root, "../workspace-test")
                .err()
                .unwrap()
                .code,
            "WORKSPACE_DENIED"
        );
        assert_eq!(
            import_workspace_skill(&state, &root, dir.path().to_str().unwrap())
                .err()
                .unwrap()
                .code,
            "WORKSPACE_DENIED"
        );
        let imported = import_workspace_skill(&state, &root, &relative).unwrap();
        assert_eq!(imported.skills.iter().filter(|item| item.name == "workspace-test").count(), 1);
        assert!(!imported.skills.iter().find(|item| item.name == "workspace-test").unwrap().enabled);
        assert_eq!(
            import_workspace_skill(&state, &root, &relative)
                .err()
                .unwrap()
                .code,
            "SKILL_EXISTS"
        );
    }

    #[test]
    #[ignore = "requires a running MCP server such as test/mcp-mock.mjs"]
    fn mcp_lists_real_tools() {
        let url = std::env::var("GEOD_TEST_MCP_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:43121/mcp".to_owned());
        tauri::async_runtime::block_on(async {
            let client = connect(&Connector {
                id: "test".into(), name: "test".into(), url,
                enabled: true, transport: ConnectorTransport::Http,
            }, None).await.unwrap();
            let tools = client.list_tools(Default::default()).await.unwrap();
            assert!(!tools.tools.is_empty());
            println!(
                "MCP tools: {}",
                tools
                    .tools
                    .iter()
                    .map(|tool| tool.name.as_ref())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            let result = client
                .call_tool(
                    CallToolRequestParams::new("echo").with_arguments(
                        serde_json::json!({ "text": "GeoD MCP OK" })
                            .as_object()
                            .unwrap()
                            .clone(),
                    ),
                )
                .await
                .unwrap();
            assert!(serde_json::to_string(&result)
                .unwrap()
                .contains("GeoD MCP OK"));
            let _ = client.cancel().await;
        });
    }

    #[test]
    #[ignore = "requires a running MCP server such as test/mcp-mock.mjs"]
    fn mcp_call_result_is_reused_after_restart_and_unknown_is_not_retried() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("extensions.json");
        let url = std::env::var("GEOD_TEST_MCP_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:43121/mcp".to_owned());
        let state = ExtensionState::new(path.clone());
        state
            .update(|store| {
                store.connectors.push(Connector {
                    id: "test-connector".into(),
                    name: "Local mock".into(),
                    url,
                    enabled: true,
                    transport: ConnectorTransport::Http,
                });
                Ok(())
            })
            .unwrap();
        tauri::async_runtime::block_on(async {
            let arguments = serde_json::json!({ "text": "idempotent result" });
            let first = call_mcp_with_state(
                &state,
                "test-connector".into(),
                "echo".into(),
                arguments.clone(),
                "generation-1:call-1".into(),
                None,
            )
            .await
            .unwrap();
            assert!(first.to_string().contains("idempotent result"));
            let reopened = ExtensionState::new(path);
            reopened
                .update(|store| {
                    store.connectors[0].url = "http://127.0.0.1:1/mcp".into();
                    Ok(())
                })
                .unwrap();
            let second = call_mcp_with_state(
                &reopened,
                "test-connector".into(),
                "echo".into(),
                arguments.clone(),
                "generation-1:call-1".into(),
                None,
            )
            .await
            .unwrap();
            assert_eq!(first, second);
            let conflict = call_mcp_with_state(
                &reopened,
                "test-connector".into(),
                "echo".into(),
                serde_json::json!({ "text": "changed" }),
                "generation-1:call-1".into(),
                None,
            )
            .await
            .unwrap_err();
            assert_eq!(conflict.code, "MCP_EXECUTION_CONFLICT");
            reopened.update(|store| {
                store.mcp_calls.push(McpCallRecord { execution_id: "generation-2:call-2".into(), fingerprint: format!("{:x}", Sha256::digest(serde_json::to_vec(&serde_json::json!({ "connectorId": "test-connector", "toolName": "echo", "arguments": arguments })).unwrap())), result: None, owner:None });
                Ok(())
            }).unwrap();
            let unknown = call_mcp_with_state(
                &reopened,
                "test-connector".into(),
                "echo".into(),
                arguments,
                "generation-2:call-2".into(),
                None,
            )
            .await
            .unwrap_err();
            assert_eq!(unknown.code, "MCP_RESULT_UNKNOWN");
        });
    }

    #[test]
    fn large_mcp_results_are_saved_and_read_without_losing_content() {
        let dir = tempfile::tempdir().unwrap();
        let state = ExtensionState::new(dir.path().join("extensions.json"));
        let execution_id = "generation-paged:call-1";
        let original = serde_json::json!({
            "content": [{"type": "text", "text": "中国影像图层".repeat(2_000)}],
            "isError": false,
        });
        state.update(|store| {
            store.mcp_calls.push(McpCallRecord {
                execution_id: execution_id.into(),
                fingerprint: "test".into(),
                result: Some(original.clone()),
                owner: None,
            });
            Ok(())
        }).unwrap();
        let reopened = ExtensionState::new(dir.path().join("extensions.json"));
        let mut offset = 0usize;
        let mut reconstructed = String::new();
        loop {
            let page = read_mcp_result_with_state(&reopened, execution_id, offset).unwrap();
            assert_eq!(page["executionId"], execution_id);
            assert_eq!(page["offset"], offset);
            reconstructed.push_str(page["content"].as_str().unwrap());
            if page["complete"] == true { break; }
            offset = page["nextOffset"].as_u64().unwrap() as usize;
        }
        assert_eq!(serde_json::from_str::<Value>(&reconstructed).unwrap(), original);
        assert_eq!(read_mcp_result_with_state(&reopened, execution_id, offset + MCP_RESULT_PAGE_CHARS * 100).unwrap_err().code, "INVALID_MCP_RESULT_OFFSET");
    }

    #[test]
    fn private_mcp_results_remain_owned_after_reopen() {
        let dir=tempfile::tempdir().unwrap();
        let path=dir.path().join("extensions.json");
        ExtensionState::new(path.clone()).update(|store|{
            store.mcp_calls.push(McpCallRecord{execution_id:"owned:call".into(),fingerprint:"test".into(),result:Some(serde_json::json!({"content":[]})),owner:Some("alice".into())});Ok(())
        }).unwrap();
        let state=ExtensionState::new(path);
        assert!(read_mcp_result_for_owner(&state,"owned:call",0,Some("alice")).is_ok());
        assert_eq!(read_mcp_result_for_owner(&state,"owned:call",0,Some("bob")).unwrap_err().code,"MCP_RESULT_NOT_FOUND");
        assert_eq!(read_mcp_result_for_owner(&state,"owned:call",0,None).unwrap_err().code,"MCP_RESULT_NOT_FOUND");
    }

    #[test]
    #[ignore = "requires the local test/mcp-mock.mjs service"]
    fn large_mock_mcp_call_round_trips_through_saved_pages() {
        tauri::async_runtime::block_on(async {
            let dir = tempfile::tempdir().unwrap();
            let state = ExtensionState::new(dir.path().join("extensions.json"));
            state.update(|store| {
                store.connectors.push(Connector {
                    id: "local-large".into(),
                    name: "Local paging test".into(),
                    url: "http://127.0.0.1:43121/mcp".into(),
                    enabled: true,
                    transport: ConnectorTransport::Http,
                });
                Ok(())
            }).unwrap();
            let execution_id = "generation-large:call-1";
            let first = call_mcp_with_state(
                &state, "local-large".into(), "large_result".into(),
                serde_json::json!({}), execution_id.into(),
                None,
            ).await.unwrap();
            assert_eq!(first["paged"], true);
            let reopened = ExtensionState::new(dir.path().join("extensions.json"));
            let mut page = first;
            let mut serialized = String::new();
            loop {
                serialized.push_str(page["content"].as_str().unwrap());
                if page["complete"] == true { break; }
                let offset = page["nextOffset"].as_u64().unwrap() as usize;
                page = read_mcp_result_with_state(&reopened, execution_id, offset).unwrap();
            }
            let result: Value = serde_json::from_str(&serialized).unwrap();
            assert!(result["content"][0]["text"].as_str().unwrap().contains("中国影像图层"));
            assert!(result["content"][0]["text"].as_str().unwrap().len() > 16_000);
        });
    }

    #[test]
    #[ignore = "requires access to the public MCP Registry"]
    fn registry_search_returns_catalogue() {
        tauri::async_runtime::block_on(async {
            let client = http_client("https://registry.modelcontextprotocol.io/").unwrap();
            let payload: Value = client
                .get("https://registry.modelcontextprotocol.io/v0.1/servers")
                .query(&[("search", "weather"), ("limit", "2")])
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert!(payload.get("servers").and_then(Value::as_array).is_some());
        });
    }
}

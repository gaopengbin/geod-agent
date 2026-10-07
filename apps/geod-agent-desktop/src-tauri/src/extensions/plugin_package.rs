//! Local portable Agent Plugins / Codex compatibility bundles, using GeoD's native MCP dispatcher.
use super::*;
use serde_json::json;
use std::collections::BTreeSet;
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    pub id: String,
    pub owner: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub format: String,
    pub sha256: String,
    pub installed_at: String,
    pub skill_ids: Vec<String>,
    pub connector_ids: Vec<String>,
    #[serde(default)]
    pub mcp_server_ids: BTreeMap<String,String>,
    #[serde(default)]
    pub registered_apps: Vec<super::plugin_apps::Declaration>,
    #[serde(default)]
    pub source: Option<MarketSource>,
    #[serde(default)]
    pub hooks: Vec<super::plugin_hooks::Group>,
    #[serde(default)]
    pub hooks_enabled: bool,
    #[serde(default)]
    pub hooks_reviewed_sha256: Option<String>,
    #[serde(default)]
    pub resource_sha256: BTreeMap<String,String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarketSource {
    pub repository: String,
    pub commit: String,
    pub path: String,
    pub marketplace: String,
}
struct Server { alias: String, name: String, url: String, command: Option<String>, secret: crate::mcp_credentials::Secret, runtime: crate::mcp_runtime_config::Settings, enabled: bool }
pub(super) struct Package { pub record: Record, skills: Vec<Skill>, servers: Vec<Server>, files: BTreeMap<String, Vec<u8>> }

fn text<'a>(v: &'a Value, key: &str) -> &'a str { v[key].as_str().unwrap_or("") }
pub(super) fn relative_path(raw: &str) -> Result<String, AppError> {
    let path=raw.strip_prefix("./").ok_or_else(||error("PLUGIN_PATH_INVALID","插件引用路径须以 ./ 开头"))?;
    validate_bundle_path(path.trim_end_matches('/')).map_err(|_|error("PLUGIN_PATH_INVALID","插件引用路径必须位于包内"))?;
    Ok(path.trim_end_matches('/').into())
}
pub(super) fn snapshot(root: &Path) -> Result<BTreeMap<String,Vec<u8>>,AppError> {
    let mut all=BTreeMap::new();let mut folders=vec![root.to_path_buf()];let mut bytes=0;
    while let Some(folder)=folders.pop(){
        for entry in fs::read_dir(folder).map_err(|_|error("PLUGIN_READ_FAILED","无法读取插件包"))? {
            let entry=entry.map_err(|_|error("PLUGIN_READ_FAILED","无法读取插件包"))?;
            if matches!(entry.file_name().to_str(),Some(".git"|"node_modules"|"__pycache__"|".venv")){continue;}
            let metadata=fs::symlink_metadata(entry.path()).map_err(|_|error("PLUGIN_READ_FAILED","无法读取插件资源"))?;
            #[cfg(windows)]
            let linked={use std::os::windows::fs::MetadataExt;metadata.file_attributes()&0x400!=0};
            #[cfg(not(windows))]
            let linked=metadata.file_type().is_symlink();
            if linked||!fs::canonicalize(entry.path()).map_err(|_|error("PLUGIN_PATH_INVALID","插件资源路径无效"))?.starts_with(root){return Err(error("PLUGIN_PATH_INVALID","插件包不能引用包外资源或目录链接"));}
            if metadata.is_dir(){folders.push(entry.path());continue;}
            if !metadata.is_file(){return Err(error("PLUGIN_PATH_INVALID","插件资源必须是普通文件"));}
            let relative=entry.path().strip_prefix(root).unwrap().to_string_lossy().replace('\\',"/");
            validate_bundle_path(&relative).map_err(|_|error("PLUGIN_PATH_INVALID","插件资源路径无效"))?;
            if all.len()>=512||metadata.len()>4*1024*1024||bytes+metadata.len()>16*1024*1024{return Err(error("PLUGIN_TOO_LARGE","插件包限 512 个文件、合计 16 MiB；依赖请使用独立运行环境"));}
            let content=fs::read(entry.path()).map_err(|_|error("PLUGIN_READ_FAILED","无法读取插件资源"))?;
            bytes+=content.len() as u64;
            if bytes>16*1024*1024||content.len()>4*1024*1024{return Err(error("PLUGIN_TOO_LARGE","读取期间插件资源超过大小限制"));}
            all.insert(relative,content);
        }
    }
    Ok(all)
}
pub(super) fn json_file(files:&BTreeMap<String,Vec<u8>>,path:&str)->Result<Value,AppError>{
    let bytes=files.get(path).ok_or_else(||error("PLUGIN_INVALID","缺少插件清单或引用的配置文件"))?;
    if bytes.len()>128*1024{return Err(error("PLUGIN_INVALID","插件配置文件不能超过 128 KiB"));}
    serde_json::from_slice(bytes).map_err(|_|error("PLUGIN_INVALID","插件配置必须是有效 JSON"))
}
fn skill_roots(overlay:&Value,portable:bool)->Result<Vec<String>,AppError>{
    // Portable components remain canonical even when an OpenAI overlay is present.
    if portable{return Ok(vec!["skills".into()]);}
    let Some(value)=overlay.get("skills").filter(|value|!value.is_null())else{return Ok(vec!["skills".into()]);};
    let values=if value.is_string(){vec![value.clone()]}else{value.as_array().cloned().ok_or_else(||error("PLUGIN_INVALID","插件 skills 须为包内路径或路径数组"))?};
    let mut roots=BTreeSet::new();
    for value in values {roots.insert(relative_path(value.as_str().ok_or_else(||error("PLUGIN_INVALID","插件 skills 须为包内路径或路径数组"))?)?);}
    if roots.is_empty(){roots.insert("skills".into());}
    Ok(roots.into_iter().collect())
}
fn mcp_component(overlay:&Value,all:&BTreeMap<String,Vec<u8>>,portable:bool)->Result<(Option<String>,Option<Value>),AppError>{
    if !portable {
        match overlay.get("mcpServers").filter(|value|!value.is_null()) {
            Some(value) if value.is_object()=>return Ok((None,Some(value.clone()))),
            Some(Value::String(path))=>{let path=relative_path(path)?;let config=json_file(all,&path)?;return Ok((Some(path),Some(config)));},
            Some(_)=>return Err(error("PLUGIN_INVALID","插件 mcpServers 须为包内路径或服务配置对象")),
            None=>{}
        }
    }
    let path=if portable{"mcp.json"}else{".mcp.json"}.to_owned();
    let config=all.contains_key(&path).then(||json_file(all,&path)).transpose()?;
    Ok((Some(path),config))
}
fn qualified_skill_name(plugin: &str, skill: &str) -> String {
    let full=format!("{plugin}-{skill}");
    if full.len()<=64 {return full;}
    let suffix=format!("{:x}",Sha256::digest(&full));
    format!("{}-{}",full[..53].trim_end_matches('-'),&suffix[..10])
}
pub(super) fn parse(root:&Path,owner:&str)->Result<Package,AppError>{
    let root=fs::canonicalize(root).map_err(|_|error("PLUGIN_READ_FAILED","请选择包含 plugin.json 的插件文件夹"))?;
    if !root.is_dir(){return Err(error("PLUGIN_INVALID","请选择插件文件夹"));}
    let all=snapshot(&root)?;
    let portable=all.contains_key("plugin.json");
    let manifest_path=if portable{"plugin.json"}else{".codex-plugin/plugin.json"};
    let manifest=json_file(&all,manifest_path)?;
    let overlay=if portable {if manifest["extensions"]["com.openai"].is_object(){manifest["extensions"]["com.openai"].clone()}else if all.contains_key(".codex-plugin/plugin.json"){json_file(&all,".codex-plugin/plugin.json")?}else{json!({})}}else{manifest.clone()};
    if !text(&manifest,"name").bytes().all(|c|c.is_ascii_lowercase()||c.is_ascii_digit()||c==b'-')
        || text(&manifest,"name").is_empty()||text(&manifest,"name").len()>40||text(&manifest,"name").starts_with('-')||text(&manifest,"name").ends_with('-')||text(&manifest,"name").contains("--") {
        return Err(error("PLUGIN_INVALID","插件名称须为小写字母、数字及单连字符，长度不超过 40"));
    }
    let (registered_apps,app_path)=super::plugin_apps::parse(&overlay,&all)?;
    let hooks=super::plugin_hooks::parse(&overlay,&all)?;
    let name=text(&manifest,"name").to_owned();
    let display_name=overlay["interface"]["displayName"].as_str().filter(|s|!s.trim().is_empty()).unwrap_or(&name).to_owned();
    let description=text(&manifest,"description").to_owned();
    let version=manifest["version"].as_str().unwrap_or("未标注").to_owned();
    if display_name.chars().count()>120||description.chars().count()>1024||version.len()>64||version.chars().any(char::is_control){return Err(error("PLUGIN_INVALID","插件名称、描述或版本过长"));}
    let skill_roots=skill_roots(&overlay,portable)?;
    let mut skills=Vec::new();let mut names=BTreeSet::new();
    for (path,bytes) in &all {
        let Some(folder)=path.strip_suffix("/SKILL.md")else{continue;};
        if !skill_roots.iter().any(|root|folder==root||folder.starts_with(&format!("{root}/"))){continue;}
        let content=String::from_utf8(bytes.clone()).map_err(|_|error("PLUGIN_INVALID","Skill 指令必须使用 UTF-8"))?;
        let mut skill=parse_skill_document(content.clone(),folder.rsplit('/').next())?;
        let qualified=qualified_skill_name(&name,&skill.name);
        if qualified.len()>64||!names.insert(qualified.clone()){return Err(error("PLUGIN_INVALID","插件技能名称重复或加前缀后超过 64 字符"));}
        // Preserve the source snapshot, and give exported skills a stable, collision-free plugin prefix.
        let rest=content.strip_prefix("---\n").or_else(||content.strip_prefix("---\r\n")).unwrap();
        let (header,body)=rest.split_once("\n---").unwrap();
        let mut metadata:serde_yaml::Value=serde_yaml::from_str(header).map_err(|_|error("PLUGIN_INVALID","Skill 元信息无效"))?;
        metadata["name"]=serde_yaml::Value::String(qualified.clone());
        skill.name=qualified;skill.content=format!("---\n{}---{}",serde_yaml::to_string(&metadata).map_err(|_|error("PLUGIN_INVALID","Skill 元信息无效"))?,body);
        let prefix=format!("{folder}/");
        skill.files=all.iter().filter_map(|(p,b)|p.strip_prefix(&prefix).filter(|p|*p!="SKILL.md").map(|p|(p.to_owned(),b.clone()))).collect();
        skill.source_url=Some(format!("plugin:{name}/{}",folder));
        skill.content_sha256=Some(format!("{:x}",Sha256::digest(bytes)));
        skills.push(skill);
    }
    let (mcp_path,mcp_config)=mcp_component(&overlay,&all,portable)?;
    let mut servers=Vec::new();
    if let Some(config)=mcp_config {
        // Codex compatibility accepts both the wrapped document and a direct server map.
        let configs=if portable||config.get("mcpServers").is_some(){config["mcpServers"].as_object()}else{config.as_object()}
            .ok_or_else(||error("PLUGIN_INVALID","MCP 配置缺少 mcpServers 对象"))?;
        if configs.len()>20{return Err(error("PLUGIN_TOO_LARGE","每个插件最多包含 20 个 MCP 服务"));}
        for (label,config) in configs {
            if label.is_empty()||label.len()>80{return Err(error("PLUGIN_INVALID","MCP 服务名称无效"));}
            let config=config.as_object().ok_or_else(||error("PLUGIN_INVALID","MCP 服务配置须为对象"))?;
            if config.keys().any(|k|!matches!(k.as_str(),"type"|"command"|"args"|"env"|"url"|"headers"|"http_headers"|"cwd"|"env_vars"|"env_http_headers"|"bearer_token_env_var"|"startup_timeout_sec"|"startup_timeout_ms"|"tool_timeout_sec"|"enabled_tools"|"disabled_tools"|"enabled")){return Err(error("PLUGIN_COMPONENT_UNSUPPORTED","MCP 配置含尚未支持的字段"));}
            let config=Value::Object(config.clone());
            let command=config.get("command").filter(|value|!value.is_null()).map(|v|v.as_str().map(str::to_owned).ok_or_else(||error("PLUGIN_INVALID","MCP command 须为字符串"))).transpose()?;
            let url=text(&config,"url").to_owned();
            let transport=text(&config,"type");
            if portable&&transport.is_empty(){return Err(error("PLUGIN_INVALID","可移植 mcp.json 须声明 type"));}
            if !matches!(transport,""|"stdio"|"http"|"streamable-http")||(command.is_some()&&!matches!(transport,""|"stdio"))||(command.is_none()&&transport=="stdio"){return Err(error("PLUGIN_COMPONENT_UNSUPPORTED","仅支持 stdio 和 Streamable HTTP MCP"));}
            let decode=|key:&str,default:Value|config.get(key).filter(|value|!value.is_null()).cloned().unwrap_or(default);
            let secret=crate::mcp_credentials::Secret {
                query:BTreeMap::new(),
                args:serde_json::from_value(decode("args",json!([]))).map_err(|_|error("PLUGIN_INVALID","MCP args 须为字符串数组"))?,
                env:serde_json::from_value(decode("env",json!({}))).map_err(|_|error("PLUGIN_INVALID","MCP env 须为字符串对象"))?,
                headers:serde_json::from_value(config.get("headers").filter(|value|!value.is_null()).or_else(||config.get("http_headers").filter(|value|!value.is_null())).cloned().unwrap_or(json!({}))).map_err(|_|error("PLUGIN_INVALID","MCP headers 须为字符串对象"))?,
            };
            crate::mcp_credentials::validate(command.as_deref(),&secret)?;
            if command.is_none(){valid_mcp_url(&url)?;}else if !url.is_empty(){return Err(error("PLUGIN_INVALID","stdio MCP 不使用服务网址"));}
            let runtime=crate::mcp_runtime_config::Settings::from_plugin(&config,command.is_some())?;
            let enabled=config.get("enabled").filter(|value|!value.is_null()).map(|value|value.as_bool().ok_or_else(||error("PLUGIN_INVALID","MCP enabled 须为布尔值"))).transpose()?.unwrap_or(true);
            servers.push(Server{alias:label.clone(),name:format!("{display_name} · {label}"),url,command,secret,runtime,enabled});
        }
    }
    for handler in hooks.iter().flat_map(|group|&group.handlers).filter(|handler|handler["type"]=="mcp_tool") {
        if !servers.iter().any(|server|Some(server.alias.as_str())==handler["server"].as_str()) {return Err(error("PLUGIN_HOOK_INVALID","MCP 自动化须引用本插件声明的工具服务"));}
    }
    if skills.is_empty()&&servers.is_empty()&&hooks.is_empty()&&registered_apps.is_empty(){return Err(error("PLUGIN_EMPTY","插件没有可接入的 Skill、MCP、自动化或应用声明"));}
    let sha256=format!("{:x}",Sha256::digest(serde_json::to_vec(&all).map_err(|_|error("PLUGIN_INVALID","插件内容无效"))?));
    let files:BTreeMap<String,Vec<u8>>=all.into_iter().filter(|(path,_)|path!=manifest_path&&path!="plugin.json"&&path!=".codex-plugin/plugin.json"&&Some(path)!=mcp_path.as_ref()&&path!=&app_path&&path!=".app.json"&&path!=".mcp.json"&&path!="mcp.json"&&!path.rsplit('/').next().is_some_and(|p|p==".env"||p.starts_with(".env."))).collect();
    let resource_sha256=files.iter().map(|(path,bytes)|(path.clone(),format!("{:x}",Sha256::digest(bytes)))).collect();
    Ok(Package {record:Record{id:Uuid::new_v4().to_string(),owner:owner.into(),name,display_name,description,version,format:if portable{"agentPlugins"}else{"codex"}.into(),sha256,installed_at:chrono::Utc::now().to_rfc3339(),skill_ids:vec![],connector_ids:vec![],mcp_server_ids:BTreeMap::new(),registered_apps,source:None,hooks,hooks_enabled:false,hooks_reviewed_sha256:None,resource_sha256},skills,servers,files})
}
pub(super) fn summary(record:&Record,store:Option<&ExtensionStore>)->Value{
    let enabled_skills=store.map(|s|s.skills.iter().filter(|x|record.skill_ids.contains(&x.id)&&x.enabled).count()).unwrap_or(0);
    let enabled_connectors=store.map(|s|s.connectors.iter().filter(|x|record.connector_ids.contains(&x.id)&&x.enabled).count()).unwrap_or(0);
    let reviewed=record.hooks_reviewed_sha256.as_deref()==Some(&record.sha256);let hooks=super::plugin_hooks::count(&record.hooks);
    json!({"id":record.id,"name":record.name,"displayName":record.display_name,"description":record.description,"version":record.version,"format":record.format,"sha256":record.sha256,"installedAt":record.installed_at,"skillIds":record.skill_ids,"connectorIds":record.connector_ids,"enabledSkills":enabled_skills,"enabledConnectors":enabled_connectors,"source":record.source,"hooksCount":hooks,"hooksReviewed":reviewed,"enabledHooks":if reviewed&&record.hooks_enabled{hooks}else{0},"registeredApps":super::plugin_apps::summary(record,store)})
}
pub(super) fn package_root(state:&ExtensionState,id:&str)->Result<PathBuf,AppError>{
    scoped_root(state,"plugin-packages",id)
}
pub(super) fn scoped_root(state:&ExtensionState,folder:&str,id:&str)->Result<PathBuf,AppError>{
    Uuid::parse_str(id).map_err(|_|error("PLUGIN_INVALID","插件标识无效"))?;
    let storage=state.path.parent().ok_or_else(||error("PLUGIN_STORAGE","无法读取插件保存位置"))?;
    let base=storage.canonicalize().map_err(|_|error("PLUGIN_STORAGE","应用保存位置不可读"))?;
    let parent=storage.join(folder);let root=parent.join(id);
    for (path,expected) in [(&parent,base.join(folder)),(&root,base.join(folder).join(id))] {
        if path.exists()&&(!path.is_dir()||path.canonicalize().map_err(|_|error("PLUGIN_STORAGE","插件保存位置不可读"))?!=expected){return Err(error("PLUGIN_PATH_INVALID","插件保存位置越出了应用保存范围"));}
    }
    Ok(root)
}
pub(super) fn runtime_skill_content(state: &ExtensionState, store: &ExtensionStore, skill: &Skill) -> Result<String,AppError> {
    let Some(plugin)=store.plugins.iter().find(|plugin|plugin.skill_ids.contains(&skill.id))else{return Ok(skill.content.clone());};
    let root=package_root(state,&plugin.id)?.to_string_lossy().replace('\\',"/");
    let content=skill.content.replace("<installed-plugin-root>",&root)
        .replace("${PLUGIN_ROOT}",&root).replace("${CODEX_PLUGIN_ROOT}",&root).replace("${CLAUDE_PLUGIN_ROOT}",&root);
    let Some((header,body))=content.split_once("\n---")else{return Err(error("PLUGIN_INVALID","已安装插件的 Skill 元信息不可读"));};
    Ok(format!("{header}\n---\n\nPlugin package directory: {root}\nUse this directory for the plugin's shared scripts and resources. Quote paths containing spaces. Keep task files in the user's workspace.\n{body}"))
}
fn rooted(value:&str,root:&Path)->Result<String,AppError>{
    let root=root.to_string_lossy();
    let mut result=value.replace("${PLUGIN_ROOT}",&root).replace("${CODEX_PLUGIN_ROOT}",&root).replace("${CLAUDE_PLUGIN_ROOT}",&root);
    if result.starts_with("./"){result=Path::new(root.as_ref()).join(relative_path(&result)?).to_string_lossy().into_owned();}
    if result.contains("${"){return Err(error("PLUGIN_CONFIG_REQUIRED","插件包含未填写的环境变量，请在包的 MCP 配置中提供值后导入"));}
    Ok(result)
}
pub(super) fn install(state:&ExtensionState,mut package:Package,expected:&str,enabled:bool)->Result<Value,AppError>{
    if package.record.sha256!=expected{return Err(error("PLUGIN_CHANGED","插件包在检查后发生变化，请重新检查"));}
    let snapshot=state.load()?;
    if let Some(previous)=snapshot.plugins.iter().find(|p|p.owner==package.record.owner&&p.name==package.record.name){
        if previous.sha256==expected{return Ok(summary(previous,Some(&snapshot)));}
        return Err(error("PLUGIN_EXISTS","当前账号已安装同名插件；请核对版本并移除旧包后导入"));
    }
    let root=package_root(state,&package.record.id)?;
    let mut credentials=Vec::new();
    let result=(||{
        fs::create_dir_all(&root).map_err(|_|error("PLUGIN_STORAGE","无法保存插件包"))?;
        for (path,bytes) in &package.files {
            let destination=root.join(path);if let Some(parent)=destination.parent(){fs::create_dir_all(parent).map_err(|_|error("PLUGIN_STORAGE","无法保存插件资源"))?;}
            fs::write(destination,bytes).map_err(|_|error("PLUGIN_STORAGE","无法保存插件资源"))?;
        }
        let mut connectors=Vec::new();let mut settings=BTreeMap::new();
        for mut server in package.servers {
            let id=Uuid::new_v4().to_string();
            let command=server.command.map(|v|rooted(&v,&root)).transpose()?;
            server.secret.args=server.secret.args.iter().map(|v|rooted(v,&root)).collect::<Result<_,_>>()?;
            server.secret.env=server.secret.env.iter().map(|(k,v)|Ok((k.clone(),rooted(v,&root)?))).collect::<Result<_,AppError>>()?;
            server.runtime.cwd=server.runtime.cwd.map(|value|if value=="./"{Ok(root.to_string_lossy().into_owned())}else{rooted(&value,&root)}).transpose()?;
            server.runtime.validate(command.is_some())?;
            crate::mcp_credentials::validate(command.as_deref(),&server.secret)?;
            crate::mcp_credentials::save(&state.path,&id,&server.secret)?;credentials.push(id.clone());
            settings.insert(id.clone(),crate::mcp_credentials::Metadata{owner:package.record.owner.clone(),command:command.clone(),header_names:server.secret.headers.keys().cloned().collect(),query_names:vec![],env_names:server.secret.env.keys().cloned().collect(),argument_count:server.secret.args.len(),oauth:false,runtime:server.runtime});
            connectors.push(Connector{id:id.clone(),name:server.name,url:server.url,enabled:enabled&&server.enabled,transport:if command.is_some(){ConnectorTransport::Stdio}else{ConnectorTransport::Http}});
            package.record.mcp_server_ids.insert(server.alias,id.clone());
            package.record.connector_ids.push(id);
        }
        for skill in &mut package.skills {
            skill.content=skill.content.replace("${PLUGIN_ROOT}",&root.to_string_lossy()).replace("${CODEX_PLUGIN_ROOT}",&root.to_string_lossy()).replace("${CLAUDE_PLUGIN_ROOT}",&root.to_string_lossy());
            skill.enabled=enabled;package.record.skill_ids.push(skill.id.clone());
        }
        let updated=state.update(|store|{
            if store.plugins.iter().any(|p|p.owner==package.record.owner&&p.name==package.record.name){return Err(error("PLUGIN_EXISTS","此插件已安装"));}
            if store.skills.iter().any(|s|package.skills.iter().any(|n|n.name==s.name)&&store.skill_owners.get(&s.id).is_none_or(|o|o==&package.record.owner)){return Err(error("SKILL_CONFLICT","插件前缀后的 Skill 名称与现有技能冲突"));}
            for skill in &package.skills {store.skill_owners.insert(skill.id.clone(),package.record.owner.clone());}
            store.skills.extend(package.skills);store.connectors.extend(connectors);store.connector_settings.extend(settings);store.plugins.push(package.record.clone());Ok(())
        })?;
        Ok(summary(&package.record,Some(&updated)))
    })();
    if result.is_err(){for id in credentials{let _=crate::mcp_credentials::remove(&state.path,&id);}let _=fs::remove_dir_all(&root);}
    result
}
fn current_owner(services:&services::ServiceState)->Result<String,AppError>{services::current_user_id(services).map_err(|e|error(e.code,&e.message))}
#[tauri::command]
pub(crate) fn plugin_preview(services:State<'_,services::ServiceState>,path:String)->Result<Value,AppError>{
    let package=parse(Path::new(&path),&current_owner(&services)?)?;
    Ok(preview(&package))
}
pub(super) fn preview(package:&Package)->Value{
    json!({"name":package.record.name,"displayName":package.record.display_name,"version":package.record.version,"description":package.record.description,"format":package.record.format,"sha256":package.record.sha256,"source":package.record.source,
        "skills":package.skills.iter().map(|s|json!({"name":s.name,"description":s.description,"content":s.content})).collect::<Vec<_>>(),"hooks":package.record.hooks,"registeredApps":super::plugin_apps::preview(&package.record,&package.servers.iter().map(|s|s.alias.clone()).collect::<Vec<_>>()),
        "connectors":package.servers.iter().map(|s|json!({"name":s.name,"url":s.url,"command":s.command,"argumentCount":s.secret.args.len(),"envNames":s.secret.env.keys().collect::<Vec<_>>(),"headerNames":s.secret.headers.keys().collect::<Vec<_>>(),"runtime":s.runtime,"enabled":s.enabled})).collect::<Vec<_>>() })
}
#[tauri::command]
pub(crate) fn plugin_import(state:State<'_,ExtensionState>,services:State<'_,services::ServiceState>,path:String,expected_sha256:String,enabled:bool,hooks_approved:Option<bool>)->Result<Value,AppError>{
    let mut package=parse(Path::new(&path),&current_owner(&services)?)?;
    if hooks_approved==Some(true)&&!package.record.hooks.is_empty(){package.record.hooks_reviewed_sha256=Some(expected_sha256.clone());package.record.hooks_enabled=enabled;}
    install(&state,package,&expected_sha256,enabled)
}
#[tauri::command]
pub(crate) fn plugins_list(state:State<'_,ExtensionState>,services:State<'_,services::ServiceState>)->Result<Value,AppError>{
    let owner=current_owner(&services)?;let store=state.load()?;
    Ok(json!({"plugins":store.plugins.iter().filter(|p|p.owner==owner).map(|p|summary(p,Some(&store))).collect::<Vec<_>>()}))
}
#[tauri::command]
pub(crate) fn plugin_set_enabled(state:State<'_,ExtensionState>,services:State<'_,services::ServiceState>,id:String,enabled:bool)->Result<Value,AppError>{
    let owner=current_owner(&services)?;let mut record=None;
    let updated=state.update(|store|{
        let found=store.plugins.iter().find(|p|p.id==id&&p.owner==owner).cloned().ok_or_else(||error("PLUGIN_NOT_FOUND","未找到当前账号的插件"))?;
        for skill in &mut store.skills{if found.skill_ids.contains(&skill.id){skill.enabled=enabled;}}
        for connector in &mut store.connectors{if found.connector_ids.contains(&connector.id){connector.enabled=enabled;}}
        if let Some(record)=store.plugins.iter_mut().find(|record|record.id==id){record.hooks_enabled=enabled&&record.hooks_reviewed_sha256.as_deref()==Some(&record.sha256);}
        record=store.plugins.iter().find(|record|record.id==id).cloned();Ok(())
    })?;
    Ok(summary(&record.unwrap(),Some(&updated)))
}
#[tauri::command]
pub(crate) async fn plugin_remove(app:AppHandle,state:State<'_,ExtensionState>,services:State<'_,services::ServiceState>,id:String)->Result<Value,AppError>{
    use rmcp::transport::auth::CredentialStore;
    let owner=current_owner(&services)?;let snapshot=state.load()?;
    let record=snapshot.plugins.iter().find(|p|p.id==id&&p.owner==owner).cloned().ok_or_else(||error("PLUGIN_NOT_FOUND","未找到当前账号的插件"))?;
    let root=package_root(&state,&id)?;
    // Hold refresh guards through removal so late OAuth results cannot resurrect credentials.
    let mut vaults=Vec::new();let mut guards=Vec::new();
    for connector in &record.connector_ids {
        app.state::<crate::mcp_oauth::OAuthState>().abort_connector(connector,&owner)?;
        let vault=crate::mcp_oauth::VaultStore{path:state.path.clone(),id:connector.clone()};
        guards.push(vault.acquire_refresh_guard().await.map_err(|_|error("MCP_AUTH_BUSY","授权正在更新，请稍后移除"))?);vaults.push(vault);
    }
    state.update(|store|{
        if !store.plugins.iter().any(|p|p.id==id&&p.owner==owner){return Err(error("PLUGIN_NOT_FOUND","此插件已移除"));}
        store.skills.retain(|s|!record.skill_ids.contains(&s.id));
        for skill in &record.skill_ids{store.skill_owners.remove(skill);}
        store.connectors.retain(|c|!record.connector_ids.contains(&c.id));
        for connector in &record.connector_ids{store.connector_settings.remove(connector);}
        store.plugins.retain(|p|p.id!=id);Ok(())
    })?;
    for connector in &record.connector_ids{crate::mcp_credentials::remove(&state.path,connector)?;}
    for vault in vaults{vault.clear().await.map_err(|_|error("PLUGIN_CREDENTIAL_FAILED","插件已移除，授权凭据清理失败"))?;}
    if root.exists(){fs::remove_dir_all(root).map_err(|_|error("PLUGIN_STORAGE","插件已停用，资源文件清理失败"))?;}
    let data=super::plugin_hooks::data_root(&state,&id)?;
    if data.exists(){fs::remove_dir_all(data).map_err(|_|error("PLUGIN_STORAGE","插件已停用，自动化数据清理失败"))?;}
    Ok(json!({"removed":true,"id":id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root:&Path){
        fs::create_dir_all(root.join("skills/read-map")).unwrap();
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(root.join("scripts/check.txt"),"installed shared resource").unwrap();
        fs::write(root.join("plugin.json"),r#"{"name":"qa-map","version":"1.0.0","description":"QA"}"#).unwrap();
        fs::write(root.join("skills/read-map/SKILL.md"),"---\nname: read-map\ndescription: Read actual map data\n---\nRead <installed-plugin-root>/scripts/check.txt through real tools.").unwrap();
    }
    #[test]
    fn snapshot_hash_namespaces_and_owner_exports(){
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("source");fixture(&source);
        let state=ExtensionState::new(dir.path().join("extensions.json"));
        let package=parse(&source,"one").unwrap();assert_eq!(package.skills[0].name,"qa-map-read-map");
        assert!(package.skills[0].content.contains("name: qa-map-read-map"));
        let hash=package.record.sha256.clone();
        let installed=install(&state,package,&hash,true).unwrap();
        fs::remove_dir_all(&source).unwrap();
        let a=dir.path().join("home-a");state.codex_bundle_owned(&a,"one").unwrap();assert!(a.join("skills/qa-map-read-map/SKILL.md").exists());
        let exported=fs::read_to_string(a.join("skills/qa-map-read-map/SKILL.md")).unwrap();
        let installed_root=package_root(&state,installed["id"].as_str().unwrap()).unwrap();
        assert!(exported.contains(&installed_root.to_string_lossy().replace('\\',"/")));assert!(!exported.contains("<installed-plugin-root>"));
        assert_eq!(fs::read_to_string(installed_root.join("scripts/check.txt")).unwrap(),"installed shared resource");
        let b=dir.path().join("home-b");state.codex_bundle_owned(&b,"two").unwrap();assert!(!b.join("skills/qa-map-read-map/SKILL.md").exists());
        let store=state.load().unwrap();assert_eq!(store.plugins[0].id,installed["id"].as_str().unwrap());
        assert!(visible_to(store,Some("two")).plugins.is_empty());
    }
    #[test]
    fn changed_package_and_unsupported_components_do_not_install(){
        let dir=tempfile::tempdir().unwrap();fixture(dir.path());let old=parse(dir.path(),"one").unwrap().record.sha256;
        fs::write(dir.path().join("skills/read-map/reference.txt"),"changed").unwrap();
        let state=ExtensionState::new(dir.path().join("extensions-store.json"));
        assert_eq!(install(&state,parse(dir.path(),"one").unwrap(),&old,true).unwrap_err().code,"PLUGIN_CHANGED");
        assert!(state.load().unwrap().plugins.is_empty());
        fs::write(dir.path().join("plugin.json"),r#"{"name":"qa-map","version":"1.0.0","extensions":{"com.openai":{"apps":"./.app.json"}}}"#).unwrap();
        assert_eq!(parse(dir.path(),"one").err().unwrap().code,"PLUGIN_INVALID");
        assert!(relative_path("./../outside").is_err());assert!(relative_path("C:/outside").is_err());
    }
    #[test]
    fn long_upstream_skill_names_fit_codex_without_colliding() {
        let plugin="reviewops-auditor-benchmark";
        let one=qualified_skill_name(plugin,"recommend-review-reference-architecture");
        let two=qualified_skill_name(plugin,"recommend-review-reference-architecture-next");
        assert_eq!(one.len(),64);assert_ne!(one,two);
        assert_eq!(one,qualified_skill_name(plugin,"recommend-review-reference-architecture"));
        assert_eq!(qualified_skill_name("qa","read"),"qa-read");
    }
    #[test]
    fn portable_and_codex_mcp_runtime_fields_have_matching_semantics() {
        let dir=tempfile::tempdir().unwrap();fixture(dir.path());
        fs::create_dir_all(dir.path().join(".codex-plugin")).unwrap();
        fs::write(dir.path().join(".codex-plugin/plugin.json"),r#"{"name":"qa-map","version":"1.0.0"}"#).unwrap();
        fs::remove_file(dir.path().join("plugin.json")).unwrap();
        let stdio=json!({"command":"node","args":["./scripts/server.mjs"],"cwd":"${PLUGIN_ROOT}/scripts","env_vars":["PATH",{"name":"TEMP","source":"local"}],"startup_timeout_ms":350,"tool_timeout_sec":12.5,"enabled_tools":["read","hidden"],"disabled_tools":["hidden"],"enabled":false});
        let http=json!({"url":"https://example.com/mcp","bearer_token_env_var":"MCP_QA_TOKEN","env_http_headers":{"X-Key":"MCP_QA_HEADER"},"startup_timeout_sec":30,"tool_timeout_sec":180});
        fs::write(dir.path().join(".mcp.json"),json!({"mcpServers":{"stdio":stdio,"http":http}}).to_string()).unwrap();
        let codex=parse(dir.path(),"alice").unwrap();assert_eq!(codex.servers.len(),2);
        assert!(!codex.servers[1].enabled);assert_eq!(codex.servers[1].runtime.startup_timeout_sec,Some(0.35));
        fs::remove_file(dir.path().join(".codex-plugin/plugin.json")).unwrap();
        fs::write(dir.path().join("plugin.json"),r#"{"name":"qa-map","version":"1.0.0"}"#).unwrap();
        let mut portable_stdio=stdio;portable_stdio["type"]=json!("stdio");let mut portable_http=http;portable_http["type"]=json!("http");
        fs::write(dir.path().join("mcp.json"),json!({"mcpServers":{"stdio":portable_stdio,"http":portable_http}}).to_string()).unwrap();
        let portable=parse(dir.path(),"alice").unwrap();assert_eq!(preview(&portable)["connectors"][1]["runtime"],preview(&codex)["connectors"][1]["runtime"]);
        assert!(!preview(&portable).to_string().contains("Bearer "));
        fs::write(dir.path().join("mcp.json"),json!({"mcpServers":{"http":{"type":"http","command":null,"args":null,"env":null,"headers":null,"url":"https://example.com/mcp","enabled":null}}}).to_string()).unwrap();
        let nullable=parse(dir.path(),"alice").unwrap();assert!(nullable.servers[0].enabled);assert!(nullable.servers[0].command.is_none());
        fs::write(dir.path().join("mcp.json"),json!({"mcpServers":{"bad":{"type":"http","url":"https://example.com/mcp","cwd":"./server"}}}).to_string()).unwrap();
        assert_eq!(parse(dir.path(),"alice").err().unwrap().code,"MCP_CONFIG_INVALID");
    }
    #[test]
    fn inline_codex_servers_and_explicit_config_have_the_same_native_credentials() {
        let dir=tempfile::tempdir().unwrap();fixture(dir.path());
        fs::remove_file(dir.path().join("plugin.json")).unwrap();fs::create_dir_all(dir.path().join(".codex-plugin")).unwrap();
        let servers=json!({"local":{"command":"node","args":["./scripts/server.mjs"],"env":{"QA_PRIVATE_VALUE":"owned credential"},"enabled_tools":["read"]}});
        let manifest=json!({"name":"qa-map","skills":null,"mcpServers":servers});
        fs::write(dir.path().join(".codex-plugin/plugin.json"),manifest.to_string()).unwrap();
        fs::write(dir.path().join(".mcp.json"),"invalid ignored fallback").unwrap();
        let inline=parse(dir.path(),"alice").unwrap();assert_eq!(inline.servers.len(),1);assert_eq!(inline.skills.len(),1);
        assert!(!preview(&inline).to_string().contains("owned credential"));assert!(!inline.files.contains_key(".codex-plugin/plugin.json"));assert!(!inline.files.contains_key(".mcp.json"));
        let storage=tempfile::tempdir().unwrap();let state=ExtensionState::new(storage.path().join("agent-extensions.json"));
        let hash=inline.record.sha256.clone();let installed=install(&state,inline,&hash,true).unwrap();let store=state.load().unwrap();let plugin=&store.plugins[0];
        assert_eq!(plugin.mcp_server_ids["local"],installed["connectorIds"][0].as_str().unwrap());
        let secret=crate::mcp_credentials::load(&state.path,&plugin.mcp_server_ids["local"]).unwrap();assert_eq!(secret.env["QA_PRIVATE_VALUE"],"owned credential");
        let mut manifest=manifest;manifest["mcpServers"]=json!({"mcpServers":servers});fs::write(dir.path().join(".codex-plugin/plugin.json"),manifest.to_string()).unwrap();
        let wrapped=parse(dir.path(),"alice").unwrap();assert_eq!(wrapped.servers[0].alias,"local");
        manifest["mcpServers"]=json!("./servers.json");fs::write(dir.path().join(".codex-plugin/plugin.json"),manifest.to_string()).unwrap();
        fs::write(dir.path().join("servers.json"),servers.to_string()).unwrap();let external=parse(dir.path(),"alice").unwrap();
        assert_eq!(external.servers[0].secret.env,wrapped.servers[0].secret.env);assert!(!external.files.contains_key("servers.json"));
        fs::remove_file(dir.path().join("servers.json")).unwrap();assert_eq!(parse(dir.path(),"alice").err().unwrap().code,"PLUGIN_INVALID");
    }
    #[test]
    fn multiple_and_nested_skill_roots_are_deduplicated_and_portable_roots_stay_canonical() {
        let dir=tempfile::tempdir().unwrap();fixture(dir.path());fs::remove_file(dir.path().join("plugin.json")).unwrap();
        fs::create_dir_all(dir.path().join(".codex-plugin")).unwrap();fs::create_dir_all(dir.path().join("extra/nested/write-map")).unwrap();
        fs::write(dir.path().join("extra/nested/write-map/SKILL.md"),"---\nname: write-map\ndescription: Read real map context.\n---\nUse the MCP read tool.\n").unwrap();
        fs::write(dir.path().join("extra/nested/write-map/reference.txt"),"owned second reference").unwrap();
        let manifest=json!({"name":"qa-map","skills":["./skills","./skills/read-map","./extra"],"mcpServers":{}});
        fs::write(dir.path().join(".codex-plugin/plugin.json"),manifest.to_string()).unwrap();let package=parse(dir.path(),"alice").unwrap();
        assert_eq!(package.skills.len(),2);assert_eq!(package.skills.iter().find(|s|s.name=="qa-map-write-map").unwrap().files["reference.txt"],b"owned second reference");
        let mut manifest=manifest;manifest["skills"]=json!(["./../outside"]);fs::write(dir.path().join(".codex-plugin/plugin.json"),manifest.to_string()).unwrap();
        assert_eq!(parse(dir.path(),"alice").err().unwrap().code,"PLUGIN_PATH_INVALID");
        fs::write(dir.path().join("plugin.json"),json!({"name":"qa-map","extensions":{"com.openai":{"skills":["./extra"],"mcpServers":{"ignored":{"command":"node"}}}}}).to_string()).unwrap();
        let portable=parse(dir.path(),"alice").unwrap();assert_eq!(portable.skills.len(),1);assert!(portable.servers.is_empty());
    }
    #[test]
    fn registered_apps_keep_usable_components_and_bind_only_the_owned_mcp_alias(){
        let source=tempfile::tempdir().unwrap();fixture(source.path());
        fs::write(source.path().join("plugin.json"),json!({"name":"qa-map","extensions":{"com.openai":{"apps":"./.app.json"}}}).to_string()).unwrap();
        fs::write(source.path().join(".app.json"),json!({"apps":{"notes":{"id":"asdk_app_notes"},"calendar":{"id":"connector_calendar"}}}).to_string()).unwrap();
        fs::write(source.path().join("mcp.json"),json!({"mcpServers":{"notes":{"type":"http","url":"https://example.com/mcp"}}}).to_string()).unwrap();
        let package=parse(source.path(),"alice").unwrap();let view=preview(&package);assert_eq!(view["skills"].as_array().unwrap().len(),1);assert_eq!(view["registeredApps"][1]["route"],"bundledMcp");assert_eq!(view["registeredApps"][0]["route"],"unavailable");assert!(!package.files.contains_key(".app.json"));
        let storage=tempfile::tempdir().unwrap();let state=ExtensionState::new(storage.path().join("agent-extensions.json"));let hash=package.record.sha256.clone();let installed=install(&state,package,&hash,false).unwrap();
        assert_eq!(installed["registeredApps"][1]["connectorId"],installed["connectorIds"][0]);assert_eq!(installed["registeredApps"][1]["enabled"],false);assert_eq!(installed["registeredApps"][0]["connectorId"],Value::Null);
        let mut store=state.load().unwrap();let record=store.plugins[0].clone();store.connector_settings.values_mut().next().unwrap().owner="bob".into();assert_eq!(super::super::plugin_apps::summary(&record,Some(&store))[1]["route"],"unavailable");
        let mut old=serde_json::to_value(&record).unwrap();old.as_object_mut().unwrap().remove("registeredApps");assert!(serde_json::from_value::<Record>(old).unwrap().registered_apps.is_empty());
    }
}

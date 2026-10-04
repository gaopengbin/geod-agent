//! GitHub plugin catalogs, pinned public snapshots and owner-scoped install previews.
//! Downloading a catalog/package never runs its scripts or enables its tools.
use super::*;
use serde_json::json;
use std::collections::BTreeSet;
use super::plugin_package::{self, MarketSource};

const CATALOG_LIMIT: usize = 512 * 1024;
const TREE_LIMIT: usize = 4 * 1024 * 1024;
const FILE_LIMIT: usize = 4 * 1024 * 1024;
const PACKAGE_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    pub owner: String,
    id: String,
    repository: String,
    reference: String,
    name: String,
    display_name: String,
    builtin: bool,
    commit: Option<String>,
    refreshed_at: Option<String>,
    entries: Vec<Entry>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    developer_name: String,
    description: String,
    category: String,
    path: Option<String>,
    components: Vec<String>,
    unavailable_reason: Option<String>,
    files: Vec<RepoFile>,
}
#[derive(Clone, Serialize, Deserialize)]
struct RepoFile { path: String, size: usize, mode: String }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StageMetadata { owner: String, plugin_name: String, source: MarketSource }

fn owner(services: &services::ServiceState) -> Result<String, AppError> {
    services::current_user_id(services).map_err(|e| error(e.code, &e.message))
}
fn bounded_text(value: &Value, key: &str, limit: usize) -> Result<String, AppError> {
    let text=value.get(key).and_then(Value::as_str).unwrap_or("");
    if text.chars().count()>limit || text.chars().any(char::is_control) {
        return Err(error("PLUGIN_MARKETPLACE_INVALID", "插件目录包含无效或过长的文字"));
    }
    Ok(text.into())
}
fn safe_path(path: &str) -> Result<(), AppError> {
    validate_bundle_path(path).map_err(|_|error("PLUGIN_MARKETPLACE_PATH", "插件目录的资源路径无效"))?;
    if path.split('/').any(|part| {
        let stem=part.split('.').next().unwrap_or("").to_ascii_uppercase();
        part=="." || part==".." || part.ends_with(['.',' ']) || part.chars().any(|c| c.is_control() || matches!(c,'<'|'>'|'|'|'?'|'*'))
            || matches!(stem.as_str(),"CON"|"PRN"|"AUX"|"NUL")
            || (stem.len()==4 && (stem.starts_with("COM")||stem.starts_with("LPT")) && matches!(stem.as_bytes()[3],b'1'..=b'9'))
    }) { return Err(error("PLUGIN_MARKETPLACE_PATH", "插件目录的资源路径不能在 Windows 中安全保存")); }
    Ok(())
}
fn source_parts(raw: &str) -> Result<(String,String), AppError> {
    let value=raw.trim();
    let (repository,reference)=if value.starts_with("https://") {
        let url=reqwest_mcp::Url::parse(value).map_err(|_|error("PLUGIN_MARKETPLACE_SOURCE", "请填写 GitHub 仓库链接或 owner/repo"))?;
        if url.host_str()!=Some("github.com") || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.port().is_some() {
            return Err(error("PLUGIN_MARKETPLACE_SOURCE", "插件目录目前使用公开 GitHub 仓库"));
        }
        let parts=url.path().trim_matches('/').split('/').collect::<Vec<_>>();
        if parts.len()!=2 {return Err(error("PLUGIN_MARKETPLACE_SOURCE", "请使用仓库根链接；指定版本可填写 owner/repo@分支或提交"));}
        (format!("{}/{}",parts[0],parts[1].trim_end_matches(".git")),"HEAD".to_owned())
    } else {
        let (repo,reference)=value.split_once('@').unwrap_or((value,"HEAD"));
        (repo.trim_end_matches(".git").to_owned(),reference.to_owned())
    };
    let parts=repository.split('/').collect::<Vec<_>>();
    if parts.len()!=2 || parts.iter().any(|part| part.is_empty() || part.len()>100 || *part=="." || *part==".." || !part.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c,b'.'|b'_'|b'-')))
        || reference.is_empty() || reference.len()>128 || reference.contains("..") || !reference.bytes().all(|c|c.is_ascii_alphanumeric()||matches!(c,b'.'|b'_'|b'-'|b'/')) {
        return Err(error("PLUGIN_MARKETPLACE_SOURCE", "GitHub 仓库或版本格式无效"));
    }
    Ok((repository.to_ascii_lowercase(),reference))
}
fn url(base: &str, segments: &[&str]) -> Result<String, AppError> {
    let mut url=reqwest_mcp::Url::parse(base).map_err(|_|error("PLUGIN_MARKETPLACE_SOURCE", "插件来源无效"))?;
    {
        let mut path=url.path_segments_mut().map_err(|_|error("PLUGIN_MARKETPLACE_SOURCE", "插件来源无效"))?;
        for segment in segments {path.push(segment);}
    }
    Ok(url.to_string())
}
fn record(owner: &str, repository: &str, reference: &str, builtin: bool, label: &str) -> Record {
    let id=format!("{:x}",Sha256::digest(format!("{repository}@{reference}")))[..24].to_owned();
    Record {owner:owner.into(),id,repository:repository.into(),reference:reference.into(),name:repository.into(),display_name:label.into(),builtin,commit:None,refreshed_at:None,entries:vec![]}
}
fn records(state: &ExtensionState, owner: &str) -> Result<Vec<Record>,AppError> {
    let mut records=vec![
        record(owner,"openai/plugins","HEAD",true,"OpenAI"),
        record(owner,"openai/community-plugins","HEAD",true,"Community Plugins"),
    ];
    for saved in state.load()?.plugin_marketplaces.into_iter().filter(|r|r.owner==owner) {
        if let Some(previous)=records.iter_mut().find(|r|r.id==saved.id) {*previous=saved;}else{records.push(saved);}
    }
    Ok(records)
}
fn summary(record: &Record) -> Value {
    json!({
        "id":record.id,"repository":record.repository,"reference":record.reference,"name":record.name,"displayName":record.display_name,"builtin":record.builtin,"commit":record.commit,"refreshedAt":record.refreshed_at,
        "entries":record.entries.iter().map(|entry|json!({
            "name":entry.name,"displayName":if entry.display_name.is_empty(){&entry.name}else{&entry.display_name},"version":entry.version,"developerName":entry.developer_name,"description":entry.description,"category":entry.category,"components":entry.components,
            "unavailableReason":entry.unavailable_reason,"fileCount":entry.files.len(),"bytes":package_size(entry),
        })).collect::<Vec<_>>()
    })
}
fn package_size(entry: &Entry) -> usize {entry.files.iter().fold(0usize,|total,file|total.saturating_add(file.size))}
async fn body(mut response: reqwest_mcp::Response, limit: usize) -> Result<Vec<u8>,AppError> {
    if response.status().as_u16()==404 {return Err(error("PLUGIN_MARKETPLACE_NOT_FOUND", "插件目录、版本或资源不存在"));}
    if response.status().as_u16()==429 || (response.status().as_u16()==403 && response.headers().get("x-ratelimit-remaining").is_some_and(|v|v=="0")) {
        return Err(error("PLUGIN_MARKETPLACE_RATE_LIMIT", "GitHub 请求额度已用完，请稍后重试"));
    }
    if !response.status().is_success() {return Err(error("PLUGIN_MARKETPLACE_UNAVAILABLE", "无法读取公开插件来源，请检查网络与仓库地址"));}
    if response.content_length().is_some_and(|n|n>limit as u64) {return Err(error("PLUGIN_MARKETPLACE_TOO_LARGE", "插件目录或资源超过大小限制"));}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|error("PLUGIN_MARKETPLACE_UNAVAILABLE", "插件资源下载中断，可重新检查"))? {
        if bytes.len()+chunk.len()>limit {return Err(error("PLUGIN_MARKETPLACE_TOO_LARGE", "插件目录或资源超过大小限制"));}
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn get(client: &reqwest_mcp::Client, url: &str, limit: usize) -> Result<Vec<u8>,AppError> {
    let response=client.get(url).header("User-Agent","GeoD-Agent").header("Accept","application/vnd.github+json").send().await
        .map_err(|_|error("PLUGIN_MARKETPLACE_UNAVAILABLE", "无法连接插件来源，请检查网络设置"))?;
    body(response,limit).await
}
fn decode(bytes: &[u8]) -> Result<Value,AppError> {
    serde_json::from_slice(bytes).map_err(|_|error("PLUGIN_MARKETPLACE_INVALID", "插件来源没有返回有效 JSON"))
}
fn parse_catalog(catalog: &Value, tree: &Value) -> Result<(String,String,Vec<Entry>),AppError> {
    let name=bounded_text(catalog,"name",120)?;
    if name.is_empty(){return Err(error("PLUGIN_MARKETPLACE_INVALID","插件目录缺少名称"));}
    let display=bounded_text(&catalog["interface"],"displayName",120)?;
    let plugins=catalog["plugins"].as_array().filter(|v|v.len()<=1500).ok_or_else(||error("PLUGIN_MARKETPLACE_INVALID","插件目录缺少可读取的 plugins 列表"))?;
    if tree["truncated"].as_bool()==Some(true){return Err(error("PLUGIN_MARKETPLACE_TOO_LARGE","GitHub 仓库资源列表被截断，无法完整核验插件"));}
    let files=tree["tree"].as_array().ok_or_else(||error("PLUGIN_MARKETPLACE_INVALID","GitHub 仓库资源列表无效"))?;
    let mut names=BTreeSet::new();let mut entries=Vec::new();
    for item in plugins {
        let name=bounded_text(item,"name",128)?;
        if name.is_empty() || !names.insert(name.clone()) {return Err(error("PLUGIN_MARKETPLACE_INVALID","插件目录含重复或缺失的名称"));}
        let local=if item["source"]["source"]=="local" {item["source"]["path"].as_str()}else{item["source"].as_str().filter(|s|s.starts_with("./"))};
        let path=local.map(|raw|raw.strip_prefix("./").unwrap_or(raw).trim_end_matches('/').to_owned());
        if let Some(path)=&path {safe_path(path)?;}
        let mut entry=Entry {name,display_name:String::new(),version:String::new(),developer_name:String::new(),description:bounded_text(item,"description",1024)?,category:bounded_text(item,"category",120)?,path:path.clone(),components:vec![],unavailable_reason:None,files:vec![]};
        let available=item["policy"]["installation"].as_str().is_none_or(|value|value=="AVAILABLE"||value=="INSTALLED_BY_DEFAULT");
        if !available {entry.unavailable_reason=Some("来源未开放此插件的安装".into());}
        if let Some(path)=path {
            let prefix=format!("{path}/");
            let mut paths=BTreeSet::new();
            for file in files {
                if file["type"]!="blob"{continue;}
                let Some(relative)=file["path"].as_str().and_then(|p|p.strip_prefix(&prefix))else{continue;};
                if relative.split('/').any(|p|matches!(p,".git"|"node_modules"|"__pycache__"|".venv")){continue;}
                safe_path(relative)?;
                if !paths.insert(relative.to_ascii_lowercase()){return Err(error("PLUGIN_MARKETPLACE_PATH","插件资源含 Windows 下重名的路径"));}
                let mode=file["mode"].as_str().unwrap_or("");
                if !matches!(mode,"100644"|"100755"){entry.unavailable_reason=Some("插件包含目录链接，无法保存为独立本机包".into());}
                let size=file["size"].as_u64().filter(|n|*n<=usize::MAX as u64).ok_or_else(||error("PLUGIN_MARKETPLACE_INVALID","插件资源缺少有效大小"))? as usize;
                entry.files.push(RepoFile {path:relative.into(),size,mode:mode.into()});
            }
            if entry.files.is_empty(){entry.unavailable_reason=Some("目录声明的插件文件夹不存在".into());}
            if entry.files.len()>512 || entry.files.iter().any(|f|f.size>FILE_LIMIT) || package_size(&entry)>PACKAGE_LIMIT {
                entry.unavailable_reason=Some("插件包超过 512 个文件或 16 MiB".into());
            }
            if entry.files.iter().any(|f|f.path.ends_with("/SKILL.md")){entry.components.push("skills".into());}
            if entry.files.iter().any(|f|matches!(f.path.as_str(),".mcp.json"|"mcp.json")){entry.components.push("mcp".into());}
            if entry.files.iter().any(|f|f.path==".app.json"){entry.components.push("apps".into());}
            if entry.files.iter().any(|f|f.path=="hooks/hooks.json"){entry.components.push("hooks".into());}
        }else{entry.unavailable_reason=Some("此条目引用外部来源；请导入对应仓库中的插件包".into());}
        entries.push(entry);
    }
    Ok((name,if display.is_empty(){catalog["name"].as_str().unwrap().into()}else{display},entries))
}
async fn entry_metadata(client: reqwest_mcp::Client, repository: String, sha: String, mut entry: Entry) -> Entry {
    let result=async {
        let Some(prefix)=entry.path.as_deref()else{return Ok::<_,AppError>(());};
        let manifest=if entry.files.iter().any(|f|f.path=="plugin.json"){"plugin.json"}else{".codex-plugin/plugin.json"};
        let (user,repo)=repository.split_once('/').unwrap();
        let segments=std::iter::once(user).chain(std::iter::once(repo)).chain(std::iter::once(sha.as_str())).chain(prefix.split('/')).chain(manifest.split('/')).collect::<Vec<_>>();
        let manifest=decode(&get(&client,&url("https://raw.githubusercontent.com/",&segments)?,128*1024).await?)?;
        if manifest["name"].as_str()!=Some(entry.name.as_str()){return Err(error("PLUGIN_MARKETPLACE_CHANGED","插件名称与目录声明不一致"));}
        let overlay=if manifest["extensions"]["com.openai"].is_object(){&manifest["extensions"]["com.openai"]}else{&manifest};
        entry.display_name=bounded_text(&overlay["interface"],"displayName",120)?;
        entry.version=bounded_text(&manifest,"version",64)?;
        entry.developer_name=bounded_text(&overlay["interface"],"developerName",120)?;
        if entry.developer_name.is_empty(){entry.developer_name=bounded_text(&manifest["author"],"name",120)?;}
        let description=bounded_text(&overlay["interface"],"shortDescription",1024)?;
        entry.description=if description.is_empty(){bounded_text(&manifest,"description",1024)?}else{description};
        if entry.category.is_empty(){entry.category=bounded_text(&overlay["interface"],"category",120)?;}
        Ok(())
    }.await;
    if let Err(cause)=result {entry.unavailable_reason=Some(cause.message);}
    entry
}
async fn metadata(client: &reqwest_mcp::Client, repository: &str, sha: &str, entries: Vec<Entry>) -> Result<Vec<Entry>,AppError> {
    let mut jobs=tokio::task::JoinSet::new();let mut pending=entries.into_iter().enumerate();let mut result=Vec::new();
    loop {
        while jobs.len()<6 {
            let Some((index,entry))=pending.next()else{break;};
            let client=client.clone();let repository=repository.to_owned();let sha=sha.to_owned();
            jobs.spawn(async move{(index,entry_metadata(client,repository,sha,entry).await)});
        }
        let Some(entry)=jobs.join_next().await else{break;};
        result.push(entry.map_err(|_|error("PLUGIN_MARKETPLACE_UNAVAILABLE","插件清单检查未完成"))?);
    }
    result.sort_by_key(|(index,_)|*index);
    Ok(result.into_iter().map(|(_,entry)|entry).collect())
}
async fn fetch(mut record: Record) -> Result<Record,AppError> {
    let (repository,reference)=source_parts(&format!("{}@{}",record.repository,record.reference))?;
    let (user,repo)=repository.split_once('/').unwrap();
    let api=http_client("https://api.github.com/")?;
    let commit=decode(&get(&api,&url("https://api.github.com/",&["repos",user,repo,"commits",&reference])?,256*1024).await?)?;
    let sha=commit["sha"].as_str().filter(|s|s.len()==40&&s.bytes().all(|c|c.is_ascii_hexdigit())).ok_or_else(||error("PLUGIN_MARKETPLACE_INVALID","GitHub 返回的提交版本无效"))?;
    let mut tree_url=reqwest_mcp::Url::parse(&url("https://api.github.com/",&["repos",user,repo,"git","trees",sha])?).unwrap();
    tree_url.query_pairs_mut().append_pair("recursive","1");
    let tree=decode(&get(&api,tree_url.as_str(),TREE_LIMIT).await?)?;
    let raw=http_client("https://raw.githubusercontent.com/")?;
    let catalog_url=url("https://raw.githubusercontent.com/",&[user,repo,sha,".agents","plugins","marketplace.json"])?;
    let bytes=match get(&raw,&catalog_url,CATALOG_LIMIT).await {
        Err(cause) if cause.code=="PLUGIN_MARKETPLACE_NOT_FOUND" => get(&raw,&url("https://raw.githubusercontent.com/",&[user,repo,sha,".claude-plugin","marketplace.json"])?,CATALOG_LIMIT).await?,
        other=>other?,
    };
    let (name,display_name,entries)=parse_catalog(&decode(&bytes)?,&tree)?;
    let entries=metadata(&raw,&repository,sha,entries).await?;
    record.name=name;record.display_name=display_name;record.entries=entries;record.commit=Some(sha.into());record.refreshed_at=Some(chrono::Utc::now().to_rfc3339());
    Ok(record)
}
fn save(state: &ExtensionState, record: &Record) -> Result<(),AppError> {
    state.update(|store| {
        if let Some(existing)=store.plugin_marketplaces.iter_mut().find(|r|r.owner==record.owner&&r.id==record.id){*existing=record.clone();}
        else {
            if store.plugin_marketplaces.iter().filter(|r|r.owner==record.owner).count()>=30 {return Err(error("PLUGIN_MARKETPLACE_LIMIT","当前账号最多保存 30 个插件目录"));}
            store.plugin_marketplaces.push(record.clone());
        }
        Ok(())
    })?;
    Ok(())
}
fn stage_path(state: &ExtensionState, owner: &str, id: &str) -> Result<PathBuf,AppError> {
    Uuid::parse_str(id).map_err(|_|error("PLUGIN_MARKETPLACE_STAGE","插件预览标识无效"))?;
    let scope=format!("{:x}",Sha256::digest(owner));
    let base=state.path.parent().ok_or_else(||error("PLUGIN_MARKETPLACE_STORAGE","无法读取本机插件保存位置"))?.join("cache/plugin-marketplace-staging").join(scope);
    fs::create_dir_all(&base).map_err(|_|error("PLUGIN_MARKETPLACE_STORAGE","无法准备插件预览位置"))?;
    if !fs::canonicalize(&base).map_err(|_|error("PLUGIN_MARKETPLACE_STORAGE","插件预览位置不可读"))?.starts_with(fs::canonicalize(state.path.parent().unwrap()).map_err(|_|error("PLUGIN_MARKETPLACE_STORAGE","应用保存位置不可读"))?) {
        return Err(error("PLUGIN_MARKETPLACE_PATH","插件预览位置越出了应用保存范围"));
    }
    let path=base.join(id);
    if path.exists() && !fs::canonicalize(&path).map_err(|_|error("PLUGIN_MARKETPLACE_STORAGE","插件预览位置不可读"))?.starts_with(fs::canonicalize(&base).map_err(|_|error("PLUGIN_MARKETPLACE_STORAGE","插件预览位置不可读"))?) {
        return Err(error("PLUGIN_MARKETPLACE_PATH","插件预览位置不属于当前账号"));
    }
    Ok(path)
}
struct TemporaryStage { path: PathBuf, keep: bool }
impl Drop for TemporaryStage {fn drop(&mut self){if !self.keep {let _=fs::remove_dir_all(&self.path);}}}
async fn prepare(state: &ExtensionState, owner: &str, marketplace_id: &str, name: &str) -> Result<Value,AppError> {
    let market=records(state,owner)?.into_iter().find(|r|r.id==marketplace_id).ok_or_else(||error("PLUGIN_MARKETPLACE_NOT_FOUND","未找到当前账号的插件目录"))?;
    let entry=market.entries.iter().find(|e|e.name==name).ok_or_else(||error("PLUGIN_MARKETPLACE_NOT_FOUND","请先刷新目录，再选择插件"))?;
    if let Some(reason)=&entry.unavailable_reason {return Err(error("PLUGIN_MARKETPLACE_UNSUPPORTED",reason));}
    let sha=market.commit.as_deref().ok_or_else(||error("PLUGIN_MARKETPLACE_NOT_FOUND","请先刷新插件目录"))?;
    if sha.len()!=40 || !sha.bytes().all(|c|c.is_ascii_hexdigit()){return Err(error("PLUGIN_MARKETPLACE_INVALID","插件目录的提交版本无效"));}
    let (repository,_)=source_parts(&market.repository)?;
    let (user,repo)=repository.split_once('/').unwrap();
    let prefix=entry.path.as_deref().ok_or_else(||error("PLUGIN_MARKETPLACE_PATH","插件文件夹无效"))?;
    let source=MarketSource {repository:repository.clone(),commit:sha.into(),path:prefix.into(),marketplace:market.display_name.clone()};
    let id=Uuid::new_v4().to_string();let path=stage_path(state,owner,&id)?;let mut temporary=TemporaryStage {path:path.clone(),keep:false};
    let bundle=path.join("bundle");fs::create_dir_all(&bundle).map_err(|_|error("PLUGIN_MARKETPLACE_STORAGE","无法保存插件预览"))?;
    let client=http_client("https://raw.githubusercontent.com/")?;
    let mut jobs=tokio::task::JoinSet::new();let mut total=0;
    let mut files=entry.files.iter();
    loop {
        while jobs.len()<6 {
            let Some(file)=files.next()else{break;};
            safe_path(&file.path)?;
            if !matches!(file.mode.as_str(),"100644"|"100755"){return Err(error("PLUGIN_MARKETPLACE_PATH","插件资源不能是目录链接"));}
            let segments=std::iter::once(user).chain(std::iter::once(repo)).chain(std::iter::once(sha)).chain(prefix.split('/')).chain(file.path.split('/')).collect::<Vec<_>>();
            let resource=url("https://raw.githubusercontent.com/",&segments)?;let client=client.clone();let file=file.clone();
            jobs.spawn(async move {
                let bytes=get(&client,&resource,FILE_LIMIT).await?;
                if bytes.len()!=file.size {return Err(error("PLUGIN_MARKETPLACE_CHANGED","插件资源与目录快照不一致，请重新刷新"));}
                Ok::<_,AppError>((file.path,bytes))
            });
        }
        let Some(result)=jobs.join_next().await else{break;};
        let (relative,bytes)=result.map_err(|_|error("PLUGIN_MARKETPLACE_UNAVAILABLE","插件资源下载未完成"))??;
        total+=bytes.len();if total>PACKAGE_LIMIT {return Err(error("PLUGIN_MARKETPLACE_TOO_LARGE","插件包超过 16 MiB"));}
        let file=bundle.join(relative);fs::create_dir_all(file.parent().unwrap()).map_err(|_|error("PLUGIN_MARKETPLACE_STORAGE","无法保存插件资源"))?;
        fs::write(file,bytes).map_err(|_|error("PLUGIN_MARKETPLACE_STORAGE","无法保存插件资源"))?;
    }
    let mut package=plugin_package::parse(&bundle,owner)?;
    if package.record.name!=entry.name {return Err(error("PLUGIN_MARKETPLACE_CHANGED","插件名称与目录声明不一致，请检查来源"));}
    package.record.source=Some(source.clone());
    let metadata=StageMetadata {owner:owner.into(),plugin_name:entry.name.clone(),source};
    fs::write(path.join("stage.json"),serde_json::to_vec(&metadata).unwrap()).map_err(|_|error("PLUGIN_MARKETPLACE_STORAGE","无法保存插件预览信息"))?;
    temporary.keep=true;
    Ok(json!({"stageId":id,"bundle":plugin_package::preview(&package)}))
}
#[tauri::command]
pub(crate) fn plugin_marketplaces_list(state: State<'_,ExtensionState>,services: State<'_,services::ServiceState>) -> Result<Value,AppError> {
    Ok(json!({"marketplaces":records(&state,&owner(&services)?)?.iter().map(summary).collect::<Vec<_>>()}))
}
#[tauri::command]
pub(crate) async fn plugin_marketplace_add(state: State<'_,ExtensionState>,services: State<'_,services::ServiceState>,source: String) -> Result<Value,AppError> {
    let owner=owner(&services)?;let (repo,reference)=source_parts(&source)?;
    let initial=record(&owner,&repo,&reference,false,&repo);
    if let Some(existing)=records(&state,&owner)?.into_iter().find(|r|r.id==initial.id){return Ok(summary(&existing));}
    let fetched=tokio::time::timeout(Duration::from_secs(90),fetch(initial)).await.map_err(|_|error("PLUGIN_MARKETPLACE_UNAVAILABLE","读取插件目录超时，请重试"))??;
    save(&state,&fetched)?;Ok(summary(&fetched))
}
#[tauri::command]
pub(crate) async fn plugin_marketplace_refresh(state: State<'_,ExtensionState>,services: State<'_,services::ServiceState>,id: String) -> Result<Value,AppError> {
    let owner=owner(&services)?;
    let initial=records(&state,&owner)?.into_iter().find(|r|r.id==id).ok_or_else(||error("PLUGIN_MARKETPLACE_NOT_FOUND","未找到当前账号的插件目录"))?;
    let fetched=tokio::time::timeout(Duration::from_secs(90),fetch(initial)).await.map_err(|_|error("PLUGIN_MARKETPLACE_UNAVAILABLE","读取插件目录超时，请重试"))??;
    save(&state,&fetched)?;Ok(summary(&fetched))
}
#[tauri::command]
pub(crate) fn plugin_marketplace_remove(state: State<'_,ExtensionState>,services: State<'_,services::ServiceState>,id: String) -> Result<Value,AppError> {
    let owner=owner(&services)?;
    state.update(|store|{store.plugin_marketplaces.retain(|r|r.owner!=owner||r.id!=id);Ok(())})?;
    Ok(json!({"removed":true}))
}
#[tauri::command]
pub(crate) async fn plugin_marketplace_prepare(state: State<'_,ExtensionState>,services: State<'_,services::ServiceState>,marketplace_id: String,name: String) -> Result<Value,AppError> {
    let owner=owner(&services)?;
    tokio::time::timeout(Duration::from_secs(150),prepare(&state,&owner,&marketplace_id,&name)).await.map_err(|_|error("PLUGIN_MARKETPLACE_UNAVAILABLE","获取插件资源超时，请重试"))?
}
#[tauri::command]
pub(crate) fn plugin_marketplace_install(state: State<'_,ExtensionState>,services: State<'_,services::ServiceState>,stage_id: String,expected_sha256: String,enabled: bool,hooks_approved:Option<bool>) -> Result<Value,AppError> {
    let owner=owner(&services)?;let path=stage_path(&state,&owner,&stage_id)?;
    let metadata:StageMetadata=serde_json::from_slice(&fs::read(path.join("stage.json")).map_err(|_|error("PLUGIN_MARKETPLACE_STAGE","此插件预览已失效，请重新检查"))?).map_err(|_|error("PLUGIN_MARKETPLACE_STAGE","插件预览信息不可读"))?;
    if metadata.owner!=owner {return Err(error("PLUGIN_MARKETPLACE_STAGE","未找到当前账号的插件预览"));}
    let mut package=plugin_package::parse(&path.join("bundle"),&owner)?;
    if package.record.name!=metadata.plugin_name {return Err(error("PLUGIN_MARKETPLACE_CHANGED","插件名称在检查后发生变化"));}
    package.record.source=Some(metadata.source);
    if hooks_approved==Some(true)&&!package.record.hooks.is_empty(){package.record.hooks_reviewed_sha256=Some(expected_sha256.clone());package.record.hooks_enabled=enabled;}
    let installed=plugin_package::install(&state,package,&expected_sha256,enabled)?;
    let _=fs::remove_dir_all(path);
    Ok(installed)
}
#[tauri::command]
pub(crate) fn plugin_marketplace_discard(state: State<'_,ExtensionState>,services: State<'_,services::ServiceState>,stage_id: String) -> Result<Value,AppError> {
    let path=stage_path(&state,&owner(&services)?,&stage_id)?;
    if path.exists(){fs::remove_dir_all(path).map_err(|_|error("PLUGIN_MARKETPLACE_STORAGE","无法清理插件预览"))?;}
    Ok(json!({"discarded":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tree() -> Value {json!({"truncated":false,"tree":[
        {"type":"blob","mode":"100644","path":"plugins/example/.codex-plugin/plugin.json","size":29},
        {"type":"blob","mode":"100644","path":"plugins/example/skills/read/SKILL.md","size":52},
        {"type":"blob","mode":"100644","path":"plugins/example/skills/read/references/actual.csv","size":64},
    ]})}
    #[test]
    fn pinned_catalog_keeps_all_package_resources_and_classifies_components() {
        let catalog=json!({"name":"example-market","plugins":[{"name":"example","source":{"source":"local","path":"./plugins/example"}}]});
        let (_,_,entries)=parse_catalog(&catalog,&tree()).unwrap();
        assert_eq!(entries[0].files.len(),3);assert_eq!(entries[0].components,vec!["skills"]);assert!(entries[0].unavailable_reason.is_none());
        let legacy=json!({"name":"example-market","plugins":[{"name":"example","source":"./plugins/example"}]});
        assert_eq!(parse_catalog(&legacy,&tree()).unwrap().2[0].files.len(),3);
        let external=json!({"name":"example-market","plugins":[{"name":"example","source":{"source":"github","repo":"external/repo"}}]});
        assert!(parse_catalog(&external,&tree()).unwrap().2[0].unavailable_reason.is_some());
    }
    #[test]
    fn untrusted_catalog_paths_duplicates_links_and_truncated_trees_are_not_installable() {
        for path in ["../elsewhere","C:/secret","plugins/CON.txt","plugins/unsafe."] {
            assert!(parse_catalog(&json!({"name":"test","plugins":[{"name":"a","source":format!("./{path}")}]}),&tree()).is_err());
        }
        assert!(parse_catalog(&json!({"name":"test","plugins":[{"name":"a","source":"./plugins/example"},{"name":"a","source":"./plugins/example"}]}),&tree()).is_err());
        let mut linked=tree();linked["tree"][0]["mode"]=json!("120000");
        assert!(parse_catalog(&json!({"name":"test","plugins":[{"name":"a","source":"./plugins/example"}]}),&linked).unwrap().2[0].unavailable_reason.is_some());
        let mut truncated=tree();truncated["truncated"]=json!(true);
        assert!(parse_catalog(&json!({"name":"test","plugins":[]}),&truncated).is_err());
    }
    #[test]
    fn sources_and_persisted_catalogs_are_owner_scoped_without_losing_offline_snapshots() {
        assert_eq!(source_parts("https://github.com/OpenAI/plugins.git").unwrap(),("openai/plugins".into(),"HEAD".into()));
        assert_eq!(source_parts("team/repo@feature/branch").unwrap().1,"feature/branch");
        for source in ["https://user:password@github.com/team/repo","http://github.com/team/repo","team/../repo","https://example.com/repo","team/repo@../../secret"] {assert!(source_parts(source).is_err());}
        let root=tempfile::tempdir().unwrap();let state=ExtensionState::new(root.path().join("extensions.json"));
        let mut one=record("one","team/repo","HEAD",false,"Team");one.commit=Some("a".repeat(40));save(&state,&one).unwrap();
        assert_eq!(records(&state,"one").unwrap().len(),3);assert_eq!(records(&state,"two").unwrap().len(),2);
        let reloaded=ExtensionState::new(state.path.clone());assert_eq!(records(&reloaded,"one").unwrap()[2].commit,one.commit);
        let id=Uuid::new_v4().to_string();assert_ne!(stage_path(&state,"one",&id).unwrap(),stage_path(&state,"two",&id).unwrap());
        assert!(stage_path(&state,"one","../outside").is_err());
    }
}

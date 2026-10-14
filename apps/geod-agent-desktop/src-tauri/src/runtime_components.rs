//! Content-addressed runtimes survive app-only NSIS upgrades. Release signatures
//! cover the component index and every archive; the executable pins required hashes.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, BTreeSet}, fs, io::{Read, Write}, path::{Component, Path, PathBuf}, sync::{Mutex, OnceLock}};
use tauri::{ipc::Channel, AppHandle, Manager};
use tauri_plugin_updater::Update;
use std::time::Duration;

pub(crate) const IDS: &[&str] = &["codex-runtime", "pgedge-runtime", "document-runtime", "dbhub-runtime", "audio-runtime", "python-runtime"];
static CACHE: OnceLock<PathBuf> = OnceLock::new();
static VERIFIED: Mutex<BTreeMap<String, PathBuf>> = Mutex::new(BTreeMap::new());
pub(crate) fn initialize(app: &AppHandle) {
    if let Ok(root) = app.path().app_data_dir() { initialize_directory(root.join("runtime-components")); }
}
pub(crate) fn initialize_directory(base: PathBuf) { let _ = CACHE.set(base); }
fn required() -> BTreeMap<String, String> {
    serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/runtime-components.json"))).expect("build runtime catalog")
}
pub(crate) fn root(app: &AppHandle, id: &str) -> Option<PathBuf> {
    resolve(app.path().resource_dir().ok()?.as_path(), id)
}
pub(crate) fn resolve(resources: &Path, id: &str) -> Option<PathBuf> {
    let expected = required().remove(id)?;
    if let Some(path) = VERIFIED.lock().ok()?.get(id) { return Some(path.clone()); }
    let mut roots = vec![resources.join(id)];
    if let Some(base) = CACHE.get() { roots.push(component_path(base, id, &expected)); }
    // Hash all payload files at migration/download/install boundaries. Startup
    // only selects the build-pinned manifest; feature-specific runtime checks
    // remain in place without scanning thousands of DBHub files at every launch.
    let path = roots.into_iter().find(|path| entries(path, &expected).is_ok())?;
    VERIFIED.lock().ok()?.insert(id.into(), path.clone());
    Some(path)
}
pub(crate) fn cache(app: &AppHandle) -> Result<PathBuf, Value> {
    app.path().app_data_dir().map(|root| root.join("runtime-components")).map_err(|_| failure())
}
fn failure() -> Value { json!({"code":"UPDATE_COMPONENTS", "message":"更新运行环境校验失败，请重新检查更新或使用完整安装包。"}) }
pub(crate) fn hash(path: &Path) -> Result<String, Value> {
    let mut file = fs::File::open(path).map_err(|_| failure())?;
    let mut digest = Sha256::new(); let mut buffer = [0; 65536];
    loop { let n = file.read(&mut buffer).map_err(|_| failure())?; if n == 0 { break; } digest.update(&buffer[..n]); }
    Ok(format!("{:x}", digest.finalize()))
}
fn safe_relative(name: &str) -> bool {
    !name.is_empty() && !name.contains(['\\', ':']) && !name.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        && Path::new(name).components().all(|c| matches!(c, Component::Normal(_)))
}
fn hex(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn regular(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| {
        #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if m.file_attributes() & 0x400 != 0 { return false; } }
        m.is_file() && !m.file_type().is_symlink()
    })
}
fn entries(root: &Path, expected: &str) -> Result<BTreeMap<String, String>, Value> {
    if !hex(expected) || !regular(&root.join("manifest.json")) || hash(&root.join("manifest.json"))? != expected { return Err(failure()); }
    let value: Value = serde_json::from_slice(&fs::read(root.join("manifest.json")).map_err(|_| failure())?).map_err(|_| failure())?;
    let files = value["files"].as_object().filter(|files| !files.is_empty() && files.len() <= 50000).ok_or_else(failure)?;
    files.iter().map(|(name, value)| {
        let sha = value.as_str().or_else(|| value["sha256"].as_str()).ok_or_else(failure)?;
        if !safe_relative(name) || name == "manifest.json" || !hex(sha) { return Err(failure()); }
        Ok((name.clone(), sha.into()))
    }).collect()
}
pub(crate) fn verify(root: &Path, expected: &str) -> Result<(), Value> {
    let canonical = fs::canonicalize(root).map_err(|_| failure())?;
    for (name, expected) in entries(root, expected)? {
        let file = root.join(name);
        if !regular(&file) || !fs::canonicalize(&file).is_ok_and(|path| path.starts_with(&canonical)) || hash(&file)? != expected { return Err(failure()); }
    }
    Ok(())
}
pub(crate) fn component_path(base: &Path, id: &str, expected: &str) -> PathBuf { base.join(id).join(expected) }
fn publish(temp: tempfile::TempDir, target: &Path, expected: &str) -> Result<(), Value> {
    verify(temp.path(), expected)?;
    fs::create_dir_all(target.parent().ok_or_else(failure)?).map_err(|_| failure())?;
    // A damaged cache is quarantined only inside this component's own directory.
    if target.exists() {
        if verify(target, expected).is_ok() { return Ok(()); }
        fs::rename(target, target.with_file_name(format!("{expected}.invalid-{}", uuid::Uuid::new_v4()))).map_err(|_| failure())?;
    }
    fs::rename(temp.path(), target).map_err(|_| failure())
}
pub(crate) fn reuse(base: &Path, resources: &Path, component: &RuntimePackage) -> Result<bool, Value> {
    let target = component_path(base, &component.id, &component.manifest_sha256);
    if verify(&target, &component.manifest_sha256).is_ok() { return Ok(true); }
    let source = resources.join(&component.id);
    if verify(&source, &component.manifest_sha256).is_err() { return Ok(false); }
    fs::create_dir_all(base).map_err(|_| failure())?;
    let temp = tempfile::Builder::new().prefix("staging-").tempdir_in(base).map_err(|_| failure())?;
    // Copy only pinned files; bytecode, local edits and unrelated files never migrate.
    for name in entries(&source, &component.manifest_sha256)?.keys().map(String::as_str).chain(std::iter::once("manifest.json")) {
        let target = temp.path().join(name);
        fs::create_dir_all(target.parent().ok_or_else(failure)?).map_err(|_| failure())?;
        fs::copy(source.join(name), target).map_err(|_| failure())?;
    }
    publish(temp, &target, &component.manifest_sha256)?;
    Ok(true)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Artifact { pub url: String, pub signature: String, pub bytes: u64, pub sha256: String }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RuntimePackage { pub id: String, pub manifest_sha256: String, pub installed_bytes: u64, pub artifact: Artifact }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateIndex { pub schema: u32, pub version: String, pub platform: String, pub application: Artifact, pub runtimes: Vec<RuntimePackage> }
impl UpdateIndex {
    pub(crate) fn validate(&self, version: &str) -> Result<(), Value> {
        if self.schema != 1 || self.platform != "windows-x86_64" || self.version != version || self.runtimes.len() != IDS.len() { return Err(failure()); }
        let mut seen = BTreeSet::new();
        for runtime in &self.runtimes {
            if !IDS.contains(&runtime.id.as_str()) || !seen.insert(&runtime.id) || !hex(&runtime.manifest_sha256)
                || runtime.installed_bytes == 0 || runtime.installed_bytes > 2_000_000_000 { return Err(failure()); }
            validate_artifact(&runtime.artifact)?;
        }
        validate_artifact(&self.application)
    }
}
fn validate_artifact(a: &Artifact) -> Result<(), Value> {
    let url = reqwest::Url::parse(&a.url).map_err(|_| failure())?;
    let local = cfg!(debug_assertions) && url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if (!local && url.scheme() != "https") || !url.username().is_empty() || url.password().is_some()
        || url.host_str().is_none() || !hex(&a.sha256) || a.signature.is_empty() || a.bytes == 0 || a.bytes > 1_000_000_000 { return Err(failure()); }
    Ok(())
}
pub(crate) fn verify_download(bytes: &[u8], artifact: &Artifact) -> Result<(), Value> {
    if bytes.len() as u64 != artifact.bytes || format!("{:x}", Sha256::digest(bytes)) != artifact.sha256 { return Err(failure()); } Ok(())
}
pub(crate) fn unpack(base: &Path, package: &RuntimePackage, bytes: &[u8]) -> Result<(), Value> {
    verify_download(bytes, &package.artifact)?;
    fs::create_dir_all(base).map_err(|_| failure())?;
    let temp = tempfile::Builder::new().prefix("staging-").tempdir_in(base).map_err(|_| failure())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut seen = BTreeSet::new(); let mut total = 0u64;
    for entry in archive.entries().map_err(|_| failure())? {
        let mut entry = entry.map_err(|_| failure())?;
        let name = entry.path().map_err(|_| failure())?.to_str().ok_or_else(failure)?.to_owned();
        if !safe_relative(&name) || !entry.header().entry_type().is_file() || !seen.insert(name.clone()) || seen.len() > 50001 { return Err(failure()); }
        total = total.checked_add(entry.size()).filter(|total| *total <= package.installed_bytes).ok_or_else(failure)?;
        let file = temp.path().join(name); fs::create_dir_all(file.parent().ok_or_else(failure)?).map_err(|_| failure())?;
        let mut out = fs::OpenOptions::new().create_new(true).write(true).open(file).map_err(|_| failure())?;
        std::io::copy(&mut entry, &mut out).map_err(|_| failure())?; out.flush().map_err(|_| failure())?;
    }
    let allowed: BTreeSet<_> = entries(temp.path(), &package.manifest_sha256)?.into_keys().chain(std::iter::once("manifest.json".into())).collect();
    if total != package.installed_bytes || seen != allowed { return Err(failure()); }
    publish(temp, &component_path(base, &package.id, &package.manifest_sha256), &package.manifest_sha256)
}

fn update_failure(code: &str, message: &str) -> Value { json!({"code":code,"message":message}) }
fn trusted_url(url: &reqwest::Url) -> bool { url.username().is_empty() && url.password().is_none() && (url.scheme()=="https" || (cfg!(debug_assertions) && url.scheme()=="http" && matches!(url.host_str(),Some("127.0.0.1"|"localhost"|"[::1]")))) }
pub(crate) fn artifact_update(update: &Update, artifact: &Artifact, proxy_for: fn(&str) -> Result<Option<String>, Value>) -> Result<Update, Value> {
    let url = reqwest::Url::parse(&artifact.url).map_err(|_| update_failure("UPDATE_COMPONENTS", "更新运行环境地址无效。"))?;
    if !trusted_url(&url) { return Err(update_failure("UPDATE_COMPONENTS", "更新运行环境地址无效。")); }
    let mut next = update.clone(); next.download_url = url; next.signature = artifact.signature.clone();
    next.timeout = Some(Duration::from_secs(600));
    next.proxy = proxy_for(&artifact.url)?
        .map(|url| reqwest::Url::parse(&url)).transpose().map_err(|_| update_failure("UPDATE_NETWORK", "更新代理地址不可读。"))?;
    next.no_proxy = next.proxy.is_none();
    Ok(next)
}
pub(crate) async fn download_artifact(update: &Update, artifact: &Artifact, events: &Channel<Value>, transferred: u64, proxy_for: fn(&str) -> Result<Option<String>, Value>) -> Result<Vec<u8>, Value> {
    let update = artifact_update(update, artifact, proxy_for)?;
    let mut count = transferred;
    // During index/component preparation the final missing-component total is
    // still being determined; avoid displaying repeated 100% -> 0% jumps.
    let bytes = update.download(|n, _| { count += n as u64; let _ = events.send(json!({"phase":"downloading","downloaded":count})); },
        || { let _ = events.send(json!({"phase":"verifying"})); }).await
        .map_err(|_| update_failure("UPDATE_VERIFY", "更新下载或签名验证失败，请重新检查后重试。"))?;
    verify_download(&bytes, artifact)?;
    Ok(bytes)
}
pub(crate) async fn prepare(update: Update, events: &Channel<Value>, base: PathBuf, resources: PathBuf, proxy_for: fn(&str) -> Result<Option<String>, Value>) -> Result<(Update, Option<UpdateIndex>, u64, usize), Value> {
    let Some(pointer) = update.raw_json.get("componentUpdate") else { return Ok((update, None, 0, 0)); };
    let pointer: Artifact = serde_json::from_value(pointer.clone()).map_err(|_| update_failure("UPDATE_COMPONENTS", "更新运行环境清单无效。"))?;
    if pointer.bytes > 1_000_000 { return Err(update_failure("UPDATE_COMPONENTS", "更新运行环境清单无效。")); }
    // The ordinary updater remains a full-installer fallback for old clients.
    // Only a separately signed, version-bound index can select the small installer.
    let index_bytes = download_artifact(&update, &pointer, events, 0, proxy_for).await?;
    let value: Value = serde_json::from_slice(&index_bytes).map_err(|_| update_failure("UPDATE_COMPONENTS", "更新运行环境清单无效。"))?;
    // A future signed component protocol must not strand this client. The
    // ordinary full installer remains independently signed and self-contained.
    if value["schema"] != 1 { return Ok((update, None, index_bytes.len() as u64, 0)); }
    let index: UpdateIndex = serde_json::from_value(value).map_err(|_| update_failure("UPDATE_COMPONENTS", "更新运行环境清单无效。"))?;
    index.validate(&update.version)?;
    let mut transferred = index_bytes.len() as u64; let mut reused = 0;
    for package in &index.runtimes {
        let (base_copy, resources_copy, package_copy) = (base.clone(), resources.clone(), package.clone());
        let cached = tauri::async_runtime::spawn_blocking(move || reuse(&base_copy, &resources_copy, &package_copy))
            .await.map_err(|_| update_failure("UPDATE_COMPONENTS", "无法准备更新运行环境。"))??;
        if cached { reused += 1; continue; }
        let bytes = download_artifact(&update, &package.artifact, events, transferred, proxy_for).await?;
        transferred += bytes.len() as u64;
        let (base_copy, package_copy) = (base.clone(), package.clone());
        tauri::async_runtime::spawn_blocking(move || unpack(&base_copy, &package_copy, &bytes))
            .await.map_err(|_| update_failure("UPDATE_COMPONENTS", "无法准备更新运行环境。"))??;
    }
    let next = artifact_update(&update, &index.application, proxy_for)?;
    Ok((next, Some(index), transferred, reused))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn package(root: &Path, id: &str, content: &[u8]) -> RuntimePackage {
        fs::create_dir_all(root.join("nested")).unwrap(); fs::write(root.join("nested/engine.bin"), content).unwrap();
        fs::write(root.join("manifest.json"), serde_json::to_vec(&json!({"files":{"nested/engine.bin":format!("{:x}",Sha256::digest(content))}})).unwrap()).unwrap();
        RuntimePackage{id:id.into(),manifest_sha256:hash(&root.join("manifest.json")).unwrap(),installed_bytes:content.len() as u64+fs::metadata(root.join("manifest.json")).unwrap().len(),
            artifact:Artifact{url:"https://example.test/runtime.tar.gz".into(),signature:"fixture".into(),bytes:1,sha256:"0".repeat(64)}}
    }
    fn archive(root: &Path, p: &mut RuntimePackage, extra: Option<(&str, &[u8])>) -> Vec<u8> {
        let gzip=flate2::write::GzEncoder::new(Vec::new(),flate2::Compression::default()); let mut tar=tar::Builder::new(gzip);
        for name in ["manifest.json","nested/engine.bin"] { tar.append_path_with_name(root.join(name),name).unwrap(); }
        if let Some((name, content))=extra { let mut header=tar::Header::new_gnu();header.set_size(content.len() as u64);header.set_mode(0o644);header.set_cksum();tar.append_data(&mut header,name,content).unwrap(); }
        let bytes=tar.into_inner().unwrap().finish().unwrap();p.artifact.bytes=bytes.len() as u64;p.artifact.sha256=format!("{:x}",Sha256::digest(&bytes));bytes
    }
    #[test]
    fn unchanged_runtime_migrates_without_download_and_survives_removal_of_install_folder() {
        let dir=tempfile::tempdir().unwrap();let resources=dir.path().join("installed");let source=resources.join("codex-runtime");let p=package(&source,"codex-runtime",b"working runtime");
        let cache=dir.path().join("cache");assert!(reuse(&cache,&resources,&p).unwrap());fs::remove_dir_all(resources).unwrap();
        assert!(reuse(&cache,&dir.path().join("absent"),&p).unwrap());verify(&component_path(&cache,&p.id,&p.manifest_sha256),&p.manifest_sha256).unwrap();
    }
    #[test]
    fn changed_component_is_atomic_and_does_not_replace_previous_runtime() {
        let dir=tempfile::tempdir().unwrap();let resources=dir.path().join("installed");let old=package(&resources.join("python-runtime"),"python-runtime",b"old");let cache=dir.path().join("cache");assert!(reuse(&cache,&resources,&old).unwrap());
        let mut new=package(&dir.path().join("new"),"python-runtime",b"new runtime");assert!(!reuse(&cache,&resources,&new).unwrap());let bytes=archive(&dir.path().join("new"),&mut new,None);unpack(&cache,&new,&bytes).unwrap();
        verify(&component_path(&cache,&old.id,&old.manifest_sha256),&old.manifest_sha256).unwrap();verify(&component_path(&cache,&new.id,&new.manifest_sha256),&new.manifest_sha256).unwrap();
    }
    #[test]
    fn interrupted_tampered_oversized_and_extra_file_archives_cannot_activate() {
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("source");let mut p=package(&source,"audio-runtime",b"engine");let bytes=archive(&source,&mut p,None);let cache=dir.path().join("cache");
        assert!(unpack(&cache,&p,&bytes[..bytes.len()-1]).is_err());assert!(!component_path(&cache,&p.id,&p.manifest_sha256).exists());
        let mut corrupted=bytes.clone();corrupted[10]^=1;assert!(unpack(&cache,&p,&corrupted).is_err());
        p.installed_bytes-=1;assert!(unpack(&cache,&p,&bytes).is_err());p.installed_bytes+=1;
        let extra=archive(&source,&mut p,Some(("unlisted.exe",b"bad")));p.installed_bytes+=3;assert!(unpack(&cache,&p,&extra).is_err());
        assert!(!component_path(&cache,&p.id,&p.manifest_sha256).exists());
    }
    #[test]
    fn corrupt_cached_component_is_repaired_without_deleting_old_version() {
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("installed/codex-runtime");let p=package(&source,"codex-runtime",b"engine");let cache=dir.path().join("cache");let resources=source.parent().unwrap();assert!(reuse(&cache,resources,&p).unwrap());
        fs::write(component_path(&cache,&p.id,&p.manifest_sha256).join("nested/engine.bin"),b"corrupt").unwrap();assert!(reuse(&cache,resources,&p).unwrap());verify(&component_path(&cache,&p.id,&p.manifest_sha256),&p.manifest_sha256).unwrap();
    }
    #[test]
    fn paths_versions_duplicates_and_missing_catalog_entries_are_rejected() {
        for path in ["../outside","/absolute","C:/outside","nested\\outside","a/./b","a//b"] { assert!(!safe_relative(path),"{path}"); }
        let dir=tempfile::tempdir().unwrap();let p=package(&dir.path().join("source"),"codex-runtime",b"engine");
        let mut index=UpdateIndex{schema:1,version:"0.2.5".into(),platform:"windows-x86_64".into(),application:p.artifact.clone(),runtimes:IDS.iter().map(|id|RuntimePackage{id:(*id).into(),..p.clone()}).collect()};
        index.validate("0.2.5").unwrap();assert!(index.validate("0.2.6").is_err());index.runtimes[1].id=index.runtimes[0].id.clone();assert!(index.validate("0.2.5").is_err());
    }
    #[test]
    fn link_entries_cannot_write_or_activate_an_external_payload() {
        let dir=tempfile::tempdir().unwrap();let source=dir.path().join("source");let mut p=package(&source,"python-runtime",b"engine");
        let gzip=flate2::write::GzEncoder::new(Vec::new(),flate2::Compression::default());let mut archive=tar::Builder::new(gzip);
        let mut header=tar::Header::new_gnu();header.set_entry_type(tar::EntryType::Symlink);header.set_size(0);header.set_mode(0o644);header.set_link_name("../outside").unwrap();header.set_cksum();
        archive.append_data(&mut header,"linked-engine",std::io::empty()).unwrap();let bytes=archive.into_inner().unwrap().finish().unwrap();
        p.artifact.bytes=bytes.len() as u64;p.artifact.sha256=format!("{:x}",Sha256::digest(&bytes));let cache=dir.path().join("cache");
        assert!(unpack(&cache,&p,&bytes).is_err());assert!(!component_path(&cache,&p.id,&p.manifest_sha256).exists());assert!(!dir.path().join("outside").exists());
    }
    #[test]
    fn real_prepared_runtimes_match_build_pins() {
        let native=PathBuf::from(env!("CARGO_MANIFEST_DIR"));let catalog=required();
        for (source,id) in [("codex","codex-runtime"),("pgedge","pgedge-runtime"),("documents","document-runtime"),("dbhub","dbhub-runtime"),("audio","audio-runtime"),("python","python-runtime")] {
            verify(&native.join("resources").join(source),&catalog[id]).unwrap();
        }
    }
}

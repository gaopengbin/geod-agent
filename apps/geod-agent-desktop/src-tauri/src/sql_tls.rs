//! Owned, user-only session material for the versioned DBHub TLS extension.
use crate::{workspace_error, AppError};
use fs2::FileExt;
use serde_json::json;
use std::{fs, fs::File, io::Write, path::{Path, PathBuf}};
use uuid::Uuid;

fn failed() -> AppError { workspace_error("INPUT_CREDENTIAL_FAILED", "数据库证书无法读取，请在本机重新配置") }
pub(crate) fn validate_ca(ca: Option<&str>, mode: &str) -> Result<Option<String>, AppError> {
    let Some(ca) = ca.filter(|value| !value.trim().is_empty()) else { return Ok(None); };
    if mode == "disable" || ca.len() > 256*1024 || ca.contains("PRIVATE KEY")
        || reqwest::Certificate::from_pem_bundle(ca.as_bytes()).map(|certs| certs.is_empty()).unwrap_or(true) {
        return Err(workspace_error("INPUT_TLS_INVALID", "请选择有效的 CA 证书并启用加密连接"));
    }
    Ok(Some(ca.to_owned()))
}

pub(crate) struct Material {
    pub(crate) settings: PathBuf,
    pub(crate) ca: Option<PathBuf>,
    directory: PathBuf,
    lease: Option<File>,
}
impl Drop for Material {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.settings);
        if let Some(path) = &self.ca { let _ = fs::remove_file(path); }
        self.lease.take();
        let _ = fs::remove_file(self.directory.join(".lease"));
        let _ = fs::remove_dir(&self.directory);
    }
}
pub(crate) fn prepare(root: &Path, id: &str, mode: &str, ca: Option<&str>, client: bool) -> Result<Material, AppError> {
    let ca = validate_ca(ca, mode)?;
    let secret = if client { Some(crate::database_tls::load(root, id, mode)?) } else { None };
    let parent = root.join("tmp");
    fs::create_dir_all(&parent).map_err(|_| failed())?;
    cleanup(root);
    let directory = parent.join(format!(".sql-tls-session-{}", Uuid::new_v4()));
    crate::database_tls::secure_directory(&directory)?;
    let mut material = Material { settings: directory.join("settings.json"), ca: ca.as_ref().map(|_| directory.join("ca.pem")), directory, lease: None };
    let lease = fs::OpenOptions::new().read(true).write(true).create_new(true).open(material.directory.join(".lease")).map_err(|_| failed())?;
    lease.try_lock_exclusive().map_err(|_| failed())?;
    material.lease = Some(lease);
    let mut value = json!({"mode": mode});
    if let Some(ca) = &ca { value["ca"] = json!(ca); }
    if let Some(secret) = &secret { value["cert"] = json!(secret.certificate); value["key"] = json!(secret.key); }
    let bytes = zeroize::Zeroizing::new(serde_json::to_vec(&value).map_err(|_| failed())?);
    if let Some(serde_json::Value::String(key)) = value.get_mut("key") { zeroize::Zeroize::zeroize(key); }
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&material.settings).map_err(|_| failed())?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| failed())?;
    if let (Some(path), Some(ca)) = (&material.ca, &ca) { fs::write(path, ca).map_err(|_| failed())?; }
    Ok(material)
}
pub(crate) fn cleanup(root: &Path) {
    let Ok(parent) = root.join("tmp").canonicalize() else { return; };
    let Ok(entries) = fs::read_dir(&parent) else { return; };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.strip_prefix(".sql-tls-session-").is_some_and(|value| Uuid::parse_str(value).is_ok()) { continue; }
        let directory = parent.join(name);
        if fs::symlink_metadata(&directory).map(|m| !m.is_dir() || m.file_type().is_symlink()).unwrap_or(true)
            || directory.canonicalize().ok().as_ref() != Some(&directory) { continue; }
        let Ok(lease) = fs::OpenOptions::new().read(true).write(true).open(directory.join(".lease")) else { continue; };
        if lease.try_lock_exclusive().is_err() { continue; }
        drop(lease);
        for file in ["settings.json", "ca.pem", ".lease"] { let _ = fs::remove_file(directory.join(file)); }
        let _ = fs::remove_dir(directory);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn session_lease_preserves_active_material_and_drop_removes_it() {
        let root = tempfile::tempdir().unwrap();
        let material = prepare(root.path(), &Uuid::new_v4().to_string(), "require", None, false).unwrap();
        let directory = material.directory.clone();
        assert_eq!(fs::read_to_string(&material.settings).unwrap(), "{\"mode\":\"require\"}");
        cleanup(root.path()); assert!(directory.exists());
        drop(material); assert!(!directory.exists());
        let orphan = root.path().join("tmp").join(format!(".sql-tls-session-{}", Uuid::new_v4()));
        crate::database_tls::secure_directory(&orphan).unwrap();
        fs::write(orphan.join(".lease"), b"").unwrap();
        fs::write(orphan.join("settings.json"), b"owned orphan secret").unwrap();
        cleanup(root.path()); assert!(!orphan.exists());
    }
    #[test]
    fn invalid_ca_is_not_treated_as_a_saved_credential() {
        assert!(validate_ca(Some("-----BEGIN PRIVATE KEY-----"), "verify-full").is_err());
        assert!(validate_ca(Some("invalid CA"), "require").is_err());
        assert_eq!(validate_ca(None, "verify-full").unwrap(), None);
    }
}

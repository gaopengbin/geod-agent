//! Client TLS material is DPAPI protected at rest and never part of MCP metadata.
//! pgEdge requires file paths, so each owned session gets a user-only directory.
use crate::{workspace_error, AppError};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, fs::File, path::{Path, PathBuf}};
use uuid::Uuid;
use zeroize::Zeroize;
use std::{process::Stdio,time::Duration};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

#[derive(Serialize, Deserialize)]
pub(crate) struct Secret { pub(crate) certificate: String, pub(crate) key: String }
impl Drop for Secret { fn drop(&mut self) { self.key.zeroize(); } }
fn failed() -> AppError { workspace_error("INPUT_CREDENTIAL_FAILED", "客户端证书无法保存或读取，请在本机重新配置证书和私钥") }
fn invalid() -> AppError { workspace_error("INPUT_TLS_INVALID", "请提供匹配的客户端证书和 PEM 私钥；双向证书需要启用 TLS") }
fn key_error(code:&str)->AppError{
    match code{
        "INPUT_TLS_KEY_PASSWORD_REQUIRED"=>workspace_error("INPUT_TLS_KEY_PASSWORD_REQUIRED","请输入客户端私钥密码"),
        "INPUT_TLS_KEY_PASSWORD_INCORRECT"=>workspace_error("INPUT_TLS_KEY_PASSWORD_INCORRECT","客户端私钥密码不正确，请重试"),
        "INPUT_TLS_KEY_PASSWORD_INPUT"=>workspace_error("INPUT_TLS_KEY_PASSWORD_INPUT","客户端私钥密码格式无效"),
        "INPUT_TLS_KEY_UNSUPPORTED"=>workspace_error("INPUT_TLS_KEY_UNSUPPORTED","此客户端私钥的加密方式暂不支持"),
        "INPUT_TLS_KEY_RUNTIME"=>workspace_error("INPUT_TLS_KEY_RUNTIME","内置私钥解析环境无法启动，请修复应用"),
        _=>workspace_error("INPUT_TLS_INVALID","请选择匹配的客户端证书和 PEM 私钥"),
    }
}
pub(crate) fn requires_local_input(error:&AppError)->bool{matches!(error.code,"INPUT_TLS_KEY_PASSWORD_REQUIRED"|"INPUT_TLS_KEY_PASSWORD_INCORRECT"|"INPUT_TLS_INVALID")}
pub(crate) async fn unlock(app:&AppHandle,certificate:Option<&str>,key:Option<String>,password:Option<String>)->Result<Option<String>,AppError>{
    let key=key.map(zeroize::Zeroizing::new);
    let password=password.map(zeroize::Zeroizing::new);
    if password.as_ref().is_some_and(|value|value.len()>4096){return Err(key_error("INPUT_TLS_KEY_PASSWORD_INPUT"));}
    let Some(key)=key.filter(|value|!value.trim().is_empty())else{return Ok(None)};
    if key.len()>64*1024{return Err(key_error("INPUT_TLS_INVALID"));}
    if !key.contains("ENCRYPTED"){return Ok(Some(key.to_string()));}
    let certificate=certificate.filter(|value|!value.trim().is_empty()&&value.len()<=256*1024).ok_or_else(||key_error("INPUT_TLS_INVALID"))?;
    let root=crate::attachment_inputs::parser_root(app).map_err(|_|key_error("INPUT_TLS_KEY_RUNTIME"))?;
    let mut command=crate::python_runtime::command(include_str!("private_key_worker.py"))?;
    command.arg(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut request=serde_json::json!({"certificate":certificate,"key":key.as_str(),"password":password.as_ref().map(|value|value.as_str())});
    let bytes=zeroize::Zeroizing::new(serde_json::to_vec(&request).map_err(|_|key_error("INPUT_TLS_INVALID"))?);
    for field in ["key","password"]{if let Some(Value::String(value))=request.get_mut(field){value.zeroize();}}
    let output=tokio::time::timeout(Duration::from_secs(20),async{
        let mut child=command.spawn()?;
        if let Some(mut input)=child.stdin.take(){input.write_all(&bytes).await?;}
        child.wait_with_output().await
    }).await.map_err(|_|key_error("INPUT_TLS_KEY_RUNTIME"))?.map_err(|_|key_error("INPUT_TLS_KEY_RUNTIME"))?;
    let stdout=zeroize::Zeroizing::new(output.stdout);
    if stdout.len()>128*1024{return Err(key_error("INPUT_TLS_INVALID"));}
    let mut response:Value=serde_json::from_slice(&stdout).map_err(|_|key_error("INPUT_TLS_INVALID"))?;
    if !output.status.success()||response["ok"]!=true{return Err(key_error(response["error"].as_str().unwrap_or("")));}
    let Value::String(plain)=response["key"].take()else{return Err(key_error("INPUT_TLS_INVALID"));};
    Ok(Some(plain))
}
fn path(root: &Path, id: &str) -> Result<PathBuf, AppError> {
    Uuid::parse_str(id).map_err(|_| failed())?;
    Ok(root.join("certificates").join(format!("{id}.client-tls")))
}
fn entropy(root: &Path, id: &str) -> Vec<u8> {
    format!("GeoD-database-TLS:{}:{id}", root.file_name().unwrap_or_default().to_string_lossy()).into_bytes()
}
pub fn validate(certificate: Option<&str>, key: Option<&str>, mode: &str) -> Result<bool, AppError> {
    let certificate = certificate.filter(|v| !v.trim().is_empty());
    let key = key.filter(|v| !v.trim().is_empty());
    match (certificate, key) {
        (None, None) => Ok(false),
        (Some(certificate), Some(key)) if ["require", "verify-ca", "verify-full"].contains(&mode) => {
            if certificate.len() > 256*1024 || key.len() > 64*1024 || certificate.contains("PRIVATE KEY")
                || key.contains("ENCRYPTED") || !key.contains("PRIVATE KEY")
                || reqwest::Certificate::from_pem_bundle(certificate.as_bytes()).map(|v| v.is_empty()).unwrap_or(true) {
                return Err(invalid());
            }
            let mut pem = format!("{key}\n{certificate}");
            let valid = reqwest::Identity::from_pem(pem.as_bytes()).is_ok();
            pem.zeroize();
            if !valid { return Err(invalid()); }
            Ok(true)
        },
        _ => Err(invalid()),
    }
}
pub fn save(root: &Path, id: &str, certificate: String, key: String) -> Result<(), AppError> {
    let secret = Secret { certificate, key };
    let mut plain = serde_json::to_vec(&secret).map_err(|_| failed())?;
    let sealed = protect(&plain, &entropy(root, id), false);
    plain.zeroize();
    let sealed = sealed?;
    let path = path(root, id)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|_| failed())?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| failed())?;
    use std::io::Write;
    if file.write_all(&sealed).and_then(|_| file.sync_all()).is_err() {
        drop(file); let _ = fs::remove_file(&path); return Err(failed());
    }
    Ok(())
}
pub fn remove(root: &Path, id: &str) { if let Ok(path) = path(root, id) { let _ = fs::remove_file(path); } }

pub struct Material { pub certificate: PathBuf, pub key: PathBuf, directory: PathBuf, lease: Option<File> }
impl Drop for Material {
    fn drop(&mut self) {
        // Only these generated files are removed; never recursively delete a path.
        let _ = fs::remove_file(&self.key); let _ = fs::remove_file(&self.certificate);
        self.lease.take();
        let _ = fs::remove_file(self.directory.join(".lease"));
        let _ = fs::remove_dir(&self.directory);
    }
}
pub fn prepare(database: &Value) -> Result<Option<Material>, AppError> {
    if database["clientCertificate"] != true { return Ok(None); }
    let root = Path::new(database["tlsRoot"].as_str().ok_or_else(failed)?);
    let id = database["id"].as_str().ok_or_else(failed)?;
    let secret = load(root, id, database["sslMode"].as_str().unwrap_or_default())?;
    cleanup(root);
    let parent = fs::canonicalize(root.join("certificates")).map_err(|_| failed())?;
    let directory = parent.join(format!(".tls-session-{}", Uuid::new_v4()));
    secure_directory(&directory)?;
    let mut material = Material { certificate: directory.join("client.pem"), key: directory.join("client.key"), directory, lease: None };
    let lease = fs::OpenOptions::new().read(true).write(true).create_new(true).open(material.directory.join(".lease")).map_err(|_| failed())?;
    lease.try_lock_exclusive().map_err(|_| failed())?;
    material.lease = Some(lease);
    fs::write(&material.certificate, &secret.certificate).map_err(|_| failed())?;
    fs::write(&material.key, &secret.key).map_err(|_| failed())?;
    Ok(Some(material))
}
pub(crate) fn load(root: &Path, id: &str, mode: &str) -> Result<Secret, AppError> {
    let stored = path(root, id)?;
    if fs::metadata(&stored).map(|m| m.len() > 512*1024).unwrap_or(true) { return Err(failed()); }
    let sealed = fs::read(stored).map_err(|_| failed())?;
    let mut plain = protect(&sealed, &entropy(root, id), true)?;
    let secret = serde_json::from_slice::<Secret>(&plain);
    plain.zeroize();
    let secret = secret.map_err(|_| failed())?;
    validate(Some(&secret.certificate), Some(&secret.key), mode)?;
    Ok(secret)
}
pub fn cleanup(root: &Path) {
    let Ok(parent) = fs::canonicalize(root.join("certificates")) else { return; };
    let Ok(entries) = fs::read_dir(&parent) else { return; };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.strip_prefix(".tls-session-").is_some_and(|v| Uuid::parse_str(v).is_ok()) { continue; }
        let directory = parent.join(name);
        if fs::symlink_metadata(&directory).map(|m| !m.is_dir() || m.file_type().is_symlink()).unwrap_or(true)
            || fs::canonicalize(&directory).ok().as_ref() != Some(&directory) { continue; }
        let Ok(lease) = fs::OpenOptions::new().read(true).write(true).open(directory.join(".lease")) else { continue; };
        if lease.try_lock_exclusive().is_err() { continue; } // Another GUI/daemon owns it.
        drop(lease);
        let _ = fs::remove_file(directory.join("client.key"));
        let _ = fs::remove_file(directory.join("client.pem"));
        let _ = fs::remove_file(directory.join(".lease"));
        let _ = fs::remove_dir(directory);
    }
}

#[cfg(windows)]
fn protect(bytes: &[u8], entropy: &[u8], decrypt: bool) -> Result<Vec<u8>, AppError> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::*};
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 };
    let entropy = CRYPT_INTEGER_BLOB { cbData: entropy.len() as u32, pbData: entropy.as_ptr() as *mut u8 };
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        if decrypt { CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
        else { CryptProtectData(&input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
    };
    if ok == 0 { return Err(failed()); }
    let result = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    if decrypt { unsafe { std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize).zeroize(); } }
    unsafe { LocalFree(output.pbData.cast()); }
    Ok(result)
}
#[cfg(windows)]
pub(crate) fn secure_directory(path: &Path) -> Result<(), AppError> {
    use std::{os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{Foundation::{CloseHandle, LocalFree}, Security::{*, Authorization::*}, Storage::FileSystem::CreateDirectoryW, System::Threading::{GetCurrentProcess, OpenProcessToken}};
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 { return Err(failed()); }
    let mut needed = 0;
    unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed); }
    let mut info = vec![0usize; (needed as usize + std::mem::size_of::<usize>() - 1)/std::mem::size_of::<usize>()];
    let ok = unsafe { GetTokenInformation(token, TokenUser, info.as_mut_ptr().cast(), needed, &mut needed) };
    unsafe { CloseHandle(token); }
    if ok == 0 { return Err(failed()); }
    let mut sid = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW((*(info.as_ptr().cast::<TOKEN_USER>())).User.Sid, &mut sid) } == 0 { return Err(failed()); }
    let mut len = 0; unsafe { while *sid.add(len) != 0 { len += 1; } }
    let sid_string = unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(sid, len)) };
    unsafe { LocalFree(sid.cast()); }
    let descriptor: Vec<u16> = format!("O:{sid_string}D:P(A;OICI;FA;;;{sid_string})").encode_utf16().chain(Some(0)).collect();
    let mut security = ptr::null_mut();
    if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor.as_ptr(), SDDL_REVISION_1, &mut security, ptr::null_mut()) } == 0 { return Err(failed()); }
    let attributes = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: security, bInheritHandle: 0 };
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let ok = unsafe { CreateDirectoryW(path.as_ptr(), &attributes) };
    unsafe { LocalFree(security.cast()); }
    if ok == 0 { Err(failed()) } else { Ok(()) }
}
#[cfg(not(windows))]
fn protect(_: &[u8], _: &[u8], _: bool) -> Result<Vec<u8>, AppError> { Err(failed()) }
#[cfg(not(windows))]
pub(crate) fn secure_directory(_: &Path) -> Result<(), AppError> { Err(failed()) }

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn dpapi_binds_owner_and_connection_and_cleans_orphans() {
        let temp = tempfile::tempdir().unwrap();
        let input = b"private credential acceptance";
        let sealed = protect(input, b"owner:id-a", false).unwrap();
        assert!(!sealed.windows(input.len()).any(|v| v == input));
        assert_eq!(protect(&sealed, b"owner:id-a", true).unwrap(), input);
        assert!(protect(&sealed, b"owner:id-b", true).is_err());
        let root = temp.path(); fs::create_dir(root.join("certificates")).unwrap();
        let parent = fs::canonicalize(root.join("certificates")).unwrap();
        let directory = parent.join(format!(".tls-session-{}", Uuid::new_v4()));
        secure_directory(&directory).unwrap();
        let lease = fs::OpenOptions::new().read(true).write(true).create_new(true).open(directory.join(".lease")).unwrap();
        lease.try_lock_exclusive().unwrap(); fs::write(directory.join("client.key"), input).unwrap();
        cleanup(root); assert!(directory.join("client.key").exists());
        drop(lease); cleanup(root); assert!(!directory.exists());
    }
}

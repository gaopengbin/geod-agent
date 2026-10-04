//! Hash-pinned local OCR models and packages; no downloads during document reads.
use crate::{workspace_error, AppError};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, path::{Component, Path, PathBuf}, sync::OnceLock};
use tauri::{AppHandle, Manager};

const MANIFEST: &str = include_str!("../resources/ocr/manifest.json");
static VERIFIED: OnceLock<PathBuf> = OnceLock::new();
fn error(message: &str) -> AppError { workspace_error("ATTACHMENT_OCR_RUNTIME", message) }
fn verify_files(root: &Path, files: &BTreeMap<String,String>) -> Result<(), AppError> {
    for (name, expected) in files {
        let relative = Path::new(name);
        if relative.components().any(|part|!matches!(part,Component::Normal(_))) || expected.len()!=64 {
            return Err(error("内置扫描识别环境校验失败，请修复应用"));
        }
        let mut file=fs::File::open(root.join(relative)).map_err(|_|error("内置扫描识别环境缺失，请修复应用"))?;
        let mut hash=Sha256::new();let mut buffer=[0u8;65536];
        loop {let length=file.read(&mut buffer).map_err(|_|error("无法读取内置扫描识别环境"))?;if length==0{break;}hash.update(&buffer[..length]);}
        if format!("{:x}",hash.finalize())!=*expected{return Err(error("内置扫描识别环境校验失败，请修复应用"));}
    }
    Ok(())
}
pub(crate) fn root(app: &AppHandle) -> Result<PathBuf,AppError> {
    if let Some(root)=VERIFIED.get(){return Ok(root.clone());}
    let mut roots=vec![];
    if let Ok(root)=app.path().resource_dir(){roots.push(root.join("ocr-runtime"));}
    if cfg!(debug_assertions){roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/ocr"));}
    if let Some(root)=std::env::current_exe().ok().and_then(|path|path.parent().map(Path::to_path_buf)){roots.push(root.join("ocr-runtime"));}
    let root=roots.into_iter().find(|root|root.join("manifest.json").is_file()).ok_or_else(||error("内置扫描识别环境缺失，请修复应用"))?;
    if fs::read(root.join("manifest.json")).map_err(|_|error("无法读取内置扫描识别环境"))?!=MANIFEST.as_bytes(){return Err(error("内置扫描识别环境校验失败，请修复应用"));}
    let value:serde_json::Value=serde_json::from_str(MANIFEST).map_err(|_|error("内置扫描识别配置无效"))?;
    let files:BTreeMap<String,String>=serde_json::from_value(value["files"].clone()).map_err(|_|error("内置扫描识别配置无效"))?;
    if files.is_empty(){return Err(error("内置扫描识别配置无效"));}
    verify_files(&root,&files)?;
    let _=VERIFIED.set(root.clone());Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_or_escaping_ocr_files_are_rejected() {
        let folder=tempfile::tempdir().unwrap();let name="model.onnx";
        fs::write(folder.path().join(name),b"accepted local model").unwrap();
        let mut files=BTreeMap::from([(name.into(),format!("{:x}",Sha256::digest(b"accepted local model")))]);
        verify_files(folder.path(),&files).unwrap();
        fs::write(folder.path().join(name),b"modified").unwrap();assert_eq!(verify_files(folder.path(),&files).unwrap_err().code,"ATTACHMENT_OCR_RUNTIME");
        files.insert("../external.onnx".into(),"0".repeat(64));assert!(verify_files(folder.path(),&files).is_err());
    }
}

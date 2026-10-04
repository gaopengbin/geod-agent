//! Private read-only Office runtime. No system Java or inherited JVM options.
use crate::{workspace_error, AppError};
use sha2::{Digest,Sha256};
use std::{collections::BTreeMap,fs,io::Read,path::{Component,Path,PathBuf},sync::OnceLock};
use tauri::{AppHandle,Manager};

const MANIFEST:&str=include_str!("../resources/legacy-office/manifest.json");
static VERIFIED:OnceLock<PathBuf>=OnceLock::new();
fn error(message:&str)->AppError{workspace_error("ATTACHMENT_OFFICE_RUNTIME",message)}
pub(crate) fn root(app:&AppHandle)->Result<PathBuf,AppError>{
    if let Some(root)=VERIFIED.get(){return Ok(root.clone());}
    let mut roots=vec![];
    if cfg!(debug_assertions){roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/legacy-office"));}
    if let Ok(root)=app.path().resource_dir(){roots.push(root.join("legacy-office-runtime"));}
    if let Some(root)=std::env::current_exe().ok().and_then(|path|path.parent().map(Path::to_path_buf)){roots.push(root.join("legacy-office-runtime"));}
    let root=roots.into_iter().find(|root|root.join("manifest.json").is_file()).ok_or_else(||error("内置 Office 解析环境缺失，请修复应用"))?;
    if fs::read(root.join("manifest.json")).map_err(|_|error("无法读取内置 Office 解析环境"))?!=MANIFEST.as_bytes(){return Err(error("内置 Office 解析环境校验失败，请修复应用"));}
    let value:serde_json::Value=serde_json::from_str(MANIFEST).map_err(|_|error("内置 Office 解析配置无效"))?;
    let files:BTreeMap<String,String>=serde_json::from_value(value["files"].clone()).map_err(|_|error("内置 Office 解析配置无效"))?;
    if files.is_empty(){return Err(error("内置 Office 解析配置无效"));}
    for(name,expected)in files{
        if Path::new(&name).components().any(|part|!matches!(part,Component::Normal(_)))||expected.len()!=64{return Err(error("内置 Office 解析环境校验失败，请修复应用"));}
        let mut file=fs::File::open(root.join(name)).map_err(|_|error("内置 Office 解析环境缺失，请修复应用"))?;
        let mut hash=Sha256::new();let mut buffer=[0u8;65536];
        loop{let count=file.read(&mut buffer).map_err(|_|error("无法读取内置 Office 解析环境"))?;if count==0{break;}hash.update(&buffer[..count]);}
        if format!("{:x}",hash.finalize())!=expected{return Err(error("内置 Office 解析环境校验失败，请修复应用"));}
    }
    let _=VERIFIED.set(root.clone());Ok(root)
}
// Windows resource_dir may use the extended path prefix. The JVM's classpath
// URL loader treats that prefix as a malformed UNC host, unlike Windows file IO.
pub(crate) fn java_path(path:&Path)->String{
    let value=path.to_string_lossy();
    if let Some(tail)=value.strip_prefix(r"\\?\UNC\"){return format!(r"\\{}",tail);}
    value.strip_prefix(r"\\?\").unwrap_or(&value).to_owned()
}
pub(crate) fn command(root:&Path,temporary:&Path)->tokio::process::Command{
    let mut command=tokio::process::Command::new(root.join("java/bin/java.exe"));
    command.env_clear();
    for key in ["SYSTEMROOT","WINDIR"]{if let Some(value)=std::env::var_os(key){command.env(key,value);}}
    command.env("TEMP",temporary).env("TMP",temporary);
    if let Some(value)=std::env::var_os("SYSTEMROOT"){command.env("PATH",PathBuf::from(value).join("System32"));}
    command.args(["-Xms16m","-Xmx384m","-Djava.awt.headless=true","-Dfile.encoding=UTF-8"])
        .arg(format!("-Djava.io.tmpdir={}",java_path(temporary))).arg("-cp")
        .arg(format!("{};{}",java_path(root),java_path(&root.join("tika-app-3.3.2.jar")))).arg("GeodOfficeReader");
    #[cfg(windows)]command.creation_flags(0x08000000);
    command
}

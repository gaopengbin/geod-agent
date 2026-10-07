//! Optional, pinned RTK stdin filter. It never executes the user's command.
use crate::{services, workspace_error, AppError};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

static DATA: OnceLock<PathBuf> = OnceLock::new();
static INSTALLS: Mutex<BTreeMap<String, (String, Arc<AtomicBool>)>> = Mutex::new(BTreeMap::new());
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Package {version:String,url:String,filename:String,download_bytes:u64,sha256:String,executable_member:String,executable_bytes:u64,executable_sha256:String,license_sha256:String}
fn package()->Package{serde_json::from_str(include_str!("../../../../vendor/rtk-runtime.json")).expect("pinned RTK catalog")}
fn error(code:&'static str,message:&str)->AppError{workspace_error(code,message)}
pub(crate) fn initialize(base:PathBuf){let _=DATA.set(base.join("rtk-runtime"));}
fn base()->Result<PathBuf,AppError>{DATA.get().cloned().ok_or_else(||error("RTK_STORAGE","无法读取命令精简组件保存位置"))}
fn owner(app:&AppHandle)->Result<String,AppError>{services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))}
fn regular(path:&Path,directory:bool)->bool{fs::symlink_metadata(path).is_ok_and(|m|{
    #[cfg(windows)]{use std::os::windows::fs::MetadataExt;if m.file_attributes()&0x400!=0{return false;}}
    !m.file_type().is_symlink()&&if directory{m.is_dir()}else{m.is_file()}
})}
fn directory(path:&Path)->Result<(),AppError>{
    if !path.exists(){fs::create_dir_all(path).map_err(|_|error("RTK_STORAGE","无法准备命令精简组件目录"))?;}
    if !regular(path,true){return Err(error("RTK_STORAGE","命令精简组件目录无效"));}Ok(())
}
fn hash(path:&Path)->Result<String,AppError>{
    if !regular(path,false){return Err(error("RTK_INVALID","命令精简组件文件无效"));}
    let mut f=fs::File::open(path).map_err(|_|error("RTK_INVALID","命令精简组件文件缺失"))?;let mut h=Sha256::new();let mut buf=[0;65536];
    loop{let n=f.read(&mut buf).map_err(|_|error("RTK_INVALID","无法核验命令精简组件"))?;if n==0{break;}h.update(&buf[..n]);}Ok(format!("{:x}",h.finalize()))
}
fn root(base:&Path,p:&Package)->PathBuf{base.join(format!("rtk-{}-{}",p.version,&p.sha256[..16]))}
fn verify(root:&Path,p:&Package)->bool{regular(root,true)&&fs::metadata(root.join("rtk.exe")).is_ok_and(|m|m.len()==p.executable_bytes)&&hash(&root.join("rtk.exe")).ok().as_deref()==Some(&p.executable_sha256)&&hash(&root.join("LICENSE.txt")).ok().as_deref()==Some(&p.license_sha256)}
fn account(base:&Path,owner:&str)->PathBuf{base.join("accounts").join(format!("{:x}",Sha256::digest(owner.as_bytes())))}
fn enabled(path:&Path)->bool{regular(path,false)&&fs::read(path).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok()).is_some_and(|v|v["enabled"]==true)}
fn save_enabled(base:&Path,owner:&str,value:bool)->Result<(),AppError>{
    directory(base)?;directory(&base.join("accounts"))?;let home=account(base,owner);directory(&home)?;
    let target=home.join("settings.json");if target.exists()&&!regular(&target,false){return Err(error("RTK_STORAGE","命令精简设置文件无效"));}
    let mut temp=tempfile::NamedTempFile::new_in(&home).map_err(|_|error("RTK_STORAGE","无法保存命令精简设置"))?;
    temp.write_all(serde_json::to_string(&json!({"enabled":value})).unwrap().as_bytes()).map_err(|_|error("RTK_STORAGE","无法保存命令精简设置"))?;
    temp.persist(target).map_err(|_|error("RTK_STORAGE","无法保存命令精简设置"))?;Ok(())
}
fn status(base:&Path,owner:&str)->Value{
    let p=package();let installed=root(base,&p).exists();let ready=verify(&root(base,&p),&p);
    let cached=fs::metadata(base.join("cache").join(&p.filename)).is_ok_and(|m|m.len()==p.download_bytes)&&hash(&base.join("cache").join(&p.filename)).ok().as_deref()==Some(&p.sha256);
    let active=INSTALLS.lock().ok().and_then(|jobs|jobs.iter().find(|(_, (user,_))|user==owner).map(|(id,_)|id.clone()));
    json!({"supported":cfg!(all(windows,target_arch="x86_64")),"version":p.version,"installed":installed,"ready":ready,"enabled":ready&&enabled(&account(base,owner).join("settings.json")),"downloadBytes":if ready||cached{0}else{p.download_bytes},"installedBytes":p.executable_bytes,"activeRequestId":active,"sourceUrl":"https://github.com/rtk-ai/rtk/releases/tag/v0.40.0"})
}
/// Local configuration only; never transmitted to the model provider.
pub(crate) fn descriptor(owner:&str)->Option<Value>{
    if !cfg!(all(windows,target_arch="x86_64")){return None;}let base=base().ok()?;directory(&base).ok()?;directory(&base.join("accounts")).ok()?;
    let home=account(&base,owner);directory(&home).ok()?;
    for name in ["profile","profile/temp","profile/appdata","profile/localappdata"]{directory(&home.join(name)).ok()?;}
    let p=package();let active=verify(&root(&base,&p),&p)&&enabled(&home.join("settings.json"));Some(json!({"enabled":active,"executable":root(&base,&p).join("rtk.exe"),"sha256":p.executable_sha256,"settingsFile":home.join("settings.json"),"profile":home.join("profile")}))
}
#[tauri::command]
pub(crate) async fn rtk_status(app:AppHandle)->Result<Value,AppError>{let owner=owner(&app)?;let base=base()?;tauri::async_runtime::spawn_blocking(move||Ok(status(&base,&owner))).await.map_err(|_|error("RTK_STORAGE","无法核对命令精简组件"))?}
#[tauri::command]
pub(crate) async fn rtk_set_enabled(app:AppHandle,value:bool)->Result<Value,AppError>{
    let owner=owner(&app)?;let base=base()?;let handle=app.clone();
    tauri::async_runtime::spawn_blocking(move||{
        if value&&!verify(&root(&base,&package()),&package()){return Err(error("RTK_NOT_INSTALLED","请先安装或修复命令输出精简组件"));}
        if crate::rtk_runtime::owner(&handle)?!=owner{return Err(error("ACCOUNT_CHANGED","账号已切换，请重新操作"));}
        save_enabled(&base,&owner,value)?;Ok(status(&base,&owner))
    }).await.map_err(|_|error("RTK_STORAGE","无法保存命令精简设置"))?
}
fn check_cancel(cancel:&AtomicBool)->Result<(),AppError>{if cancel.load(Ordering::Relaxed){Err(error("RTK_INSTALL_CANCELLED","安装已取消，可稍后重试"))}else{Ok(())}}
fn progress(app:&AppHandle,id:&str,phase:&str,bytes:u64,total:u64){let _=app.emit("geod:rtk-install-progress",json!({"requestId":id,"phase":phase,"bytes":bytes,"total":total}));}
fn install(app:&AppHandle,base:&Path,archive_path:Option<&Path>,id:&str,cancel:&AtomicBool)->Result<(),AppError>{
    directory(base)?;let lock_path=base.join("install.lock");if lock_path.exists()&&!regular(&lock_path,false){return Err(error("RTK_STORAGE","组件安装锁无效"));}
    let lock=fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(lock_path).map_err(|_|error("RTK_STORAGE","无法准备组件安装"))?;
    loop{check_cancel(cancel)?;match fs2::FileExt::try_lock_exclusive(&lock){Ok(())=>break,Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(100)),Err(_)=>return Err(error("RTK_STORAGE","组件安装暂时不可用"))}}
    let p=package();let destination=root(base,&p);progress(app,id,"checking",0,0);check_cancel(cancel)?;if verify(&destination,&p){return Ok(());}
    let cache=base.join("cache");directory(&cache)?;let archive=cache.join(&p.filename);
    if hash(&archive).ok().as_deref()!=Some(&p.sha256){
        let part=tempfile::NamedTempFile::new_in(&cache).map_err(|_|error("RTK_STORAGE","无法准备组件下载"))?;
        let mut file=part.reopen().map_err(|_|error("RTK_STORAGE","无法保存组件下载"))?;
        if let Some(path)=archive_path{
            if !regular(path,false)||fs::metadata(path).map(|m|m.len()).ok()!=Some(p.download_bytes){return Err(error("RTK_INVALID","请选择官方 RTK 0.40.0 Windows 安装包"));}
            fs::copy(path,part.path()).map_err(|_|error("RTK_STORAGE","无法读取本地安装包"))?;
        }else{
            let proxy=crate::network::proxy_for(&p.url).map_err(|_|error("RTK_DOWNLOAD_FAILED","无法读取下载代理设置"))?;
            let client=crate::network::apply_blocking(reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(180)),proxy.as_deref()).map_err(|_|error("RTK_DOWNLOAD_FAILED","下载代理不可用"))?.build().map_err(|_|error("RTK_DOWNLOAD_FAILED","无法准备组件下载"))?;
            progress(app,id,"downloading",0,p.download_bytes);
            let mut response=client.get(&p.url).send().and_then(|r|r.error_for_status()).map_err(|_|error("RTK_DOWNLOAD_FAILED","组件下载失败，请重试或从本地安装"))?;
            if response.content_length().is_some_and(|n|n!=p.download_bytes){return Err(error("RTK_INVALID","组件下载大小不符"));}
            let mut bytes=0;let mut buffer=[0;65536];let mut last=std::time::Instant::now();
            loop{check_cancel(cancel)?;let n=response.read(&mut buffer).map_err(|_|error("RTK_DOWNLOAD_FAILED","组件下载中断，请重试"))?;if n==0{break;}bytes+=n as u64;
                if bytes>p.download_bytes{return Err(error("RTK_INVALID","组件下载超过大小上限"));}
                file.write_all(&buffer[..n]).map_err(|_|error("RTK_STORAGE","组件下载保存失败"))?;
                if last.elapsed()>Duration::from_millis(150){progress(app,id,"downloading",bytes,p.download_bytes);last=std::time::Instant::now();}
            }
        }
        drop(file);check_cancel(cancel)?;progress(app,id,"verifying",p.download_bytes,p.download_bytes);
        if fs::metadata(part.path()).map(|m|m.len()).ok()!=Some(p.download_bytes)||hash(part.path())?!=p.sha256{return Err(error("RTK_INVALID","组件安装包校验失败"));}
        if archive.exists()&&!regular(&archive,false){return Err(error("RTK_STORAGE","组件缓存文件无效"));}
        part.persist(&archive).map_err(|_|error("RTK_STORAGE","无法保存已核验安装包"))?;
    }
    check_cancel(cancel)?;progress(app,id,"installing",0,0);
    let staging=tempfile::Builder::new().prefix("stage-").tempdir_in(base).map_err(|_|error("RTK_STORAGE","无法准备组件安装目录"))?;
    let mut command=crate::python_runtime::command(include_str!("rtk_extract.py"))?;
    let result=command.arg(&archive).arg(staging.path()).arg(&p.executable_member).arg(p.executable_bytes.to_string()).arg(&p.executable_sha256).as_std_mut().output().map_err(|_|error("RTK_INSTALL_FAILED","无法解包命令精简组件"))?;
    if !result.status.success(){return Err(error("RTK_INVALID","组件解包校验失败"));}
    fs::write(staging.path().join("LICENSE.txt"),include_bytes!("../../../../vendor/rtk-0.40.0-LICENSE.txt")).map_err(|_|error("RTK_STORAGE","无法保存组件许可"))?;
    if !verify(staging.path(),&p){return Err(error("RTK_INVALID","组件文件核验失败"));}check_cancel(cancel)?;
    if destination.exists(){
        if !regular(&destination,true)||!fs::canonicalize(&destination).is_ok_and(|path|fs::canonicalize(base).is_ok_and(|base|path.starts_with(base))){return Err(error("RTK_STORAGE","组件目录无效"));}
        fs::remove_dir_all(&destination).map_err(|_|error("RTK_STORAGE","无法替换损坏的组件，请关闭运行中的对话后重试"))?;
    }
    fs::rename(staging.path(),destination).map_err(|_|error("RTK_STORAGE","无法完成组件安装"))?;Ok(())
}
#[tauri::command]
pub(crate) async fn rtk_install(app:AppHandle,archive_path:Option<String>,request_id:String)->Result<Value,AppError>{
    if !cfg!(all(windows,target_arch="x86_64")){return Err(error("RTK_UNSUPPORTED","此组件目前支持 Windows x64"));}
    let owner=owner(&app)?;let storage=base()?;if request_id.is_empty()||request_id.len()>80||!request_id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'){return Err(error("RTK_INSTALL_INVALID","安装请求标识无效"));}
    let cancel=Arc::new(AtomicBool::new(false));{
        let mut jobs=INSTALLS.lock().map_err(|_|error("RTK_STORAGE","无法登记组件安装"))?;
        if jobs.values().any(|(o,_)|o==&owner)||jobs.contains_key(&request_id){return Err(error("RTK_INSTALL_ACTIVE","组件安装已在进行"));}
        jobs.insert(request_id.clone(),(owner.clone(),cancel.clone()));
    }
    let handle=app.clone();let id=request_id.clone();let flag=cancel.clone();
    let result=tauri::async_runtime::spawn_blocking(move||install(&handle,&storage,archive_path.as_deref().map(Path::new),&id,&flag)).await;
    if let Ok(mut jobs)=INSTALLS.lock(){jobs.remove(&request_id);}
    result.map_err(|_|error("RTK_INSTALL_FAILED","组件安装中断"))??;check_cancel(&cancel)?;
    if crate::rtk_runtime::owner(&app)?!=owner{return Err(error("ACCOUNT_CHANGED","账号已切换，组件已缓存，请在当前账号启用"));}
    let base=base()?;save_enabled(&base,&owner,true)?;progress(&app,&request_id,"ready",0,0);Ok(status(&base,&owner))
}
#[tauri::command]
pub(crate) fn rtk_install_cancel(app:AppHandle,request_id:String)->Result<Value,AppError>{
    let owner=owner(&app)?;let jobs=INSTALLS.lock().map_err(|_|error("RTK_STORAGE","无法读取组件安装状态"))?;
    if let Some((expected,flag))=jobs.get(&request_id){if expected!=&owner{return Err(error("ACCOUNT_CHANGED","此安装不属于当前账号"));}flag.store(true,Ordering::Relaxed);}
    Ok(json!({"cancelled":jobs.contains_key(&request_id)}))
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn pinned_binary_and_license_are_required(){let dir=tempfile::tempdir().unwrap();let mut p=package();fs::write(dir.path().join("rtk.exe"),b"binary").unwrap();fs::write(dir.path().join("LICENSE.txt"),b"license").unwrap();p.executable_bytes=6;p.executable_sha256=format!("{:x}",Sha256::digest(b"binary"));p.license_sha256=format!("{:x}",Sha256::digest(b"license"));assert!(verify(dir.path(),&p));fs::write(dir.path().join("rtk.exe"),b"tamper").unwrap();assert!(!verify(dir.path(),&p));}
    #[test]fn account_enable_is_scoped_and_persistent(){let dir=tempfile::tempdir().unwrap();save_enabled(dir.path(),"one",true).unwrap();assert!(enabled(&account(dir.path(),"one").join("settings.json")));assert!(!enabled(&account(dir.path(),"two").join("settings.json")));save_enabled(dir.path(),"one",false).unwrap();assert!(!enabled(&account(dir.path(),"one").join("settings.json")));}
    #[test]fn cancellation_is_explicit(){let flag=AtomicBool::new(true);assert_eq!(check_cancel(&flag).unwrap_err().code,"RTK_INSTALL_CANCELLED");}
}

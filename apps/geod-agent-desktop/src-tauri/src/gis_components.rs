//! Optional GIS dependencies pinned by the application; never pip install at runtime.
use crate::{services, workspace_error, AppError};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::{Read, Write}, path::{Component, Path, PathBuf}, sync::OnceLock, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};

static DATA: OnceLock<PathBuf> = OnceLock::new();
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct Catalog { components: Vec<Package> }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase")]
struct Package { id:String, version:String, filename:String, url:String, sha256:String, manifest_sha256:String, download_bytes:u64, installed_bytes:u64 }
pub(crate) struct Feature { pub id:&'static str, pub name:&'static str, pub description:&'static str, pub components:&'static [&'static str], pub tools:&'static [&'static str], pub skill:&'static str }
pub(crate) const FEATURES:&[Feature]=&[
    Feature{id:"gis-import",name:"多格式范围导入",description:"读取 Shapefile、GeoPackage、KML、GML、FGB、WKT，检查图层和坐标系",components:&["gis-common","gis-vector"],tools:&["vector_info"],skill:include_str!("../../skills/gis-import/SKILL.md")},
    Feature{id:"gis-vector-convert",name:"矢量转换",description:"矢量格式转换和坐标系重投影",components:&["gis-common","gis-vector"],tools:&["vector_info","vector_convert","vector_reproject"],skill:include_str!("../../skills/gis-vector-convert/SKILL.md")},
    Feature{id:"gis-vector-analysis",name:"矢量分析",description:"按范围裁剪、缓冲区和几何简化",components:&["gis-common","gis-vector"],tools:&["vector_info","vector_clip","vector_buffer","vector_simplify"],skill:include_str!("../../skills/gis-vector-analysis/SKILL.md")},
    Feature{id:"gis-raster-inspect",name:"栅格检查",description:"读取影像坐标系、波段、范围和像元统计",components:&["gis-common","gis-raster"],tools:&["raster_info","raster_stats"],skill:include_str!("../../skills/gis-raster-inspect/SKILL.md")},
    Feature{id:"gis-raster-convert",name:"栅格转换",description:"栅格格式转换、压缩、COG、金字塔和重投影",components:&["gis-common","gis-raster"],tools:&["raster_info","raster_convert","raster_reproject"],skill:include_str!("../../skills/gis-raster-convert/SKILL.md")},
];
fn error(code:&'static str,message:&str)->AppError{workspace_error(code,message)}
fn catalog()->Catalog{serde_json::from_str(include_str!("../../../../vendor/gis-components.json")).expect("build-pinned GIS catalog")}
pub(crate) fn initialize(app:&AppHandle){if let Ok(root)=app.path().app_data_dir(){let _=DATA.set(root.join("gis-components"));}}
fn data()->Result<PathBuf,AppError>{DATA.get().cloned().ok_or_else(||error("GIS_STORAGE","无法读取 GIS 技能保存位置"))}
pub(crate) fn feature(id:&str)->Result<&'static Feature,AppError>{FEATURES.iter().find(|f|f.id==id).ok_or_else(||error("GIS_SKILL_UNKNOWN","未找到此 GIS 技能"))}
fn hash(path:&Path)->Result<String,AppError>{let mut f=fs::File::open(path).map_err(|_|error("GIS_COMPONENT_INVALID","GIS 组件文件缺失"))?;let mut h=Sha256::new();let mut buf=[0;65536];loop{let n=f.read(&mut buf).map_err(|_|error("GIS_COMPONENT_INVALID","无法校验 GIS 组件"))?;if n==0{break;}h.update(&buf[..n]);}Ok(format!("{:x}",h.finalize()))}
fn package_root(base:&Path,p:&Package)->PathBuf{base.join(format!("{}-{}-{}",p.id,p.version,&p.sha256[..16]))}

#[tauri::command]
pub(crate) async fn gis_install_prepare(app:AppHandle,id:String,require_tools:Option<bool>)->Result<Value,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    let enabled=app.state::<crate::extensions::ExtensionState>().gis_skill_status(&id,&owner)==Some(true);
    tauri::async_runtime::spawn_blocking(move||{
        let f=feature(&id)?;let base=data()?;let c=catalog();
        let packages:Vec<_>=c.components.iter().filter(|p|f.components.contains(&p.id.as_str())).map(|p|{
            let ready=verify(&package_root(&base,p),p,true).is_ok();
            let cached=ready||hash(&base.join("cache").join(&p.filename)).ok().as_deref()==Some(&p.sha256);
            json!({"id":p.id,"ready":ready,"cached":cached,"downloadBytes":if cached{0}else{p.download_bytes},"installedBytes":if ready{0}else{p.installed_bytes}})
        }).collect();
        Ok(json!({"id":f.id,"name":f.name,"description":f.description,"ready":packages.iter().all(|p|p["ready"]==true)&&(!require_tools.unwrap_or(false)||enabled),"enabled":enabled,
            "downloadBytes":packages.iter().filter_map(|p|p["downloadBytes"].as_u64()).sum::<u64>(),"installedBytes":packages.iter().filter_map(|p|p["installedBytes"].as_u64()).sum::<u64>(),"components":packages}))
    }).await.map_err(|_|error("GIS_INSTALL_FAILED","无法核对 GIS 组件"))?
}
fn regular(path:&Path)->bool{fs::symlink_metadata(path).is_ok_and(|m|{if !m.is_file(){return false;}#[cfg(windows)]{use std::os::windows::fs::MetadataExt;if m.file_attributes()&0x400!=0{return false;}}!m.file_type().is_symlink()})}
fn verify(root:&Path,p:&Package,full:bool)->Result<(),AppError>{
    let manifest=root.join("manifest.json");
    if !regular(&manifest)||hash(&manifest)?!=p.manifest_sha256{return Err(error("GIS_SKILL_NOT_INSTALLED","请在技能与连接器中安装所需 GIS 技能"));}
    if full {
        let canonical_root=fs::canonicalize(root).map_err(|_|error("GIS_COMPONENT_INVALID","GIS 组件目录无效"))?;
        let v:Value=serde_json::from_slice(&fs::read(manifest).map_err(|_|error("GIS_COMPONENT_INVALID","无法读取 GIS 组件清单"))?).map_err(|_|error("GIS_COMPONENT_INVALID","GIS 组件清单损坏"))?;
        for (name,expected) in v["files"].as_object().ok_or_else(||error("GIS_COMPONENT_INVALID","GIS 组件清单无效"))?{
            let rel=Path::new(name);if rel.is_absolute()||!rel.components().all(|c|matches!(c,Component::Normal(_))){return Err(error("GIS_COMPONENT_INVALID","GIS 组件路径无效"));}
            let file=root.join(rel);if !regular(&file)||!fs::canonicalize(&file).is_ok_and(|f|f.starts_with(&canonical_root))||hash(&file)?!=expected.as_str().unwrap_or(""){return Err(error("GIS_COMPONENT_INVALID","GIS 组件校验失败，请重新安装技能"));}
        }
    }Ok(())
}
pub(crate) fn paths(ids:&[&str])->Result<Vec<PathBuf>,AppError>{let base=data()?;let c=catalog();ids.iter().map(|id|{let p=c.components.iter().find(|p|p.id==*id).ok_or_else(||error("GIS_SKILL_UNKNOWN","GIS 依赖无效"))?;let root=package_root(&base,p);let canonical=fs::canonicalize(&root).map_err(|_|error("GIS_SKILL_NOT_INSTALLED","请先安装所需 GIS 技能：多格式范围导入或栅格处理"))?;let base=fs::canonicalize(&base).map_err(|_|error("GIS_STORAGE","无法读取 GIS 技能目录"))?;if !canonical.starts_with(&base){return Err(error("GIS_COMPONENT_INVALID","GIS 依赖目录无效"));}verify(&canonical,p,true)?;Ok(canonical)}).collect()}
#[tauri::command]
pub(crate) fn gis_skills_list(state:State<'_,crate::extensions::ExtensionState>,services:State<'_,services::ServiceState>)->Result<Value,AppError>{
    let owner=services::current_user_id(&services).map_err(|e|error(e.code,&e.message))?;let base=data()?;let c=catalog();
    Ok(json!(FEATURES.iter().map(|f|{let status=state.gis_skill_status(f.id,&owner);let packages:Vec<_>=c.components.iter().filter(|p|f.components.contains(&p.id.as_str())).collect();let bytes:u64=packages.iter().filter(|p|verify(&package_root(&base,p),p,false).is_err()).map(|p|p.download_bytes).sum();json!({"id":f.id,"name":f.name,"description":f.description,"tools":f.tools,"installed":status.is_some(),"enabled":status.unwrap_or(false),"ready":packages.iter().all(|p|verify(&package_root(&base,p),p,false).is_ok()),"downloadBytes":bytes,"installedBytes":packages.iter().map(|p|p.installed_bytes).sum::<u64>()})}).collect::<Vec<_>>()))
}
static INSTALLS: std::sync::Mutex<std::collections::BTreeMap<String,(String,std::sync::Arc<std::sync::atomic::AtomicBool>)>> = std::sync::Mutex::new(std::collections::BTreeMap::new());
fn check_cancel(cancel:&std::sync::atomic::AtomicBool)->Result<(),AppError>{
    if cancel.load(std::sync::atomic::Ordering::Relaxed){Err(error("GIS_INSTALL_CANCELLED","安装已取消，已核验的组件缓存会保留"))}else{Ok(())}
}
fn progress(app:&AppHandle,feature_id:&str,request_id:&str,phase:&str,bytes:u64,total:u64,component:Option<&str>){
    let _=app.emit("geod:gis-install-progress",json!({"featureId":feature_id,"requestId":request_id,"phase":phase,"bytes":bytes,"total":total,"component":component}));
}
fn install_packages(app:&AppHandle,f:&Feature,directory:Option<&Path>,request_id:&str,cancel:&std::sync::atomic::AtomicBool)->Result<(),AppError>{
    let base=data()?;fs::create_dir_all(&base).map_err(|_|error("GIS_STORAGE","无法准备 GIS 技能目录"))?;
    let lock=fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(base.join("install.lock")).map_err(|_|error("GIS_STORAGE","无法锁定 GIS 技能目录"))?;
    loop {check_cancel(cancel)?;match fs2::FileExt::try_lock_exclusive(&lock){Ok(())=>break,Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(Duration::from_millis(100)),Err(_)=>return Err(error("GIS_STORAGE","GIS 安装暂时不可用"))}}
    let cache=base.join("cache");fs::create_dir_all(&cache).map_err(|_|error("GIS_STORAGE","无法准备下载缓存"))?;
    let c=catalog();let packages:Vec<_>=c.components.iter().filter(|p|f.components.contains(&p.id.as_str())).collect();
    let total=packages.iter().filter(|p|verify(&package_root(&base,p),p,true).is_err()&&hash(&cache.join(&p.filename)).ok().as_deref()!=Some(&p.sha256)).map(|p|p.download_bytes).sum();
    let mut downloaded=0;
    progress(app,f.id,request_id,"checking",0,total,None);
    for p in packages {
        check_cancel(cancel)?;
        let root=package_root(&base,p);if verify(&root,p,true).is_ok(){continue;}
        let archive=cache.join(&p.filename);
        if hash(&archive).ok().as_deref()!=Some(&p.sha256){
            let part=cache.join(format!("{}.part",p.filename));
            if let Some(directory)=directory{
                fs::copy(directory.join(&p.filename),&part).map_err(|_|error("GIS_PACKAGE_MISSING","离线目录中缺少此技能的组件包"))?;
            }else{
                let proxy=crate::network::proxy_for(&p.url).map_err(|_|error("GIS_DOWNLOAD_FAILED","无法读取下载代理"))?;
                let client=crate::network::apply_blocking(reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(20)).timeout(Duration::from_secs(600)),proxy.as_deref()).map_err(|_|error("GIS_DOWNLOAD_FAILED","下载代理不可用"))?.build().map_err(|_|error("GIS_DOWNLOAD_FAILED","无法准备组件下载"))?;
                let mut response=client.get(&p.url).send().and_then(|r|r.error_for_status()).map_err(|_|error("GIS_DOWNLOAD_FAILED","GIS 组件下载失败，可重试或从本地安装"))?;
                if response.content_length().is_some_and(|n|n!=p.download_bytes){return Err(error("GIS_COMPONENT_INVALID","GIS 下载大小不符"));}
                let mut file=fs::File::create(&part).map_err(|_|error("GIS_STORAGE","无法保存 GIS 下载"))?;
                let mut bytes=0;let mut buf=[0;65536];let mut last=std::time::Instant::now();
                progress(app,f.id,request_id,"downloading",downloaded,total,Some(&p.id));
                loop{
                    check_cancel(cancel)?;
                    let n=response.read(&mut buf).map_err(|_|error("GIS_DOWNLOAD_FAILED","GIS 下载中断，请重试"))?;if n==0{break;}
                    bytes+=n as u64;if bytes>p.download_bytes{return Err(error("GIS_COMPONENT_INVALID","GIS 下载超过大小上限"));}
                    file.write_all(&buf[..n]).map_err(|_|error("GIS_STORAGE","GIS 下载写入失败"))?;
                    if last.elapsed()>Duration::from_millis(200){progress(app,f.id,request_id,"downloading",downloaded+bytes,total,Some(&p.id));last=std::time::Instant::now();}
                }
            }
            check_cancel(cancel)?;
            progress(app,f.id,request_id,"verifying",downloaded,total,Some(&p.id));
            if fs::metadata(&part).map(|m|m.len()).ok()!=Some(p.download_bytes)||hash(&part)?!=p.sha256{let _=fs::remove_file(part);return Err(error("GIS_COMPONENT_INVALID","GIS 下载校验失败"));}
            if archive.exists(){fs::remove_file(&archive).map_err(|_|error("GIS_STORAGE","无法替换损坏的下载缓存"))?;}
            fs::rename(part,&archive).map_err(|_|error("GIS_STORAGE","无法保存 GIS 缓存"))?;
            downloaded+=p.download_bytes;
        }
        check_cancel(cancel)?;
        progress(app,f.id,request_id,"installing",downloaded,total,Some(&p.id));
        let temp=tempfile::Builder::new().prefix("stage-").tempdir_in(&base).map_err(|_|error("GIS_STORAGE","无法准备 GIS 安装"))?;
        let mut command=crate::python_runtime::command(include_str!("gis_component_worker.py"))?;
        let result=command.arg(&archive).arg(temp.path()).arg(&p.id).arg(&p.manifest_sha256).as_std_mut().output().map_err(|_|error("GIS_INSTALL_FAILED","无法启动 GIS 安装"))?;
        if !result.status.success(){return Err(error("GIS_COMPONENT_INVALID","GIS 组件解包校验失败"));}
        verify(temp.path(),p,true)?;check_cancel(cancel)?;
        if root.exists(){let canonical=fs::canonicalize(&root).map_err(|_|error("GIS_STORAGE","GIS 目录无效"))?;if !canonical.starts_with(fs::canonicalize(&base).map_err(|_|error("GIS_STORAGE","GIS 目录无效"))?){return Err(error("GIS_STORAGE","GIS 目录无效"));}fs::remove_dir_all(&root).map_err(|_|error("GIS_STORAGE","无法替换损坏的 GIS 组件"))?;}
        fs::rename(temp.path(),&root).map_err(|_|error("GIS_STORAGE","无法完成 GIS 安装"))?;
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn gis_skill_install(app:AppHandle,id:String,directory:Option<String>,request_id:Option<String>)->Result<Value,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    let f=feature(&id)?;let request_id=request_id.unwrap_or_else(||uuid::Uuid::new_v4().to_string());
    if request_id.is_empty()||request_id.len()>80||!request_id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'){return Err(error("GIS_INSTALL_INVALID","安装请求标识无效"));}
    let cancel=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {let mut jobs=INSTALLS.lock().map_err(|_|error("GIS_STORAGE","无法登记安装请求"))?;if jobs.contains_key(&request_id){return Err(error("GIS_INSTALL_ACTIVE","安装请求已在进行"));}jobs.insert(request_id.clone(),(owner.clone(),cancel.clone()));}
    let handle=app.clone();let operation=request_id.clone();let stopped=cancel.clone();
    let result=tauri::async_runtime::spawn_blocking(move||install_packages(&handle,f,directory.as_deref().map(Path::new),&operation,&stopped)).await;
    if let Ok(mut jobs)=INSTALLS.lock(){jobs.remove(&request_id);}
    result.map_err(|_|error("GIS_INSTALL_FAILED","GIS 安装进程中断"))??;
    check_cancel(&cancel)?;
    if services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?!=owner{return Err(error("GIS_OWNER_CHANGED","账号已切换，组件已缓存，请在当前账号重新安装技能"));}
    app.state::<crate::extensions::ExtensionState>().install_gis_skill(f,&owner)?;
    progress(&app,f.id,&request_id,"ready",0,0,None);
    Ok(json!({"installed":true,"id":id,"requestId":request_id}))
}
#[tauri::command]
pub(crate) fn gis_install_cancel(app:AppHandle,request_id:String)->Result<Value,AppError>{
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|e|error(e.code,&e.message))?;
    let jobs=INSTALLS.lock().map_err(|_|error("GIS_STORAGE","无法读取安装请求"))?;
    if let Some((expected,cancel))=jobs.get(&request_id){if expected!=&owner{return Err(error("GIS_OWNER_CHANGED","此安装请求不属于当前账号"));}cancel.store(true,std::sync::atomic::Ordering::Relaxed);}
    Ok(json!({"cancelled":jobs.contains_key(&request_id)}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(root:&Path,files:Value)->Package{
        let bytes=serde_json::to_vec(&json!({"id":"gis-common","version":"1.0.0","files":files})).unwrap();
        fs::write(root.join("manifest.json"),&bytes).unwrap();
        Package{id:"gis-common".into(),version:"1.0.0".into(),filename:"fixture.zip".into(),url:String::new(),sha256:"0".repeat(64),manifest_sha256:format!("{:x}",Sha256::digest(&bytes)),download_bytes:0,installed_bytes:0}
    }
    #[test]
    fn installed_component_rejects_changed_binary_and_untrusted_manifest(){
        let directory=tempfile::tempdir().unwrap();fs::write(directory.path().join("engine.pyd"),b"accepted").unwrap();
        let p=fixture(directory.path(),json!({"engine.pyd":format!("{:x}",Sha256::digest(b"accepted"))}));
        verify(directory.path(),&p,true).unwrap();
        fs::write(directory.path().join("engine.pyd"),b"changed").unwrap();assert_eq!(verify(directory.path(),&p,true).unwrap_err().code,"GIS_COMPONENT_INVALID");
        fs::write(directory.path().join("manifest.json"),b"{}").unwrap();assert!(verify(directory.path(),&p,false).is_err());
    }
    #[test]
    fn installed_component_rejects_paths_outside_package(){
        let directory=tempfile::tempdir().unwrap();let p=fixture(directory.path(),json!({"../escape.py":"0".repeat(64)}));
        assert_eq!(verify(directory.path(),&p,true).unwrap_err().code,"GIS_COMPONENT_INVALID");
    }
}

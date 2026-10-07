//! Authenticated feature snapshots using the existing background task ledger.
use crate::{online_inputs, workspace_error, AppError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::{Component, Path}, process::Stdio, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

fn default_max()->usize{10_000}
fn default_page()->usize{500}
fn default_outputs()->Vec<String>{vec!["geojson".into(),"gpkg".into()]}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct OnlineSpec {
    pub source_url:Option<String>,
    pub online_connection_id:Option<String>,
    pub connection_revision:Option<String>,
    pub layer:Option<String>,
    pub source_crs:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")] pub target_crs:Option<String>,
    pub bounds:Option<[f64;4]>,
    pub boundary:Option<geod_core::boundary::BoundaryGeometry>,
    #[serde(default="default_max")] pub max_features:usize,
    #[serde(default="default_page")] pub page_size:usize,
    #[serde(default="default_outputs")] pub outputs:Vec<String>,
}
impl OnlineSpec {
    pub(crate) fn bind(&mut self,app:&AppHandle,owner:&str)->Result<(),AppError>{
        if let Some(id)=&self.online_connection_id {
            if self.source_url.is_some(){return Err(workspace_error("DATA_PLAN_INVALID","请选择在线连接或公开数据网址之一"));}
            let (_,revision)=online_inputs::binding(app,owner,id)?;
            if self.connection_revision.as_ref().is_some_and(|old|old!=&revision){return Err(workspace_error("INPUT_CONNECTION_CHANGED","在线连接发生变化，请重新创建任务"));}
            self.connection_revision=Some(revision);
        }else if let Some(url)=&self.source_url{self.source_url=Some(online_inputs::public_url(url)?);}
        Ok(())
    }
    pub(crate) fn validate(&self)->Result<Self,AppError>{
        if self.source_url.is_some()==self.online_connection_id.is_some() || self.online_connection_id.is_some()!=self.connection_revision.is_some(){return Err(workspace_error("DATA_PLAN_INVALID","请选择已保存的在线连接或公开数据网址"));}
        if let Some(url)=&self.source_url{online_inputs::public_url(url)?;}
        if self.layer.as_ref().is_some_and(|v|v.trim().is_empty()||v.len()>256||v.chars().any(char::is_control))||self.source_crs.as_ref().is_some_and(|v|v.len()>128||v.chars().any(char::is_control)){return Err(workspace_error("DATA_PLAN_INVALID","在线图层或坐标系无效"));}
        let mut result=self.clone();
        result.outputs.sort();result.outputs.dedup();
        if let Some(crs)=&mut result.target_crs {
            *crs=crate::export_crs::normalize(crs)?;
            if crs!="EPSG:4326" && result.outputs != ["gpkg"] {return Err(workspace_error("OUTPUT_CRS_FORMAT_CONFLICT","GeoJSON 固定为 WGS84；其他成果坐标系请使用 GeoPackage"));}
        }
        if result.outputs.is_empty()||result.outputs.iter().any(|v|!matches!(v.as_str(),"geojson"|"gpkg")){return Err(workspace_error("DATA_PLAN_INVALID","在线矢量数据支持 GeoJSON 和 GeoPackage 导出"));}
        if let Some(boundary)=&mut result.boundary {
            let bounds=boundary.normalize().map_err(|e|workspace_error("DATA_PLAN_INVALID",e.0))?;
            if result.bounds.is_some_and(|b|b.iter().zip(bounds).any(|(a,b)|(a-b).abs()>1e-6)){return Err(workspace_error("DATA_PLAN_INVALID","范围与保存的边界不一致"));}
            result.bounds=Some(bounds);
        }
        online_inputs::validate_options(&online_inputs::ReadOptions{bounds:result.bounds,max_features:Some(result.max_features),page_size:Some(result.page_size)})?;
        Ok(result)
    }
    fn fingerprint(&self)->Result<String,String>{Ok(format!("{:x}",Sha256::digest(serde_json::to_vec(self).map_err(|_|"在线来源记录无效")?)))}
}

async fn cancelled(cancel:Arc<AtomicBool>){while !cancel.load(Ordering::SeqCst){tokio::time::sleep(Duration::from_millis(50)).await;}}

async fn worker(request:Value,cancel:Arc<AtomicBool>)->Result<Value,String>{
    let mut command=crate::python_runtime::gis_command(include_str!("online_export_worker.py"),&["gis-common","gis-vector"]).map_err(|e|e.message)?;
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    for key in ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy"]{command.env_remove(key);}
    if let Some(proxy)=crate::network::proxy_for("https://pypi.org")?{command.env("HTTP_PROXY",&proxy).env("HTTPS_PROXY",&proxy);}
    let mut child=command.spawn().map_err(|_|"无法启动内置数据导出运行环境")?;
    let mut stdin=child.stdin.take().ok_or("数据导出进程无法接收输入")?;
    stdin.write_all(&serde_json::to_vec(&request).map_err(|_|"导出参数无效")?).await.map_err(|_|"数据导出进程已退出")?;drop(stdin);
    let output=tokio::select!{
        value=tokio::time::timeout(Duration::from_secs(180),child.wait_with_output())=>value.map_err(|_|"数据导出超过 180 秒")?.map_err(|_|"数据导出进程失败")?,
        _=cancelled(cancel)=>return Err("任务已取消".into()),
    };
    if !output.status.success()||output.stdout.len()>1024*1024{return Err("数据导出返回无效结果".into());}
    let value:Value=serde_json::from_slice(&output.stdout).map_err(|_|"数据导出返回无效记录")?;
    if let Some(error)=value["error"].as_str(){return Err(error.into());}
    Ok(value)
}

pub(crate) async fn run(app:AppHandle,owner:String,spec:&OnlineSpec,output:&Path,plan_hash:&str,cancel:Arc<AtomicBool>,report:impl Fn(&str,u64,u64,u64))->Result<Value,String>{
    if cancel.load(Ordering::SeqCst){return Err("任务已取消".into());}
    let parent=output.parent().ok_or("成果目录无效")?.canonicalize().map_err(|_|"工作区不可用")?;
    if output.exists(){return Err("成果目录已存在，未覆盖原文件".into());}
    report("downloading",0,0,0);
    let retrieved=tokio::select!{
        value=online_inputs::read_bound(&app,owner,spec.source_url.clone(),spec.online_connection_id.clone(),spec.connection_revision.clone().unwrap_or_default(),spec.layer.as_deref(),online_inputs::ReadOptions{bounds:spec.bounds,max_features:Some(spec.max_features),page_size:Some(spec.page_size)})=>value.map_err(|e|e.message)?,
        _=cancelled(cancel.clone())=>return Err("任务已取消".into()),
    };
    let (name,bytes,info)=retrieved;
    let extension=Path::new(&name).extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["json","geojson","gml"].contains(&extension.as_str()){return Err("在线下载当前支持 GeoJSON、ArcGIS 要素和 WFS GML；其他文件请从数据输入导入".into());}
    if output.parent().ok_or("成果目录无效")?.canonicalize().map_err(|_|"工作区不可用")?!=parent{return Err("工作区路径已变化".into());}
    let stage=parent.join(format!(".geod-online-{}",uuid::Uuid::new_v4()));
    fs::create_dir(&stage).map_err(|_|"无法创建导出暂存目录")?;
    let result=async {
        let source=stage.join(format!("input.{extension}"));
        fs::write(&source,&bytes).map_err(|_|"在线数据暂存失败")?;
        let total=info["featureCount"].as_u64().unwrap_or(0);
        report(if spec.target_crs.as_deref().is_some_and(|c|c!="EPSG:4326"){"reprojecting"}else{"packaging"},0,total,bytes.len() as u64);
        let mut manifest=worker(json!({"inputPath":source,"directory":stage,"sourceCrs":spec.source_crs,"targetCrs":spec.target_crs,"storageLayer":if info["remoteLayer"]==true{Value::Null}else{json!(spec.layer)},"maxFeatures":spec.max_features,"expectedFeatures":info["featureCount"],"bounds":spec.bounds,"boundary":spec.boundary,"outputs":spec.outputs}),cancel.clone()).await?;
        fs::remove_file(source).map_err(|_|"暂存数据清理失败")?;
        manifest["schemaVersion"]=json!(1);manifest["kind"]=json!("online");manifest["planHash"]=json!(plan_hash);manifest["sourceFingerprint"]=json!(spec.fingerprint()?);
        manifest["createdAt"]=json!(chrono::Utc::now().to_rfc3339());manifest["protocol"]=info["protocol"].clone();manifest["sourceLayer"]=info["sourceLayer"].clone();manifest["sourceName"]=info["sourceName"].clone();manifest["complete"]=info["complete"].clone();manifest["failures"]=json!([]);
        fs::write(stage.join("manifest.json"),serde_json::to_vec_pretty(&manifest).map_err(|_|"成果清单无效")?).map_err(|_|"成果清单保存失败")?;
        report("verifying",total,total,bytes.len() as u64);
        inspect(&stage,spec,plan_hash)?;
        if cancel.load(Ordering::SeqCst){return Err("任务已取消".into());}
        if output.parent().ok_or("成果目录无效")?.canonicalize().map_err(|_|"工作区不可用")?!=parent||stage.canonicalize().map_err(|_|"暂存目录不可用")?.parent()!=Some(parent.as_path()){return Err("工作区路径已变化".into());}
        if output.exists(){return Err("成果目录已存在，未覆盖原文件".into());}
        fs::rename(&stage,output).map_err(|_|"成果目录提交失败")?;
        let count=manifest["featureCount"].as_u64().unwrap_or(0);
        let size=manifest["assets"].as_array().unwrap().iter().filter_map(|a|a["size"].as_u64()).sum();
        report("completed",count,count,size);
        Ok(manifest)
    }.await;
    // stage is a newly generated direct child of the checked workspace only.
    if stage.is_dir()&&stage.canonicalize().ok().is_some_and(|p|p==stage){let _=fs::remove_dir_all(&stage);}
    result
}

pub(crate) fn inspect(output:&Path,spec:&OnlineSpec,plan_hash:&str)->Result<Value,String>{
    let path=output.join("manifest.json");
    if fs::metadata(&path).map_err(|_|"成果清单不存在")?.len()>1024*1024{return Err("成果清单过大".into());}
    let value:Value=serde_json::from_slice(&fs::read(path).map_err(|_|"成果清单不可读")?).map_err(|_|"成果清单无效")?;
    if value["schemaVersion"]!=1||value["kind"]!="online"||value["planHash"]!=plan_hash||value["sourceFingerprint"]!=spec.fingerprint()?||value["featureCount"].as_u64().is_none_or(|n|n>spec.max_features as u64){return Err("在线成果与当前计划不匹配".into());}
    if value["outputCrs"]!=spec.target_crs.as_deref().unwrap_or("EPSG:4326"){return Err("成果坐标系与计划不一致".into());}
    let root=output.canonicalize().map_err(|_|"成果目录不存在")?;
    let assets=value["assets"].as_array().ok_or("成果文件记录无效")?;
    if assets.len()!=spec.outputs.len()+1{return Err("成果文件数量与计划不一致".into());}
    let mut seen=std::collections::HashSet::new();
    for asset in assets {
        let name=asset["path"].as_str().ok_or("成果文件名无效")?;
        let kind=asset["kind"].as_str().ok_or("成果格式无效")?;
        if name.contains(['/', '\\', ':'])||!Path::new(name).components().all(|c|matches!(c,Component::Normal(_)))||!seen.insert(kind.to_owned())||name!=match kind{"geojson"=>"features.geojson","gpkg"=>"features.gpkg","preview"=>"preview.geojson",_=>return Err("成果格式无效".into())}{return Err("成果文件路径无效".into());}
        let path=root.join(name).canonicalize().map_err(|_|"成果文件不存在")?;
        if path.parent()!=Some(root.as_path()){return Err("成果文件已移出目录".into());}
        let size=fs::metadata(&path).map_err(|_|"成果文件不可读")?.len();
        if size>256*1024*1024||asset["size"]!=size{return Err("成果文件大小变化".into());}
        let hash=format!("{:x}",Sha256::digest(fs::read(path).map_err(|_|"成果文件不可读")?));
        if asset["sha256"]!=hash{return Err("成果文件校验失败".into());}
    }
    if !seen.contains("preview")||spec.outputs.iter().any(|s|!seen.contains(s)){return Err("计划要求的成果文件缺失".into());}
    Ok(value)
}

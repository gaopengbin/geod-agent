use crate::{workspace_error, AppError};
use geod_core::imagery::{CoreError, ExportOptions, ProjectedRaster, RasterProjector};
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, sync::atomic::{AtomicBool, Ordering}, time::Duration};
use tokio::io::AsyncWriteExt;

pub(crate) struct Projector;
impl geod_vector::VectorProjector for Projector {
    fn reproject<'a>(&'a self,path:&'a Path,target:&'a str,cancel:&'a AtomicBool)
        ->std::pin::Pin<Box<dyn std::future::Future<Output=geod_vector::Result<()>>+Send+'a>>{
        Box::pin(async move {
            let error=|message:String|geod_vector::Error::InvalidData(message);
            let mut command=crate::python_runtime::gis_command(include_str!("export_crs_worker.py"),&["gis-common","gis-vector"]).map_err(|e|error(e.message))?;
            let mut child=command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().map_err(|_|error("无法启动矢量坐标转换".into()))?;
            child.stdin.take().ok_or_else(||error("转换进程不可用".into()))?.write_all(json!({"kind":"vector","path":path,"targetCrs":target}).to_string().as_bytes()).await.map_err(|_|error("转换进程已退出".into()))?;
            let output=tokio::select!{
                result=tokio::time::timeout(Duration::from_secs(7200),child.wait_with_output())=>result.map_err(|_|error("坐标转换超时".into()))?.map_err(|_|error("转换进程中断".into()))?,
                _=async{while !cancel.load(Ordering::Relaxed){tokio::time::sleep(Duration::from_millis(100)).await;}}=>return Err(error("任务已取消".into())),
            };
            let result:Value=serde_json::from_slice(&output.stdout).map_err(|_|error("转换记录无效".into()))?;
            if !output.status.success()||result["crs"]!=target{return Err(error(result["error"].as_str().unwrap_or("转换结果与计划坐标系不一致").into()));}
            Ok(())
        })
    }
}
pub(crate) fn normalize(value:&str)->Result<String,AppError>{geod_core::crs::normalize(value).map_err(|e|workspace_error(e.code,e.message))}
pub(crate) fn validate(value:&str,raster:bool)->Result<String,AppError>{
    let value=normalize(value)?;
    if value==if raster{"EPSG:3857"}else{"EPSG:4326"}{return Ok(value);}
    let components=if raster{vec!["gis-common","gis-raster"]}else{vec!["gis-common","gis-vector"]};
    let mut command=crate::python_runtime::gis_command(include_str!("export_crs_worker.py"),&components)?;
    let mut child=command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).as_std_mut().spawn().map_err(|_|workspace_error("CRS_RUNTIME_FAILED","无法核对目标坐标系"))?;
    use std::io::Write;
    child.stdin.take().ok_or_else(||workspace_error("CRS_RUNTIME_FAILED","坐标转换进程不可用"))?.write_all(json!({"targetCrs":value,"validateOnly":true,"raster":raster}).to_string().as_bytes()).map_err(|_|workspace_error("CRS_RUNTIME_FAILED","坐标转换进程不可用"))?;
    let started=std::time::Instant::now();
    while child.try_wait().map_err(|_|workspace_error("CRS_RUNTIME_FAILED","坐标系核对进程中断"))?.is_none(){
        if started.elapsed()>Duration::from_secs(15){let _=child.kill();let _=child.wait();return Err(workspace_error("CRS_RUNTIME_FAILED","坐标系核对超时"));}
        std::thread::sleep(Duration::from_millis(20));
    }
    let result=child.wait_with_output().map_err(|_|workspace_error("CRS_RUNTIME_FAILED","坐标转换进程不可用"))?;
    if !result.status.success() || result.stdout.len() > 65536 { return Err(workspace_error("INVALID_OUTPUT_CRS", "坐标系核对失败")); }
    let result:Value=serde_json::from_slice(&result.stdout).map_err(|_|workspace_error("INVALID_OUTPUT_CRS","无法识别此 EPSG 编号"))?;
    if let Some(message)=result["error"].as_str(){return Err(workspace_error("INVALID_OUTPUT_CRS",message));}
    if result["crs"] != value { return Err(workspace_error("INVALID_OUTPUT_CRS", "坐标系核对结果不一致")); }
    Ok(value)
}
impl RasterProjector for Projector {
    fn reproject<'a>(&'a self,path:&'a Path,bounds:[f64;4],options:&'a ExportOptions,cancelled:&'a AtomicBool,paused:Option<&'a AtomicBool>)
        ->std::pin::Pin<Box<dyn std::future::Future<Output=Result<ProjectedRaster,CoreError>>+Send+'a>>{
        Box::pin(async move {
            let error=|e:AppError|CoreError::new(e.code,e.message);
            let mut command=crate::python_runtime::gis_command(include_str!("export_crs_worker.py"),&["gis-common","gis-raster"]).map_err(error)?;
            let mut child=command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().map_err(|_|CoreError::new("CRS_RUNTIME_FAILED","无法启动坐标转换"))?;
            let request=json!({"path":path,"bounds":bounds,"targetCrs":options.target_crs,"options":options});
            child.stdin.take().ok_or_else(||CoreError::new("CRS_RUNTIME_FAILED","转换进程不可用"))?.write_all(request.to_string().as_bytes()).await.map_err(|_|CoreError::new("CRS_RUNTIME_FAILED","转换进程已退出"))?;
            let output=tokio::select!{
                result=tokio::time::timeout(Duration::from_secs(7200),child.wait_with_output())=>result.map_err(|_|CoreError::new("TIMEOUT","坐标转换超时"))?.map_err(|_|CoreError::new("CRS_RUNTIME_FAILED","坐标转换进程中断"))?,
                result=async{loop{if cancelled.load(Ordering::Relaxed){break "CANCELLED";}if paused.is_some_and(|v|v.load(Ordering::Relaxed)){break "PAUSED";}tokio::time::sleep(Duration::from_millis(100)).await;}}=>return Err(CoreError::new(result,"坐标转换已停止；可沿用下载缓存重新生成成果")),
            };
            if !output.status.success()||output.stdout.len()>65536{return Err(CoreError::new("CRS_RUNTIME_FAILED","转换进程返回无效记录"));}
            let result:Value=serde_json::from_slice(&output.stdout).map_err(|_|CoreError::new("CRS_RUNTIME_FAILED","转换记录无效"))?;
            if let Some(message)=result["error"].as_str(){return Err(CoreError::new("CRS_TRANSFORM_FAILED",message));}
            serde_json::from_value(result).map_err(|_|CoreError::new("CRS_RUNTIME_FAILED","转换记录缺少目标网格"))
        })
    }
}

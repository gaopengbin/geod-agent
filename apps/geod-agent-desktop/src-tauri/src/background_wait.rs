//! A native wait reads owned ledgers, never invokes a model or resubmits work.
use crate::{AppState,read_workspace,services};
use serde_json::{json,Value};
use std::{sync::{Arc,atomic::{AtomicBool,Ordering}},time::{Duration,Instant},path::Path};
use tauri::{AppHandle,Manager};

fn fields(value:&Value,names:&[&str])->Value {
    let mut out=serde_json::Map::new();for name in names {if let Some(v)=value.get(*name){out.insert((*name).into(),v.clone());}}Value::Object(out)
}
pub(crate) fn artifact_summary(value:&Value)->Value {
    let assets=value["assets"].as_array().or_else(||value["resources"].as_array()).map(|items|items.iter().map(|asset|{let mut safe=fields(asset,&["id","kind","role","bytes","sha256","bounds","width","height","crs","targetCrs"]);if safe.get("bytes").is_none(){safe["bytes"]=asset["size"].clone();}safe}).collect::<Vec<_>>()).unwrap_or_default();
    let mut safe=fields(value,&["quality","provenance","outputCrs","bounds","featureCount","tileCount","selectedTiles"]);
    safe["fileCount"]=json!(assets.len());safe["assets"]=json!(assets);safe
}
fn verified_assets(value:&Value)->bool {value["assets"].as_array().is_some_and(|assets|!assets.is_empty()&&assets.iter().all(|asset|asset["bytes"].as_u64().is_some_and(|n|n>0)&&asset["sha256"].as_str().is_some_and(|s|s.len()==64&&s.bytes().all(|b|b.is_ascii_hexdigit()))))}
pub(crate) fn terminal(state:&str)->bool {matches!(state,"completed"|"partial"|"failed"|"cancelled"|"paused")}

pub(crate) fn wait(app:&AppHandle,owner:&str,conversation:&str,kind:&str,id:&str,cancel:&Arc<AtomicBool>,detached:&Arc<AtomicBool>,progress:impl Fn(&str)) -> Value {
    let read=||->Result<Value,crate::AppError>{
        let state=app.state::<AppState>();let service=app.state::<services::ServiceState>();
        if services::current_user_id(&service).ok().as_deref()!=Some(owner){return Err(crate::workspace_error("ACCOUNT_CHANGED","账号已切换，已结束等待"));}
        let workspace=read_workspace(app,&state,&service,conversation)?;
        if kind=="imagery" {
            let job=crate::open_store(&state)?.get_job(id)?.ok_or_else(||crate::workspace_error("JOB_NOT_FOUND","本机任务不存在"))?;
            crate::imagery_recovery::assert_plan_owner(&state,owner,conversation,Path::new(&workspace.directory),&job.plan_id)?;
            let raw=serde_json::to_value(job).map_err(|_|crate::workspace_error("TASK_STATE_UNAVAILABLE","任务状态不可读"))?;
            let status=raw["state"].as_str().unwrap_or("unknown");
            let mut output=json!({"jobId":id,"state":status,"verified":false,"progress":fields(&raw,&["completedTiles","totalTiles","version"])});
            if status=="completed" {
                let manifest=crate::open_store(&state)?.inspect_job_artifact(id)?;
                let value=serde_json::to_value(manifest).map_err(|_|crate::workspace_error("ARTIFACT_UNAVAILABLE","成果核验清单不可读"))?;
                let summary=artifact_summary(&value);
                output["verified"]=json!(summary["quality"]["status"]=="complete"&&summary["quality"]["missingTiles"]==0&&verified_assets(&summary));
                output["artifact"]=summary;
            }
            Ok(output)
        } else if kind=="data" {
            let task=crate::data_jobs::data_download_get(app.clone(),state,service,conversation.into(),id.into())?;
            let status=task.status.clone();let mut output=json!({"taskId":id,"state":status,"verified":false,"progress":task.progress});
            if status=="completed" {
                let inspected=crate::data_jobs::data_download_inspect(app.clone(),app.state(),app.state(),conversation.into(),id.into())?;
                if let Some(manifest)=inspected.manifest {let summary=artifact_summary(&manifest);output["verified"]=json!(verified_assets(&summary));output["artifact"]=summary;}
            }
            Ok(output)
        } else {Err(crate::workspace_error("BACKGROUND_WAIT_UNSUPPORTED","此任务类型没有本机等待适配器"))}
    };
    let mut last=String::new();let mut last_probe=Instant::now()-Duration::from_secs(3);
    loop {
        if cancel.load(Ordering::Acquire)||detached.load(Ordering::Acquire){return json!({"error":"BACKGROUND_WAIT_DETACHED","state":"unknown","verified":false,"downloadCancelled":false});}
        match read(){
            Ok(value)=>{let state=value["state"].as_str().unwrap_or("unknown");let marker=format!("{}:{}",state,value["progress"]);if marker!=last{progress(state);last=marker;}if terminal(state)||state=="unknown"{return value;}},
            Err(cause)=>return json!({"error":cause.code,"state":"unknown","verified":false,"message":"本机等待或成果核验不可用，请在任务面板核对"}),
        }
        if last_probe.elapsed()>=Duration::from_secs(2) {
            if app.state::<crate::background_runtime::BackgroundClient>().observe().is_err() {
                return json!({"error":"BACKGROUND_UNCERTAIN","state":"unknown","verified":false,"downloadCancelled":false,"message":"本机后台连接中断，请在任务面板核对；未重新提交下载"});
            }
            last_probe=Instant::now();
        }
        // Only the native monitor waits. No generation or tool follow-up is
        // dispatched while progress is unchanged; long tasks have no turn cap.
        std::thread::sleep(Duration::from_millis(500));
    }
}

#[cfg(test)]mod tests {
 use super::*;
 #[test]fn terminal_states_do_not_invent_success(){for state in ["completed","partial","failed","cancelled","paused"]{assert!(terminal(state));}for state in ["queued","downloading","processing","verifying","unknown"]{assert!(!terminal(state));}}
 #[test]fn artifact_summary_keeps_verification_and_dimensions_without_local_paths(){let raw=json!({"quality":{"status":"complete","missingTiles":0},"assets":[{"id":"raster","bytes":100,"sha256":"proof","width":501,"height":522,"crs":"EPSG:4326","path":"private.tif"}],"provenance":[]});let value=artifact_summary(&raw);assert!(value["assets"][0].get("path").is_none());assert_eq!(value["assets"][0]["crs"],"EPSG:4326");assert_eq!(value["assets"][0]["width"],501);}
 #[test]fn vector_and_3d_native_manifests_keep_real_verification_without_assuming_imagery_fields(){let sha="a".repeat(64);let vector=artifact_summary(&json!({"outputCrs":"EPSG:4490","assets":[{"size":55,"sha256":sha,"path":"features.gpkg"}]}));assert!(verified_assets(&vector));assert_eq!(vector["outputCrs"],"EPSG:4490");let scene=artifact_summary(&json!({"resources":[{"bytes":99,"sha256":sha,"path":"tileset.json"}]}));assert!(verified_assets(&scene));assert!(scene["assets"][0].get("path").is_none());assert!(!verified_assets(&artifact_summary(&json!({"assets":[{"bytes":0,"sha256":sha}]}))));}
}

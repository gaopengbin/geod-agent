use super::*;
use crate::acquisition_diagnostic::{AcquisitionDiagnostic,StorageDiagnostic,safe_integer,volume_label,describe_source};
use std::{future::Future,sync::Arc};

tokio::task_local! { pub(super) static CURRENT: Arc<Mutex<AcquisitionDiagnostic>>; }
tokio::task_local! { static SOURCE: usize; }

pub(super) fn new(request:&ImageryRequest,source:&HttpSource)->Arc<Mutex<AcquisitionDiagnostic>>{
 let mut d=AcquisitionDiagnostic::default();
 for(i,s)in std::iter::once(source).chain(request.overlays.iter()).enumerate(){
  if i<8{d.sources.push(describe_source(if i==0{"base"}else{"overlay"},&s.url_template,s.authentication.is_some()));}
  else{d.additional_sources=d.additional_sources.saturating_add(1);}
 }
 Arc::new(Mutex::new(d))
}
pub(super) fn phase(value:&str){let _=CURRENT.try_with(|d|if let Ok(mut d)=d.lock(){d.phase=value.into();});}
pub(super) fn response(host:&str,status:u16){
 let index=SOURCE.try_with(|v|*v).unwrap_or(0);
 let _=CURRENT.try_with(|d|if let Ok(mut d)=d.lock(){d.phase=if index==0{"base_download"}else{"overlay_download"}.into();d.response(index,host,status);});
}
pub(super) async fn source<T>(index:usize,future:impl Future<Output=Result<T,CoreError>>)->Result<T,CoreError>{
 SOURCE.scope(index,async{future.await.map_err(|mut e|{e.source_index=Some(index);e.http_status=e.http_status.or_else(||crate::acquisition_diagnostic::http_status(&e.message));e})}).await
}
pub(super) fn storage(report:&crate::storage_preflight::DiskPreflight){
 let _=CURRENT.try_with(|d|if let Ok(mut d)=d.lock(){
  d.phase="storage_preflight".into();d.storage_checked_at=Some(chrono::Utc::now().to_rfc3339());d.storage=report.volumes.iter().map(|v|StorageDiagnostic{
   roles:{let mut roles=vec![];for l in &v.locations{for role in if l.role=="cache"{vec!["cache"]}else{vec!["output","temporary"]}{if !roles.iter().any(|s|s==role){roles.push(role.into());}}}roles},
   volume:v.locations.first().map(|l|volume_label(&l.path)).unwrap_or_else(||"unknown".into()),
   budget_kind:"preflight".into(),required_bytes:safe_integer(v.required_bytes),available_bytes:safe_integer(v.available_bytes),
   met_budget:if safe_integer(v.required_bytes).is_some()&&safe_integer(v.available_bytes).is_some(){Some(v.sufficient)}else{None},
  }).collect();
 });
}
pub(super) fn pending_storage(workspace:&Path,cache:Option<&Path>,workspace_bytes:u64,cache_bytes:u64){
 let _=CURRENT.try_with(|d|if let Ok(mut d)=d.lock(){d.phase="storage_preflight".into();d.storage_checked_at=Some(chrono::Utc::now().to_rfc3339());d.storage=std::iter::once((vec!["output".into(),"temporary".into()],workspace,workspace_bytes)).chain(cache.map(|p|(vec!["cache".into()],p,cache_bytes))).map(|(roles,path,bytes)|StorageDiagnostic{roles,volume:volume_label(&path.display().to_string()),budget_kind:"estimate".into(),required_bytes:bytes.checked_add(16*1024*1024).and_then(safe_integer),available_bytes:None,met_budget:None}).collect();});
}

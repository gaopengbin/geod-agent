//! Budget each write location on its actual filesystem, not each against the
//! combined workspace/cache budget. Reports stay local to the task ledger.
use crate::imagery::CoreError;
use schemars::JsonSchema;
use serde::{Deserialize,Serialize};
use std::path::Path;

const RESERVE:u64=16*1024*1024;
const TILE_OVERHEAD:u64=32*1024;
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize,JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct DiskLocation {pub role:String,pub path:String,pub required_bytes:u64}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize,JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct DiskVolumeCheck {pub locations:Vec<DiskLocation>,pub required_bytes:u64,pub available_bytes:u64,pub sufficient:bool}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize,JsonSchema)]
#[serde(rename_all="camelCase")]
pub struct DiskPreflight {pub volumes:Vec<DiskVolumeCheck>}

fn overflow()->CoreError {CoreError::new("RESOURCE_LIMIT","Disk budget overflow")}
pub fn location_budgets(tiles:u64,size:u16,outputs:usize,pyramid:bool,cache:bool)->Result<(u64,u64),CoreError>{
 let rgba=tiles.checked_mul(u64::from(size).pow(2)).and_then(|n|n.checked_mul(4)).ok_or_else(overflow)?;
 let copies=u64::try_from(outputs.max(2)).map_err(|_|overflow())?.checked_add(u64::from(pyramid)).ok_or_else(overflow)?;
 let workspace=rgba.checked_mul(copies).ok_or_else(overflow)?;
 let cached=if cache {rgba.checked_mul(2).and_then(|n|tiles.checked_mul(TILE_OVERHEAD).and_then(|m|n.checked_add(m))).ok_or_else(overflow)?}else{tiles.checked_mul(TILE_OVERHEAD).ok_or_else(overflow)?};
 Ok(if cache {(workspace,cached)}else{(workspace.checked_add(cached).ok_or_else(overflow)?,0)})
}

#[cfg(windows)]
fn volume_id(path:&Path)->Result<String,CoreError>{
 use std::os::windows::ffi::OsStrExt;
 #[link(name="kernel32")]
 extern "system" {
  fn GetVolumePathNameW(file:*const u16,volume:*mut u16,size:u32)->i32;
  fn GetVolumeNameForVolumeMountPointW(mount:*const u16,name:*mut u16,size:u32)->i32;
 }
 let input:Vec<u16>=path.as_os_str().encode_wide().chain(Some(0)).collect();
 let mut mount=vec![0u16;32768];let mut name=vec![0u16;32768];
 // Both buffers are owned, sized in UTF-16 units and NUL-terminated. These
 // documented APIs resolve junction/mount aliases before grouping capacity.
 if unsafe{GetVolumePathNameW(input.as_ptr(),mount.as_mut_ptr(),mount.len()as u32)}==0{return Err(CoreError::new("DISK_CHECK_FAILED","无法确认保存位置或缓存目录所在的磁盘。"));}
 let chosen=if unsafe{GetVolumeNameForVolumeMountPointW(mount.as_ptr(),name.as_mut_ptr(),name.len()as u32)}!=0{&name}else{&mount}; // UNC shares need not expose a volume GUID.
 let end=chosen.iter().position(|&n|n==0).unwrap_or(chosen.len());
 Ok(String::from_utf16_lossy(&chosen[..end]).to_lowercase())
}
#[cfg(unix)]
fn volume_id(path:&Path)->Result<String,CoreError>{
 use std::os::unix::fs::MetadataExt;
 std::fs::metadata(path).map(|m|m.dev().to_string()).map_err(|_|CoreError::new("DISK_CHECK_FAILED","无法确认目录所在的磁盘。"))
}

fn group(samples:Vec<(String,u64,DiskLocation)>)->Result<DiskPreflight,CoreError>{
 let mut result:Vec<(String,DiskVolumeCheck)>=vec![];
 for(id,available,location)in samples{
  if let Some((_,v))=result.iter_mut().find(|(key,_)|*key==id){v.required_bytes=v.required_bytes.checked_add(location.required_bytes).ok_or_else(overflow)?;v.available_bytes=v.available_bytes.min(available);v.locations.push(location);}
  else{result.push((id,DiskVolumeCheck{required_bytes:location.required_bytes.checked_add(RESERVE).ok_or_else(overflow)?,available_bytes:available,locations:vec![location],sufficient:false}));}
 }
 for(_,v)in &mut result{v.sufficient=v.available_bytes>=v.required_bytes;}
 Ok(DiskPreflight{volumes:result.into_iter().map(|(_,v)|v).collect()})
}
pub fn inspect(workspace:&Path,cache:Option<&Path>,workspace_bytes:u64,cache_bytes:u64)->Result<DiskPreflight,CoreError>{
 let mut samples=vec![];
 for(role,path,required)in [Some(("workspace",workspace,workspace_bytes)),cache.map(|p|("cache",p,cache_bytes))].into_iter().flatten(){
  let canonical=path.canonicalize().map_err(|_|CoreError::new("DISK_CHECK_FAILED","保存位置或缓存目录无法访问，请检查目录和权限。"))?;
  let available=crate::imagery::available_disk_bytes(&canonical)?;
  samples.push((volume_id(&canonical)?,available,DiskLocation{role:role.into(),path:canonical.display().to_string(),required_bytes:required}));
 }
 group(samples)
}
impl DiskPreflight{
 pub fn ensure(&self)->Result<(),CoreError>{
  if let Some(v)=self.volumes.iter().find(|v|!v.sufficient){
   let roles=v.locations.iter().map(|l|if l.role=="cache"{"缓存目录"}else{"保存及导出临时目录"}).collect::<Vec<_>>().join("、");
   let message=format!("{roles}所在磁盘空间不足：保守预算需 {:.2} GB，实际可用 {:.2} GB。请调整对应目录后恢复原任务；已下载瓦片保留。",v.required_bytes as f64/1e9,v.available_bytes as f64/1e9);
   let mut error=CoreError::new("DISK_INSUFFICIENT",message);error.diagnostic=Some(crate::imagery::FailureDiagnostic::Storage{report:self.clone()});return Err(error);
  }Ok(())
 }
}

#[cfg(test)]mod tests{
 use super::*;
 fn sample(id:&str,free:u64,role:&str,required:u64)->(String,u64,DiskLocation){(id.into(),free,DiskLocation{role:role.into(),path:format!("{id}/{role}"),required_bytes:required})}
 #[test]fn screenshot_budget_splits_between_devices(){let(w,c)=location_budgets(40200,256,1,false,true).unwrap();assert_eq!(w+c+RESERVE,43_486_806_016);let p=group(vec![sample("D",600_000_000_000,"workspace",w),sample("C",30_000_000_000,"cache",c)]).unwrap();assert!(p.ensure().is_ok());}
 #[test]fn same_volume_requires_the_sum_not_the_max(){let p=group(vec![sample("D",60_000_000,"workspace",30_000_000),sample("D",60_000_000,"cache",30_000_000)]).unwrap();assert_eq!(p.volumes.len(),1);assert!(p.ensure().is_err());}
 #[test]fn failing_cache_is_identified_without_blame_on_output_disk(){let p=group(vec![sample("D",600_000_000_000,"workspace",20_000_000_000),sample("C",5_000_000_000,"cache",20_000_000_000)]).unwrap();let e=p.ensure().unwrap_err();assert!(e.message.starts_with("缓存目录"));assert!(p.volumes[0].sufficient);assert!(!p.volumes[1].sufficient);assert!(e.diagnostic.is_some());}
 #[test]fn oversized_budgets_fail_instead_of_wrapping(){assert!(location_budgets(u64::MAX,512,1,false,true).is_err());}
 #[test]fn actual_directories_are_grouped_and_not_allocated(){let t=tempfile::tempdir().unwrap();let c=t.path().join("cache");std::fs::create_dir(&c).unwrap();let p=inspect(t.path(),Some(&c),1,1).unwrap();assert_eq!(p.volumes.len(),1);assert!(p.ensure().is_ok());}
}

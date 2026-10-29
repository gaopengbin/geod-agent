//! Small live builtin-source diagnostic. No model, credentials, retries on 403,
//! or source configuration writes. This cannot prove a customer's batch works.
use geod_core::{imagery::*,tile};
use std::{path::PathBuf,sync::atomic::AtomicBool,time::Duration};
#[tokio::main]async fn main()->Result<(),Box<dyn std::error::Error>>{
 let out=PathBuf::from(std::env::args().nth(1).ok_or("new absolute evidence directory required")?);if !out.is_absolute()||out.exists(){return Err("new absolute evidence directory required".into());}std::fs::create_dir(&out)?;
 let reuse=std::env::args().nth(2).map(PathBuf::from);
 let catalogue:serde_json::Value=serde_json::from_str(include_str!("../../../contracts/source-presets.v1.json"))?;let mut results=vec![];
 for p in catalogue["presets"].as_array().ok_or("presets")?.iter().filter(|p|p["id"].as_str().is_some_and(|v|v.starts_with("gaode-"))){
  let id=p["id"].as_str().ok_or("id")?;let source:HttpSource=serde_json::from_value(serde_json::json!({"id":id,"name":p["name"],"attribution":p["attribution"],"license":"","urlTemplate":p["urlTemplate"],"subdomains":p["subdomains"],"coordinateSystem":p["coordinateSystem"],"scheme":"XYZ","tileSize":256,"networkPolicy":"PublicHttps","minIntervalMs":500}))?;
  let bounds=[116.402,39.914,116.4021,39.9141];let grid=tile::grid(bounds,15,256)?;
  let mut result=serde_json::json!({"id":id,"route":"direct","scope":"one native WGS84 tile, possibly multiple GCJ source tiles","modelCalls":0});
  let preview=if reuse.is_some(){Ok(vec![])}else{fetch_preview_tile(&source,grid.zoom,grid.x_min,grid.y_min,ProxyRoute::Direct).await};
  match preview{
   Err(e)=>{result["preview"]=serde_json::json!({"ok":false,"code":e.code,"diagnostic":e.diagnostic});result["download"]=serde_json::json!({"state":"not attempted after preview rejection"});},
   Ok(bytes)=>{if reuse.is_none(){std::fs::write(out.join(format!("{id}-preview.png")),bytes)?;}result["preview"]=serde_json::json!({"ok":true,"reusedPriorObservation":reuse.is_some()});
    let mut export=ExportOptions::default();export.cache_only=reuse.is_some();
    let request=ImageryRequest{name:id.into(),bounds,boundary:None,grids:vec![grid.clone()],output_geotiff:true,output_mbtiles:false,extra_outputs:vec![],export_options:export,overlays:vec![],max_tiles:grid.tile_count,max_decoded_rgba_bytes:grid.tile_count*256*256*4,destination:out.join(id),deadline:Duration::from_secs(90)};
    let cache=TileCacheConfig{root:reuse.as_ref().unwrap_or(&out).join(format!("{id}-cache")),plan_hash:"a".repeat(64),job_id:uuid::Uuid::new_v4().to_string()};
    match fetch_bundle_with_cache_control_proxy_options(&request,&source,&AtomicBool::new(false),&AtomicBool::new(false),&cache,ProxyRoute::Direct,DownloadOptions{concurrency:1,..Default::default()},|_,_|Ok(())).await{
     Ok(_)=>{let checked=inspect_bundle(&request.destination).map_err(|e|e.message)?;result["download"]=serde_json::json!({"ok":true,"quality":checked.quality,"verifiedAssets":checked.assets.len()});},
     Err(e)=>{result["download"]=serde_json::json!({"ok":false,"code":e.code,"message":e.message,"diagnostic":e.diagnostic});}
    }
   }
  }results.push(result);
 }
 let all=results.iter().all(|r|r["download"]["ok"]==true);let report=serde_json::json!({"at":chrono::Utc::now(),"route":"direct","cacheOnly":reuse.is_some(),"customerEnvironmentReproduced":false,"passed":all,"results":results});std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&report)?)?;println!("{report}");if !all{return Err("A source sample was not delivered; see bounded local receipt".into());}Ok(())
}

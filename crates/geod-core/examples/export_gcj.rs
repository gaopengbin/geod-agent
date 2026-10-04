//! Real GCJ-02 source acceptance: canonical WGS84 tiles, raster and raw comparison.
use geod_core::{imagery::*,tile};
use std::{path::PathBuf,time::Duration,sync::atomic::AtomicBool};
#[tokio::main]
async fn main()->Result<(),Box<dyn std::error::Error>> {
    let mut args=std::env::args().skip(1);let output=PathBuf::from(args.next().ok_or("new absolute output required")?);
    if !output.is_absolute() || output.exists(){return Err("new absolute output required".into());}
    let source:HttpSource=serde_json::from_value(serde_json::json!({
        "id":"gaode-road-gcj02","name":"高德道路 GCJ-02","attribution":"高德地图","license":"",
        "urlTemplate":"https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}","subdomains":["1","2","3","4"],"coordinateSystem":"gcj02",
        "scheme":"XYZ","tileSize":256,"networkPolicy":"PublicHttps","minIntervalMs":50
    }))?;
    source.validate().map_err(|e|e.message)?;
    let bounds=[116.402,39.914,116.406,39.917];let grid=tile::grid(bounds,17,256)?;let count=grid.tile_count;
    let request=ImageryRequest{name:"北京 GCJ 配准验收".into(),bounds,boundary:None,grids:vec![grid.clone()],output_geotiff:true,output_mbtiles:true,
        extra_outputs:vec![ExtraOutput::Png],export_options:ExportOptions::default(),overlays:vec![],max_tiles:count,max_decoded_rgba_bytes:count*256*256*4,destination:output.clone(),deadline:Duration::from_secs(180)};
    let proxy=args.next();let route=proxy.as_deref().map(ProxyRoute::Http).unwrap_or(ProxyRoute::Direct);
    let cache=TileCacheConfig{root:output.with_extension("cache"),plan_hash:"c".repeat(64),job_id:uuid::Uuid::new_v4().to_string()};
    let result=fetch_bundle_with_cache_control_proxy_options(&request,&source,&AtomicBool::new(false),&AtomicBool::new(false),&cache,route,DownloadOptions{concurrency:4,..Default::default()},|_,_|Ok(())).await.map_err(|e|format!("{}: {}",e.code,e.message))?;
    inspect_bundle(&output).map_err(|e|e.message)?;
    let mut raw=source.clone();raw.coordinate_system=None;
    let raw_image=fetch_preview_tile(&raw,grid.zoom,grid.x_min,grid.y_min,route).await.map_err(|e|e.message)?;
    let corrected=fetch_preview_tile(&source,grid.zoom,grid.x_min,grid.y_min,route).await.map_err(|e|e.message)?;
    let a=image::load_from_memory(&raw_image)?.to_rgba8();let b=image::load_from_memory(&corrected)?.to_rgba8();
    let changed=a.pixels().zip(b.pixels()).filter(|(a,b)|a!=b).count();if changed<1000{return Err("Expected visible GCJ coordinate correction".into());}
    let evidence=output.parent().ok_or("parent")?.join("gcj-evidence");std::fs::create_dir_all(&evidence)?;
    std::fs::write(evidence.join("gaode-raw.png"),raw_image)?;std::fs::write(evidence.join("gaode-wgs84.png"),corrected)?;
    let value=serde_json::json!({"quality":result.quality,"output":output,"tiles":count,"sourceCoordinateSystem":"gcj02","outputCoordinateSystem":"EPSG:3857","origins":source.request_origins().map_err(|e|e.message)?,"pixelChangesInOneTile":changed,"assets":result.assets.len()});
    std::fs::write(evidence.join("acceptance.json"),serde_json::to_vec_pretty(&value)?)?;println!("{value}");Ok(())
}

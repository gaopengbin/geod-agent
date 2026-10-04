use geod_core::{imagery::*,tile};
use std::{path::PathBuf,time::Duration,sync::atomic::AtomicBool};
#[tokio::main]
async fn main()->Result<(),Box<dyn std::error::Error>> {
    let args:Vec<_>=std::env::args().skip(1).collect();let destination=PathBuf::from(args.first().ok_or("absolute output directory required")?);
    let source=HttpSource { subdomains: Vec::new(), coordinate_system: None, elevation_encoding: None, id:"terrarium-dem".into(),name:"Terrarium 高程".into(),attribution:"Mapzen / AWS Terrain Tiles".into(),license:String::new(),
        url_template:"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png".into(),scheme:TileScheme::XYZ,tile_size:256,network_policy:NetworkPolicy::PublicHttps,min_interval_ms:0,authentication:None,runtime_token:None};
    let bounds=[116.2,39.8,116.6,40.1];let grid=tile::grid(bounds,10,256)?;let count=grid.tile_count;
    let request=ImageryRequest{name:source.name.clone(),bounds,boundary:None,grids:vec![grid],output_geotiff:true,output_mbtiles:false,extra_outputs:vec![],overlays:vec![],
        export_options:ExportOptions {elevation_encoding:Some(ElevationEncoding::Terrarium),build_pyramid:true,compression:TiffCompression::Deflate,..Default::default()},max_tiles:count,max_decoded_rgba_bytes:count*256*256*4,destination,deadline:Duration::from_secs(120)};
    let cache=TileCacheConfig {root:request.destination.with_extension("cache"),plan_hash:"d".repeat(64),job_id:uuid::Uuid::new_v4().to_string()};
    let result=fetch_bundle_with_cache_control_proxy(&request,&source,&AtomicBool::new(false),&AtomicBool::new(false),&cache,
        args.get(1).map(|s|ProxyRoute::Http(s)).unwrap_or(ProxyRoute::Direct),|_,_|Ok(())).await.map_err(|e|format!("{}: {}",e.code,e.message))?;
    inspect_bundle(&request.destination).map_err(|e|e.message)?;
    println!("{}",serde_json::to_string(&serde_json::json!({"tiles":count,"quality":result.quality.status,"output":request.destination}))?);Ok(())
}

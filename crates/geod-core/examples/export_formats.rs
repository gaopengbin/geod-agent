//! Small real-source acceptance bundle for each raster/container output.
use geod_core::{imagery::*, tile};
use std::{path::PathBuf, time::Duration};
#[tokio::main]
async fn main() -> Result<(),Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().ok_or("absolute output directory required")?);
    if !root.is_absolute() || root.exists() { return Err("new absolute directory required".into()); }
    let source = HttpSource { subdomains: Vec::new(), coordinate_system: None, elevation_encoding: None, id:"esri-world-imagery".into(), name:"Esri World Imagery".into(),
        attribution:"Esri and contributors".into(), license:String::new(),
        url_template:"https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}".into(),
        scheme:TileScheme::XYZ,tile_size:256,network_policy:NetworkPolicy::PublicHttps,min_interval_ms:0,authentication:None,runtime_token:None };
    let bounds = [116.38,39.89,116.48,39.98];
    let grids: Vec<_> = [11,12].into_iter().map(|z| tile::grid(bounds,z,256)).collect::<Result<_,_>>()?;
    let count: u64 = grids.iter().map(|g|g.tile_count).sum();
    let job = ImageryRequest { name:"北京格式验收".into(),bounds,boundary:None,grids,
        output_geotiff:true,output_mbtiles:true,
        extra_outputs:vec![ExtraOutput::Png,ExtraOutput::Jpeg,ExtraOutput::GeoPackage,ExtraOutput::Tiles],
        export_options:ExportOptions { compression:TiffCompression::Deflate,build_pyramid:true,generate_sidecars:true,jpeg_quality:90, ..Default::default() }, overlays: Vec::new(),
        max_tiles:count,max_decoded_rgba_bytes:count*256*256*4,destination:root,deadline:Duration::from_secs(120) };
    let proxy = args.next();
    let cache = TileCacheConfig {root:job.destination.with_extension("cache"),plan_hash:"e".repeat(64),job_id:uuid::Uuid::new_v4().to_string()};
    let result = fetch_bundle_with_cache_control_proxy_options(&job,&source,&std::sync::atomic::AtomicBool::new(false),
        &std::sync::atomic::AtomicBool::new(false),&cache,proxy.as_deref().map(ProxyRoute::Http).unwrap_or(ProxyRoute::Direct),
        DownloadOptions::default(),|_,_|Ok(())).await.map_err(|e| format!("{}: {}",e.code,e.message))?;
    inspect_bundle(&job.destination).map_err(|e|format!("{}: {}",e.code,e.message))?;
    println!("{}",serde_json::to_string(&serde_json::json!({"tiles":count,"quality":result.quality,"output":job.destination,"assets":result.assets.len()}))?);
    Ok(())
}

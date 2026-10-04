//! Small same-source cold-cache benchmark; never touches the user's task DB.
use geod_core::{
    imagery::{
        fetch_bundle_with_cache_control_proxy_options, inspect_bundle, DownloadOptions, HttpSource,
        ImageryRequest, NetworkPolicy, ProxyRoute, TileCacheConfig, TileScheme,
    },
    tile,
};
use std::{
    path::PathBuf,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let destination = PathBuf::from(args.next().ok_or("expected absolute evidence directory")?);
    if !destination.is_absolute() || destination.exists() {
        return Err("evidence directory must be absolute and new".into());
    }
    std::fs::create_dir_all(&destination)?;
    let proxy = args.next();
    let route = proxy
        .as_deref()
        .map(ProxyRoute::Http)
        .unwrap_or(ProxyRoute::Direct);
    let source = HttpSource { subdomains: Vec::new(), coordinate_system: None, elevation_encoding: None, id: "esri-world-imagery".into(), name: "Esri World Imagery".into(), attribution: "Esri, Vantor, Earthstar Geographics and the GIS User Community".into(), license: "".into(), url_template: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}".into(), scheme: TileScheme::XYZ, tile_size: 256, network_policy: NetworkPolicy::PublicHttps, min_interval_ms: 500, authentication: None, runtime_token: None };
    let lon = |x: f64| x / 4096.0 * 360.0 - 180.0;
    let lat = |y: f64| {
        (std::f64::consts::PI * (1.0 - 2.0 * y / 4096.0))
            .sinh()
            .atan()
            .to_degrees()
    };
    let bounds = [
        lon(3370.0) + 0.00001,
        lat(1554.0) + 0.00001,
        lon(3378.0) - 0.00001,
        lat(1550.0) - 0.00001,
    ];
    let grid = tile::grid(bounds, 12, 256)?;
    assert_eq!(grid.tile_count, 32);
    let mut evidence = Vec::new();
    for concurrency in [1, 30] {
        let label = format!("cold-{concurrency}");
        let request = ImageryRequest {
            name: label.clone(),
            bounds,
            boundary: None,
            grids: vec![grid.clone()],
            output_geotiff: true,
            output_mbtiles: false,
            extra_outputs: Vec::new(),
            export_options: geod_core::imagery::ExportOptions::default(), overlays: Vec::new(),
            max_tiles: 32,
            max_decoded_rgba_bytes: 32 * 256 * 256 * 4,
            destination: destination.join(&label),
            deadline: Duration::from_secs(180),
        };
        let cache = TileCacheConfig {
            root: destination.join(format!("cache-{concurrency}")),
            plan_hash: "e".repeat(64),
            job_id: uuid::Uuid::new_v4().to_string(),
        };
        let started = Instant::now();
        let mut tiles_ms = 0;
        println!("START concurrency={concurrency}, cold cache, 32 Esri tiles");
        let manifest = fetch_bundle_with_cache_control_proxy_options(
            &request,
            &source,
            &AtomicBool::new(false),
            &AtomicBool::new(false),
            &cache,
            route,
            DownloadOptions { concurrency },
            |done, _| {
                if done == 32 {
                    tiles_ms = started.elapsed().as_millis();
                }
                Ok(())
            },
        )
        .await
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
        let elapsed = started.elapsed();
        let inspected = inspect_bundle(&request.destination)
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
        assert_eq!(inspected.quality.status, "complete");
        let cache_db = rusqlite::Connection::open(cache.root.join("tiles.sqlite"))?;
        let bytes: u64 =
            cache_db.query_row("SELECT sum(bytes) FROM tiles", [], |row| row.get(0))?;
        let record = serde_json::json!({ "concurrency":concurrency, "tiles":32, "coldLocalCache":true, "tilePhaseMs":tiles_ms, "bundleMs":elapsed.as_millis(), "tilesPerSecond":32.0 / (tiles_ms as f64 / 1000.0), "sourceBytes":bytes, "quality":inspected.quality.status, "raster":manifest.assets.iter().find(|asset| asset.role=="analysis"), "output":request.destination });
        println!("{}", serde_json::to_string(&record)?);
        evidence.push(record);
    }
    let serial_tif = std::fs::read(destination.join("cold-1/imagery-z12.tif"))?;
    let parallel_tif = std::fs::read(destination.join("cold-30/imagery-z12.tif"))?;
    if serial_tif != parallel_tif {
        return Err("serial and parallel rasters differ".into());
    }
    let report = serde_json::json!({ "source":source.url_template, "bounds":bounds, "zoom":12, "perLaneIntervalMs":500, "sameRasterBytes":true, "results":evidence });
    std::fs::write(
        destination.join("benchmark.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!(
        "PASS identical GeoTIFFs and verified manifest hashes: {}",
        destination.display()
    );
    Ok(())
}

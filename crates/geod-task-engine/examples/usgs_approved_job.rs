//! Live acceptance exercise of the same source, plan, approval, job, and
//! artifact path used by the desktop commands. Use two new absolute paths:
//! an output directory and a SQLite database file.
use chrono::Utc;
use geod_core::imagery::{HttpSource, NetworkPolicy, TileScheme as HttpTileScheme};
use geod_task_engine::{
    ledger::{JobState, TaskStore},
    OutputFormat, ResourceLimits, SchemaVersion, TaskKind, TaskSpec,
};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let output = PathBuf::from(args.next().ok_or("Pass a new absolute output directory")?);
    let database = PathBuf::from(args.next().ok_or("Pass a new absolute SQLite file path")?);
    let tile_size: u16 = args.next().unwrap_or_else(|| "256".into()).parse()?;
    if !matches!(tile_size, 256 | 512) || args.next().is_some() {
        return Err("Optional tile size must be 256 or 512".into());
    }
    if !output.is_absolute() || !database.is_absolute() || output.exists() || database.exists() {
        return Err("Output and SQLite paths must be new absolute paths".into());
    }
    if !output.parent().is_some_and(|parent| parent.is_dir())
        || !database.parent().is_some_and(|parent| parent.is_dir())
    {
        return Err("Both parent directories must already exist".into());
    }
    let source = HttpSource { subdomains: Vec::new(), coordinate_system: None, elevation_encoding: None, id: "usgs-naip-plus-conus".into(),
        name: "USGS NAIP Plus (CONUS)".into(),
        attribution: "USGS, USDA, The National Map: Orthoimagery".into(),
        license: "USGS The National Map public-domain CONUS imagery".into(),
        url_template: "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage".into(),
        scheme: HttpTileScheme::XYZ,
        tile_size,
        network_policy: NetworkPolicy::PublicHttps,
        min_interval_ms: 500, authentication: None, runtime_token: None,
    };
    let mut store = TaskStore::open(&database)?;
    // This example's explicit USGS source is the only permitted source here.
    let descriptor = store.save_source(source.clone(), 0, 20, true, Utc::now())?;
    let spec = TaskSpec {
        schema_version: SchemaVersion::V0_1,
        kind: TaskKind::Imagery,
        source_id: descriptor.id.clone(),
        bounds: [-77.05, 38.85, -77.04, 38.86],
        boundary: None,
        zoom_levels: vec![12],
        output_formats: vec![OutputFormat::GeoTiff, OutputFormat::Mbtiles],
        export_options: None,
        output_directory: output.to_string_lossy().into_owned(),
        limits: ResourceLimits {
            max_tiles: 4,
            max_decoded_rgba_bytes: 4 * u64::from(tile_size).pow(2) * 4,
        },
    };
    let planned = store.create_plan(spec, &descriptor, Utc::now())?;
    let approved = store.grant_approval(
        &planned.plan_id,
        &planned.plan.plan_hash,
        "local-acceptance",
        "usgs-example-0.1",
        Utc::now(),
    )?;
    let job = store.start_job(
        &planned.plan_id,
        &planned.plan.plan_hash,
        &approved.approval_id,
        "usgs-acceptance-1",
        &descriptor,
        Utc::now(),
    )?;
    store
        .run_job(&job.job_id, &descriptor, &source, Utc::now())
        .await?;
    let completed = store.get_job(&job.job_id)?.ok_or("Job disappeared")?;
    if completed.state != JobState::Completed {
        return Err("Job did not complete".into());
    }
    let manifest = store.inspect_job_artifact(&job.job_id)?;
    println!(
        "jobId={} approvalId={} state={:?} tiles={} assets={} missingTiles={}",
        completed.job_id,
        completed.approval_id,
        completed.state,
        planned.plan.total_tiles,
        manifest.assets.len(),
        manifest.quality.missing_tiles
    );
    println!("output={}", output.display());
    Ok(())
}

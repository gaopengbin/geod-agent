use geod_vector::{NetworkOptions, OsmTag, OutputFormat, Request, RunOptions, Source, TileScheme};
use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let kind = args.get(1).map(String::as_str).unwrap_or("mvt");
    let output = PathBuf::from(
        args.get(2)
            .ok_or("usage: download_public mvt|osm OUTPUT_DIR [PROXY]")?,
    );
    let source = match kind {
        "mvt" => Source::Mvt {
            id: "maplibre-demo-countries".into(),
            name: "MapLibre public country vector tiles".into(),
            url_template: "https://demotiles.maplibre.org/tiles/{z}/{x}/{y}.pbf".into(),
            scheme: TileScheme::Xyz,
            layers: vec![],
            attribution: "MapLibre demo tiles / Natural Earth".into(),
        },
        "osm" => Source::Osm {
            id: "osm-overpass".into(),
            name: "OpenStreetMap Berlin buildings".into(),
            endpoint: args
                .get(4)
                .cloned()
                .unwrap_or_else(|| "https://overpass-api.de/api/interpreter".into()),
            tags: vec![OsmTag {
                key: "building".into(),
                value: None,
            }],
        },
        _ => return Err("kind must be mvt or osm".into()),
    };
    let request = Request {
        target_crs: None,
        source,
        bounds: [13.404, 52.52, 13.406, 52.522],
        boundary: None,
        zoom_levels: if kind == "mvt" { vec![2] } else { vec![] },
        outputs: if kind == "mvt" {
            vec![
                OutputFormat::Pbf,
                OutputFormat::Mbtiles,
                OutputFormat::Geojson,
                OutputFormat::Gpkg,
            ]
        } else {
            vec![OutputFormat::Geojson, OutputFormat::Gpkg]
        },
        allow_partial: false,
    };
    let plan = geod_vector::plan(request)?;
    let mut options = RunOptions::new(
        output.clone(),
        output.parent().unwrap().join("vector-cache"),
    );
    options.network = NetworkOptions {
        proxy: args.get(3).cloned(),
        ..Default::default()
    };
    let manifest = geod_vector::run(&plan, options, |p| {
        eprintln!(
            "{} {}/{} bytes={} cached={}",
            p.phase, p.completed, p.total, p.bytes, p.cache_hits
        )
    })
    .await?;
    let inspected = geod_vector::inspect(&output)?;
    assert_eq!(manifest.plan_hash, inspected.plan_hash);
    println!("{}", serde_json::to_string_pretty(&manifest)?);
    Ok(())
}

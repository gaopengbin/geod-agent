//! Small, explicit live-source acceptance check for the public-domain
//! CONUS imagery described by The National Map. Pass a new absolute output
//! directory; the program never overwrites an existing directory.
use geod_core::{
    imagery::{
        fetch_bundle, inspect_bundle, HttpSource, ImageryRequest, NetworkPolicy, TileScheme,
    },
    tile,
};
use std::{path::PathBuf, time::Duration};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let destination = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Pass a new absolute output directory")?,
    );
    if !destination.is_absolute() || destination.exists() {
        return Err("Output must be a new absolute directory".into());
    }
    let bounds = [-77.05, 38.85, -77.04, 38.86];
    let grid = tile::grid(bounds, 12, 256)?;
    let request = ImageryRequest {
        name: "Washington DC NAIP acceptance sample".into(),
        bounds,
        grids: vec![grid],
        output_geotiff: true,
        output_mbtiles: true,
        max_tiles: 4,
        max_decoded_rgba_bytes: 4 * 256 * 256 * 4,
        destination: destination.clone(),
        deadline: Duration::from_secs(90),
    };
    let source = HttpSource {
        id: "usgs-naip-plus-conus".into(), name: "USGS NAIP Plus (CONUS)".into(),
        attribution: "USGS, USDA, The National Map: Orthoimagery".into(),
        license: "USGS The National Map public-domain CONUS imagery".into(),
        url_template: "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage".into(),
        scheme: TileScheme::XYZ, tile_size: 256, network_policy: NetworkPolicy::PublicHttps,
        min_interval_ms: 500,
    };
    let produced = fetch_bundle(&request, &source)
        .await
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    let inspected =
        inspect_bundle(&destination).map_err(|e| format!("{}: {}", e.code, e.message))?;
    assert_eq!(produced.assets.len(), inspected.assets.len());
    println!("{}", serde_json::to_string_pretty(&inspected)?);
    Ok(())
}

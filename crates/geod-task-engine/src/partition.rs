//! Deterministic partitioning of whole source tiles. No model-created geometry,
//! downloads, approvals or relaxed per-plan limits are involved.
use crate::{plan, OutputFormat, Plan, PlanError, SourceDescriptor, TaskSpec};
use chrono::{DateTime, Utc};
use geod_core::tile;
use serde::{Deserialize, Serialize};
use std::path::Path;

const MAX_PARTITION_RECORDS: u64 = 256;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Partition {
    pub requested_bounds: [f64; 4],
    pub total_tiles: u64,
    pub required_free_disk_bytes: u64,
    pub plans: Vec<Plan>,
}

fn longitude(edge: f64, zoom: u8) -> f64 {
    edge / f64::from(1u32 << zoom) * 360.0 - 180.0
}
fn latitude(edge: f64, zoom: u8) -> f64 {
    (std::f64::consts::PI * (1.0 - 2.0 * edge / f64::from(1u32 << zoom)))
        .sinh()
        .atan()
        .to_degrees()
}

pub fn partition(
    spec: TaskSpec,
    source: &SourceDescriptor,
    now: DateTime<Utc>,
) -> Result<Partition, PlanError> {
    // Whole-tile containers have an exact, disjoint integer grid. Cropped rasters
    // require a different pixel-window contract; never introduce seams by
    // pretending hand-rounded geographic rectangles are that contract.
    if spec.boundary.is_some()
        || spec.output_formats.is_empty()
        || spec.output_formats.iter().any(|f| {
            !matches!(
                f,
                OutputFormat::Tiles | OutputFormat::Mbtiles | OutputFormat::GeoPackage
            )
        })
    {
        return Err(PlanError::new("PARTITION_FORMAT_UNSUPPORTED", "Exact automatic partitioning supports raw tiles, MBTiles and tile GeoPackage without polygon clipping. Raster cropping needs an explicit supported pixel-window workflow."));
    }
    let mut levels = spec.zoom_levels.clone();
    levels.sort_unstable();
    levels.dedup();
    if levels.is_empty() {
        return Err(PlanError::new(
            "INVALID_SPEC",
            "Choose at least one zoom level",
        ));
    }
    let pixel_bytes = u64::from(source.tile_size)
        .pow(2)
        .checked_mul(4)
        .ok_or_else(|| PlanError::new("RESOURCE_LIMIT", "Tile size overflow"))?;
    let budget = spec.limits.max_tiles.min(
        spec.limits
            .max_decoded_rgba_bytes
            .checked_div(pixel_bytes)
            .unwrap_or(0),
    );
    if budget == 0 {
        return Err(PlanError::new(
            "RESOURCE_LIMIT",
            "The per-plan budget cannot hold one source tile",
        ));
    }
    let mut grids = Vec::new();
    let mut record_count = 0u64;
    for z in levels {
        let grid = tile::grid(spec.bounds, z, source.tile_size)
            .map_err(|e| PlanError::new("INVALID_SPEC", e))?;
        let width = grid.columns.min(budget);
        let height = (budget / width).max(1).min(grid.rows);
        record_count = record_count
            .checked_add(
                grid.columns
                    .div_ceil(width)
                    .checked_mul(grid.rows.div_ceil(height))
                    .ok_or_else(|| PlanError::new("RESOURCE_LIMIT", "Partition count overflow"))?,
            )
            .ok_or_else(|| PlanError::new("RESOURCE_LIMIT", "Partition count overflow"))?;
        if record_count > MAX_PARTITION_RECORDS {
            return Err(PlanError::new("PARTITION_MANIFEST_TOO_LARGE",format!("This request requires {record_count} or more plan records. The local manifest budget is {MAX_PARTITION_RECORDS}; partition the request into explicit geographic or zoom groups first, preserving the original request.")));
        }
        grids.push((grid, width, height));
    }
    let mut plans = Vec::new();
    let mut total_tiles = 0u64;
    let mut required_free_disk_bytes = 0u64;
    for (grid, width, height) in grids {
        let mut y = grid.y_min;
        while y <= grid.y_max {
            let end_y = (u64::from(y) + height - 1).min(u64::from(grid.y_max)) as u32;
            let mut x = grid.x_min;
            while x <= grid.x_max {
                let end_x = (u64::from(x) + width - 1).min(u64::from(grid.x_max)) as u32;
                let mut child = spec.clone();
                child.zoom_levels = vec![grid.zoom];
                // Coordinates are deliberately inside each outer tile. GeoD's
                // existing inclusive-edge planner expands them back to exactly
                // these integer cells, including after eight-decimal storage.
                child.bounds = [
                    longitude(f64::from(x) + 0.25, grid.zoom),
                    latitude(f64::from(end_y) + 0.75, grid.zoom),
                    longitude(f64::from(end_x) + 0.75, grid.zoom),
                    latitude(f64::from(y) + 0.25, grid.zoom),
                ];
                child.output_directory = Path::new(&spec.output_directory)
                    .join(format!(
                        "part-{:03}-z{}-x{}-y{}",
                        plans.len() + 1,
                        grid.zoom,
                        x,
                        y
                    ))
                    .to_string_lossy()
                    .into_owned();
                let child = plan(child, source, now)?;
                let actual = &child.tile_grids[0];
                if (actual.x_min, actual.y_min, actual.x_max, actual.y_max) != (x, y, end_x, end_y)
                {
                    return Err(PlanError::new(
                        "PARTITION_GRID_MISMATCH",
                        "Stored partition coordinates did not preserve the exact source tile grid",
                    ));
                }
                total_tiles = total_tiles
                    .checked_add(child.total_tiles)
                    .ok_or_else(|| PlanError::new("RESOURCE_LIMIT", "Tile count overflow"))?;
                required_free_disk_bytes = required_free_disk_bytes
                    .checked_add(child.required_free_disk_bytes)
                    .ok_or_else(|| PlanError::new("RESOURCE_LIMIT", "Disk budget overflow"))?;
                plans.push(child);
                x = end_x + 1;
            }
            y = end_y + 1;
        }
    }
    Ok(Partition {
        requested_bounds: spec.bounds,
        total_tiles,
        required_free_disk_bytes,
        plans,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (TaskSpec, SourceDescriptor) {
        let spec:TaskSpec=serde_json::from_value(serde_json::json!({"schemaVersion":"0.1","kind":"imagery","sourceId":"actual-source","bounds":[-180.0,-85.05112878,180.0,85.05112878],"zoomLevels":[12],"outputFormats":["tiles"],"exportOptions":{"targetCrs":"EPSG:3857"},"outputDirectory":std::env::temp_dir().join("partition-proof"),"limits":{"maxTiles":1000000,"maxDecodedRgbaBytes":1099511627776u64}})).unwrap();
        let source:SourceDescriptor=serde_json::from_value(serde_json::json!({"schemaVersion":"0.1","id":"actual-source","displayName":"Actual source","attribution":"Provider","license":"","bulkDownloadAllowed":true,"scheme":"XYZ","tileSize":256,"minZoom":0,"maxZoom":22,"configRevision":"revision","credentialRefVersion":null})).unwrap();
        (spec, source)
    }
    #[test]
    fn world_z12_has_exact_disjoint_full_coverage_and_unchanged_limits() {
        let (spec, source) = fixture();
        let result = partition(spec.clone(), &source, Utc::now()).unwrap();
        assert_eq!(result.total_tiles, 16777216);
        assert_eq!(result.plans.len(), 17);
        let mut last = 0;
        for p in &result.plans {
            let g = &p.tile_grids[0];
            assert_eq!((g.x_min, g.x_max), (0, 4095));
            assert_eq!(g.y_min, last);
            last = g.y_max + 1;
            assert!(p.total_tiles <= 1000000);
            assert_eq!(p.spec.limits, spec.limits);
            assert_eq!(p.spec.output_formats, spec.output_formats);
            assert!(p.spec.output_directory.starts_with(&spec.output_directory));
        }
        assert_eq!(last, 4096);
    }
    #[test]
    fn multiple_zooms_and_partial_ranges_keep_every_selected_cell_once() {
        let (mut spec, source) = fixture();
        spec.bounds = [100.13, 20.07, 123.9, 45.2];
        spec.zoom_levels = vec![5, 7, 5];
        spec.limits.max_tiles = 32;
        spec.output_formats = vec![OutputFormat::Mbtiles];
        let result = partition(spec.clone(), &source, Utc::now()).unwrap();
        let mut seen = std::collections::BTreeSet::new();
        for p in result.plans {
            let g = &p.tile_grids[0];
            for x in g.x_min..=g.x_max {
                for y in g.y_min..=g.y_max {
                    assert!(seen.insert((g.zoom, x, y)));
                }
            }
        }
        let expected: [u8; 2] = [5, 7];
        let n: u64 = expected
            .into_iter()
            .map(|z| tile::grid(spec.bounds, z, 256).unwrap().tile_count)
            .sum();
        assert_eq!(seen.len() as u64, n);
        assert_eq!(result.total_tiles, n);
    }
    #[test]
    fn partition_never_approves_unsupported_format_or_unbounded_record_allocation() {
        let (mut spec, source) = fixture();
        spec.output_formats = vec![OutputFormat::GeoTiff];
        assert_eq!(
            partition(spec.clone(), &source, Utc::now())
                .unwrap_err()
                .code,
            "PARTITION_FORMAT_UNSUPPORTED"
        );
        spec.output_formats = vec![OutputFormat::Tiles];
        spec.zoom_levels = vec![22];
        assert_eq!(
            partition(spec, &source, Utc::now()).unwrap_err().code,
            "PARTITION_MANIFEST_TOO_LARGE"
        );
    }
    #[test]
    fn original_numeric_bands_are_not_silently_rendered_and_encoded_dem_remains_supported() {
        let (mut spec, mut source) = fixture();
        spec.bounds = [-1.0, 1.0, 1.0, 2.0];
        spec.zoom_levels = vec![1];
        spec.output_formats = vec![OutputFormat::GeoTiff];
        spec.export_options.as_mut().unwrap().pixel_value_mode =
            Some(geod_core::imagery::PixelValueMode::Native);
        assert_eq!(
            plan(spec.clone(), &source, Utc::now()).unwrap_err().code,
            "RASTER_ANALYSIS_UNSUPPORTED"
        );
        source.elevation_encoding = Some(geod_core::imagery::ElevationEncoding::Terrarium);
        assert!(plan(spec, &source, Utc::now()).is_ok());
    }
}

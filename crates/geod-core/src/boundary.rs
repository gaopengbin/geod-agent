//! Bounded WGS84 GeoJSON polygons and deterministic raster masking.

use crate::tile::TileGrid;
use image::RgbaImage;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_GEOJSON_BYTES: usize = 1024 * 1024;
const MAX_POLYGONS: usize = 32;
const MAX_RINGS: usize = 64;
const MAX_VERTICES: usize = 4096;
const MAX_LATITUDE: f64 = 85.051_128_78;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BoundaryGeometry {
    /// Polygon → ring → WGS84 [longitude, latitude]. The first ring is the
    /// exterior; later rings are holes. MultiPolygon members are independent.
    pub polygons: Vec<Vec<Vec<[f64; 2]>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundaryError(pub &'static str);

impl BoundaryGeometry {
    pub fn from_geojson(bytes: &[u8]) -> Result<Self, BoundaryError> {
        if bytes.is_empty() || bytes.len() > MAX_GEOJSON_BYTES {
            return Err(BoundaryError("GeoJSON must be 1 MiB or smaller"));
        }
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| BoundaryError("Invalid GeoJSON"))?;
        let mut polygons = Vec::new();
        collect(&value, &mut polygons)?;
        let mut geometry = Self { polygons };
        geometry.normalize()?;
        Ok(geometry)
    }

    /// Round before hashing so equivalent imported files yield one plan.
    pub fn normalize(&mut self) -> Result<[f64; 4], BoundaryError> {
        if self.polygons.is_empty() || self.polygons.len() > MAX_POLYGONS {
            return Err(BoundaryError("Boundary polygon count is unsupported"));
        }
        let mut bounds = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        let mut vertices = 0usize;
        for polygon in &mut self.polygons {
            if polygon.is_empty() || polygon.len() > MAX_RINGS {
                return Err(BoundaryError("Boundary ring count is unsupported"));
            }
            for ring in polygon {
                if ring.len() < 4 {
                    return Err(BoundaryError("Boundary rings need at least three vertices"));
                }
                vertices += ring.len();
                if vertices > MAX_VERTICES {
                    return Err(BoundaryError("Boundary has too many vertices"));
                }
                for point in ring.iter_mut() {
                    if !point[0].is_finite()
                        || !point[1].is_finite()
                        || !(-180.0..=180.0).contains(&point[0])
                        || !(-MAX_LATITUDE..=MAX_LATITUDE).contains(&point[1])
                    {
                        return Err(BoundaryError(
                            "Boundary coordinates must be WGS84 within Web Mercator latitude",
                        ));
                    }
                    for coordinate in point.iter_mut() {
                        *coordinate = (*coordinate * 100_000_000.0).round() / 100_000_000.0;
                        if *coordinate == 0.0 {
                            *coordinate = 0.0;
                        }
                    }
                    bounds[0] = bounds[0].min(point[0]);
                    bounds[1] = bounds[1].min(point[1]);
                    bounds[2] = bounds[2].max(point[0]);
                    bounds[3] = bounds[3].max(point[1]);
                }
                if ring.first() != ring.last() {
                    return Err(BoundaryError("Boundary rings must be closed"));
                }
                let area: f64 = ring
                    .windows(2)
                    .map(|edge| edge[0][0] * edge[1][1] - edge[1][0] * edge[0][1])
                    .sum();
                if area.abs() < 1e-14 {
                    return Err(BoundaryError("Boundary ring has zero area"));
                }
                let west = ring
                    .iter()
                    .map(|point| point[0])
                    .fold(f64::INFINITY, f64::min);
                let east = ring
                    .iter()
                    .map(|point| point[0])
                    .fold(f64::NEG_INFINITY, f64::max);
                if east - west >= 180.0 {
                    return Err(BoundaryError("Split boundaries crossing the antimeridian"));
                }
            }
        }
        if bounds[0] >= bounds[2] || bounds[1] >= bounds[3] {
            return Err(BoundaryError("Boundary extent is empty"));
        }
        Ok(bounds)
    }
}

fn collect(value: &Value, out: &mut Vec<Vec<Vec<[f64; 2]>>>) -> Result<(), BoundaryError> {
    if value.get("crs").is_some() {
        return Err(BoundaryError("GeoJSON must use WGS84 without a custom CRS"));
    }
    match value.get("type").and_then(Value::as_str) {
        Some("Polygon") => {
            out.push(
                serde_json::from_value(
                    value
                        .get("coordinates")
                        .cloned()
                        .ok_or(BoundaryError("GeoJSON coordinates are missing"))?,
                )
                .map_err(|_| BoundaryError("Invalid Polygon coordinates"))?,
            );
        }
        Some("MultiPolygon") => {
            let polygons: Vec<Vec<Vec<[f64; 2]>>> = serde_json::from_value(
                value
                    .get("coordinates")
                    .cloned()
                    .ok_or(BoundaryError("GeoJSON coordinates are missing"))?,
            )
            .map_err(|_| BoundaryError("Invalid MultiPolygon coordinates"))?;
            out.extend(polygons);
        }
        Some("Feature") => collect(
            value
                .get("geometry")
                .ok_or(BoundaryError("Feature geometry is missing"))?,
            out,
        )?,
        Some("FeatureCollection") => {
            let features = value
                .get("features")
                .and_then(Value::as_array)
                .ok_or(BoundaryError("FeatureCollection features are missing"))?;
            if features.len() > MAX_POLYGONS {
                return Err(BoundaryError("Too many GeoJSON features"));
            }
            for feature in features {
                collect(feature, out)?;
            }
        }
        _ => {
            return Err(BoundaryError(
                "Only GeoJSON Polygon and MultiPolygon are supported",
            ))
        }
    }
    if out.len() > MAX_POLYGONS {
        return Err(BoundaryError("Boundary polygon count is unsupported"));
    }
    Ok(())
}

/// Clear alpha outside the polygon at pixel centers. GeoTIFF and preview use
/// this mask; complete source tiles in MBTiles remain unchanged.
pub fn mask_rgba(
    image: &mut RgbaImage,
    geometry: &BoundaryGeometry,
    grid: &TileGrid,
    tile_size: u16,
    crop_left: u32,
    crop_top: u32,
) {
    let dimension = (1u32 << grid.zoom) as f64 * f64::from(tile_size);
    let pixel_x = |lon: f64| {
        (lon + 180.0) / 360.0 * dimension
            - f64::from(grid.x_min) * f64::from(tile_size)
            - f64::from(crop_left)
    };
    let pixel_y = |lat: f64| {
        (1.0 - lat.to_radians().tan().asinh() / std::f64::consts::PI) / 2.0 * dimension
            - f64::from(grid.y_min) * f64::from(tile_size)
            - f64::from(crop_top)
    };
    let projected: Vec<Vec<Vec<(f64, f64)>>> = geometry
        .polygons
        .iter()
        .map(|polygon| {
            polygon
                .iter()
                .map(|ring| {
                    ring.iter()
                        .map(|point| (pixel_x(point[0]), pixel_y(point[1])))
                        .collect()
                })
                .collect()
        })
        .collect();
    let width = image.width() as usize;
    let mut keep = vec![false; width];
    for y in 0..image.height() {
        keep.fill(false);
        let center_y = f64::from(y) + 0.5;
        for polygon in &projected {
            let mut crossings = Vec::new();
            for ring in polygon {
                for edge in ring.windows(2) {
                    let ((x0, y0), (x1, y1)) = (edge[0], edge[1]);
                    if (y0 <= center_y && center_y < y1) || (y1 <= center_y && center_y < y0) {
                        crossings.push(x0 + (center_y - y0) * (x1 - x0) / (y1 - y0));
                    }
                }
            }
            crossings.sort_by(f64::total_cmp);
            for pair in crossings.chunks_exact(2) {
                let start = (pair[0] - 0.5).ceil().max(0.0) as usize;
                let end = (pair[1] - 0.5).ceil().min(width as f64) as usize;
                if start < end {
                    keep[start..end].fill(true);
                }
            }
        }
        for (x, visible) in keep.iter().enumerate() {
            if !visible {
                image.get_pixel_mut(x as u32, y)[3] = 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tile;

    #[test]
    fn a_polygon_hole_remains_transparent() {
        let geometry = BoundaryGeometry::from_geojson(br#"{"type":"Polygon","coordinates":[[[-20,-20],[20,-20],[20,20],[-20,20],[-20,-20]],[[-5,-5],[-5,5],[5,5],[5,-5],[-5,-5]]]}"#).unwrap();
        let grid = tile::grid([-20.0, -20.0, 20.0, 20.0], 0, 256).unwrap();
        let mut image = RgbaImage::from_pixel(256, 256, image::Rgba([30, 60, 90, 255]));
        mask_rgba(&mut image, &geometry, &grid, 256, 0, 0);
        assert_eq!(image.get_pixel(128, 128)[3], 0);
        assert_eq!(image.get_pixel(135, 128)[3], 255);
        assert_eq!(image.get_pixel(80, 128)[3], 0);
    }
}

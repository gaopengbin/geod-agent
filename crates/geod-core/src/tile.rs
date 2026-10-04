//! Web Mercator XYZ grid calculations. The inclusive edge behavior follows the
//! GeoD `tile::get_tile_matrix_size` baseline at geo-downloader 0938626.

use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

pub const MAX_MERCATOR_LAT: f64 = 85.051_128_78;
pub const MAX_ZOOM: u8 = 22;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TileGrid {
    pub zoom: u8,
    pub x_min: u32,
    pub y_min: u32,
    pub x_max: u32,
    pub y_max: u32,
    pub columns: u64,
    pub rows: u64,
    pub tile_count: u64,
    pub pixel_width: u64,
    pub pixel_height: u64,
    /// WGS84 footprint of the complete tile grid, which may exceed the request.
    pub actual_bounds: [f64; 4],
}

impl TileGrid {
    /// JSON readers may round the derived geographic extent by one ULP. The
    /// authoritative tile indices/pixel grid still have to match exactly.
    pub fn matches_persisted(&self, stored: &Self) -> bool {
        let mut comparable = stored.clone();
        comparable.actual_bounds = self.actual_bounds;
        self == &comparable && self.actual_bounds.iter().zip(stored.actual_bounds).all(|(a, b)|
            b.is_finite() && (a - b).abs() <= f64::EPSILON * 8.0 * a.abs().max(1.0))
    }
}

fn tile_xy(lon: f64, lat: f64, zoom: u8) -> (u32, u32) {
    let n = (1u32 << zoom) as f64;
    let lat = lat.clamp(-MAX_MERCATOR_LAT, MAX_MERCATOR_LAT);
    let x = ((lon + 180.0) / 360.0 * n).floor().clamp(0.0, n - 1.0);
    let radians = lat.to_radians();
    let y = ((1.0 - (radians.tan() + 1.0 / radians.cos()).ln() / PI) / 2.0 * n)
        .floor()
        .clamp(0.0, n - 1.0);
    (x as u32, y as u32)
}

fn longitude(edge: u32, zoom: u8) -> f64 {
    edge as f64 / (1u32 << zoom) as f64 * 360.0 - 180.0
}

fn latitude(edge: u32, zoom: u8) -> f64 {
    (PI * (1.0 - 2.0 * edge as f64 / (1u32 << zoom) as f64))
        .sinh()
        .atan()
        .to_degrees()
}

pub fn grid(bounds: [f64; 4], zoom: u8, tile_size: u16) -> Result<TileGrid, &'static str> {
    if zoom > MAX_ZOOM || !matches!(tile_size, 256 | 512) {
        return Err("unsupported zoom or tile size");
    }
    if bounds.iter().any(|v| !v.is_finite())
        || bounds[0] < -180.0
        || bounds[2] > 180.0
        || bounds[1] < -MAX_MERCATOR_LAT
        || bounds[3] > MAX_MERCATOR_LAT
        || bounds[0] >= bounds[2]
        || bounds[1] >= bounds[3]
    {
        return Err("invalid WGS84 bounds; antimeridian areas must be split");
    }
    let (x_min, y_min) = tile_xy(bounds[0], bounds[3], zoom);
    let (x_max, y_max) = tile_xy(bounds[2], bounds[1], zoom);
    let columns = u64::from(x_max - x_min) + 1;
    let rows = u64::from(y_max - y_min) + 1;
    Ok(TileGrid {
        zoom,
        x_min,
        y_min,
        x_max,
        y_max,
        columns,
        rows,
        tile_count: columns * rows,
        pixel_width: columns * u64::from(tile_size),
        pixel_height: rows * u64::from(tile_size),
        actual_bounds: [
            longitude(x_min, zoom),
            latitude(y_max + 1, zoom),
            longitude(x_max + 1, zoom),
            latitude(y_min, zoom),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_pinned_legacy_two_tile_fixture() {
        let g = grid([-1.0, 1.0, 1.0, 2.0], 1, 256).unwrap();
        assert_eq!((g.x_min, g.y_min, g.x_max, g.y_max), (0, 0, 1, 0));
        assert_eq!((g.tile_count, g.pixel_width, g.pixel_height), (2, 512, 256));
        assert_eq!(g.actual_bounds[0], -180.0);
        assert_eq!(g.actual_bounds[1], 0.0);
        assert_eq!(g.actual_bounds[2], 180.0);
        assert!((g.actual_bounds[3] - 85.051_128_779_806_6).abs() < 1e-9);
    }

    #[test]
    fn limits_and_rejects_bad_coordinates() {
        assert!(grid([1.0, 0.0, -1.0, 2.0], 1, 256).is_err());
        assert!(grid([0.0, f64::NAN, 1.0, 2.0], 1, 256).is_err());
        assert!(grid([-1.0, 1.0, 1.0, 2.0], 23, 256).is_err());
        assert!(grid([-1.0, 1.0, 1.0, 2.0], 1, 1024).is_err());
    }

    #[test]
    fn tile_size_changes_pixels_not_tile_count() {
        let small = grid([-1.0, 1.0, 1.0, 2.0], 1, 256).unwrap();
        let large = grid([-1.0, 1.0, 1.0, 2.0], 1, 512).unwrap();
        assert_eq!(small.tile_count, large.tile_count);
        assert_eq!(large.pixel_width, small.pixel_width * 2);
    }

    #[test]
    fn json_roundtrip_preserves_execution_grid_without_accepting_changed_tiles() {
        let expected = grid([-170.0, 0.0, -100.0, 70.0], 5, 256).unwrap();
        let mut stored: TileGrid = serde_json::from_slice(&serde_json::to_vec(&expected).unwrap()).unwrap();
        assert!(expected.matches_persisted(&stored));
        stored.actual_bounds[0] += 0.001;
        assert!(!expected.matches_persisted(&stored));
        stored = expected.clone();
        stored.x_max += 1;
        assert!(!expected.matches_persisted(&stored));
    }
}

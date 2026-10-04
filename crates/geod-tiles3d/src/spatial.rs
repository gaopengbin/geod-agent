use geo::{BoundingRect, Coord, Intersects, LineString, Polygon, Rect, Validation};
use geod_core::boundary::BoundaryGeometry;
use serde_json::Value;

pub type Transform = [f64; 16];
pub const IDENTITY: Transform = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

/// Prepared once per download. Polygons retain their exterior, holes and islands;
/// geographic envelopes select whole tile resources and do not cut mesh geometry.
pub(crate) struct AreaOfInterest {
    bounds: Option<[f64; 4]>,
    polygons: Option<Vec<(Rect<f64>, Polygon<f64>)>>,
}
impl AreaOfInterest {
    pub(crate) fn new(
        bounds: Option<[f64; 4]>,
        boundary: Option<&BoundaryGeometry>,
    ) -> Result<Self, String> {
        if let Some(bounds) = bounds {
            validate_bounds(bounds)?;
        }
        let polygons = boundary
            .map(|boundary| {
                let mut boundary = boundary.clone();
                boundary.normalize().map_err(|e| e.0.to_owned())?;
                boundary
                    .polygons
                    .iter()
                    .map(|rings| {
                        let ring = |points: &Vec<[f64; 2]>| {
                            LineString::from(
                                points.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>(),
                            )
                        };
                        let polygon =
                            Polygon::new(ring(&rings[0]), rings[1..].iter().map(ring).collect());
                        polygon
                            .check_validation()
                            .map_err(|e| format!("Invalid 3D area polygon: {e}"))?;
                        let rectangle = polygon.bounding_rect().ok_or("Empty 3D area polygon")?;
                        Ok((rectangle, polygon))
                    })
                    .collect::<Result<Vec<_>, String>>()
            })
            .transpose()?;
        Ok(Self { bounds, polygons })
    }

    pub(crate) fn intersects_volume(
        &self,
        volume: &Value,
        transform: &Transform,
    ) -> Result<bool, String> {
        let Some(envelope) = envelope(volume, transform)? else {
            // Unknown geographic position cannot justify discarding content.
            return Ok(true);
        };
        if self
            .bounds
            .is_some_and(|bounds| !intersects(bounds, envelope))
        {
            return Ok(false);
        }
        let Some(polygons) = &self.polygons else {
            return Ok(true);
        };
        // A tile envelope may straddle the date line; stored AOI polygons are
        // individually split there by the common boundary validation contract.
        Ok(segments(envelope).into_iter().any(|(west, east)| {
            let tile = Rect::new(
                Coord {
                    x: west,
                    y: envelope[1],
                },
                Coord {
                    x: east,
                    y: envelope[3],
                },
            );
            polygons
                .iter()
                .any(|(bounds, polygon)| bounds.intersects(&tile) && polygon.intersects(&tile))
        }))
    }
}

pub fn cumulative(parent: &Transform, local: Option<&Value>) -> Result<Transform, String> {
    let Some(local) = local else {
        return Ok(*parent);
    };
    let v = numbers(local, 16)?;
    let mut out = [0.; 16];
    for col in 0..4 {
        for row in 0..4 {
            out[col * 4 + row] = (0..4).map(|k| parent[k * 4 + row] * v[col * 4 + k]).sum();
        }
    }
    if v[3] != 0. || v[7] != 0. || v[11] != 0. || v[15] != 1. {
        return Err("3D Tiles transform must be affine".into());
    }
    Ok(out)
}

fn numbers(v: &Value, size: usize) -> Result<Vec<f64>, String> {
    let a = v.as_array().ok_or("Expected numeric bounding volume")?;
    if a.len() != size {
        return Err(format!("Expected {size} bounding volume values"));
    }
    a.iter()
        .map(|v| {
            v.as_f64()
                .filter(|n| n.is_finite())
                .ok_or_else(|| "Non-finite bounding volume".into())
        })
        .collect()
}
fn point(t: &Transform, p: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|r| t[r] * p[0] + t[4 + r] * p[1] + t[8 + r] * p[2] + t[12 + r])
}
fn vector(t: &Transform, p: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|r| t[r] * p[0] + t[4 + r] * p[1] + t[8 + r] * p[2])
}
fn norm(p: [f64; 3]) -> f64 {
    p.iter().map(|v| v * v).sum::<f64>().sqrt()
}
fn lonlat(p: [f64; 3]) -> [f64; 2] {
    let r = p[0].hypot(p[1]);
    let mut lat = p[2].atan2(r);
    for _ in 0..8 {
        let n = 6_378_137. / (1. - 0.0066943799901413165 * lat.sin().powi(2)).sqrt();
        lat = (p[2] + 0.0066943799901413165 * n * lat.sin()).atan2(r);
    }
    [p[1].atan2(p[0]).to_degrees(), lat.to_degrees()]
}

/// A conservative geographic envelope. Box and sphere filtering keeps complete
/// intersecting tiles; it never clips mesh geometry. Regions already use global
/// EPSG:4979 and do not receive the tile transform (3D Tiles specification).
pub fn envelope(volume: &Value, t: &Transform) -> Result<Option<[f64; 4]>, String> {
    if crate::s2::present(volume) { return crate::s2::envelope(volume).map(Some); }
    if let Some(r) = volume.get("region") {
        let r = numbers(r, 6)?;
        if r[1] > r[3] || r[4] > r[5] {
            return Err("Invalid region".into());
        }
        return Ok(Some([
            r[0].to_degrees(),
            r[1].to_degrees(),
            r[2].to_degrees(),
            r[3].to_degrees(),
        ]));
    }
    let (center, radius) = if let Some(v) = volume.get("box") {
        let b = numbers(v, 12)?;
        let center = point(t, [b[0], b[1], b[2]]);
        let axes = [
            vector(t, [b[3], b[4], b[5]]),
            vector(t, [b[6], b[7], b[8]]),
            vector(t, [b[9], b[10], b[11]]),
        ];
        let mut radius: f64 = 0.;
        for x in [-1., 1.] {
            for y in [-1., 1.] {
                for z in [-1., 1.] {
                    radius = radius.max(norm(std::array::from_fn(|i| {
                        axes[0][i] * x + axes[1][i] * y + axes[2][i] * z
                    })));
                }
            }
        }
        (center, radius)
    } else if let Some(v) = volume.get("sphere") {
        let s = numbers(v, 4)?;
        if s[3] < 0. {
            return Err("Negative bounding sphere radius".into());
        }
        let row = (0..3)
            .map(|r| (0..3).map(|c| t[c * 4 + r].abs()).sum::<f64>())
            .fold(0., f64::max);
        let col = (0..3)
            .map(|c| (0..3).map(|r| t[c * 4 + r].abs()).sum::<f64>())
            .fold(0., f64::max);
        (point(t, [s[0], s[1], s[2]]), s[3] * (row * col).sqrt())
    } else {
        return Ok(None);
    };
    let distance = norm(center);
    // At or near the ellipsoid centre geographic coordinates are undefined.
    // Retaining the tile is safer than dropping possible content.
    if distance - radius < 1_000_000. {
        return Ok(None);
    }
    let ll = lonlat(center);
    // The geodetic latitude derivative is bounded by the sphere radius reduced
    // by twice the WGS84 axis difference; longitude uses the exact spherical cap.
    let delta = (radius / (distance - radius - 43_000.))
        .min(1.)
        .asin()
        .to_degrees();
    let south = (ll[1] - delta).max(-90.);
    let north = (ll[1] + delta).min(90.);
    let cap = (radius / distance).min(1.).asin();
    let lat_gc = center[2].atan2(center[0].hypot(center[1]));
    if lat_gc.abs() + cap >= std::f64::consts::FRAC_PI_2 {
        return Ok(Some([-180., south, 180., north]));
    }
    let dl = (cap.sin() / lat_gc.cos())
        .clamp(-1., 1.)
        .asin()
        .abs()
        .to_degrees();
    let wrap = |x: f64| (x + 180.).rem_euclid(360.) - 180.;
    Ok(Some([wrap(ll[0] - dl), south, wrap(ll[0] + dl), north]))
}

fn segments(b: [f64; 4]) -> Vec<(f64, f64)> {
    if b[0] > b[2] {
        vec![(b[0], 180.), (-180., b[2])]
    } else {
        vec![(b[0], b[2])]
    }
}
pub fn intersects(a: [f64; 4], b: [f64; 4]) -> bool {
    a[1] <= b[3]
        && a[3] >= b[1]
        && segments(a)
            .iter()
            .any(|x| segments(b).iter().any(|y| x.0 <= y.1 && x.1 >= y.0))
}
pub fn validate_bounds(b: [f64; 4]) -> Result<(), String> {
    if b.iter().any(|x| !x.is_finite())
        || b[0].abs() > 180.
        || b[2].abs() > 180.
        || b[1] < -90.
        || b[3] > 90.
        || b[1] >= b[3]
        || b[0] == b[2]
    {
        Err(
            "Bounds must be a nonempty WGS84 rectangle; west > east denotes the antimeridian"
                .into(),
        )
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn region_ignores_transform_and_crosses_dateline() {
        let mut t = IDENTITY;
        t[12] = 9e8;
        let v = json!({"region":[170f64.to_radians(),-0.1,-170f64.to_radians(),0.1,0,100]});
        let b = envelope(&v, &t).unwrap().unwrap();
        assert!(intersects(b, [175., -1., 179., 1.]));
        assert!(intersects(b, [-179., -1., -175., 1.]));
        assert!(!intersects(b, [0., -1., 1., 1.]));
    }
    #[test]
    fn box_and_sphere_inherit_transform() {
        let mut t = IDENTITY;
        t[12] = 6378137.;
        for v in [
            json!({"sphere":[0,0,0,100]}),
            json!({"box":[0,0,0,100,0,0,0,100,0,0,0,100]}),
        ] {
            let b = envelope(&v, &t).unwrap().unwrap();
            assert!(intersects(b, [-0.1, -0.1, 0.1, 0.1]));
            assert!(!intersects(b, [90., -1., 91., 1.]));
        }
    }
    #[test]
    fn polygon_hole_filters_transformed_box_and_sphere_conservatively() {
        let boundary = BoundaryGeometry {
            polygons: vec![vec![
                vec![[-2., -2.], [2., -2.], [2., 2.], [-2., 2.], [-2., -2.]],
                vec![[-1., -1.], [1., -1.], [1., 1.], [-1., 1.], [-1., -1.]],
            ]],
        };
        let area = AreaOfInterest::new(None, Some(&boundary)).unwrap();
        let mut transform = IDENTITY;
        transform[12] = 6_378_137.;
        for volume in [
            json!({"sphere":[0,0,0,100]}),
            json!({"box":[0,0,0,100,0,0,0,100,0,0,0,100]}),
        ] {
            assert!(!area.intersects_volume(&volume, &transform).unwrap());
            assert!(
                area.intersects_volume(&volume, &IDENTITY).unwrap(),
                "Unknown earth-centre position must remain"
            );
        }
        // A box crossing the hole rim remains whole; this is tile selection,
        // not an assertion that model geometry has been cut at the boundary.
        assert!(area
            .intersects_volume(&json!({"sphere":[0,0,0,150000]}), &transform)
            .unwrap());
    }

    #[test]
    fn split_dateline_aoi_matches_wrapped_region_and_rejects_middle() {
        let boundary = BoundaryGeometry {
            polygons: vec![
                vec![vec![
                    [175., -2.],
                    [179., -2.],
                    [179., 2.],
                    [175., 2.],
                    [175., -2.],
                ]],
                vec![vec![
                    [-179., -2.],
                    [-175., -2.],
                    [-175., 2.],
                    [-179., 2.],
                    [-179., -2.],
                ]],
            ],
        };
        let area = AreaOfInterest::new(None, Some(&boundary)).unwrap();
        assert!(area
            .intersects_volume(
                &json!({"region":[170f64.to_radians(),-0.1,-170f64.to_radians(),0.1,0,100]}),
                &IDENTITY
            )
            .unwrap());
        assert!(!area
            .intersects_volume(&json!({"region":[-0.1,-0.1,0.1,0.1,0,100]}), &IDENTITY)
            .unwrap());
    }
}

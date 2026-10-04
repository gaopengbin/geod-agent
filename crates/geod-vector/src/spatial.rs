//! Select complete intersecting geometries; this deliberately does not cut them.
use crate::{Error, Request, Result};
use geo::{
    BoundingRect, Coord, Geometry, GeometryCollection, Intersects, LineString, MultiLineString,
    MultiPoint, MultiPolygon, Point, Polygon, Rect, Validation,
};
use geod_core::boundary::BoundaryGeometry;
use serde_json::Value;

pub(crate) struct Area(Vec<(Rect<f64>, Polygon<f64>)>);
impl Area {
    pub(crate) fn for_request(request: &Request) -> Result<Self> {
        match &request.boundary {
            Some(boundary) => Self::new(boundary),
            None => {
                let [west, south, east, north] = request.bounds;
                let bounds = Rect::new((west, south), (east, north));
                Ok(Self(vec![(bounds, bounds.to_polygon())]))
            }
        }
    }
    pub(crate) fn new(boundary: &BoundaryGeometry) -> Result<Self> {
        let mut boundary = boundary.clone();
        boundary
            .normalize()
            .map_err(|e| Error::InvalidPlan(e.0.into()))?;
        let polygons = boundary
            .polygons
            .iter()
            .map(|rings| {
                let ring = |r: &Vec<[f64; 2]>| {
                    LineString::from(r.iter().map(|p| (p[0], p[1])).collect::<Vec<_>>())
                };
                let polygon = Polygon::new(ring(&rings[0]), rings[1..].iter().map(ring).collect());
                polygon
                    .check_validation()
                    .map_err(|e| Error::InvalidPlan(format!("Invalid vector boundary: {e}")))?;
                Ok((
                    polygon
                        .bounding_rect()
                        .ok_or_else(|| Error::InvalidPlan("Empty boundary".into()))?,
                    polygon,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Self(polygons))
    }
    fn intersects(&self, geometry: &Geometry<f64>) -> bool {
        let Some(bounds) = geometry.bounding_rect() else {
            return false;
        };
        self.0
            .iter()
            .any(|(envelope, polygon)| envelope.intersects(&bounds) && polygon.intersects(geometry))
    }
    pub(crate) fn feature(&self, feature: &Value) -> Result<bool> {
        Ok(self.intersects(&geometry(&feature["geometry"])?))
    }
    fn tile(&self, z: u8, x: u32, y: u32) -> bool {
        let n = (1u32 << z) as f64;
        let lon = |v: u32| v as f64 / n * 360. - 180.;
        let lat = |v: u32| {
            (std::f64::consts::PI * (1. - 2. * v as f64 / n))
                .sinh()
                .atan()
                .to_degrees()
        };
        self.intersects(&Geometry::Rect(Rect::new(
            (lon(x), lat(y + 1)),
            (lon(x + 1), lat(y)),
        )))
    }
}
pub(crate) fn tiles(request: &Request) -> Result<Vec<(u8, u32, u32)>> {
    let area = request.boundary.as_ref().map(Area::new).transpose()?;
    let mut tiles = Vec::new();
    let mut candidates = 0u64;
    for &z in &request.zoom_levels {
        let grid = geod_core::tile::grid(request.bounds, z, 256)
            .map_err(|e| Error::InvalidPlan(e.into()))?;
        candidates = candidates.saturating_add(grid.tile_count);
        if candidates > 1_000_000 {
            return Err(Error::InvalidPlan(
                "Vector extent exceeds one million candidate tiles; split the area or levels"
                    .into(),
            ));
        }
        for y in grid.y_min..=grid.y_max {
            for x in grid.x_min..=grid.x_max {
                if area.as_ref().is_none_or(|area| area.tile(z, x, y)) {
                    tiles.push((z, x, y));
                }
            }
        }
    }
    Ok(tiles)
}
fn array(v: &Value) -> Result<&Vec<Value>> {
    v.as_array()
        .ok_or_else(|| Error::InvalidData("Invalid geometry coordinates".into()))
}
fn coord(v: &Value) -> Result<Coord<f64>> {
    let a = array(v)?;
    let number = |i| {
        a.get(i)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .ok_or_else(|| Error::InvalidData("Invalid geometry position".into()))
    };
    Ok(Coord {
        x: number(0)?,
        y: number(1)?,
    })
}
fn line(v: &Value) -> Result<LineString<f64>> {
    Ok(LineString(
        array(v)?.iter().map(coord).collect::<Result<Vec<_>>>()?,
    ))
}
fn polygon(v: &Value) -> Result<Polygon<f64>> {
    let rings = array(v)?;
    if rings.is_empty() {
        return Err(Error::InvalidData("Polygon has no rings".into()));
    }
    Ok(Polygon::new(
        line(&rings[0])?,
        rings[1..].iter().map(line).collect::<Result<_>>()?,
    ))
}
fn geometry(v: &Value) -> Result<Geometry<f64>> {
    let c = &v["coordinates"];
    Ok(match v["type"].as_str() {
        Some("Point") => Point::from(coord(c)?).into(),
        Some("MultiPoint") => MultiPoint(
            array(c)?
                .iter()
                .map(|v| coord(v).map(Point::from))
                .collect::<Result<_>>()?,
        )
        .into(),
        Some("LineString") => line(c)?.into(),
        Some("MultiLineString") => {
            MultiLineString(array(c)?.iter().map(line).collect::<Result<_>>()?).into()
        }
        Some("Polygon") => polygon(c)?.into(),
        Some("MultiPolygon") => {
            MultiPolygon(array(c)?.iter().map(polygon).collect::<Result<_>>()?).into()
        }
        Some("GeometryCollection") => Geometry::GeometryCollection(GeometryCollection(
            array(&v["geometries"])?
                .iter()
                .map(geometry)
                .collect::<Result<_>>()?,
        )),
        _ => {
            return Err(Error::InvalidData(
                "Unsupported geometry type in boundary filter".into(),
            ))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exact_feature_selection_preserves_holes_islands_and_crossings() {
        let boundary = BoundaryGeometry::from_geojson(
            &serde_json::to_vec(&json!({"type":"MultiPolygon","coordinates":[
                [[[0,0],[10,0],[10,10],[0,10],[0,0]],[[4,4],[4,6],[6,6],[6,4],[4,4]]],
                [[[20,0],[22,0],[22,2],[20,2],[20,0]]]
            ]}))
            .unwrap(),
        )
        .unwrap();
        let area = Area::new(&boundary).unwrap();
        let feature = |geometry| json!({"type":"Feature","geometry":geometry,"properties":{}});
        for (point, keep) in [
            ([1, 1], true),
            ([5, 5], false),
            ([15, 1], false),
            ([21, 1], true),
        ] {
            assert_eq!(
                area.feature(&feature(json!({"type":"Point","coordinates":point})))
                    .unwrap(),
                keep
            );
        }
        assert!(area
            .feature(&feature(
                json!({"type":"LineString","coordinates":[[-1,2],[11,2]]})
            ))
            .unwrap());
        assert!(!area
            .feature(&feature(
                json!({"type":"LineString","coordinates":[[4.5,5],[5.5,5]]})
            ))
            .unwrap());
        assert!(area
            .feature(&feature(
                json!({"type":"Polygon","coordinates":[[[-1,-1],[11,-1],[11,11],[-1,11],[-1,-1]]]})
            ))
            .unwrap());
        assert!(!area.feature(&feature(json!({"type":"Polygon","coordinates":[[[4.1,4.1],[5.9,4.1],[5.9,5.9],[4.1,5.9],[4.1,4.1]]]}))).unwrap());
        assert!(!area.feature(&feature(json!({"type":"Polygon","coordinates":[[[-1,-1],[11,-1],[11,11],[-1,11],[-1,-1]],[[-0.5,-0.5],[-0.5,10.5],[10.5,10.5],[10.5,-0.5],[-0.5,-0.5]]]}))).unwrap());
    }
    #[test]
    fn tiles_entirely_inside_a_hole_are_not_requested() {
        let boundary = BoundaryGeometry::from_geojson(
            &serde_json::to_vec(&json!({"type":"Polygon","coordinates":[
                [[-100,-60],[100,-60],[100,60],[-100,60],[-100,-60]],
                [[-80,-50],[-80,50],[10,50],[10,-50],[-80,-50]]
            ]}))
            .unwrap(),
        );
        // The shared contract rejects a single exterior spanning >=180 degrees.
        assert!(boundary.is_err());
        let boundary = BoundaryGeometry::from_geojson(
            &serde_json::to_vec(&json!({"type":"Polygon","coordinates":[
                [[-100,-60],[70,-60],[70,60],[-100,60],[-100,-60]],
                [[-80,-50],[-80,50],[10,50],[10,-50],[-80,-50]]
            ]}))
            .unwrap(),
        )
        .unwrap();
        let area = Area::new(&boundary).unwrap();
        assert!(!area.tile(3, 3, 3));
        assert!(area.tile(3, 4, 3));
    }
}

//! Overpass JSON to geographic features. Relations are assembled from member
//! geometry, preserving multipolygon holes and incomplete-geometry warnings.
use crate::{Error, OsmTag, Result};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub fn query(bounds: [f64; 4], tags: &[OsmTag]) -> Result<String> {
    query_boundary(bounds, tags, None)
}
pub fn query_boundary(
    bounds: [f64; 4],
    tags: &[OsmTag],
    boundary: Option<&geod_core::boundary::BoundaryGeometry>,
) -> Result<String> {
    if let Some(boundary) = boundary {
        boundary
            .clone()
            .normalize()
            .map_err(|e| Error::InvalidPlan(e.0.into()))?;
    }
    let mut selectors = Vec::new();
    if tags.is_empty() {
        selectors.push(String::new());
    }
    for tag in tags {
        if tag.key.is_empty()
            || tag.key.len() > 128
            || tag.value.as_ref().is_some_and(|v| v.len() > 256)
        {
            return Err(Error::InvalidPlan("Invalid OSM tag selector".into()));
        }
        let key = serde_json::to_string(&tag.key)?;
        selectors.push(match &tag.value {
            Some(value) => format!("[{key}={}]", serde_json::to_string(value)?),
            None => format!("[{key}]"),
        });
    }
    let areas = match boundary {
        Some(boundary) => boundary
            .polygons
            .iter()
            .map(|rings| {
                let positions = rings[0]
                    .iter()
                    .map(|p| format!("{} {}", p[1], p[0]))
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("poly:\"{positions}\"")
            })
            .collect::<Vec<_>>(),
        None => vec![format!(
            "{},{},{},{}",
            bounds[1], bounds[0], bounds[3], bounds[2]
        )],
    };
    Ok(format!(
        "[out:json][timeout:90];({});out body geom;",
        selectors
            .iter()
            .flat_map(|s| areas.iter().map(move |area| format!("nwr{s}({area});")))
            .collect::<String>()
    ))
}

pub struct OsmFeatures {
    pub features: Vec<Value>,
    pub warnings: Vec<String>,
    pub timestamp: Option<String>,
}
pub fn decode(bytes: &[u8]) -> Result<OsmFeatures> {
    let value: Value = serde_json::from_slice(bytes)?;
    if let Some(remark) = value.get("remark").and_then(Value::as_str) {
        return Err(Error::InvalidData(format!(
            "Overpass returned an incomplete response: {}",
            remark.chars().take(400).collect::<String>()
        )));
    }
    let elements = value["elements"]
        .as_array()
        .ok_or_else(|| Error::InvalidData("Overpass response has no elements array".into()))?;
    if elements.len() > 1_000_000 {
        return Err(Error::InvalidData(
            "Overpass result exceeds one million elements".into(),
        ));
    }
    let mut features = Vec::new();
    let mut warnings = Vec::new();
    let mut seen = BTreeMap::new();
    for element in elements {
        let kind = element["type"].as_str().unwrap_or("");
        let id = element["id"]
            .as_i64()
            .ok_or_else(|| Error::InvalidData("OSM element has no ID".into()))?;
        if seen.insert((kind, id), ()).is_some() {
            continue;
        }
        let tags = element["tags"].as_object().cloned().unwrap_or_default();
        let geometry = match kind {
            "node" => Some(json!({"type":"Point","coordinates":point(element)?})),
            "way" => {
                let points = points(&element["geometry"])?;
                if points.len() < 2 {
                    warnings.push(format!("way/{id}: fewer than two positions; omitted"));
                    continue;
                }
                let closed = points.first() == points.last() && points.len() >= 4;
                let area = tags.get("area").and_then(Value::as_str);
                let area_key = [
                    "building",
                    "building:part",
                    "landuse",
                    "amenity",
                    "leisure",
                    "shop",
                    "tourism",
                    "area:highway",
                    "boundary",
                ]
                .iter()
                .any(|k| tags.contains_key(*k))
                    || tags
                        .get("natural")
                        .and_then(Value::as_str)
                        .is_some_and(|v| {
                            !matches!(v, "coastline" | "cliff" | "ridge" | "arete" | "tree_row")
                        })
                    || tags.get("waterway") == Some(&json!("riverbank"));
                if closed && (area == Some("yes") || area != Some("no") && area_key) {
                    Some(json!({"type":"Polygon","coordinates":[orient(points,true)]}))
                } else {
                    Some(json!({"type":"LineString","coordinates":points}))
                }
            }
            "relation" => {
                let relation_type = tags.get("type").and_then(Value::as_str).unwrap_or("");
                if matches!(relation_type, "multipolygon" | "boundary") {
                    match multipolygon(element) {
                        Ok(g) => Some(g),
                        Err(e) => {
                            warnings.push(format!("relation/{id}: {e}; omitted"));
                            None
                        }
                    }
                } else {
                    let lines = element["members"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|m| m.get("geometry"))
                        .map(points)
                        .collect::<Result<Vec<_>>>()?
                        .into_iter()
                        .filter(|p| p.len() >= 2)
                        .collect::<Vec<_>>();
                    if lines.is_empty() {
                        warnings.push(format!(
                            "relation/{id}: no supported member geometry; omitted"
                        ));
                        None
                    } else {
                        Some(json!({"type":"MultiLineString","coordinates":lines}))
                    }
                }
            }
            _ => {
                warnings.push(format!("{kind}/{id}: unsupported element type; omitted"));
                None
            }
        };
        if let Some(geometry) = geometry {
            let mut properties = tags;
            properties.insert("_osmType".into(), json!(kind));
            properties.insert("_osmId".into(), json!(id.to_string()));
            properties.insert("_sourceLayer".into(), json!("osm"));
            features.push(json!({"type":"Feature","id":format!("{kind}/{id}"),"geometry":geometry,"properties":properties}));
        }
    }
    Ok(OsmFeatures {
        features,
        warnings,
        timestamp: value["osm3s"]["timestamp_osm_base"]
            .as_str()
            .map(str::to_owned),
    })
}
fn point(value: &Value) -> Result<[f64; 2]> {
    let x = value["lon"].as_f64().unwrap_or(f64::NAN);
    let y = value["lat"].as_f64().unwrap_or(f64::NAN);
    if !x.is_finite()
        || !y.is_finite()
        || !(-180.0..=180.0).contains(&x)
        || !(-90.0..=90.0).contains(&y)
    {
        return Err(Error::InvalidData(
            "OSM element contains a missing or invalid position".into(),
        ));
    }
    Ok([x, y])
}
fn points(value: &Value) -> Result<Vec<[f64; 2]>> {
    value
        .as_array()
        .ok_or_else(|| Error::InvalidData("OSM geometry is missing".into()))?
        .iter()
        .map(point)
        .collect()
}
fn area(ring: &[[f64; 2]]) -> f64 {
    ring.windows(2)
        .map(|p| p[0][0] * p[1][1] - p[1][0] * p[0][1])
        .sum()
}
fn orient(mut ring: Vec<[f64; 2]>, outer: bool) -> Vec<[f64; 2]> {
    if (area(&ring) > 0.0) != outer {
        ring.reverse();
    }
    ring
}
fn join(mut parts: Vec<Vec<[f64; 2]>>) -> Result<Vec<Vec<[f64; 2]>>> {
    let mut rings = Vec::new();
    while let Some(mut ring) = parts.pop() {
        if ring.len() < 2 {
            return Err(Error::InvalidData("Incomplete relation member".into()));
        }
        while ring.first() != ring.last() {
            let end = ring.last().copied().unwrap();
            let Some(index) = parts
                .iter()
                .position(|p| p.first() == Some(&end) || p.last() == Some(&end))
            else {
                return Err(Error::InvalidData(
                    "Relation rings are incomplete in this response".into(),
                ));
            };
            let mut next = parts.swap_remove(index);
            if next.first() != Some(&end) {
                next.reverse();
            }
            ring.extend_from_slice(&next[1..]);
        }
        if ring.len() < 4 || area(&ring).abs() < 1e-15 {
            return Err(Error::InvalidData("Relation ring has zero area".into()));
        }
        rings.push(ring);
    }
    Ok(rings)
}
fn contains(ring: &[[f64; 2]], p: [f64; 2]) -> bool {
    let mut inside = false;
    for e in ring.windows(2) {
        if (e[0][1] > p[1]) != (e[1][1] > p[1])
            && p[0] < (e[1][0] - e[0][0]) * (p[1] - e[0][1]) / (e[1][1] - e[0][1]) + e[0][0]
        {
            inside = !inside;
        }
    }
    inside
}
fn multipolygon(element: &Value) -> Result<Value> {
    let members = element["members"]
        .as_array()
        .ok_or_else(|| Error::InvalidData("Relation has no members".into()))?;
    let mut outers = Vec::new();
    let mut inners = Vec::new();
    for member in members {
        if member["type"] == "relation"
            && matches!(member["role"].as_str(), Some("outer" | "inner" | ""))
        {
            return Err(Error::InvalidData(
                "Nested relation geometry is not included in the response".into(),
            ));
        }
        if member["type"] != "way" {
            continue;
        }
        let role = member["role"].as_str().unwrap_or("");
        if !matches!(role, "" | "outer" | "inner") {
            continue;
        }
        let p = points(&member["geometry"])?;
        if role == "inner" {
            inners.push(p)
        } else {
            outers.push(p)
        }
    }
    let mut polygons: Vec<Vec<Vec<[f64; 2]>>> = join(outers)?
        .into_iter()
        .map(|r| vec![orient(r, true)])
        .collect();
    if polygons.is_empty() {
        return Err(Error::InvalidData("Relation has no outer rings".into()));
    }
    for ring in join(inners)? {
        let index = polygons
            .iter()
            .enumerate()
            .filter(|(_, p)| contains(&p[0], ring[0]))
            .min_by(|(_, a), (_, b)| area(&a[0]).abs().total_cmp(&area(&b[0]).abs()))
            .map(|(i, _)| i)
            .ok_or_else(|| Error::InvalidData("Relation hole has no containing exterior".into()))?;
        polygons[index].push(orient(ring, false));
    }
    Ok(if polygons.len() == 1 {
        json!({"type":"Polygon","coordinates":polygons[0]})
    } else {
        json!({"type":"MultiPolygon","coordinates":polygons})
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserve_osm_types_and_multipolygon_hole() {
        let data = json!({"elements":[{"type":"node","id":1,"lon":10,"lat":20,"tags":{"name":"A"}},{"type":"way","id":2,"tags":{"building":"yes"},"geometry":[{"lon":0,"lat":0},{"lon":4,"lat":0},{"lon":4,"lat":4},{"lon":0,"lat":0}]},{"type":"relation","id":3,"tags":{"type":"multipolygon"},"members":[{"type":"way","role":"outer","geometry":[{"lon":0,"lat":0},{"lon":4,"lat":0},{"lon":4,"lat":4}]},{"type":"way","role":"outer","geometry":[{"lon":0,"lat":0},{"lon":0,"lat":4},{"lon":4,"lat":4}]},{"type":"way","role":"inner","geometry":[{"lon":1,"lat":1},{"lon":2,"lat":1},{"lon":2,"lat":2},{"lon":1,"lat":1}]}]}]});
        let result = decode(&serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(result.warnings.is_empty());
        assert_eq!(result.features.len(), 3);
        assert_eq!(result.features[1]["geometry"]["type"], "Polygon");
        assert_eq!(
            result.features[2]["geometry"]["coordinates"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn reject_partial_overpass_response() {
        assert!(decode(br#"{"remark":"runtime error: timed out","elements":[]}"#).is_err());
    }
}

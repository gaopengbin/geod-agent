//! MVT 1/2 protobuf and command stream decoding. Field numbers follow the
//! public Mapbox vector-tile 2.1 schema; no generated build-time dependency.
use crate::{Error, Result};
use flate2::read::GzDecoder;
use prost::Message;
use serde_json::{json, Map, Value};
use std::io::Read;

#[derive(Clone, PartialEq, Message)]
pub struct Tile {
    #[prost(message, repeated, tag = "3")]
    pub layers: Vec<Layer>,
}
#[derive(Clone, PartialEq, Message)]
pub struct Layer {
    #[prost(string, required, tag = "1")]
    pub name: String,
    #[prost(message, repeated, tag = "2")]
    pub features: Vec<Feature>,
    #[prost(string, repeated, tag = "3")]
    pub keys: Vec<String>,
    #[prost(message, repeated, tag = "4")]
    pub values: Vec<TileValue>,
    #[prost(uint32, optional, tag = "5", default = "4096")]
    pub extent: Option<u32>,
    #[prost(uint32, required, tag = "15")]
    pub version: u32,
}
#[derive(Clone, PartialEq, Message)]
pub struct Feature {
    #[prost(uint64, optional, tag = "1")]
    pub id: Option<u64>,
    #[prost(uint32, repeated, packed = "true", tag = "2")]
    pub tags: Vec<u32>,
    #[prost(uint32, optional, tag = "3")]
    pub kind: Option<u32>,
    #[prost(uint32, repeated, packed = "true", tag = "4")]
    pub geometry: Vec<u32>,
}
#[derive(Clone, PartialEq, Message)]
pub struct TileValue {
    #[prost(string, optional, tag = "1")]
    pub string_value: Option<String>,
    #[prost(float, optional, tag = "2")]
    pub float_value: Option<f32>,
    #[prost(double, optional, tag = "3")]
    pub double_value: Option<f64>,
    #[prost(int64, optional, tag = "4")]
    pub int_value: Option<i64>,
    #[prost(uint64, optional, tag = "5")]
    pub uint_value: Option<u64>,
    #[prost(sint64, optional, tag = "6")]
    pub sint_value: Option<i64>,
    #[prost(bool, optional, tag = "7")]
    pub bool_value: Option<bool>,
}

pub fn inflate(bytes: &[u8]) -> Result<Vec<u8>> {
    const LIMIT: usize = 64 * 1024 * 1024;
    let data = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut data = Vec::new();
        GzDecoder::new(bytes)
            .take((LIMIT + 1) as u64)
            .read_to_end(&mut data)?;
        data
    } else {
        bytes.to_vec()
    };
    if data.len() > LIMIT {
        return Err(Error::InvalidData("Decoded MVT exceeds 64 MiB".into()));
    }
    Ok(data)
}

pub fn decode(bytes: &[u8], z: u8, x: u32, y: u32, layers: &[String]) -> Result<Vec<Value>> {
    if z > 22 || x >= (1 << z) || y >= (1 << z) {
        return Err(Error::InvalidData(
            "MVT tile address is outside its zoom level".into(),
        ));
    }
    let tile = Tile::decode(inflate(bytes)?.as_slice())
        .map_err(|e| Error::InvalidData(format!("Invalid MVT protobuf: {e}")))?;
    let mut features = Vec::new();
    for layer in tile.layers {
        if !matches!(layer.version, 1 | 2)
            || layer.name.is_empty()
            || layer.extent.unwrap_or(4096) == 0
        {
            return Err(Error::InvalidData(
                "MVT layer version, name or extent is invalid".into(),
            ));
        }
        if !layers.is_empty() && !layers.contains(&layer.name) {
            continue;
        }
        for (index, feature) in layer.features.iter().enumerate() {
            let Some(geometry) = geometry(feature, z, x, y, layer.extent.unwrap_or(4096))? else {
                continue;
            };
            if feature.tags.len() % 2 != 0 {
                return Err(Error::InvalidData("MVT feature has unpaired tags".into()));
            }
            let mut properties = Map::new();
            for pair in feature.tags.chunks_exact(2) {
                let key = layer
                    .keys
                    .get(pair[0] as usize)
                    .ok_or_else(|| Error::InvalidData("MVT key index out of range".into()))?;
                let value = layer
                    .values
                    .get(pair[1] as usize)
                    .ok_or_else(|| Error::InvalidData("MVT value index out of range".into()))?;
                properties.insert(key.clone(), value_json(value)?);
            }
            properties.insert("_sourceLayer".into(), json!(layer.name));
            properties.insert("_tile".into(), json!(format!("{z}/{x}/{y}")));
            if let Some(id) = feature.id {
                properties.insert("_sourceId".into(), json!(id.to_string()));
            }
            features.push(json!({"type":"Feature", "id":format!("{z}/{x}/{y}/{}/{}",layer.name,feature.id.map(|i|i.to_string()).unwrap_or_else(||format!("i{index}"))), "geometry":geometry,"properties":properties}));
        }
    }
    Ok(features)
}

fn value_json(value: &TileValue) -> Result<Value> {
    let count = value.string_value.is_some() as u8
        + value.float_value.is_some() as u8
        + value.double_value.is_some() as u8
        + value.int_value.is_some() as u8
        + value.uint_value.is_some() as u8
        + value.sint_value.is_some() as u8
        + value.bool_value.is_some() as u8;
    if count != 1 {
        return Err(Error::InvalidData(
            "MVT value must contain one scalar".into(),
        ));
    }
    if let Some(v) = &value.string_value {
        return Ok(json!(v));
    }
    if let Some(v) = value.float_value {
        if !v.is_finite() {
            return Err(Error::InvalidData("Non-finite MVT value".into()));
        }
        return Ok(json!(v));
    }
    if let Some(v) = value.double_value {
        if !v.is_finite() {
            return Err(Error::InvalidData("Non-finite MVT value".into()));
        }
        return Ok(json!(v));
    }
    if let Some(v) = value.int_value {
        return Ok(json!(v));
    }
    if let Some(v) = value.uint_value {
        return Ok(json!(v));
    }
    if let Some(v) = value.sint_value {
        return Ok(json!(v));
    }
    Ok(json!(value.bool_value.unwrap()))
}

fn geometry(
    feature: &Feature,
    z: u8,
    tile_x: u32,
    tile_y: u32,
    extent: u32,
) -> Result<Option<Value>> {
    let kind = feature.kind.unwrap_or(0);
    if kind == 0 {
        return Ok(None);
    }
    if kind > 3 {
        return Err(Error::InvalidData("Unknown MVT geometry type".into()));
    }
    let commands = &feature.geometry;
    if commands.len() > 4_000_000 {
        return Err(Error::InvalidData(
            "MVT geometry exceeds vertex limit".into(),
        ));
    }
    let mut offset = 0;
    let mut position = [0i64; 2];
    let mut paths: Vec<Vec<[i64; 2]>> = Vec::new();
    while offset < commands.len() {
        let command = commands[offset];
        offset += 1;
        let id = command & 7;
        let count = (command >> 3) as usize;
        if count == 0 {
            return Err(Error::InvalidData("MVT command count is zero".into()));
        }
        match id {
            1 | 2 => {
                if count > (commands.len() - offset) / 2
                    || (id == 2 && (paths.is_empty() || kind == 1))
                    || (id == 1 && kind != 1 && count != 1)
                {
                    return Err(Error::InvalidData("Invalid MVT move/line command".into()));
                }
                for _ in 0..count {
                    for axis in 0..2 {
                        let value = commands[offset];
                        offset += 1;
                        let delta = ((value >> 1) as i64) ^ -((value & 1) as i64);
                        position[axis] = position[axis]
                            .checked_add(delta)
                            .ok_or_else(|| Error::InvalidData("MVT coordinate overflow".into()))?;
                        if position[axis].abs() > i32::MAX as i64 {
                            return Err(Error::InvalidData(
                                "MVT coordinate exceeds supported range".into(),
                            ));
                        }
                    }
                    if id == 1 {
                        paths.push(vec![position]);
                    } else {
                        paths.last_mut().unwrap().push(position);
                    }
                }
            }
            7 if kind == 3 && count == 1 && !paths.is_empty() => {
                let ring = paths.last_mut().unwrap();
                if ring.len() < 3 || ring.first() == ring.last() {
                    return Err(Error::InvalidData(
                        "Invalid MVT polygon close command".into(),
                    ));
                }
                ring.push(ring[0]);
            }
            _ => {
                return Err(Error::InvalidData(
                    "Unsupported or misplaced MVT geometry command".into(),
                ))
            }
        }
    }
    if paths.is_empty() {
        return Ok(None);
    }
    let convert = |p: &[i64; 2]| -> [f64; 2] {
        let n = (1u32 << z) as f64;
        let x = (tile_x as f64 + p[0] as f64 / extent as f64) / n;
        let y = (tile_y as f64 + p[1] as f64 / extent as f64) / n;
        [
            x * 360.0 - 180.0,
            (std::f64::consts::PI * (1.0 - 2.0 * y))
                .sinh()
                .atan()
                .to_degrees(),
        ]
    };
    Ok(Some(match kind {
        1 => {
            let points: Vec<_> = paths.iter().map(|p| convert(&p[0])).collect();
            if points.len() == 1 {
                json!({"type":"Point","coordinates":points[0]})
            } else {
                json!({"type":"MultiPoint","coordinates":points})
            }
        }
        2 => {
            if paths.iter().any(|p| p.len() < 2) {
                return Err(Error::InvalidData("MVT line needs two positions".into()));
            }
            let lines: Vec<Vec<_>> = paths
                .iter()
                .map(|p| p.iter().map(convert).collect())
                .collect();
            if lines.len() == 1 {
                json!({"type":"LineString","coordinates":lines[0]})
            } else {
                json!({"type":"MultiLineString","coordinates":lines})
            }
        }
        3 => {
            let mut polygons: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
            for ring in paths {
                if ring.len() < 4 || ring.first() != ring.last() {
                    return Err(Error::InvalidData("MVT polygon is not closed".into()));
                }
                let signed: i128 = ring
                    .windows(2)
                    .map(|p| p[0][0] as i128 * p[1][1] as i128 - p[1][0] as i128 * p[0][1] as i128)
                    .sum();
                if signed == 0 {
                    continue;
                }
                // MVT screen Y points down. Positive winding denotes an exterior.
                let mut converted: Vec<_> = ring.iter().map(convert).collect();
                converted.reverse(); // RFC 7946 exterior CCW / holes clockwise.
                if signed > 0 {
                    polygons.push(vec![converted]);
                } else if let Some(polygon) = polygons.last_mut() {
                    polygon.push(converted);
                } else {
                    return Err(Error::InvalidData(
                        "MVT interior ring precedes exterior".into(),
                    ));
                }
            }
            if polygons.is_empty() {
                return Ok(None);
            }
            if polygons.len() == 1 {
                json!({"type":"Polygon","coordinates":polygons[0]})
            } else {
                json!({"type":"MultiPolygon","coordinates":polygons})
            }
        }
        _ => unreachable!(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decode_points_lines_polygons_holes_and_reject_bad_tags() {
        let polygon = Feature {
            id: Some(42),
            tags: vec![0, 0],
            kind: Some(3),
            geometry: vec![
                9, 0, 0, 26, 8192, 0, 0, 8192, 8191, 0, 15, 9, 2048, 6143, 26, 0, 4096, 4096, 0, 0,
                4095, 15,
            ],
        };
        let mut tile = Tile {
            layers: vec![Layer {
                name: "land".into(),
                features: vec![polygon],
                keys: vec!["name".into()],
                values: vec![TileValue {
                    string_value: Some("park".into()),
                    ..Default::default()
                }],
                extent: Some(4096),
                version: 2,
            }],
        };
        let out = decode(&tile.encode_to_vec(), 1, 1, 0, &[]).unwrap();
        assert_eq!(out[0]["geometry"]["type"], "Polygon");
        assert_eq!(
            out[0]["geometry"]["coordinates"].as_array().unwrap().len(),
            2
        );
        assert_eq!(out[0]["properties"]["name"], "park");
        assert!(decode(&tile.encode_to_vec(), 1, 1, 0, &["roads".into()])
            .unwrap()
            .is_empty());
        tile.layers[0].features[0].tags.push(0);
        assert!(decode(&tile.encode_to_vec(), 1, 1, 0, &[]).is_err());
    }
}

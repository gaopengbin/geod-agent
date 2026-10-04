//! S2 token addressing and conservative geographic envelopes, per
//! 3DTILES_bounding_volume_S2. No tile transform is applied to an S2 volume.
use serde_json::Value;

const ORDER: [[u32; 4]; 4] = [[0, 1, 3, 2], [0, 2, 3, 1], [3, 2, 0, 1], [3, 1, 0, 2]];
const TURN: [usize; 4] = [1, 0, 0, 3];

#[derive(Clone, Copy)]
struct Cell { id: u64, face: u32, level: u32, i: u32, j: u32 }
impl Cell {
    fn parse(token: &str) -> Result<Self, String> {
        if token.is_empty() || token.len() > 16 || !token.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid S2 token".into());
        }
        let id = u64::from_str_radix(token, 16).map_err(|_| "Invalid S2 token")? << (4 * (16 - token.len()));
        let trailing = id.trailing_zeros();
        if id == 0 || id >> 61 > 5 || trailing > 60 || trailing % 2 != 0 { return Err("Invalid S2 cell ID".into()); }
        let face = (id >> 61) as u32; let level = 30 - trailing / 2;
        let (mut i, mut j, mut orientation) = (0, 0, (face & 1) as usize);
        for bit in 0..level {
            let position = ((id >> (59 - 2 * bit)) & 3) as usize;
            let ij = ORDER[orientation][position]; i = i * 2 + (ij >> 1); j = j * 2 + (ij & 1);
            orientation ^= TURN[position];
        }
        Ok(Self { id, face, level, i, j })
    }
    fn encode(face: u32, level: u32, i: u32, j: u32) -> Self {
        let (mut id, mut orientation) = ((face as u64) << 61, (face & 1) as usize);
        for bit in 0..level {
            let shift = level - bit - 1;
            let ij = (((i >> shift) & 1) << 1) | ((j >> shift) & 1);
            let position = ORDER[orientation].iter().position(|v| *v == ij).unwrap();
            id |= (position as u64) << (59 - 2 * bit); orientation ^= TURN[position];
        }
        id |= 1u64 << (2 * (30 - level));
        Self { id, face, level, i, j }
    }
    fn token(self) -> String { format!("{:016x}", self.id).trim_end_matches('0').to_owned() }
}

fn extension(volume: &Value) -> Option<&Value> { volume.pointer("/extensions/3DTILES_bounding_volume_S2") }
pub(crate) fn present(volume: &Value) -> bool { extension(volume).is_some() }
fn parse(volume: &Value) -> Result<(Cell, f64, f64), String> {
    let ext = extension(volume).ok_or("S2 bounding volume missing")?;
    let cell = Cell::parse(ext["token"].as_str().ok_or("S2 token missing")?)?;
    let min = ext["minimumHeight"].as_f64().filter(|v| v.is_finite()).ok_or("Invalid S2 minimum height")?;
    let max = ext["maximumHeight"].as_f64().filter(|v| v.is_finite()).ok_or("Invalid S2 maximum height")?;
    if min > max { return Err("S2 minimum height exceeds maximum height".into()); }
    Ok((cell, min, max))
}
fn uv(s: f64) -> f64 { if s >= 0.5 { (4. * s * s - 1.) / 3. } else { (1. - 4. * (1. - s).powi(2)) / 3. } }
fn xyz(face: u32, u: f64, v: f64) -> [f64; 3] {
    match face { 0 => [1., u, v], 1 => [-u, 1., v], 2 => [-u, -v, 1.], 3 => [-1., -v, -u], 4 => [v, -1., -u], _ => [v, u, -1.] }
}
fn wrap(lon: f64) -> f64 { (lon + 180.).rem_euclid(360.) - 180. }

pub(crate) fn envelope(volume: &Value) -> Result<[f64; 4], String> {
    let (cell, _, _) = parse(volume)?; let n = (1u64 << cell.level) as f64;
    let u = [uv(cell.i as f64 / n), uv((cell.i as f64 + 1.) / n)];
    let v = [uv(cell.j as f64 / n), uv((cell.j as f64 + 1.) / n)];
    let center = xyz(cell.face, (u[0] + u[1]) / 2., (v[0] + v[1]) / 2.);
    let middle = center[1].atan2(center[0]).to_degrees();
    let pole = matches!(cell.face, 2 | 5) && u[0] <= 0. && u[1] >= 0. && v[0] <= 0. && v[1] >= 0.;
    let (mut west, mut east, mut south, mut north) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    // Latitude extrema occur at endpoints or the closest point to a zero
    // face coordinate; corners alone under-bound curved edges near the poles.
    for s in [u[0], u[1], 0f64.clamp(u[0], u[1])] {
        for t in [v[0], v[1], 0f64.clamp(v[0], v[1])] {
            let p = xyz(cell.face, s, t); let lon = middle + wrap(p[1].atan2(p[0]).to_degrees() - middle);
            let lat = p[2].atan2(p[0].hypot(p[1])).to_degrees();
            west = west.min(lon); east = east.max(lon); south = south.min(lat); north = north.max(lat);
        }
    }
    let epsilon = 1e-9;
    Ok([if pole { -180. } else { wrap(west - epsilon) }, (south - epsilon).max(-90.),
        if pole { 180. } else { wrap(east + epsilon) }, (north + epsilon).min(90.)])
}

pub(crate) fn subdivide(volume: &Value, level: u32, x: u32, y: u32, z: Option<u32>) -> Result<Value, String> {
    let (root, min, max) = parse(volume)?;
    if level > 30 || root.level + level > 30 { return Err("Implicit S2 exceeds maximum cell level 30".into()); }
    let count = 1u64 << level;
    if x as u64 >= count || y as u64 >= count || z.is_some_and(|z| z as u64 >= count) { return Err("Implicit S2 coordinates outside level".into()); }
    let cell = Cell::encode(root.face, root.level + level, root.i * count as u32 + x, root.j * count as u32 + y);
    let (bottom, top) = z.map(|z| { let span = (max - min) / count as f64; let bottom = min + span * z as f64; (bottom, bottom + span) }).unwrap_or((min, max));
    let mut result = volume.clone(); let ext = &mut result["extensions"]["3DTILES_bounding_volume_S2"];
    ext["token"] = Value::String(cell.token()); ext["minimumHeight"] = Value::from(bottom); ext["maximumHeight"] = Value::from(top);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn volume(token: &str) -> Value { json!({"extensions":{"3DTILES_bounding_volume_S2":{"token":token,"minimumHeight":-100.,"maximumHeight":900.}}}) }
    #[test]
    fn invalid_tokens_and_height_ranges_are_rejected() {
        for token in ["", "0", "f", "2", "xyz", "12345678901234567"] { assert!(envelope(&volume(token)).is_err(), "{token}"); }
        let mut v = volume("3"); v["extensions"]["3DTILES_bounding_volume_S2"]["minimumHeight"] = json!(1000.); assert!(envelope(&v).is_err());
        assert!(subdivide(&volume("0000000000000001"), 1, 0, 0, None).is_err());
    }
    #[test]
    fn root_faces_dateline_and_poles_are_conservative() {
        let north = envelope(&volume("5")).unwrap(); assert_eq!((north[0], north[2], north[3]), (-180., 180., 90.));
        let south = envelope(&volume("b")).unwrap(); assert_eq!((south[0], south[1], south[2]), (-180., -90., 180.));
        let dateline = envelope(&volume("7")).unwrap(); assert!(dateline[0] > dateline[2]);
        assert!(crate::spatial::intersects(dateline, [179., -1., -179., 1.])); assert!(!crate::spatial::intersects(dateline, [-1., -1., 1., 1.]));
    }
    #[test]
    fn address_roundtrip_all_faces_levels_and_non_root_descendants() {
        for face in 0..6 { for level in 0..=30 { let n = 1u32 << level; for (i,j) in [(0,0),(n-1,n-1),(n/2,n/3)] {
            let cell = Cell::encode(face, level, i, j); let decoded = Cell::parse(&cell.token()).unwrap(); assert_eq!((decoded.face,decoded.level,decoded.i,decoded.j),(face,level,i,j));
        } } }
        let parent = Cell::parse("89c6c7").unwrap(); let child = subdivide(&volume("89c6c7"), 2, 3, 1, Some(2)).unwrap(); let ext = &child["extensions"]["3DTILES_bounding_volume_S2"];
        let decoded = Cell::parse(ext["token"].as_str().unwrap()).unwrap(); assert_eq!((decoded.i,decoded.j),(parent.i*4+3,parent.j*4+1));
        assert_eq!((ext["minimumHeight"].as_f64(),ext["maximumHeight"].as_f64()),(Some(400.),Some(650.)));
    }
    #[test]
    fn published_cesium_reference_points_and_children_match() {
        let reference: Value = serde_json::from_str(include_str!("../tests/data/s2-reference.json")).unwrap();
        for fact in reference["facts"].as_array().unwrap() {
            let token = fact["token"].as_str().unwrap(); let root = volume(token); let cell = Cell::parse(token).unwrap();
            assert_eq!(cell.level as u64, fact["level"].as_u64().unwrap());
            let bounds = envelope(&root).unwrap();
            for point in fact["points"].as_array().unwrap() {
                let lon = point[0].as_f64().unwrap(); let lat = point[1].as_f64().unwrap();
                assert!(crate::spatial::intersects(bounds, [lon,lat,lon,lat]), "{token}: {point} outside {bounds:?}");
            }
            let mut children = vec![];
            if cell.level < 30 { for x in 0..2 { for y in 0..2 { children.push(subdivide(&root, 1, x, y, None).unwrap()["extensions"]["3DTILES_bounding_volume_S2"]["token"].as_str().unwrap().to_owned()); } } }
            let mut expected: Vec<_> = fact["children"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
            children.sort(); expected.sort(); assert_eq!(children, expected, "{token}");
        }
    }
}

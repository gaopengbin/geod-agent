use crate::{
    spatial::{self, Transform},
    Expected, RewriteContext,
};
use serde_json::Value;

fn u32at(b: &[u8], o: usize) -> Result<usize, String> {
    let a: builtin::U32 = b
        .get(o..o + 4)
        .ok_or("Truncated 3D content header")?
        .try_into()
        .unwrap();
    Ok(u32::from_le_bytes(a) as usize)
}
mod builtin {
    pub type U32 = [u8; 4];
}
fn put32(b: &mut [u8], o: usize, n: usize) -> Result<(), String> {
    let n = u32::try_from(n).map_err(|_| "3D content exceeds 32-bit container size")?;
    b[o..o + 4].copy_from_slice(&n.to_le_bytes());
    Ok(())
}
fn json_bytes(v: &Value) -> Result<Vec<u8>, String> {
    serde_json::to_vec(v).map_err(|e| e.to_string())
}

pub fn rewrite(
    bytes: &[u8],
    ctx: &mut RewriteContext<'_>,
    expected: Expected,
) -> Result<(Vec<u8>, String), String> {
    let magic = bytes.get(..4).unwrap_or_default();
    if magic == b"glTF" {
        return Ok((rewrite_glb(bytes, ctx)?, "glb".into()));
    }
    if matches!(magic, b"b3dm" | b"pnts" | b"i3dm" | b"cmpt") {
        return Ok((
            rewrite_container(bytes, ctx)?,
            String::from_utf8_lossy(magic).into_owned(),
        ));
    }
    let first = bytes.iter().copied().find(|c| !c.is_ascii_whitespace());
    if first == Some(b'{') {
        let mut doc: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid 3D Tiles JSON")?;
        if doc.get("root").is_some() && doc.get("asset").is_some() {
            let version = doc
                .pointer("/asset/version")
                .and_then(Value::as_str)
                .ok_or("Tileset asset version missing")?;
            if !matches!(version, "1.0" | "1.1") {
                return Err("Unsupported 3D Tiles asset version".into());
            }
            let mut root = doc.get("root").cloned().unwrap();
            if !tile(&mut root, ctx.current.transform, ctx, 0)? {
                // A coarse parent envelope can intersect the AOI while the
                // external tileset's tighter root does not. Keep a valid empty
                // local tileset instead of failing unrelated selected content.
                for key in ["content", "contents", "children"] {
                    root.as_object_mut()
                        .ok_or("Invalid tile object")?
                        .remove(key);
                }
            }
            doc["root"] = root;
            if let Some(uri) = doc.get("schemaUri").and_then(Value::as_str) {
                let local = ctx.reference(uri, ctx.current.transform, Expected::Resource)?;
                doc["schemaUri"] = Value::String(local);
            }
            return Ok((json_bytes(&doc)?, "tileset".into()));
        }
        if expected == Expected::Root {
            return Err("Source JSON is not a 3D Tiles tileset".into());
        }
        if doc
            .pointer("/asset/version")
            .and_then(Value::as_str)
            .is_some_and(|v| v == "1.0" || v.starts_with("2."))
        {
            gltf_references(&mut doc, ctx)?;
            return Ok((json_bytes(&doc)?, "gltf".into()));
        }
        if expected == Expected::Content {
            return Err("Tile content JSON is neither a tileset nor glTF 1/2".into());
        }
        return Ok((bytes.to_vec(), "json".into()));
    }
    if expected != Expected::Resource {
        return Err("Tile content has an unsupported or invalid magic header".into());
    }
    if bytes.is_empty() {
        return Err("Empty external resource".into());
    }
    Ok((bytes.to_vec(), "resource".into()))
}

fn tile(
    node: &mut Value,
    parent: Transform,
    ctx: &mut RewriteContext<'_>,
    depth: usize,
) -> Result<bool, String> {
    if depth > 128 {
        return Err("Tileset hierarchy exceeds 128 levels".into());
    }
    if node.get("implicitTiling").is_some()
        || node
            .pointer("/extensions/3DTILES_implicit_tiling")
            .is_some()
    {
        return Err("Implicit 3D Tiles require subtree expansion and are not yet supported by this exporter".into());
    }
    let transform = spatial::cumulative(&parent, node.get("transform"))?;
    let volume = node
        .get("boundingVolume")
        .ok_or("Tile is missing its bounding volume")?;
    let inside = ctx.area.intersects_volume(volume, &transform)?;
    let mut children = vec![];
    if let Some(existing) = node.get_mut("children") {
        for mut child in existing
            .as_array_mut()
            .ok_or("Tile children is not an array")?
            .drain(..)
        {
            if tile(&mut child, transform, ctx, depth + 1)? {
                children.push(child);
            }
        }
    }
    if !inside && children.is_empty() {
        return Ok(false);
    }
    if children.is_empty() {
        node.as_object_mut()
            .ok_or("Invalid tile object")?
            .remove("children");
    } else {
        node["children"] = Value::Array(children);
    }
    if inside {
        ctx.selected += 1;
        if let Some(content) = node.get_mut("content") {
            if !content_ref(content, transform, ctx)? {
                node.as_object_mut().unwrap().remove("content");
            }
        }
        if let Some(contents) = node.get_mut("contents") {
            let mut selected = vec![];
            for mut content in contents
                .as_array_mut()
                .ok_or("Tile contents is not an array")?
                .drain(..)
            {
                if content_ref(&mut content, transform, ctx)? {
                    selected.push(content);
                }
            }
            *contents = Value::Array(selected);
        }
    } else {
        let n = node.as_object_mut().unwrap();
        n.remove("content");
        n.remove("contents");
    }
    Ok(true)
}
fn content_ref(
    content: &mut Value,
    transform: Transform,
    ctx: &mut RewriteContext<'_>,
) -> Result<bool, String> {
    if let Some(volume) = content.get("boundingVolume") {
        if !ctx.area.intersects_volume(volume, &transform)? {
            return Ok(false);
        }
    }
    let key = if content.get("uri").is_some() {
        "uri"
    } else {
        "url"
    };
    let uri = content
        .get(key)
        .and_then(Value::as_str)
        .ok_or("Tile content has no URI")?;
    let local = ctx.reference(uri, transform, Expected::Content)?;
    content[key] = Value::String(local.clone());
    if key == "uri" && content.get("url").is_some() {
        content["url"] = Value::String(local);
    }
    Ok(true)
}
fn gltf_references(doc: &mut Value, ctx: &mut RewriteContext<'_>) -> Result<bool, String> {
    let mut changed = false;
    let legacy = doc.pointer("/asset/version").and_then(Value::as_str) == Some("1.0");
    for collection in ["buffers", "images", "shaders"] {
        if let Some(items) = doc.get_mut(collection) {
            let values: Vec<&mut Value> = if legacy { items.as_object_mut().ok_or("glTF 1 resource list is not an object")?.values_mut().collect() }
                else { items.as_array_mut().ok_or("glTF 2 resource list is not an array")?.iter_mut().collect() };
            for item in values {
                if let Some(uri) = item.get("uri").and_then(Value::as_str) {
                    if legacy && collection == "buffers" && uri == "binary_glTF" { continue; }
                    let local = ctx.reference(uri, ctx.current.transform, Expected::Resource)?;
                    changed |= local != uri;
                    item["uri"] = Value::String(local);
                }
            }
        }
    }
    Ok(changed)
}
struct GlbLayout {
    json: Value,
    json_end: usize,
    // Only an otherwise complete terminal BIN can omit its alignment bytes.
    // Download rewrites this legacy representation; saved bundles stay strict.
    unpadded_bin: Option<(usize, usize)>,
}
fn glb_json(bytes: &[u8], normalize_terminal_bin: bool) -> Result<GlbLayout, String> {
    if bytes.get(..4) != Some(b"glTF") || u32at(bytes, 4)? != 2 || u32at(bytes, 8)? != bytes.len() {
        return Err("Invalid glTF 2 binary header or byte length".into());
    }
    let size = u32at(bytes, 12)?;
    if bytes.get(16..20) != Some(b"JSON") || size % 4 != 0 {
        return Err("Invalid GLB JSON chunk".into());
    }
    let end = 20usize.checked_add(size).ok_or("GLB length overflow")?;
    let json: Value = serde_json::from_slice(bytes.get(20..end).ok_or("Truncated GLB JSON")?)
        .map_err(|_| "Invalid GLB JSON document")?;
    let mut offset = end;
    let mut bin_seen = false;
    let mut unpadded_bin = None;
    while offset < bytes.len() {
        let header_end = offset.checked_add(8).ok_or("GLB length overflow")?;
        let header = bytes
            .get(offset..header_end)
            .ok_or("Truncated GLB chunk header")?;
        let n = u32at(bytes, offset)?;
        let chunk_end = header_end.checked_add(n).ok_or("GLB length overflow")?;
        if chunk_end > bytes.len() {
            return Err("Truncated GLB data chunk".into());
        }
        let is_bin = &header[4..] == b"BIN\0";
        if &header[4..] == b"JSON" || (is_bin && (bin_seen || offset != end)) {
            return Err("Invalid GLB chunk order".into());
        }
        bin_seen |= is_bin;
        if n % 4 != 0 {
            let complete_embedded_buffer = json.pointer("/buffers/0").is_some_and(|buffer| {
                buffer.get("uri").is_none()
                    && buffer.get("byteLength").and_then(Value::as_u64) == Some(n as u64)
            });
            if !normalize_terminal_bin
                || !is_bin
                || chunk_end != bytes.len()
                || !complete_embedded_buffer
            {
                return Err("Unaligned GLB chunk".into());
            }
            unpadded_bin = Some((offset, 4 - n % 4));
        }
        offset = chunk_end;
    }
    Ok(GlbLayout {
        json,
        json_end: end,
        unpadded_bin,
    })
}
fn rewrite_glb(bytes: &[u8], ctx: &mut RewriteContext<'_>) -> Result<Vec<u8>, String> {
    if u32at(bytes, 4)? == 1 {
        let (mut doc, end) = glb1_json(bytes)?;
        let changed = gltf_references(&mut doc, ctx)?;
        let mut json = if changed { json_bytes(&doc)? } else { bytes[20..end].to_vec() };
        while json.len() % 4 != 0 { json.push(b' '); }
        let mut out = bytes[..20].to_vec(); put32(&mut out, 12, json.len())?; out.extend(json); out.extend_from_slice(&bytes[end..]);
        let len = out.len(); put32(&mut out, 8, len)?; return Ok(out);
    }
    let GlbLayout {
        json: mut doc,
        json_end: end,
        unpadded_bin,
    } = glb_json(bytes, true)?;
    let changed = gltf_references(&mut doc, ctx)?;
    // Preserve the original JSON bytes when there are no URIs to rewrite,
    // including the provider's exact decimal metadata representation.
    let mut json = if changed {
        json_bytes(&doc)?
    } else {
        bytes[20..end].to_vec()
    };
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    let mut out = bytes[..20].to_vec();
    put32(&mut out, 12, json.len())?;
    out.extend(json);
    let tail_start = out.len();
    out.extend_from_slice(&bytes[end..]);
    if let Some((offset, padding)) = unpadded_bin {
        put32(
            &mut out,
            tail_start + offset - end,
            u32at(bytes, offset)? + padding,
        )?;
        out.resize(out.len() + padding, 0);
    }
    let len = out.len();
    put32(&mut out, 8, len)?;
    Ok(out)
}
fn glb1_json(bytes: &[u8]) -> Result<(Value, usize), String> {
    if bytes.get(..4) != Some(b"glTF") || u32at(bytes,4)? != 1 || u32at(bytes,8)? != bytes.len() || u32at(bytes,16)? != 0 { return Err("Invalid glTF 1 binary header".into()); }
    let end = 20usize.checked_add(u32at(bytes,12)?).ok_or("GLB 1 length overflow")?;
    let doc: Value = serde_json::from_slice(bytes.get(20..end).ok_or("Truncated GLB 1 JSON")?).map_err(|_| "Invalid GLB 1 JSON")?;
    if doc.pointer("/asset/version").and_then(Value::as_str) != Some("1.0") { return Err("GLB 1 asset version missing".into()); }
    if let Some(buffer) = doc.pointer("/buffers/binary_glTF") {
        let length = buffer["byteLength"].as_u64().ok_or("GLB 1 binary buffer length missing")?;
        if length > (bytes.len()-end) as u64 { return Err("Truncated GLB 1 binary buffer".into()); }
    }
    Ok((doc,end))
}
fn embedded_glb(bytes: &[u8], payload: usize) -> Result<&[u8], String> {
    let body = bytes.get(payload..).ok_or("Truncated embedded GLB")?;
    let length = u32at(body, 8)?;
    let glb = body.get(..length).ok_or("Truncated embedded GLB")?;
    let padding = &body[length..];
    // b3dm/i3dm alignment belongs to the tile, not to the GLB chunks.
    if padding.len() > 7 || padding.iter().any(|byte| *byte != 0) {
        return Err("Invalid tile padding after embedded GLB".into());
    }
    Ok(glb)
}
fn aligned_tile_prefix(bytes: &[u8], payload: usize) -> Result<Vec<u8>, String> {
    let mut prefix = bytes[..payload].to_vec();
    let padding = (8 - payload % 8) % 8;
    if padding == 0 {
        return Ok(prefix);
    }
    // Pad the final present table, so its existing binary offsets remain
    // unchanged. JSON tables use spaces; binary tables use zero bytes.
    for (field, byte) in [(24, 0), (20, b' '), (16, 0), (12, b' ')] {
        let length = u32at(bytes, field)?;
        if length != 0 {
            prefix.resize(payload + padding, byte);
            put32(&mut prefix, field, length + padding)?;
            return Ok(prefix);
        }
    }
    Err("Embedded GLB has no table available for alignment".into())
}
fn container_header(bytes: &[u8]) -> Result<(String, usize), String> {
    let kind =
        String::from_utf8_lossy(bytes.get(..4).ok_or("Truncated tile content")?).into_owned();
    if u32at(bytes, 4)? != 1 || u32at(bytes, 8)? != bytes.len() {
        return Err(format!("Invalid {kind} version or byte length"));
    }
    if kind == "cmpt" {
        return Ok((kind, 16));
    }
    let header = if kind == "i3dm" { 32usize } else { 28usize };
    let mut payload = header;
    for offset in [12, 16, 20, 24] {
        payload = payload
            .checked_add(u32at(bytes, offset)?)
            .ok_or("Tile table length overflow")?;
    }
    if payload > bytes.len() {
        return Err("Truncated tile feature or batch table".into());
    }
    let ft = u32at(bytes, 12)?;
    if ft > 0 {
        let _: Value = serde_json::from_slice(&bytes[header..header + ft])
            .map_err(|_| "Invalid feature table JSON")?;
    }
    Ok((kind, payload))
}
fn rewrite_container(bytes: &[u8], ctx: &mut RewriteContext<'_>) -> Result<Vec<u8>, String> {
    if bytes.get(..4) == Some(b"b3dm") && container_header(bytes).is_err() {
        if let Some(normalized) = normalize_legacy_b3dm(bytes)? { return rewrite_container(&normalized, ctx); }
    }
    let (kind, payload) = container_header(bytes)?;
    if kind == "pnts" {
        let ft = u32at(bytes, 12)?;
        let doc: Value = serde_json::from_slice(&bytes[28..28 + ft])
            .map_err(|_| "Invalid point feature table")?;
        if doc.get("POINTS_LENGTH").and_then(Value::as_u64).is_none() {
            return Err("Point cloud has no POINTS_LENGTH".into());
        }
        return Ok(bytes.to_vec());
    }
    if kind == "cmpt" {
        let count = u32at(bytes, 12)?;
        let mut offset = 16;
        let mut out = bytes[..16].to_vec();
        for _ in 0..count {
            let length = u32at(bytes, offset + 8)?;
            if length < 12 {
                return Err("Invalid composite inner tile length".into());
            }
            let end = offset
                .checked_add(length)
                .ok_or("Composite length overflow")?;
            let child = bytes.get(offset..end).ok_or("Truncated composite tile")?;
            out.extend(rewrite_container(child, ctx)?);
            offset = end;
        }
        if offset != bytes.len() {
            return Err("Composite tile count does not match payload".into());
        }
        let len = out.len();
        put32(&mut out, 8, len)?;
        return Ok(out);
    }
    let mut out = bytes[..payload].to_vec();
    if kind == "i3dm" && u32at(bytes, 28)? == 0 {
        let uri = std::str::from_utf8(&bytes[payload..])
            .map_err(|_| "Invalid i3dm external glTF URI")?
            .trim_matches(|c| c == '\0' || c == ' ' || c == '\r' || c == '\n');
        out.extend(
            ctx.reference(uri, ctx.current.transform, Expected::Content)?
                .as_bytes(),
        );
        while out.len() % 8 != 0 {
            out.push(0);
        }
    } else {
        if kind == "i3dm" && u32at(bytes, 28)? != 1 {
            return Err("Invalid i3dm glTF format".into());
        }
        out = aligned_tile_prefix(bytes, payload)?;
        out.extend(rewrite_glb(embedded_glb(bytes, payload)?, ctx)?);
        while out.len() % 8 != 0 {
            out.push(0);
        }
    }
    let len = out.len();
    put32(&mut out, 8, len)?;
    Ok(out)
}
/// Only the two documented legacy layouts are accepted, with a complete GLB
/// at the exact declared offset. Saved bundles always use the modern header.
fn normalize_legacy_b3dm(bytes: &[u8]) -> Result<Option<Vec<u8>>, String> {
    if bytes.len() < 24 || u32at(bytes,4)? != 1 || u32at(bytes,8)? != bytes.len() { return Ok(None); }
    for header in [20usize,24] {
        let (count, json_len, binary_len) = if header == 20 { (u32at(bytes,12)?,u32at(bytes,16)?,0) } else { (u32at(bytes,20)?,u32at(bytes,12)?,u32at(bytes,16)?) };
        let Some(end) = header.checked_add(json_len).and_then(|n| n.checked_add(binary_len)) else { continue; };
        if bytes.get(end..end.saturating_add(4)) != Some(b"glTF") { continue; }
        let json = &bytes[header..header+json_len];
        if json_len > 0 && !serde_json::from_slice::<Value>(json).is_ok_and(|v| v.is_object()) { return Err("Invalid legacy batch table JSON".into()); }
        let glb = embedded_glb(bytes,end)?;
        if u32at(glb,4)? == 1 { glb1_json(glb)?; } else { glb_json(glb,true)?; }
        let mut feature = json_bytes(&serde_json::json!({"BATCH_LENGTH":count}))?; while (28+feature.len())%8 != 0 { feature.push(b' '); }
        let mut out = b"b3dm".to_vec(); for value in [1,0,feature.len(),0,json_len,binary_len] { out.extend((value as u32).to_le_bytes()); }
        out.extend(feature); out.extend(json); out.extend_from_slice(&bytes[header+json_len..end]); out.extend_from_slice(&bytes[end..]);
        let len = out.len(); put32(&mut out,8,len)?; return Ok(Some(out));
    }
    Ok(None)
}

pub fn references(bytes: &[u8], kind: &str) -> Result<Vec<String>, String> {
    let mut refs = vec![];
    if matches!(kind, "tileset" | "gltf") {
        let doc: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid saved JSON")?;
        if kind == "tileset" {
            collect_tiles(&doc["root"], &mut refs);
            if let Some(s) = doc.get("schemaUri").and_then(Value::as_str) {
                refs.push(s.into());
            }
        } else {
            collect_gltf(&doc, &mut refs);
        }
    } else if kind == "glb" {
        let doc = if u32at(bytes,4)? == 1 { glb1_json(bytes)?.0 } else { glb_json(bytes,false)?.json };
        collect_gltf(&doc, &mut refs);
    } else if matches!(kind, "b3dm" | "i3dm" | "pnts" | "cmpt") {
        let (_, payload) = container_header(bytes)?;
        if kind == "cmpt" {
            let mut offset = 16;
            for _ in 0..u32at(bytes, 12)? {
                let len = u32at(bytes, offset + 8)?;
                let end = offset.checked_add(len).ok_or("Composite length overflow")?;
                let b = bytes.get(offset..end).ok_or("Truncated composite tile")?;
                let k = String::from_utf8_lossy(b.get(..4).ok_or("Truncated composite child")?);
                refs.extend(references(b, &k)?);
                offset = end;
            }
        } else if kind == "i3dm" && u32at(bytes, 28)? == 0 {
            refs.push(
                std::str::from_utf8(&bytes[payload..])
                    .map_err(|_| "Invalid i3dm URI")?
                    .trim_matches(|c| c == '\0' || c == ' ')
                    .into(),
            );
        } else if kind != "pnts" {
            let glb = embedded_glb(bytes, payload)?;
            let doc = if u32at(glb,4)? == 1 { glb1_json(glb)?.0 } else { glb_json(glb,false)?.json };
            collect_gltf(&doc, &mut refs);
        }
    }
    Ok(refs)
}
fn collect_gltf(doc: &Value, out: &mut Vec<String>) {
    let legacy = doc.pointer("/asset/version").and_then(Value::as_str) == Some("1.0");
    for key in ["buffers", "images", "shaders"] {
        if let Some(items) = doc.get(key) {
            let values: Vec<&Value> = if legacy { items.as_object().map(|a| a.values().collect()).unwrap_or_default() } else { items.as_array().map(|a| a.iter().collect()).unwrap_or_default() };
            for item in values {
                if let Some(s) = item.get("uri").and_then(Value::as_str) {
                    if legacy && key == "buffers" && s == "binary_glTF" { continue; }
                    out.push(s.into());
                }
            }
        }
    }
}
fn collect_tiles(node: &Value, out: &mut Vec<String>) {
    for c in node.get("content").into_iter().chain(
        node.get("contents")
            .and_then(Value::as_array)
            .into_iter()
            .flatten(),
    ) {
        if let Some(s) = c
            .get("uri")
            .or_else(|| c.get("url"))
            .and_then(Value::as_str)
        {
            out.push(s.into());
        }
    }
    if let Some(children) = node.get("children").and_then(Value::as_array) {
        for child in children {
            collect_tiles(child, out);
        }
    }
}

#[cfg(test)]
mod binary_tests {
    use super::*;
    use crate::{spatial::AreaOfInterest, Pending};
    use serde_json::json;

    fn glb(binary: &[u8], declared: usize) -> Vec<u8> {
        let mut doc = serde_json::to_vec(&json!({"asset":{"version":"2.0"},
            "buffers":[{"byteLength":declared}]}))
        .unwrap();
        while doc.len() % 4 != 0 {
            doc.push(b' ');
        }
        let mut out = b"glTF".to_vec();
        out.extend(2u32.to_le_bytes());
        out.extend(((28 + doc.len() + binary.len()) as u32).to_le_bytes());
        out.extend((doc.len() as u32).to_le_bytes());
        out.extend(b"JSON");
        out.extend(doc);
        out.extend((binary.len() as u32).to_le_bytes());
        out.extend(b"BIN\0");
        out.extend(binary);
        out
    }
    fn append_chunk(bytes: &mut Vec<u8>, kind: &[u8; 4], content: &[u8]) {
        bytes.extend((content.len() as u32).to_le_bytes());
        bytes.extend(kind);
        bytes.extend(content);
        let n = bytes.len();
        put32(bytes, 8, n).unwrap();
    }
    fn container(kind: &[u8; 4], glb: &[u8]) -> Vec<u8> {
        let header = if kind == b"i3dm" { 32 } else { 28 };
        let mut feature = b"{\"BATCH_LENGTH\":0,\"INSTANCES_LENGTH\":0}".to_vec();
        while (header + feature.len()) % 8 != 0 {
            feature.push(b' ');
        }
        let mut out = kind.to_vec();
        for n in [1, 0, feature.len(), 0, 0, 0] {
            out.extend((n as u32).to_le_bytes());
        }
        if kind == b"i3dm" {
            out.extend(1u32.to_le_bytes());
        }
        out.extend(feature);
        out.extend(glb);
        while out.len() % 8 != 0 {
            out.push(0);
        }
        let n = out.len();
        put32(&mut out, 8, n).unwrap();
        out
    }
    fn rewritten(bytes: &[u8]) -> Result<Vec<u8>, String> {
        let url = "https://example.test/model.glb".parse().unwrap();
        let current = Pending {
            url,
            path: "model.glb".into(),
            transform: spatial::IDENTITY,
            depth: 0,
            ancestors: vec![],
            expected: Expected::Content,
        };
        let area = AreaOfInterest::new(None, None).unwrap();
        let mut ctx = RewriteContext {
            current: &current,
            root: &current.url,
            inherit_query: false,
            area: &area,
            pending: vec![],
            selected: 0,
            warnings: vec![],
        };
        rewrite(bytes, &mut ctx, Expected::Content).map(|v| v.0)
    }

    #[test]
    fn legacy_headers_preserve_batch_count_and_glb_and_reject_truncation() {
        let model = glb(&[42; 8], 8); let batch = b"{\"names\":[\"a\",\"b\"]}";
        for header in [20usize,24] {
            let mut tile = b"b3dm".to_vec();
            for n in [1,header+batch.len()+model.len()] { tile.extend((n as u32).to_le_bytes()); }
            let fields = if header == 20 { vec![2,batch.len()] } else { vec![batch.len(),0,2] };
            for n in fields { tile.extend((n as u32).to_le_bytes()); } tile.extend(batch); tile.extend(&model);
            let fixed = rewritten(&tile).unwrap(); let (_,payload) = container_header(&fixed).unwrap(); assert_eq!(payload%8,0);
            let ft: Value = serde_json::from_slice(&fixed[28..28+u32at(&fixed,12).unwrap()]).unwrap(); assert_eq!(ft["BATCH_LENGTH"],2);
            assert_eq!(glb_json(embedded_glb(&fixed,payload).unwrap(),false).unwrap().json["buffers"][0]["byteLength"],8);
            references(&fixed,"b3dm").unwrap(); tile.pop(); let len = tile.len(); put32(&mut tile,8,len).unwrap(); assert!(rewritten(&tile).is_err());
        }
    }
    #[test]
    fn glb_one_rewrites_dictionary_resources_without_losing_binary_and_rejects_truncation() {
        let doc = serde_json::json!({"asset":{"version":"1.0"},"buffers":{"binary_glTF":{"byteLength":8,"uri":"binary_glTF"}},"shaders":{"vertex":{"uri":"v.glsl"}},"images":{"color":{"uri":"image.png"}}});
        let mut json = serde_json::to_vec(&doc).unwrap(); while json.len()%4!=0 { json.push(b' '); }
        let mut bytes = b"glTF".to_vec(); for n in [1,20+json.len()+8,json.len(),0] { bytes.extend((n as u32).to_le_bytes()); } bytes.extend(json); bytes.extend([42;8]);
        let fixed = rewritten(&bytes).unwrap(); let (doc,end) = glb1_json(&fixed).unwrap(); assert_eq!(&fixed[end..],&[42;8]);
        assert_eq!(doc["buffers"]["binary_glTF"]["uri"],"binary_glTF"); let refs = references(&fixed,"glb").unwrap(); assert_eq!(refs.len(),2); assert!(refs.iter().all(|v| !["v.glsl","image.png","binary_glTF"].contains(&v.as_str())));
        bytes.pop(); let len=bytes.len(); put32(&mut bytes,8,len).unwrap(); assert!(rewritten(&bytes).unwrap_err().contains("Truncated GLB 1"));
    }

    #[test]
    fn complete_terminal_bin_missing_alignment_is_normalized_then_strictly_inspected() {
        for n in [5, 6, 7] {
            let original = glb(&vec![42; n], n);
            assert!(glb_json(&original, false).is_err());
            let fixed = rewritten(&original).unwrap();
            let parsed = glb_json(&fixed, false).unwrap();
            assert_eq!(u32at(&fixed, parsed.json_end).unwrap(), 8);
            assert_eq!(parsed.json["buffers"][0]["byteLength"], n);
            assert_eq!(
                &fixed[parsed.json_end + 8..parsed.json_end + 8 + n],
                &vec![42; n]
            );
            assert!(fixed[parsed.json_end + 8 + n..].iter().all(|b| *b == 0));
            assert_eq!(u32at(&fixed, 8).unwrap(), fixed.len());
            assert!(references(&fixed, "glb").unwrap().is_empty());
        }
    }

    #[test]
    fn malformed_or_ambiguous_glb_is_not_treated_as_missing_padding() {
        let truncated_buffer = glb(&[1; 7], 8);
        assert!(rewritten(&truncated_buffer).is_err());
        let mut truncated_chunk = glb(&[1; 8], 8);
        truncated_chunk.pop();
        let n = truncated_chunk.len();
        put32(&mut truncated_chunk, 8, n).unwrap();
        assert!(rewritten(&truncated_chunk)
            .unwrap_err()
            .contains("Truncated"));
        let mut wrong_header = glb(&[1; 7], 7);
        let n = wrong_header.len() + 1;
        put32(&mut wrong_header, 8, n).unwrap();
        assert!(rewritten(&wrong_header).is_err());
        let mut nonterminal = glb(&[1; 7], 7);
        append_chunk(&mut nonterminal, b"TEST", &[0; 4]);
        assert!(rewritten(&nonterminal).is_err());
        let mut duplicate = glb(&[1; 8], 8);
        append_chunk(&mut duplicate, b"BIN\0", &[0; 3]);
        assert!(rewritten(&duplicate).is_err());
        let mut unknown = glb(&[1; 8], 8);
        append_chunk(&mut unknown, b"TEST", &[0; 3]);
        assert!(rewritten(&unknown).is_err());
        let mut truncated_header = glb(&[1; 8], 8);
        truncated_header.extend([0; 4]);
        let n = truncated_header.len();
        put32(&mut truncated_header, 8, n).unwrap();
        assert!(rewritten(&truncated_header)
            .unwrap_err()
            .contains("chunk header"));
    }

    #[test]
    fn valid_unknown_chunk_is_preserved() {
        let mut bytes = glb(&[1; 8], 8);
        append_chunk(&mut bytes, b"TEST", &[4, 3, 2, 1]);
        let fixed = rewritten(&bytes).unwrap();
        assert_eq!(&fixed[fixed.len() - 12..], &bytes[bytes.len() - 12..]);
        references(&fixed, "glb").unwrap();
    }

    #[test]
    fn embedded_glb_padding_and_rewritten_container_lengths_are_independent() {
        for kind in [b"b3dm", b"i3dm"] {
            for n in [5, 6, 7, 8, 12] {
                let bytes = container(kind, &glb(&vec![42; n], n));
                let fixed = rewritten(&bytes).unwrap();
                assert_eq!(fixed.len() % 8, 0);
                assert_eq!(u32at(&fixed, 8).unwrap(), fixed.len());
                let (_, start) = container_header(&fixed).unwrap();
                let model = embedded_glb(&fixed, start).unwrap();
                glb_json(model, false).unwrap();
                references(&fixed, std::str::from_utf8(kind).unwrap()).unwrap();
            }
        }
        let children = [
            container(b"b3dm", &glb(&[1; 5], 5)),
            container(b"i3dm", &glb(&[2; 6], 6)),
        ];
        let mut composite = b"cmpt".to_vec();
        for n in [1, 16 + children.iter().map(Vec::len).sum::<usize>(), 2] {
            composite.extend((n as u32).to_le_bytes());
        }
        for child in children {
            composite.extend(child);
        }
        let fixed = rewritten(&composite).unwrap();
        assert_eq!(u32at(&fixed, 8).unwrap(), fixed.len());
        let first = u32at(&fixed, 24).unwrap();
        assert_eq!(first % 8, 0);
        assert_eq!(
            16 + first + u32at(&fixed, 16 + first + 8).unwrap(),
            fixed.len()
        );
        references(&fixed, "cmpt").unwrap();
    }

    #[test]
    fn embedded_nonzero_or_excess_tail_is_rejected() {
        let base = glb(&[1; 8], 8);
        let mut bytes = container(b"b3dm", &base);
        let (_, start) = container_header(&bytes).unwrap();
        let end = start + base.len();
        bytes.truncate(end);
        bytes.extend([0, 1, 0, 0]);
        let n = bytes.len();
        put32(&mut bytes, 8, n).unwrap();
        assert!(rewritten(&bytes).unwrap_err().contains("padding"));
        bytes.truncate(end);
        bytes.extend([0; 8]);
        let n = bytes.len();
        put32(&mut bytes, 8, n).unwrap();
        assert!(rewritten(&bytes).unwrap_err().contains("padding"));
    }

    #[test]
    fn ion_style_unaligned_batch_table_and_terminal_bin_are_both_normalized() {
        let model = glb(&[42; 6], 6);
        let feature = b"{\"BATCH_LENGTH\":0}  ";
        let batch = b"{}  ";
        let mut bytes = b"b3dm".to_vec();
        for n in [
            1,
            28 + feature.len() + batch.len() + model.len(),
            feature.len(),
            0,
            batch.len(),
            0,
        ] {
            bytes.extend((n as u32).to_le_bytes());
        }
        bytes.extend(feature);
        bytes.extend(batch);
        bytes.extend(model);
        let fixed = rewritten(&bytes).unwrap();
        let (_, start) = container_header(&fixed).unwrap();
        assert_eq!(start % 8, 0);
        assert_eq!(u32at(&fixed, 20).unwrap(), batch.len() + 4);
        let batch_start = 28 + feature.len();
        let _: Value = serde_json::from_slice(&fixed[batch_start..start]).unwrap();
        let model = embedded_glb(&fixed, start).unwrap();
        let parsed = glb_json(model, false).unwrap();
        assert_eq!(&model[parsed.json_end + 8..parsed.json_end + 14], &[42; 6]);
        assert_eq!(fixed.len() % 8, 0);
        references(&fixed, "b3dm").unwrap();
    }
}

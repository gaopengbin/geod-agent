//! Expand implicit quad/octrees into explicit tiles while preserving metadata.
//! This makes every offline URI concrete and allows spatially pruning content.
use crate::{
    check_cancel, fetch, spatial, validate_url, CancellationToken, Client, DownloadRequest,
    Pending, Url,
};
use serde_json::{json, Value};
use spatial::Transform;
use std::{collections::HashSet, future::Future, pin::Pin, sync::Arc};

#[derive(Clone, Copy)]
struct Coord {
    level: u32,
    x: u32,
    y: u32,
    z: u32,
}
struct Subtree {
    doc: Value,
    views: Vec<Vec<u8>>,
}
struct Expander<'a> {
    client: &'a Client,
    root: &'a Url,
    source: &'a Url,
    request: &'a DownloadRequest,
    area: &'a spatial::AreaOfInterest,
    cancel: &'a CancellationToken,
    schema: Option<Value>,
    nodes: usize,
    fetches: usize,
}
struct Implicit {
    template: Value,
    volume: Value,
    scheme: u32,
    levels: u32,
    sublevels: u32,
    subtree_uri: String,
    contents: Vec<Value>,
    transform: Transform,
    error: f64,
}
type BoxResult<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

pub async fn expand(
    bytes: &[u8],
    pending: &Pending,
    client: &Client,
    root: &Url,
    request: &DownloadRequest,
    area: &spatial::AreaOfInterest,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, String> {
    if !bytes
        .iter()
        .copied()
        .find(|b| !b.is_ascii_whitespace())
        .is_some_and(|b| b == b'{')
    {
        return Ok(bytes.to_vec());
    }
    let mut doc: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid JSON content")?;
    if doc.get("root").is_none() || !contains_implicit(&doc["root"]) {
        return Ok(bytes.to_vec());
    }
    let mut expander = Expander {
        client,
        root,
        source: &pending.url,
        request,
        area,
        cancel,
        schema: doc.get("schema").cloned(),
        nodes: 0,
        fetches: 0,
    };
    if expander.schema.is_none() {
        if let Some(uri) = doc.get("schemaUri").and_then(Value::as_str) {
            let url = expander.resolve(&pending.url, uri)?;
            expander.schema = Some(
                serde_json::from_slice(&expander.get(&url).await?)
                    .map_err(|_| "Invalid metadata schema")?,
            );
        }
    }
    let mut tile = doc["root"].take();
    expander.node(&mut tile, pending.transform, 0).await?;
    doc["root"] = tile;
    if let Some(schema) = expander.schema.take() {
        doc["schema"] = schema;
        doc.as_object_mut().unwrap().remove("schemaUri");
    }
    // The legacy extension has now been expanded into standard explicit tiles.
    for field in ["extensionsUsed", "extensionsRequired"] {
        if let Some(values) = doc.get_mut(field).and_then(Value::as_array_mut) {
            values.retain(|v| v.as_str() != Some("3DTILES_implicit_tiling"));
        }
    }
    serde_json::to_vec(&doc).map_err(|e| e.to_string())
}
fn contains_implicit(node: &Value) -> bool {
    node.get("implicitTiling").is_some()
        || node
            .pointer("/extensions/3DTILES_implicit_tiling")
            .is_some()
        || node
            .get("children")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(contains_implicit))
}
impl Expander<'_> {
    fn resolve(&self, base: &Url, uri: &str) -> Result<Url, String> {
        let mut url = base
            .join(uri)
            .map_err(|_| "Invalid implicit resource URI")?;
        validate_url(&url)?;
        if self.request.inherit_query && url.origin() == self.root.origin() {
            let keys: HashSet<String> = url.query_pairs().map(|(k, _)| k.into_owned()).collect();
            let extra: Vec<_> = self
                .root
                .query_pairs()
                .filter(|(k, _)| !keys.contains(k.as_ref()))
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            if !extra.is_empty() {
                let mut q = url.query_pairs_mut();
                for (k, v) in extra {
                    q.append_pair(&k, &v);
                }
            }
        }
        Ok(url)
    }
    async fn get(&mut self, url: &Url) -> Result<Vec<u8>, String> {
        self.fetches += 1;
        if self.fetches > self.request.max_resources {
            return Err("Implicit subtree resources exceed configured limit".into());
        }
        fetch(self.client, url, self.root, self.request, self.cancel).await
    }
    fn node<'a>(
        &'a mut self,
        node: &'a mut Value,
        parent: Transform,
        depth: usize,
    ) -> BoxResult<'a, ()> {
        Box::pin(async move {
            check_cancel(self.cancel)?;
            if depth > 128 {
                return Err("Implicit tileset tree exceeds 128 levels".into());
            }
            let transform = spatial::cumulative(&parent, node.get("transform"))?;
            if let Some(config) = node
                .get("implicitTiling")
                .or_else(|| node.pointer("/extensions/3DTILES_implicit_tiling"))
                .cloned()
            {
                let scheme = match config["subdivisionScheme"].as_str() {
                    Some("QUADTREE") => 2,
                    Some("OCTREE") => 3,
                    _ => return Err("Unknown implicit subdivision scheme".into()),
                };
                let levels = config["availableLevels"]
                    .as_u64()
                    .or_else(|| config["maximumLevel"].as_u64().map(|v| v + 1))
                    .ok_or("Implicit availableLevels missing")?;
                let sublevels = config["subtreeLevels"]
                    .as_u64()
                    .ok_or("Implicit subtreeLevels missing")?;
                if levels == 0 || levels > 31 || sublevels == 0 || sublevels > 10 {
                    return Err("Implicit tree levels exceed supported integer addressing".into());
                }
                let volume = node
                    .get("boundingVolume")
                    .cloned()
                    .ok_or("Implicit bounding volume missing")?;
                if volume.get("region").is_none() && volume.get("box").is_none() && !crate::s2::present(&volume) {
                    return Err("Implicit tiling requires a region, box or S2 bounding volume".into());
                }
                let contents = node
                    .get("content")
                    .cloned()
                    .into_iter()
                    .chain(
                        node.get("contents")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                    )
                    .collect();
                let subtree_uri = config
                    .pointer("/subtrees/uri")
                    .or_else(|| config.pointer("/subtrees/url"))
                    .and_then(Value::as_str)
                    .ok_or("Implicit subtree template missing")?
                    .to_owned();
                let error = node["geometricError"]
                    .as_f64()
                    .ok_or("Implicit geometric error missing")?;
                let implicit = Implicit {
                    template: node.clone(),
                    volume,
                    scheme,
                    levels: levels as u32,
                    sublevels: sublevels as u32,
                    subtree_uri,
                    contents,
                    transform,
                    error,
                };
                *node = self
                    .generate(
                        &implicit,
                        Coord {
                            level: 0,
                            x: 0,
                            y: 0,
                            z: 0,
                        },
                        None,
                    )
                    .await?
                    .unwrap_or_else(|| empty_node(&implicit));
            } else if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
                for child in children {
                    self.node(child, transform, depth + 1).await?;
                }
            }
            Ok(())
        })
    }
    fn generate<'a>(
        &'a mut self,
        imp: &'a Implicit,
        c: Coord,
        subtree: Option<Arc<Subtree>>,
    ) -> BoxResult<'a, Option<Value>> {
        Box::pin(async move {
            check_cancel(self.cancel)?;
            if c.level >= imp.levels {
                return Ok(None);
            }
            let volume = subdivide(&imp.volume, c, imp.scheme)?;
            if !self.area.intersects_volume(&volume, &imp.transform)? {
                return Ok(None);
            }
            let local = c.level % imp.sublevels;
            let tree = if local == 0 {
                Arc::new(self.subtree(&template(&imp.subtree_uri, c)).await?)
            } else {
                subtree.ok_or("Missing parent subtree")?
            };
            let index = level_offset(local, imp.scheme) + morton(c, local, imp.scheme);
            if !available(&tree.doc["tileAvailability"], index, &tree.views)? {
                return Ok(None);
            }
            self.nodes += 1;
            if self.nodes > self.request.max_resources {
                return Err("Expanded implicit tiles exceed configured resource limit".into());
            }
            let mut node = json!({"boundingVolume":volume,"geometricError":imp.error/2f64.powi(c.level as i32)});
            if c.level == 0 {
                for (key, value) in imp.template.as_object().ok_or("Invalid implicit root")? {
                    if !matches!(
                        key.as_str(),
                        "content"
                            | "contents"
                            | "implicitTiling"
                            | "children"
                            | "boundingVolume"
                            | "geometricError"
                    ) {
                        node[key] = value.clone();
                    }
                }
                if let Some(ext) = node.get_mut("extensions").and_then(Value::as_object_mut) {
                    ext.remove("3DTILES_implicit_tiling");
                }
            }
            if let Some(table) = tree.doc.get("tileMetadata").and_then(Value::as_u64) {
                let meta = metadata(
                    &tree,
                    table as usize,
                    rank(&tree.doc["tileAvailability"], index, &tree.views)?,
                    &mut self.schema,
                )?;
                apply_semantics(&mut node, &meta, self.schema.as_ref(), false)?;
                node["metadata"] = meta;
            }
            if local == 0 {
                if let Some(meta) = tree.doc.get("subtreeMetadata") {
                    node["extras"]["geodSubtreeMetadata"] = meta.clone();
                }
            }
            let availability = tree
                .doc
                .get("contentAvailability")
                .map(|v| v.as_array().cloned().unwrap_or_else(|| vec![v.clone()]))
                .unwrap_or_default();
            let mut contents = vec![];
            for (i, base) in imp.contents.iter().enumerate() {
                let a = availability
                    .get(i)
                    .ok_or("Missing implicit content availability")?;
                if !available(a, index, &tree.views)? {
                    continue;
                }
                let mut content = base.clone();
                let key = if content.get("uri").is_some() {
                    "uri"
                } else {
                    "url"
                };
                let uri = content[key]
                    .as_str()
                    .ok_or("Implicit content template missing")?;
                content[key] = Value::String(template(uri, c));
                if let Some(table) = tree
                    .doc
                    .get("contentMetadata")
                    .and_then(Value::as_array)
                    .and_then(|a| a.get(i))
                    .and_then(Value::as_u64)
                {
                    let meta = metadata(
                        &tree,
                        table as usize,
                        rank(a, index, &tree.views)?,
                        &mut self.schema,
                    )?;
                    apply_semantics(&mut content, &meta, self.schema.as_ref(), true)?;
                    content["metadata"] = meta;
                }
                contents.push(content);
            }
            if contents.len() == 1 {
                node["content"] = contents.remove(0);
            } else if !contents.is_empty() {
                node["contents"] = Value::Array(contents);
            }
            let mut children = vec![];
            if c.level + 1 < imp.levels {
                for child in 0..(1u32 << imp.scheme) {
                    let next = Coord {
                        level: c.level + 1,
                        x: c.x * 2 + (child & 1),
                        y: c.y * 2 + ((child >> 1) & 1),
                        z: if imp.scheme == 3 {
                            c.z * 2 + ((child >> 2) & 1)
                        } else {
                            0
                        },
                    };
                    if local + 1 == imp.sublevels
                        && !available(
                            &tree.doc["childSubtreeAvailability"],
                            morton(next, imp.sublevels, imp.scheme),
                            &tree.views,
                        )?
                    {
                        continue;
                    }
                    if let Some(child) = self.generate(imp, next, Some(tree.clone())).await? {
                        children.push(child);
                    }
                }
            }
            if !children.is_empty() {
                node["children"] = Value::Array(children);
            }
            Ok(Some(node))
        })
    }
    async fn subtree(&mut self, uri: &str) -> Result<Subtree, String> {
        let url = self.resolve(self.source, uri)?;
        let bytes = self.get(&url).await?;
        let (doc, binary) = parse_subtree(&bytes)?;
        let mut buffers = vec![];
        if let Some(entries) = doc.get("buffers").and_then(Value::as_array) {
            for (i, b) in entries.iter().enumerate() {
                let bytes = if let Some(uri) = b.get("uri").and_then(Value::as_str) {
                    self.get(&self.resolve(&url, uri)?).await?
                } else if i == 0 {
                    binary.clone()
                } else {
                    return Err("Only first subtree buffer may be internal".into());
                };
                let expected = b["byteLength"]
                    .as_u64()
                    .ok_or("Subtree buffer length missing")?;
                if (bytes.len() as u64) < expected {
                    return Err("Truncated subtree buffer".into());
                }
                buffers.push(bytes);
            }
        }
        let mut views = vec![];
        if let Some(entries) = doc.get("bufferViews").and_then(Value::as_array) {
            for view in entries {
                let buffer = buffers
                    .get(
                        view["buffer"]
                            .as_u64()
                            .ok_or("Subtree buffer index missing")?
                            as usize,
                    )
                    .ok_or("Subtree buffer missing")?;
                let start = view["byteOffset"].as_u64().unwrap_or(0) as usize;
                let length = view["byteLength"]
                    .as_u64()
                    .ok_or("Subtree buffer view length missing")?
                    as usize;
                let end = start
                    .checked_add(length)
                    .ok_or("Subtree view length overflow")?;
                views.push(
                    buffer
                        .get(start..end)
                        .ok_or("Subtree view exceeds its buffer")?
                        .to_vec(),
                );
            }
        }
        Ok(Subtree { doc, views })
    }
}
fn empty_node(imp: &Implicit) -> Value {
    let mut n = imp.template.clone();
    for k in ["content", "contents", "implicitTiling", "children"] {
        n.as_object_mut().unwrap().remove(k);
    }
    if let Some(e) = n.get_mut("extensions").and_then(Value::as_object_mut) {
        e.remove("3DTILES_implicit_tiling");
    }
    n
}
fn template(value: &str, c: Coord) -> String {
    value
        .replace("{level}", &c.level.to_string())
        .replace("{x}", &c.x.to_string())
        .replace("{y}", &c.y.to_string())
        .replace("{z}", &c.z.to_string())
}
fn morton(c: Coord, bits: u32, dimensions: u32) -> usize {
    let mut out = 0usize;
    for i in 0..bits {
        out |= (((c.x >> i) & 1) as usize) << (dimensions * i);
        out |= (((c.y >> i) & 1) as usize) << (dimensions * i + 1);
        if dimensions == 3 {
            out |= (((c.z >> i) & 1) as usize) << (dimensions * i + 2);
        }
    }
    out
}
fn level_offset(level: u32, dimensions: u32) -> usize {
    ((1usize << (dimensions * level)) - 1) / ((1usize << dimensions) - 1)
}
fn available(desc: &Value, index: usize, views: &[Vec<u8>]) -> Result<bool, String> {
    if let Some(v) = desc.get("constant").and_then(Value::as_u64) {
        return match v {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err("Invalid availability constant".into()),
        };
    }
    let view = desc
        .get("bitstream")
        .or_else(|| desc.get("bufferView"))
        .and_then(Value::as_u64)
        .and_then(|i| views.get(i as usize))
        .ok_or("Availability bitstream missing")?;
    let byte = view
        .get(index / 8)
        .ok_or("Availability bitstream truncated")?;
    Ok(byte & (1 << (index % 8)) != 0)
}
fn rank(desc: &Value, index: usize, views: &[Vec<u8>]) -> Result<usize, String> {
    if desc.get("constant").and_then(Value::as_u64) == Some(1) {
        return Ok(index);
    }
    let mut count = 0;
    for i in 0..index {
        count += available(desc, i, views)? as usize;
    }
    Ok(count)
}
fn parse_subtree(bytes: &[u8]) -> Result<(Value, Vec<u8>), String> {
    if bytes.get(..4) != Some(b"subt") {
        return Ok((
            serde_json::from_slice(bytes).map_err(|_| "Invalid subtree JSON")?,
            vec![],
        ));
    }
    if bytes.get(4..8) != Some(&1u32.to_le_bytes()) {
        return Err("Invalid subtree version".into());
    }
    let read = |offset: usize| -> Result<usize, String> {
        Ok(u64::from_le_bytes(
            bytes
                .get(offset..offset + 8)
                .ok_or("Truncated subtree header")?
                .try_into()
                .unwrap(),
        )
        .try_into()
        .map_err(|_| "Subtree length overflow")?)
    };
    let json_len = read(8)?;
    let bin_len = read(16)?;
    let end = 24usize
        .checked_add(json_len)
        .ok_or("Subtree length overflow")?;
    let total = end.checked_add(bin_len).ok_or("Subtree length overflow")?;
    if total != bytes.len() {
        return Err("Subtree declared length does not match bytes".into());
    }
    Ok((
        serde_json::from_slice(&bytes[24..end]).map_err(|_| "Invalid subtree JSON chunk")?,
        bytes[end..].to_vec(),
    ))
}
fn subdivide(volume: &Value, c: Coord, dim: u32) -> Result<Value, String> {
    if crate::s2::present(volume) { return crate::s2::subdivide(volume, c.level, c.x, c.y, (dim == 3).then_some(c.z)); }
    let n = 2f64.powi(c.level as i32);
    if let Some(region) = volume.get("region").and_then(Value::as_array) {
        if region.len() != 6 {
            return Err("Implicit region requires six values".into());
        }
        let mut r = region
            .iter()
            .map(|v| v.as_f64().ok_or("Invalid implicit region"))
            .collect::<Result<Vec<_>, _>>()?;
        let east = if r[2] < r[0] {
            r[2] + std::f64::consts::TAU
        } else {
            r[2]
        };
        let dx = (east - r[0]) / n;
        let dy = (r[3] - r[1]) / n;
        let west = r[0] + dx * c.x as f64;
        let south = r[1] + dy * c.y as f64;
        r[0] = wrap(west);
        r[2] = wrap(west + dx);
        r[1] = south;
        r[3] = south + dy;
        if dim == 3 {
            let dz = (r[5] - r[4]) / n;
            let bottom = r[4] + dz * c.z as f64;
            r[4] = bottom;
            r[5] = bottom + dz;
        }
        return Ok(json!({"region":r}));
    }
    let boxv = volume
        .get("box")
        .and_then(Value::as_array)
        .ok_or("Implicit box missing")?;
    if boxv.len() != 12 {
        return Err("Implicit box requires twelve values".into());
    }
    let b = boxv
        .iter()
        .map(|v| v.as_f64().ok_or("Invalid implicit box"))
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = b.clone();
    let coords = [c.x, c.y, c.z];
    for axis in 0..dim as usize {
        let scale = 2. * (coords[axis] as f64 + 0.5) / n - 1.;
        for k in 0..3 {
            out[k] += b[3 + axis * 3 + k] * scale;
            out[3 + axis * 3 + k] = b[3 + axis * 3 + k] / n;
        }
    }
    Ok(json!({"box":out}))
}
fn wrap(value: f64) -> f64 {
    if value >= -std::f64::consts::PI && value <= std::f64::consts::PI {
        value
    } else {
        (value + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI
    }
}

fn metadata(
    tree: &Subtree,
    table_index: usize,
    row: usize,
    schema: &mut Option<Value>,
) -> Result<Value, String> {
    let table = tree
        .doc
        .get("propertyTables")
        .and_then(Value::as_array)
        .and_then(|a| a.get(table_index))
        .ok_or("Implicit metadata table missing")?;
    if row
        >= table["count"]
            .as_u64()
            .ok_or("Metadata table count missing")? as usize
    {
        return Err("Metadata table row out of range".into());
    }
    let class = table["class"].as_str().ok_or("Metadata class missing")?;
    let mut class_schema = schema
        .as_ref()
        .and_then(|s| s.get("classes"))
        .and_then(|c| c.get(class))
        .cloned()
        .ok_or("Implicit metadata schema class missing")?;
    let mut properties = serde_json::Map::new();
    let mut changed = false;
    if let Some(props) = table.get("properties").and_then(Value::as_object) {
        for (name, storage) in props {
            let definition = class_schema
                .get_mut("properties")
                .and_then(|p| p.get_mut(name))
                .ok_or("Metadata property schema missing")?;
            for key in ["offset", "scale"] {
                if let Some(value) = storage.get(key) {
                    definition[key] = value.clone();
                    changed = true;
                }
            }
            let mut decode_definition = definition.clone();
            let enum_schema = if definition["type"].as_str() == Some("ENUM") {
                let e = schema
                    .as_ref()
                    .and_then(|s| s.get("enums"))
                    .and_then(|s| s.get(definition["enumType"].as_str().unwrap_or("")))
                    .ok_or("Metadata enum missing")?;
                decode_definition["componentType"] =
                    e.get("valueType").cloned().unwrap_or(json!("UINT16"));
                Some(e)
            } else {
                None
            };
            let mut value = decode_property(storage, &decode_definition, row, &tree.views)?;
            if let Some(e) = enum_schema {
                enum_names(&mut value, e)?;
            }
            properties.insert(name.clone(), value);
        }
    }
    let output_class = if changed {
        let encoded = serde_json::to_vec(&class_schema).map_err(|e| e.to_string())?;
        let id = format!("geod_{class}_{}", &crate::digest(&encoded)[..16]);
        schema.as_mut().unwrap()["classes"][&id] = class_schema;
        id
    } else {
        class.to_string()
    };
    Ok(json!({"class":output_class,"properties":properties}))
}
fn enum_names(value: &mut Value, schema: &Value) -> Result<(), String> {
    if let Some(values) = value.as_array_mut() {
        for value in values {
            enum_names(value, schema)?;
        }
        return Ok(());
    }
    let name = schema
        .get("values")
        .and_then(Value::as_array)
        .and_then(|items| items.iter().find(|item| item.get("value") == Some(value)))
        .and_then(|v| v.get("name"))
        .and_then(Value::as_str)
        .ok_or("Metadata enum value has no name")?;
    *value = json!(name);
    Ok(())
}
fn apply_semantics(
    node: &mut Value,
    metadata: &Value,
    schema: Option<&Value>,
    content: bool,
) -> Result<(), String> {
    let class = schema
        .and_then(|s| s.get("classes"))
        .and_then(|s| s.get(metadata["class"].as_str()?));
    let Some(properties) = class
        .and_then(|c| c.get("properties"))
        .and_then(Value::as_object)
    else {
        return Ok(());
    };
    for (name, definition) in properties {
        let Some(semantic) = definition.get("semantic").and_then(Value::as_str) else {
            continue;
        };
        let Some(raw) = metadata.get("properties").and_then(|p| p.get(name)) else {
            continue;
        };
        let value = if definition.get("noData") == Some(raw) {
            match definition.get("default") {
                Some(value) => value.clone(),
                None => continue,
            }
        } else {
            semantic_value(
                raw,
                definition,
                definition.get("offset"),
                definition.get("scale"),
            )?
        };
        let prefix = if content { "CONTENT_" } else { "TILE_" };
        let Some(suffix) = semantic.strip_prefix(prefix) else {
            continue;
        };
        match suffix {
            "BOUNDING_BOX" => node["boundingVolume"] = json!({"box":value}),
            "BOUNDING_REGION" => node["boundingVolume"] = json!({"region":value}),
            "BOUNDING_SPHERE" => node["boundingVolume"] = json!({"sphere":value}),
            "GEOMETRIC_ERROR" if !content => node["geometricError"] = value,
            "MINIMUM_HEIGHT" | "MAXIMUM_HEIGHT" => {
                if let Some(r) = node
                    .pointer_mut("/boundingVolume/region")
                    .and_then(Value::as_array_mut)
                {
                    if r.len() == 6 {
                        r[if suffix == "MINIMUM_HEIGHT" { 4 } else { 5 }] = value;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}
fn semantic_value(
    value: &Value,
    definition: &Value,
    offset: Option<&Value>,
    scale: Option<&Value>,
) -> Result<Value, String> {
    if let Some(array) = value.as_array() {
        return array
            .iter()
            .enumerate()
            .map(|(i, v)| {
                semantic_value(
                    v,
                    definition,
                    offset.and_then(|o| if o.is_array() { o.get(i) } else { Some(o) }),
                    scale.and_then(|s| if s.is_array() { s.get(i) } else { Some(s) }),
                )
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array);
    }
    let Some(mut n) = value.as_f64() else {
        return Ok(value.clone());
    };
    if definition["normalized"].as_bool() == Some(true) {
        let (bits, signed) = match definition["componentType"].as_str() {
            Some("UINT8") => (8, false),
            Some("UINT16") => (16, false),
            Some("UINT32") => (32, false),
            Some("UINT64") => (64, false),
            Some("INT8") => (8, true),
            Some("INT16") => (16, true),
            Some("INT32") => (32, true),
            Some("INT64") => (64, true),
            _ => return Err("Invalid normalized metadata component".into()),
        };
        n = if signed {
            (n / (2f64.powi(bits - 1) - 1.)).max(-1.)
        } else {
            n / (2f64.powi(bits) - 1.)
        };
    }
    n = n * scale.and_then(Value::as_f64).unwrap_or(1.)
        + offset.and_then(Value::as_f64).unwrap_or(0.);
    if !n.is_finite() {
        return Err("Non-finite semantic metadata value".into());
    }
    Ok(json!(n))
}
fn offset(view: &[u8], index: usize, ty: &str) -> Result<usize, String> {
    let size = match ty {
        "UINT8" => 1,
        "UINT16" => 2,
        "UINT32" => 4,
        "UINT64" => 8,
        _ => return Err("Invalid metadata offset type".into()),
    };
    let start = index.checked_mul(size).ok_or("Metadata offset overflow")?;
    let b = view
        .get(start..start + size)
        .ok_or("Metadata offsets truncated")?;
    let mut bytes = [0u8; 8];
    bytes[..size].copy_from_slice(b);
    usize::try_from(u64::from_le_bytes(bytes)).map_err(|_| "Metadata offset overflow".into())
}
fn view<'a>(storage: &Value, key: &str, views: &'a [Vec<u8>]) -> Result<&'a [u8], String> {
    storage
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|n| views.get(n as usize))
        .map(Vec::as_slice)
        .ok_or_else(|| format!("Metadata {key} view missing"))
}
fn decode_property(
    storage: &Value,
    definition: &Value,
    row: usize,
    views: &[Vec<u8>],
) -> Result<Value, String> {
    let ty = definition["type"]
        .as_str()
        .ok_or("Metadata property type missing")?;
    let array = definition["array"].as_bool().unwrap_or(false);
    let (start, count) = if array {
        if let Some(n) = definition.get("count").and_then(Value::as_u64) {
            (row * n as usize, n as usize)
        } else {
            let offsets = view(storage, "arrayOffsets", views)?;
            let ot = storage["arrayOffsetType"].as_str().unwrap_or("UINT32");
            let start = offset(offsets, row, ot)?;
            let end = offset(offsets, row + 1, ot)?;
            (
                start,
                end.checked_sub(start)
                    .ok_or("Decreasing metadata array offsets")?,
            )
        }
    } else {
        (row, 1)
    };
    if count > 1_000_000 {
        return Err("Metadata array exceeds one million entries".into());
    }
    let values = view(storage, "values", views)?;
    let components = match ty {
        "VEC2" => 2,
        "VEC3" => 3,
        "VEC4" | "MAT2" => 4,
        "MAT3" => 9,
        "MAT4" => 16,
        _ => 1,
    };
    let mut result = vec![];
    for index in start
        ..start
            .checked_add(count)
            .ok_or("Metadata array length overflow")?
    {
        let item = if ty == "STRING" {
            let offsets = view(storage, "stringOffsets", views)?;
            let ot = storage["stringOffsetType"].as_str().unwrap_or("UINT32");
            let start = offset(offsets, index, ot)?;
            let end = offset(offsets, index + 1, ot)?;
            Value::String(
                std::str::from_utf8(
                    values
                        .get(start..end)
                        .ok_or("Metadata string range invalid")?,
                )
                .map_err(|_| "Metadata string is not UTF8")?
                .into(),
            )
        } else if ty == "BOOLEAN" {
            Value::Bool(
                values
                    .get(index / 8)
                    .ok_or("Metadata boolean buffer truncated")?
                    & (1 << (index % 8))
                    != 0,
            )
        } else {
            let ct = definition["componentType"].as_str().unwrap_or("UINT16");
            let mut elements = vec![];
            for c in 0..components {
                elements.push(number(values, index * components + c, ct)?);
            }
            if components == 1 {
                elements.remove(0)
            } else {
                Value::Array(elements)
            }
        };
        result.push(item);
    }
    Ok(if array {
        Value::Array(result)
    } else {
        result.remove(0)
    })
}
fn number(bytes: &[u8], index: usize, ty: &str) -> Result<Value, String> {
    let size = match ty {
        "UINT8" | "INT8" => 1,
        "UINT16" | "INT16" => 2,
        "UINT32" | "INT32" | "FLOAT32" => 4,
        "UINT64" | "INT64" | "FLOAT64" => 8,
        _ => return Err("Unknown metadata numeric component type".into()),
    };
    let start = index.checked_mul(size).ok_or("Metadata index overflow")?;
    let b = bytes
        .get(start..start + size)
        .ok_or("Metadata numeric buffer truncated")?;
    Ok(match ty {
        "UINT8" => json!(b[0]),
        "INT8" => json!(b[0] as i8),
        "UINT16" => json!(u16::from_le_bytes(b.try_into().unwrap())),
        "INT16" => json!(i16::from_le_bytes(b.try_into().unwrap())),
        "UINT32" => json!(u32::from_le_bytes(b.try_into().unwrap())),
        "INT32" => json!(i32::from_le_bytes(b.try_into().unwrap())),
        "UINT64" => json!(u64::from_le_bytes(b.try_into().unwrap())),
        "INT64" => json!(i64::from_le_bytes(b.try_into().unwrap())),
        "FLOAT32" => json!(f32::from_le_bytes(b.try_into().unwrap())),
        "FLOAT64" => json!(f64::from_le_bytes(b.try_into().unwrap())),
        _ => unreachable!(),
    })
}

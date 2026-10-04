//! Capability-scoped, offline serving of previously verified data bundles.
//! A registration exposes only its manifest entries, never an arbitrary folder.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs::File, io::{Read, Seek, SeekFrom}, path::{Component, Path, PathBuf}, sync::Mutex, time::SystemTime};
use tauri::http::{Request, Response};

const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataResource {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredAssets {
    pub token: String,
    pub entrypoint: String,
    /// Use convertFileSrc(`${token}/${entrypoint}`, 'geod-data') on the host.
    pub resource_path: String,
}

#[derive(Clone)]
struct VerifiedFile { path: PathBuf, bytes: u64, modified: Option<SystemTime>, content_type: &'static str }
#[derive(Clone)]
struct Registration { root: PathBuf, files: HashMap<String, VerifiedFile> }

#[derive(Default)]
pub struct DataAssets(Mutex<HashMap<String, Registration>>);

#[tauri::command]
pub fn data_asset_unregister(token: String, state: tauri::State<'_, DataAssets>) -> Result<(), String> {
    state.unregister(&token);
    Ok(())
}

impl DataAssets {
    pub fn register_verified(&self, directory: &Path, entrypoint: &str, resources: &[DataResource]) -> Result<RegisteredAssets, String> {
        let root = directory.canonicalize().map_err(|_| "Data bundle directory is missing")?;
        if !root.is_dir() || !safe_relative(entrypoint) || resources.is_empty() { return Err("Invalid data bundle registration".into()); }
        let mut files = HashMap::new();
        for resource in resources {
            if !safe_relative(&resource.path) || resource.bytes > MAX_FILE_BYTES || resource.sha256.len() != 64 {
                return Err("Invalid data bundle resource".into());
            }
            let path = root.join(&resource.path).canonicalize().map_err(|_| "Data bundle resource is missing")?;
            if !path.starts_with(&root) { return Err("Data bundle resource escapes its directory".into()); }
            let mut file = File::open(&path).map_err(|_| "Cannot open data bundle resource")?;
            let metadata = file.metadata().map_err(|_| "Cannot inspect data bundle resource")?;
            if !metadata.is_file() || metadata.len() != resource.bytes { return Err("Data bundle resource size mismatch".into()); }
            let mut hash = Sha256::new(); let mut buffer = [0u8; 64 * 1024];
            loop { let n = file.read(&mut buffer).map_err(|_| "Cannot verify data bundle resource")?; if n == 0 { break; } hash.update(&buffer[..n]); }
            if format!("{:x}", hash.finalize()) != resource.sha256 { return Err("Data bundle resource checksum mismatch".into()); }
            let entry = VerifiedFile { path, bytes: resource.bytes, modified: metadata.modified().ok(), content_type: content_type(&resource.path, &resource.kind) };
            if files.insert(resource.path.clone(), entry).is_some() { return Err("Duplicate data bundle resource".into()); }
        }
        if !files.contains_key(entrypoint) { return Err("Data bundle entrypoint is not registered".into()); }
        let token = uuid::Uuid::new_v4().to_string();
        self.0.lock().map_err(|_| "Data registry is unavailable")?.insert(token.clone(), Registration { root, files });
        Ok(RegisteredAssets { resource_path: format!("{token}/{entrypoint}"), token, entrypoint: entrypoint.into() })
    }

    pub fn unregister(&self, token: &str) { if let Ok(mut registry) = self.0.lock() { registry.remove(token); } }

    pub fn respond(&self, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
        let origin = request.headers().get("origin").and_then(|v| v.to_str().ok()).unwrap_or("http://tauri.localhost");
        if !matches!(origin, "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost" | "http://127.0.0.1:1420" | "http://localhost:1420") { return response(403); }
        let mut result = if request.method() == "OPTIONS" { response(204) }
        else if request.method() != "GET" && request.method() != "HEAD" { response(405) }
        else { self.read(&request) };
        let headers = result.headers_mut();
        if let Ok(origin) = origin.parse() { headers.insert("access-control-allow-origin", origin); }
        headers.insert("access-control-allow-methods", "GET, HEAD, OPTIONS".parse().unwrap());
        headers.insert("access-control-allow-headers", "range".parse().unwrap());
        headers.insert("access-control-expose-headers", "content-range,content-length,accept-ranges".parse().unwrap());
        headers.insert("x-content-type-options", "nosniff".parse().unwrap());
        headers.insert("cache-control", "private, no-store".parse().unwrap());
        result
    }

    fn read(&self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let Some(path) = decode_path(request.uri().path().trim_start_matches('/')) else { return response(400); };
        let Some((token, relative)) = path.split_once('/') else { return response(404); };
        if !safe_relative(relative) { return response(400); }
        let resource = self.0.lock().ok().and_then(|registry| registry.get(token).and_then(|r| r.files.get(relative).map(|f| (r.root.clone(), f.clone()))));
        let Some((root, resource)) = resource else { return response(404); };
        // Resolve again: a directory replaced by a junction/symlink after
        // registration must not expose a file outside the verified bundle.
        let Ok(actual) = resource.path.canonicalize() else { return response(404); };
        if !actual.starts_with(root) || actual != resource.path { return response(403); }
        let Ok(mut file) = File::open(actual) else { return response(404); };
        let Ok(metadata) = file.metadata() else { return response(500); };
        if !metadata.is_file() || metadata.len() != resource.bytes || metadata.modified().ok() != resource.modified { return response(409); }
        let requested = request.headers().get("range");
        let range = match requested {
            Some(raw) => match raw.to_str().ok().and_then(|s| parse_range(s, resource.bytes)) {
                Some(range) => Some(range),
                None => return Response::builder().status(416).header("Content-Range", format!("bytes */{}", resource.bytes)).body(Vec::new()).unwrap(),
            },
            None => None,
        };
        let (start, length) = range.map(|(start, end)| (start, end - start + 1)).unwrap_or((0, resource.bytes));
        if length > MAX_FILE_BYTES { return response(413); }
        let mut body = Vec::new();
        if request.method() != "HEAD" && length > 0 {
            if file.seek(SeekFrom::Start(start)).is_err() { return response(500); }
            body.resize(length as usize, 0);
            if file.read_exact(&mut body).is_err() { return response(500); }
        }
        let mut builder = Response::builder().status(if range.is_some() { 206 } else { 200 })
            .header("Content-Type", resource.content_type).header("Content-Length", length).header("Accept-Ranges", "bytes");
        if let Some((start, end)) = range { builder = builder.header("Content-Range", format!("bytes {start}-{end}/{}", resource.bytes)); }
        builder.body(body).unwrap()
    }
}

fn safe_relative(path: &str) -> bool {
    !path.is_empty() && !path.contains(['\\', ':', '\0', '?', '#']) && !path.starts_with('/')
        && Path::new(path).components().all(|c| matches!(c, Component::Normal(_)))
        && !path.split('/').any(|p| p.is_empty() || p == "." || p == "..")
}
fn decode_path(value: &str) -> Option<String> {
    let mut bytes = vec![]; let input = value.as_bytes(); let mut i = 0;
    while i < input.len() {
        if input[i] == b'%' { let hex = std::str::from_utf8(input.get(i + 1..i + 3)?).ok()?; bytes.push(u8::from_str_radix(hex, 16).ok()?); i += 3; }
        else { bytes.push(input[i]); i += 1; }
    }
    String::from_utf8(bytes).ok()
}
fn parse_range(raw: &str, size: u64) -> Option<(u64, u64)> {
    if size == 0 { return None; }
    let (start, end) = raw.strip_prefix("bytes=")?.split_once('-')?;
    if start.is_empty() { let count = end.parse::<u64>().ok()?; return (count > 0).then_some((size.saturating_sub(count), size - 1)); }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() { size - 1 } else { end.parse::<u64>().ok()?.min(size - 1) };
    (start <= end && start < size).then_some((start, end))
}
fn response(status: u16) -> Response<Vec<u8>> { Response::builder().status(status).body(Vec::new()).unwrap() }
fn content_type(path: &str, kind: &str) -> &'static str {
    if matches!(kind, "tileset" | "gltf" | "json") { return if kind == "gltf" { "model/gltf+json" } else { "application/json" }; }
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "json" | "geojson" => "application/json", "gltf" => "model/gltf+json", "glb" => "model/gltf-binary",
        "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "webp" => "image/webp", "ktx2" => "image/ktx2",
        "pbf" | "mvt" => "application/vnd.mapbox-vector-tile", _ => "application/octet-stream",
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn registry_checks_hashes_and_serves_only_manifest_files() {
        let tmp = tempfile::tempdir().unwrap(); std::fs::create_dir(tmp.path().join("assets")).unwrap();
        std::fs::write(tmp.path().join("tileset.json"), b"0123456789").unwrap(); std::fs::write(tmp.path().join("secret"), b"hidden").unwrap();
        let resources = vec![DataResource { path: "tileset.json".into(), bytes: 10, sha256: format!("{:x}", Sha256::digest(b"0123456789")), kind: "tileset".into() }];
        let files = DataAssets::default(); let registration = files.register_verified(tmp.path(), "tileset.json", &resources).unwrap();
        let request = |path: &str, range: Option<&str>| { let mut r = Request::builder().uri(format!("http://geod-data.localhost/{}/{path}", registration.token)); if let Some(range) = range { r = r.header("Range", range); } r.body(Vec::new()).unwrap() };
        let body = files.respond(request("tileset.json", Some("bytes=2-5"))); assert_eq!(body.status(), 206); assert_eq!(body.body(), b"2345"); assert_eq!(body.headers()["Content-Type"], "application/json");
        assert_eq!(files.respond(request("tileset.json", Some("bytes=-3"))).body(), b"789");
        assert_eq!(files.respond(request("tileset.json", Some("bytes=10-"))).status(), 416);
        assert_eq!(files.respond(request("secret", None)).status(), 404);
        assert_eq!(files.respond(request("%2e%2e/secret", None)).status(), 400);
        assert_eq!(files.respond(request("assets/%2e%2e/tileset.json", None)).status(), 400);
        let denied = Request::builder().uri(format!("http://geod-data.localhost/{}/tileset.json", registration.token)).header("Origin", "https://untrusted.example").body(Vec::new()).unwrap(); assert_eq!(files.respond(denied).status(), 403);
        files.unregister(&registration.token); assert_eq!(files.respond(request("tileset.json", None)).status(), 404);
    }
    #[test] fn refuses_wrong_hash_and_modified_files() {
        let tmp = tempfile::tempdir().unwrap(); std::fs::write(tmp.path().join("a.glb"), b"before").unwrap();
        let files = DataAssets::default(); let mut r = DataResource { path: "a.glb".into(), bytes: 6, sha256: "0".repeat(64), kind: "glb".into() };
        assert!(files.register_verified(tmp.path(), "a.glb", &[r.clone()]).is_err()); r.sha256 = format!("{:x}", Sha256::digest(b"before")); let registration = files.register_verified(tmp.path(), "a.glb", &[r]).unwrap();
        std::fs::write(tmp.path().join("a.glb"), b"changed").unwrap(); let req = Request::builder().uri(format!("http://geod-data.localhost/{}", registration.resource_path)).body(Vec::new()).unwrap(); assert_eq!(files.respond(req).status(), 409);
    }
}

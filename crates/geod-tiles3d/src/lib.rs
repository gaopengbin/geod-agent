//! Download a 3D Tiles graph into a self-contained, hash-verified offline bundle.
//! Authentication stays in memory and is sent only to the source origin.
mod implicit;
pub mod ion;
mod rewrite;
mod s2;
pub mod spatial;

use futures_util::{stream, StreamExt};
use geod_core::boundary::BoundaryGeometry;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use spatial::{Transform, IDENTITY};
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    time::Duration,
};
pub use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub tileset_url: String,
    pub output_dir: PathBuf,
    #[serde(default)]
    pub bounds: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<BoundaryGeometry>,
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    #[serde(default = "default_retries")]
    pub retries: usize,
    #[serde(default = "default_resources")]
    pub max_resources: usize,
    #[serde(default = "default_asset_bytes")]
    pub max_asset_bytes: u64,
    #[serde(default = "default_total_bytes")]
    pub max_total_bytes: u64,
    /// Credentials are resolved by the host. Never include this in model results.
    #[serde(skip)]
    pub headers: BTreeMap<String, String>,
    #[serde(skip)]
    pub proxy: Option<String>,
    /// Some authenticated services put credentials in the root query string.
    /// Missing query keys are inherited only for same-origin child references.
    #[serde(default)]
    pub inherit_query: bool,
    /// Stable host-verified connection revision, independent of signed endpoint URLs.
    #[serde(skip)]
    pub source_fingerprint: Option<String>,
}
impl std::fmt::Debug for DownloadRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DownloadRequest")
            .field(
                "origin",
                &Url::parse(&self.tileset_url)
                    .ok()
                    .map(|url| url.origin().ascii_serialization()),
            )
            .field("output_dir", &self.output_dir)
            .field("bounds", &self.bounds)
            .field("header_names", &self.headers.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}
fn default_concurrency() -> usize {
    8
}
fn default_retries() -> usize {
    3
}
fn default_resources() -> usize {
    100_000
}
fn default_asset_bytes() -> u64 {
    256 * 1024 * 1024
}
fn default_total_bytes() -> u64 {
    100 * 1024 * 1024 * 1024
}
impl DownloadRequest {
    pub fn new(url: impl Into<String>, output: impl Into<PathBuf>) -> Self {
        Self {
            tileset_url: url.into(),
            output_dir: output.into(),
            bounds: None,
            boundary: None,
            concurrency: 8,
            retries: 3,
            max_resources: 100_000,
            max_asset_bytes: default_asset_bytes(),
            max_total_bytes: default_total_bytes(),
            headers: BTreeMap::new(),
            proxy: None,
            inherit_query: false,
            source_fingerprint: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub path: String,
    pub kind: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub schema_version: u32,
    pub entrypoint: String,
    pub source_fingerprint: String,
    pub bounds: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<BoundaryGeometry>,
    pub resources: Vec<Asset>,
    pub total_bytes: u64,
    pub selected_tiles: usize,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub discovered: usize,
    pub completed: usize,
    pub bytes: u64,
    pub stage: String,
}

#[derive(Clone)]
pub(crate) struct Pending {
    pub url: Url,
    pub path: String,
    pub transform: Transform,
    pub depth: usize,
    pub ancestors: Vec<String>,
    pub expected: Expected,
}
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Expected {
    Root,
    Content,
    Resource,
}
pub(crate) struct RewriteContext<'a> {
    pub current: &'a Pending,
    pub root: &'a Url,
    pub inherit_query: bool,
    pub area: &'a spatial::AreaOfInterest,
    pub pending: Vec<Pending>,
    pub selected: usize,
    pub warnings: Vec<String>,
}
impl RewriteContext<'_> {
    pub fn reference(
        &mut self,
        uri: &str,
        transform: Transform,
        expected: Expected,
    ) -> Result<String, String> {
        if uri.starts_with("data:") {
            return Ok(uri.to_owned());
        }
        let mut url = self
            .current
            .url
            .join(uri)
            .map_err(|_| "Invalid resource URI")?;
        validate_url(&url)?;
        if self.inherit_query && url.origin() == self.root.origin() {
            let mut keys: HashSet<String> =
                url.query_pairs().map(|(k, _)| k.into_owned()).collect();
            let mut extra = Vec::new();
            // Ion external services can introduce a session key on an external
            // tileset. Preserve it through same-origin descendants, without
            // copying an unrelated origin's query or overwriting explicit keys.
            for parent in [&self.current.url, self.root] {
                if parent.origin() != self.root.origin() {
                    continue;
                }
                for (k, v) in parent.query_pairs() {
                    if keys.insert(k.to_string()) {
                        extra.push((k.into_owned(), v.into_owned()));
                    }
                }
            }
            if !extra.is_empty() {
                let mut pairs = url.query_pairs_mut();
                for (k, v) in extra {
                    pairs.append_pair(&k, &v);
                }
            }
        }
        url.set_fragment(None);
        // Context is part of tile-content identity because the same external
        // tileset can be instanced beneath distinct transforms and AOI filters.
        let key = identity(&url, &transform, expected);
        if self.current.ancestors.contains(&key) {
            return Err("Cyclic external 3D Tiles reference".into());
        }
        let name = format!("{}.{}", key, extension(&url, expected));
        let path = format!("assets/{name}");
        let mut ancestors = self.current.ancestors.clone();
        ancestors.push(key);
        self.pending.push(Pending {
            url,
            path,
            transform,
            depth: self.current.depth + 1,
            ancestors,
            expected,
        });
        Ok(if self.current.path == "tileset.json" {
            format!("assets/{name}")
        } else {
            name
        })
    }
}
fn identity(url: &Url, transform: &Transform, expected: Expected) -> String {
    let mut h = Sha256::new();
    h.update(url.as_str());
    if expected != Expected::Resource {
        for n in transform {
            h.update(n.to_le_bytes());
        }
    }
    format!("{:x}", h.finalize())
}
fn extension(url: &Url, expected: Expected) -> String {
    let e = url
        .path()
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if e.len() <= 10 && !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric()) {
        e
    } else if expected == Expected::Root {
        "json".into()
    } else {
        "bin".into()
    }
}
fn validate_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        Err("3D Tiles resources require HTTP(S) without URL user information".into())
    } else {
        Ok(())
    }
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub async fn download<F>(
    mut request: DownloadRequest,
    cancel: CancellationToken,
    progress: F,
) -> Result<Bundle, String>
where
    F: Fn(Progress) + Send + Sync,
{
    if !(1..=64).contains(&request.concurrency)
        || request.retries > 10
        || request.max_resources == 0
        || request.max_asset_bytes == 0
        || request.max_total_bytes == 0
    {
        return Err("Invalid download limits".into());
    }
    if let Some(bounds) = request.bounds {
        spatial::validate_bounds(bounds)?;
    }
    if let Some(boundary) = request.boundary.as_mut() {
        boundary.normalize().map_err(|e| e.0.to_owned())?;
    }
    let area = spatial::AreaOfInterest::new(request.bounds, request.boundary.as_ref())?;
    let root = Url::parse(&request.tileset_url).map_err(|_| "Invalid tileset URL")?;
    validate_url(&root)?;
    if request.output_dir.exists() {
        return Err("Output directory already exists; choose a new bundle destination".into());
    }
    let parent = request
        .output_dir
        .parent()
        .ok_or("Output directory has no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create output parent: {e}"))?;
    let stage = tempfile::Builder::new()
        .prefix(".geod-tiles3d-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    std::fs::create_dir(stage.path().join("assets")).map_err(|e| e.to_string())?;
    let mut builder = Client::builder()
        .gzip(true)
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = &request.proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| "Invalid proxy")?);
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let root_key = identity(&root, &IDENTITY, Expected::Root);
    let mut queue = VecDeque::from([Pending {
        url: root.clone(),
        path: "tileset.json".into(),
        transform: IDENTITY,
        depth: 0,
        ancestors: vec![root_key],
        expected: Expected::Root,
    }]);
    let mut seen = HashSet::from(["tileset.json".to_string()]);
    let mut bundle = Bundle {
        schema_version: 1,
        entrypoint: "tileset.json".into(),
        source_fingerprint: request
            .source_fingerprint
            .clone()
            .unwrap_or_else(|| digest(root.as_str().as_bytes())),
        bounds: request.bounds,
        boundary: request.boundary.clone(),
        resources: vec![],
        total_bytes: 0,
        selected_tiles: 0,
        warnings: vec![],
    };
    while !queue.is_empty() {
        check_cancel(&cancel)?;
        let batch: Vec<_> = (0..request.concurrency)
            .filter_map(|_| queue.pop_front())
            .collect();
        let results: Vec<_> = stream::iter(batch.into_iter().map(|p| {
            let client = &client;
            let request = &request;
            let cancel = &cancel;
            let root = &root;
            async move {
                let bytes = fetch(client, &p.url, root, request, cancel).await;
                (p, bytes)
            }
        }))
        .buffer_unordered(request.concurrency)
        .collect()
        .await;
        for (p, bytes) in results {
            check_cancel(&cancel)?;
            let bytes = bytes?;
            let bytes =
                implicit::expand(&bytes, &p, &client, &root, &request, &area, &cancel).await?;
            let mut ctx = RewriteContext {
                current: &p,
                root: &root,
                inherit_query: request.inherit_query,
                area: &area,
                pending: vec![],
                selected: 0,
                warnings: vec![],
            };
            let (bytes, kind) = rewrite::rewrite(&bytes, &mut ctx, p.expected)?;
            if p.depth > 128 {
                return Err("3D Tiles resource graph exceeds 128 levels".into());
            }
            bundle.total_bytes = bundle
                .total_bytes
                .checked_add(bytes.len() as u64)
                .ok_or("Bundle size overflow")?;
            if bundle.total_bytes > request.max_total_bytes {
                return Err("3D Tiles bundle exceeds the configured download size".into());
            }
            for dependency in ctx.pending {
                if seen.insert(dependency.path.clone()) {
                    if seen.len() > request.max_resources {
                        return Err("3D Tiles bundle exceeds the configured resource count".into());
                    }
                    queue.push_back(dependency);
                }
            }
            bundle.selected_tiles += ctx.selected;
            bundle.warnings.extend(ctx.warnings);
            tokio::fs::write(stage.path().join(&p.path), &bytes)
                .await
                .map_err(|e| e.to_string())?;
            bundle.resources.push(Asset {
                path: p.path,
                kind,
                bytes: bytes.len() as u64,
                sha256: digest(&bytes),
            });
            progress(Progress {
                discovered: seen.len(),
                completed: bundle.resources.len(),
                bytes: bundle.total_bytes,
                stage: if queue.is_empty() {
                    "verifying"
                } else {
                    "downloading"
                }
                .into(),
            });
        }
    }
    if !bundle.resources.iter().any(|asset| {
        matches!(
            asset.kind.as_str(),
            "gltf" | "glb" | "b3dm" | "pnts" | "i3dm" | "cmpt"
        )
    }) {
        return Err("Selected area contains no downloadable 3D content".into());
    }
    bundle.resources.sort_by(|a, b| a.path.cmp(&b.path));
    bundle.warnings.sort();
    bundle.warnings.dedup();
    std::fs::write(
        stage.path().join("manifest.json"),
        serde_json::to_vec_pretty(&bundle).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    inspect(stage.path())?;
    check_cancel(&cancel)?;
    std::fs::rename(stage.path(), &request.output_dir)
        .map_err(|e| format!("Cannot publish 3D Tiles bundle: {e}"))?;
    progress(Progress {
        discovered: seen.len(),
        completed: bundle.resources.len(),
        bytes: bundle.total_bytes,
        stage: "completed".into(),
    });
    Ok(bundle)
}
fn check_cancel(cancel: &CancellationToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("3D Tiles download cancelled".into())
    } else {
        Ok(())
    }
}
async fn fetch(
    client: &Client,
    url: &Url,
    root: &Url,
    request: &DownloadRequest,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, String> {
    let mut last = "Request failed".to_string();
    for attempt in 0..=request.retries {
        check_cancel(cancel)?;
        let result = async {
            let mut current = url.clone();
            for _ in 0..=5 {
                let mut req = client.get(current.clone());
                if current.origin() == root.origin() {
                    for (k, v) in &request.headers {
                        req = req.header(k, v);
                    }
                }
                let mut resp = req
                    .send()
                    .await
                    .map_err(|_| "3D Tiles network request failed".to_string())?;
                if resp.status().is_redirection() {
                    let location = resp
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|v| v.to_str().ok())
                        .ok_or("Redirect has no location")?;
                    current = current.join(location).map_err(|_| "Invalid redirect URL")?;
                    validate_url(&current)?;
                    continue;
                }
                if !resp.status().is_success() {
                    return Err(format!(
                        "3D Tiles server returned HTTP {}",
                        resp.status().as_u16()
                    ));
                }
                if resp
                    .content_length()
                    .is_some_and(|n| n > request.max_asset_bytes)
                {
                    return Err("3D Tiles resource exceeds the configured file size".into());
                }
                let mut bytes = Vec::new();
                // reqwest streams decoded bytes; this limit applies after gzip
                // expansion even when the compressed Content-Length is tiny.
                while let Some(chunk) = resp
                    .chunk()
                    .await
                    .map_err(|_| "Failed to read 3D Tiles response")?
                {
                    check_cancel(cancel)?;
                    if bytes.len() as u64 + chunk.len() as u64 > request.max_asset_bytes {
                        return Err("3D Tiles resource exceeds the configured file size".into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                return Ok(bytes);
            }
            Err("Too many redirects".into())
        };
        let result = tokio::select! {_ = cancel.cancelled()=>return Err("3D Tiles download cancelled".into()),r=result=>r};
        match result {
            Ok(bytes) => return Ok(bytes),
            Err(e) => last = e,
        }
        if attempt < request.retries {
            tokio::select! {_ = cancel.cancelled()=>return Err("3D Tiles download cancelled".into()),_=tokio::time::sleep(Duration::from_millis(250*(1<<attempt.min(5))))=>{}}
        }
    }
    Err(last)
}

/// Read back every saved byte and every reachable local reference. No network
/// is used; a missing, altered, escaping, or remote dependency fails inspection.
pub fn inspect(directory: &Path) -> Result<Bundle, String> {
    let bundle: Bundle = serde_json::from_slice(
        &std::fs::read(directory.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    spatial::AreaOfInterest::new(bundle.bounds, bundle.boundary.as_ref())?;
    let root = directory.canonicalize().map_err(|e| e.to_string())?;
    let mut total = 0u64;
    let paths: HashSet<_> = bundle.resources.iter().map(|a| a.path.as_str()).collect();
    if paths.len() != bundle.resources.len() || !paths.contains(bundle.entrypoint.as_str()) {
        return Err("Invalid bundle resource index".into());
    }
    for asset in &bundle.resources {
        let safe = directory
            .join(&asset.path)
            .canonicalize()
            .map_err(|_| format!("Missing bundle resource: {}", asset.path))?;
        if !safe.starts_with(&root) {
            return Err("Bundle resource escapes its directory".into());
        }
        let bytes = std::fs::read(&safe).map_err(|e| e.to_string())?;
        if bytes.len() as u64 != asset.bytes || digest(&bytes) != asset.sha256 {
            return Err(format!("Bundle checksum mismatch: {}", asset.path));
        }
        total += asset.bytes;
        for uri in rewrite::references(&bytes, &asset.kind)? {
            if uri.starts_with("data:") {
                continue;
            }
            if uri.contains(':')
                || uri.contains('?')
                || uri.contains('#')
                || uri.starts_with('/')
                || uri.contains('\\')
            {
                return Err("Offline bundle contains a remote or unsafe resource reference".into());
            }
            let target = safe
                .parent()
                .unwrap()
                .join(&uri)
                .canonicalize()
                .map_err(|_| format!("Missing offline dependency: {uri}"))?;
            if !target.starts_with(&root) {
                return Err("Offline dependency escapes its bundle".into());
            }
            let relative = target
                .strip_prefix(&root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if !paths.contains(relative.as_str()) {
                return Err("Offline dependency is absent from manifest".into());
            }
        }
    }
    if total != bundle.total_bytes {
        return Err("Bundle byte total does not match manifest".into());
    }
    Ok(bundle)
}

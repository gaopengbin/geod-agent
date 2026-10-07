//! Download, package and inspect vector data without desktop-product dependencies.
//! Credentials and proxy configuration are runtime-only; plans and manifests are safe to persist.
mod gpkg;
pub mod mvt;
pub mod osm;
mod spatial;

use flate2::{write::GzEncoder, Compression};
use futures_util::{stream, StreamExt};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Url,
};
use rusqlite::{params, Connection};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid vector plan: {0}")]
    InvalidPlan(String),
    #[error("Invalid vector data: {0}")]
    InvalidData(String),
    #[error("Vector download cancelled")]
    Cancelled,
    #[error("Vector request failed: {0}")]
    Network(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Source {
    #[serde(rename_all = "camelCase")]
    Mvt {
        id: String,
        name: String,
        url_template: String,
        #[serde(default)]
        scheme: TileScheme,
        #[serde(default)]
        layers: Vec<String>,
        #[serde(default)]
        attribution: String,
    },
    #[serde(rename_all = "camelCase")]
    Osm {
        id: String,
        name: String,
        #[serde(default = "default_overpass")]
        endpoint: String,
        #[serde(default)]
        tags: Vec<OsmTag>,
    },
}
fn default_overpass() -> String {
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter".into()
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TileScheme {
    #[default]
    Xyz,
    Tms,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct OsmTag {
    pub key: String,
    #[serde(default)]
    pub value: Option<String>,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    Pbf,
    Mbtiles,
    Geojson,
    Gpkg,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_crs: Option<String>,
    pub source: Source,
    pub bounds: [f64; 4],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<geod_core::boundary::BoundaryGeometry>,
    #[serde(default)]
    pub zoom_levels: Vec<u8>,
    pub outputs: Vec<OutputFormat>,
    #[serde(default)]
    pub allow_partial: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub request: Request,
    pub plan_hash: String,
    pub tile_count: u64,
    pub estimated_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: String,
    pub completed: u64,
    pub total: u64,
    pub bytes: u64,
    pub cache_hits: u64,
    pub failures: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default = "default_crs")]
    pub output_crs: String,
    pub schema_version: u32,
    pub plan_hash: String,
    pub source_name: String,
    pub bounds: [f64; 4],
    pub created_at: String,
    pub data_timestamp: Option<String>,
    pub tile_count: u64,
    pub feature_count: u64,
    pub preview_feature_count: u64,
    pub preview_truncated: bool,
    pub failures: Vec<TileFailure>,
    pub warnings: Vec<String>,
    pub assets: Vec<Asset>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileFailure {
    pub z: u8,
    pub x: u32,
    pub y: u32,
    pub reason: String,
}

/// Never serialize this type. The host resolves its secure credential references
/// and network preferences only when the local job starts.
#[derive(Clone, Default)]
pub struct NetworkOptions {
    pub proxy: Option<String>,
    pub headers: BTreeMap<String, String>,
    pub query: BTreeMap<String, String>,
    pub allow_local_http: bool,
}
fn default_crs()->String{"EPSG:4326".into()}
pub trait VectorProjector: Send + Sync {
    fn reproject<'a>(&'a self,path:&'a Path,target:&'a str,cancel:&'a AtomicBool)
        ->std::pin::Pin<Box<dyn std::future::Future<Output=Result<()>>+Send+'a>>;
}
pub struct RunOptions {
    pub projector: Option<Arc<dyn VectorProjector>>,
    pub output_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub concurrency: usize,
    pub retries: u8,
    pub network: NetworkOptions,
    pub cancel: Arc<AtomicBool>,
}
impl RunOptions {
    pub fn new(output_dir: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            projector: None,
            output_dir,
            cache_dir,
            concurrency: 12,
            retries: 3,
            network: NetworkOptions::default(),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Source {
    pub fn name(&self) -> &str {
        match self {
            Self::Mvt { name, .. } | Self::Osm { name, .. } => name,
        }
    }
    pub fn url(&self) -> &str {
        match self {
            Self::Mvt { url_template, .. } => url_template,
            Self::Osm { endpoint, .. } => endpoint,
        }
    }
}
pub fn plan(mut request: Request) -> Result<Plan> {
    if let Some(crs)=&mut request.target_crs {
        *crs=geod_core::crs::normalize(crs).map_err(|e|Error::InvalidPlan(e.message))?;
        if crs!="EPSG:4326" && request.outputs != [OutputFormat::Gpkg] {
            return Err(Error::InvalidPlan("自选矢量坐标系请使用 GeoPackage；GeoJSON 固定为 WGS84，PBF/MBTiles 保留源瓦片网格".into()));
        }
    }
    if let Some(boundary) = &mut request.boundary {
        request.bounds = boundary
            .normalize()
            .map_err(|e| Error::InvalidPlan(e.0.into()))?;
        spatial::Area::new(boundary)?;
    }
    geod_core::tile::grid(request.bounds, 0, 256).map_err(|e| Error::InvalidPlan(e.into()))?;
    if request.outputs.is_empty() {
        return Err(Error::InvalidPlan(
            "Choose at least one vector output".into(),
        ));
    }
    request.outputs.sort_by_key(|f| *f as u8);
    request.outputs.dedup();
    let (id, name) = match &request.source {
        Source::Mvt { id, name, .. } | Source::Osm { id, name, .. } => (id, name),
    };
    if id.is_empty() || id.len() > 128 || name.is_empty() || name.len() > 256 {
        return Err(Error::InvalidPlan(
            "Vector source ID or name is invalid".into(),
        ));
    }
    validate_url(
        &request
            .source
            .url()
            .replace("{z}", "0")
            .replace("{x}", "0")
            .replace("{y}", "0"),
        true,
    )?;
    let url = Url::parse(
        &request
            .source
            .url()
            .replace("{z}", "0")
            .replace("{x}", "0")
            .replace("{y}", "0"),
    )
    .map_err(|_| Error::InvalidPlan("Invalid source URL".into()))?;
    if url.query_pairs().any(|(k, _)| {
        matches!(
            k.to_ascii_lowercase().as_str(),
            "key"
                | "tk"
                | "token"
                | "access_token"
                | "api_key"
                | "apikey"
                | "password"
                | "authorization"
        )
    }) {
        return Err(Error::InvalidPlan(
            "Pass source credentials in runtime NetworkOptions, not the persisted URL".into(),
        ));
    }
    let count = match &request.source {
        Source::Mvt {
            url_template,
            layers,
            ..
        } => {
            if !["{z}", "{x}", "{y}"]
                .iter()
                .all(|v| url_template.contains(v))
            {
                return Err(Error::InvalidPlan("MVT URL needs {z}, {x}, {y}".into()));
            }
            if layers.len() > 256 || layers.iter().any(|s| s.is_empty() || s.len() > 512) {
                return Err(Error::InvalidPlan("Invalid MVT layer filter".into()));
            }
            request.zoom_levels.sort();
            request.zoom_levels.dedup();
            if request.zoom_levels.is_empty() {
                return Err(Error::InvalidPlan("MVT download needs zoom levels".into()));
            }
            spatial::tiles(&request)?.len() as u64
        }
        Source::Osm { tags, .. } => {
            if !request.zoom_levels.is_empty() {
                return Err(Error::InvalidPlan(
                    "OSM feature downloads do not use zoom levels".into(),
                ));
            }
            if request
                .outputs
                .iter()
                .any(|f| matches!(f, OutputFormat::Pbf | OutputFormat::Mbtiles))
            {
                return Err(Error::InvalidPlan(
                    "OSM outputs are GeoJSON or GeoPackage; PBF here means vector tiles".into(),
                ));
            }
            if tags.len() > 32 {
                return Err(Error::InvalidPlan(
                    "At most 32 OSM tag selectors are supported".into(),
                ));
            }
            osm::query_boundary(request.bounds, tags, request.boundary.as_ref())?;
            1
        }
    };
    if count > 1_000_000 {
        return Err(Error::InvalidPlan(
            "Vector plan exceeds one million tiles; split the area or levels".into(),
        ));
    }
    let plan_hash = hex(&Sha256::digest(serde_json::to_vec(&request)?));
    Ok(Plan {
        request,
        plan_hash,
        tile_count: count,
        estimated_bytes: count.saturating_mul(256 * 1024),
    })
}

fn validate_url(value: &str, allow_local: bool) -> Result<Url> {
    let url =
        Url::parse(value).map_err(|_| Error::InvalidPlan("Invalid vector source URL".into()))?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(Error::InvalidPlan(
            "Source URLs must not contain credentials or a fragment".into(),
        ));
    }
    let local = url
        .host_str()
        .is_some_and(|s| s == "localhost" || s == "127.0.0.1" || s == "[::1]" || s == "::1");
    if url.scheme() != "https" && !(allow_local && local && url.scheme() == "http") {
        return Err(Error::InvalidPlan(
            "Vector sources require HTTPS; local HTTP is available only to an opted-in test host"
                .into(),
        ));
    }
    Ok(url)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}
async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

struct Downloader {
    client: Client,
    network: NetworkOptions,
    retries: u8,
    cancel: Arc<AtomicBool>,
}
impl Downloader {
    fn new(options: &RunOptions) -> Result<Self> {
        let mut headers = HeaderMap::new();
        for (k, v) in &options.network.headers {
            headers.insert(
                HeaderName::from_bytes(k.as_bytes())
                    .map_err(|_| Error::InvalidPlan("Invalid request header name".into()))?,
                HeaderValue::from_str(v)
                    .map_err(|_| Error::InvalidPlan("Invalid request header value".into()))?,
            );
        }
        let mut builder = Client::builder()
            .user_agent("GeoD-Agent/0.1 vector downloader")
            .timeout(Duration::from_secs(110))
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .default_headers(headers);
        if let Some(proxy) = &options.network.proxy {
            builder = builder.proxy(
                reqwest::Proxy::all(proxy)
                    .map_err(|_| Error::InvalidPlan("Invalid network proxy".into()))?,
            );
        } else {
            builder = builder.no_proxy();
        }
        Ok(Self {
            client: builder
                .build()
                .map_err(|_| Error::Network("Could not create network client".into()))?,
            network: options.network.clone(),
            retries: options.retries.min(8),
            cancel: options.cancel.clone(),
        })
    }
    async fn fetch(&self, url: &str, body: Option<&str>, limit: usize) -> Result<Vec<u8>> {
        let mut url = validate_url(url, self.network.allow_local_http)?;
        {
            let mut pairs = url.query_pairs_mut();
            for (k, v) in &self.network.query {
                pairs.append_pair(k, v);
            }
        }
        for attempt in 0..=self.retries {
            check_cancel(&self.cancel)?;
            let request = if let Some(body) = body {
                self.client
                    .post(url.clone())
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .body(format!("data={}", form_encode(body)))
            } else {
                self.client.get(url.clone())
            };
            let response = tokio::select! {_ = cancelled(&self.cancel)=>return Err(Error::Cancelled),r=request.send()=>r};
            match response {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        if response.content_length().is_some_and(|n| n > limit as u64) {
                            return Err(Error::InvalidData(
                                "Vector response exceeds size limit".into(),
                            ));
                        }
                        let content: Result<Vec<u8>> = async {
                            let mut data = Vec::new();
                            let mut stream = response.bytes_stream();
                            while let Some(chunk) = tokio::select! {_ = cancelled(&self.cancel)=>return Err(Error::Cancelled),r=stream.next()=>r} {
                                let chunk = chunk.map_err(|_| Error::Network("Vector response body interrupted".into()))?;
                                if data.len() + chunk.len() > limit { return Err(Error::InvalidData("Vector response exceeds size limit".into())); }
                                data.extend_from_slice(&chunk);
                            }
                            Ok(data)
                        }.await;
                        match content {
                            Ok(bytes) => return Ok(bytes),
                            Err(Error::Network(_)) if attempt < self.retries => {
                                tokio::select! {_=cancelled(&self.cancel)=>return Err(Error::Cancelled),_=tokio::time::sleep(Duration::from_millis(500u64<<attempt))=>{}}
                                continue;
                            }
                            Err(error) => return Err(error),
                        }
                    }
                    if !(status.as_u16() == 429 || status.is_server_error())
                        || attempt == self.retries
                    {
                        return Err(Error::Network(format!("HTTP {}", status.as_u16())));
                    }
                    let delay = response
                        .headers()
                        .get("retry-after")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(1u64 << attempt)
                        .min(30);
                    tokio::select! {_=cancelled(&self.cancel)=>return Err(Error::Cancelled),_=tokio::time::sleep(Duration::from_secs(delay))=>{}}
                }
                Err(_) => {
                    if attempt == self.retries {
                        return Err(Error::Network("Connection failed or timed out".into()));
                    }
                    tokio::select! {_=cancelled(&self.cancel)=>return Err(Error::Cancelled),_=tokio::time::sleep(Duration::from_millis(500u64<<attempt))=>{}}
                }
            }
        }
        unreachable!()
    }
}
fn form_encode(text: &str) -> String {
    let mut s = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            s.push(b as char);
        } else {
            s.push_str(&format!("%{b:02X}"));
        }
    }
    s
}

pub async fn run(
    plan: &Plan,
    options: RunOptions,
    mut progress: impl FnMut(Progress),
) -> Result<Manifest> {
    let verified = crate::plan(plan.request.clone())?;
    if verified.plan_hash != plan.plan_hash || verified.tile_count != plan.tile_count {
        return Err(Error::InvalidPlan(
            "Vector plan changed after planning".into(),
        ));
    }
    if options.output_dir.exists() {
        return Err(Error::InvalidPlan(
            "Output directory already exists; choose a new task destination".into(),
        ));
    }
    let parent = options
        .output_dir
        .parent()
        .ok_or_else(|| Error::InvalidPlan("Output directory needs a parent".into()))?;
    fs::create_dir_all(parent)?;
    let stage = tempfile::Builder::new()
        .prefix(".geod-vector-")
        .tempdir_in(parent)?;
    let auth_digest = hex(&Sha256::digest(serde_json::to_vec(&(
        &options.network.headers,
        &options.network.query,
    ))?));
    let cache = options
        .cache_dir
        .join(&plan.plan_hash)
        .join(&auth_digest[..16]);
    fs::create_dir_all(&cache)?;
    let downloader = Downloader::new(&options)?;
    check_cancel(&options.cancel)?;
    let mut status = Progress {
        phase: "downloading".into(),
        completed: 0,
        total: plan.tile_count,
        bytes: 0,
        cache_hits: 0,
        failures: 0,
    };
    progress(status.clone());
    let mut writer = FeatureWriter::new(stage.path(), &plan.request.outputs)?;
    let area = spatial::Area::for_request(&plan.request)?;
    let mut manifest = Manifest {
        output_crs: plan.request.target_crs.clone().unwrap_or_else(default_crs),
        schema_version: 1,
        plan_hash: plan.plan_hash.clone(),
        source_name: plan.request.source.name().into(),
        bounds: plan.request.bounds,
        created_at: chrono::Utc::now().to_rfc3339(),
        data_timestamp: None,
        tile_count: 0,
        feature_count: 0,
        preview_feature_count: 0,
        preview_truncated: false,
        failures: vec![],
        warnings: vec![],
        assets: vec![],
    };
    manifest.warnings.push("GeoJSON and GeoPackage retain complete features intersecting the requested area, excluding holes and outside features; geometry is not cut at the boundary. PBF and MBTiles retain complete selected tiles.".into());
    match &plan.request.source {
        Source::Osm { endpoint, tags, .. } => {
            let bytes = downloader
                .fetch(
                    endpoint,
                    Some(&osm::query_boundary(
                        plan.request.bounds,
                        tags,
                        plan.request.boundary.as_ref(),
                    )?),
                    128 * 1024 * 1024,
                )
                .await?;
            status.bytes = bytes.len() as u64;
            let decoded = osm::decode(&bytes)?;
            manifest.data_timestamp = decoded.timestamp;
            manifest.warnings.extend(decoded.warnings);
            for feature in decoded.features {
                check_cancel(&options.cancel)?;
                if area.feature(&feature)? {
                    writer.add(&feature)?;
                }
            }
            fs::write(stage.path().join("osm-response.json"), bytes)?;
            manifest
                .assets
                .push(asset(stage.path(), "osm-response.json", "osm-source")?);
            status.completed = 1;
            manifest.warnings.push(
                "OSM features keep complete geometry and may extend beyond the requested bounds."
                    .into(),
            );
        }
        Source::Mvt {
            url_template,
            scheme,
            layers,
            attribution,
            ..
        } => {
            let mb = if plan.request.outputs.contains(&OutputFormat::Mbtiles) {
                Some(mbtiles(stage.path(), plan, attribution)?)
            } else {
                None
            };
            let raw = plan.request.outputs.contains(&OutputFormat::Pbf);
            let index = if raw {
                let db = Connection::open(stage.path().join("tiles-index.sqlite"))?;
                db.execute_batch("CREATE TABLE tiles(z INTEGER,x INTEGER,y INTEGER,path TEXT UNIQUE,size INTEGER,sha256 TEXT,PRIMARY KEY(z,x,y)); BEGIN;")?;
                Some(db)
            } else {
                None
            };
            let addresses = spatial::tiles(&plan.request)?;
            let cache_ref = &cache;
            let downloader_ref = &downloader;
            let mut pending = stream::iter(addresses.into_iter().map(|(z, x, y)| async move {
                let tile_path = cache_ref.join(format!("{z}-{x}-{y}.pbf"));
                let hash_path = cache_ref.join(format!("{z}-{x}-{y}.sha256"));
                let fresh = fs::metadata(&tile_path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age < Duration::from_secs(7 * 86400));
                let loaded = match (fs::read(&tile_path), fs::read_to_string(&hash_path)) {
                    (Ok(bytes), Ok(hash)) if fresh && hex(&Sha256::digest(&bytes)) == hash => {
                        Some(bytes)
                    }
                    _ => None,
                };
                let cache_hit = loaded.is_some();
                let result = if let Some(bytes) = loaded {
                    Ok(bytes)
                } else {
                    let row = if *scheme == TileScheme::Tms {
                        (1u32 << z) - 1 - y
                    } else {
                        y
                    };
                    let url = url_template
                        .replace("{z}", &z.to_string())
                        .replace("{x}", &x.to_string())
                        .replace("{y}", &row.to_string());
                    downloader_ref.fetch(&url, None, 24 * 1024 * 1024).await
                };
                let result = result.and_then(|bytes| {
                    let features = mvt::decode(&bytes, z, x, y, &[])?;
                    if !cache_hit {
                        atomic_write(&tile_path, &bytes)?;
                        atomic_write(&hash_path, hex(&Sha256::digest(&bytes)).as_bytes())?;
                    }
                    Ok((bytes, features, cache_hit))
                });
                (z, x, y, result)
            }))
            .buffer_unordered(options.concurrency.clamp(1, 64));
            let mut layer_fields: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
            while let Some((z, x, y, result)) = pending.next().await {
                check_cancel(&options.cancel)?;
                match result {
                    Ok((bytes, features, cached)) => {
                        status.bytes += bytes.len() as u64;
                        status.cache_hits += cached as u64;
                        manifest.tile_count += 1;
                        if let Some(db) = &mb {
                            let data = if bytes.starts_with(&[0x1f, 0x8b]) {
                                bytes.clone()
                            } else {
                                let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
                                gzip.write_all(&bytes)?;
                                gzip.finish()?
                            };
                            db.execute(
                                "INSERT INTO tiles VALUES(?1,?2,?3,?4)",
                                params![z, x, (1u32 << z) - 1 - y, data],
                            )?;
                        }
                        if let Some(db) = &index {
                            let path = format!("tiles/{z}/{x}/{y}.pbf");
                            let dest = stage.path().join(&path);
                            fs::create_dir_all(dest.parent().unwrap())?;
                            fs::write(dest, &bytes)?;
                            db.execute(
                                "INSERT INTO tiles VALUES(?1,?2,?3,?4,?5,?6)",
                                params![
                                    z,
                                    x,
                                    y,
                                    path,
                                    bytes.len() as u64,
                                    hex(&Sha256::digest(&bytes))
                                ],
                            )?;
                        }
                        for feature in features {
                            let layer = feature["properties"]["_sourceLayer"]
                                .as_str()
                                .unwrap_or("unknown");
                            let fields = layer_fields.entry(layer.into()).or_default();
                            if let Some(props) = feature["properties"].as_object() {
                                for (k, v) in props {
                                    if k.starts_with('_') {
                                        continue;
                                    }
                                    fields.insert(
                                        k.clone(),
                                        if v.is_boolean() {
                                            "Boolean"
                                        } else if v.is_number() {
                                            "Number"
                                        } else {
                                            "String"
                                        }
                                        .into(),
                                    );
                                }
                            }
                            if (layers.is_empty() || layers.iter().any(|v| v == layer))
                                && area.feature(&feature)?
                            {
                                writer.add(&feature)?;
                            }
                        }
                    }
                    Err(Error::Cancelled) => return Err(Error::Cancelled),
                    Err(error) => {
                        status.failures += 1;
                        manifest.failures.push(TileFailure {
                            z,
                            x,
                            y,
                            reason: error.to_string(),
                        });
                    }
                }
                status.completed += 1;
                progress(status.clone());
            }
            if !manifest.failures.is_empty() && !plan.request.allow_partial {
                return Err(Error::Network(format!(
                    "{} of {} tiles failed; successful tiles remain cached for retry",
                    manifest.failures.len(),
                    plan.tile_count
                )));
            }
            if manifest.tile_count == 0 && plan.tile_count > 0 {
                return Err(Error::Network("No vector tiles were downloaded".into()));
            }
            if let Some(db) = mb {
                let vector_layers: Vec<_> = layer_fields
                    .iter()
                    .map(|(id, fields)| json!({"id":id,"fields":fields}))
                    .collect();
                db.execute(
                    "INSERT INTO metadata VALUES('json',?1)",
                    [json!({"vector_layers":vector_layers}).to_string()],
                )?;
                db.execute_batch("COMMIT;")?;
                drop(db);
                manifest
                    .assets
                    .push(asset(stage.path(), "vectors.mbtiles", "mbtiles")?);
            }
            if let Some(db) = index {
                db.execute_batch("COMMIT;")?;
                drop(db);
                manifest
                    .assets
                    .push(asset(stage.path(), "tiles-index.sqlite", "pbf-index")?);
                let tilejson = json!({"tilejson":"3.0.0","name":plan.request.source.name(),"scheme":"xyz","format":"pbf","tiles":["tiles/{z}/{x}/{y}.pbf"],"bounds":plan.request.bounds,"minzoom":plan.request.zoom_levels.first(),"maxzoom":plan.request.zoom_levels.last(),"attribution":attribution,"vector_layers":layer_fields.iter().map(|(id,fields)|json!({"id":id,"fields":fields})).collect::<Vec<_>>()});
                fs::write(
                    stage.path().join("tilejson.json"),
                    serde_json::to_vec_pretty(&tilejson)?,
                )?;
                manifest
                    .assets
                    .push(asset(stage.path(), "tilejson.json", "tilejson")?);
            }
            manifest.warnings.push("Vector tile exports preserve tile boundaries and buffered features; features split across tiles or zoom levels are not merged.".into());
        }
    }
    check_cancel(&options.cancel)?;
    status.phase = "packaging".into();
    progress(status.clone());
    let (count, preview_count, mut assets) = writer.finish(stage.path())?;
    if manifest.output_crs != "EPSG:4326" {
        status.phase="reprojecting".into();progress(status.clone());
        let projector=options.projector.as_ref().ok_or_else(||Error::InvalidPlan("请先安装矢量转换技能".into()))?;
        projector.reproject(&stage.path().join("features.gpkg"),&manifest.output_crs,&options.cancel).await?;
        let item=assets.iter_mut().find(|a|a.kind=="gpkg").ok_or_else(||Error::InvalidData("坐标转换缺少 GeoPackage".into()))?;
        *item=asset(stage.path(),"features.gpkg","gpkg")?;
    }
    manifest.feature_count = count;
    manifest.preview_feature_count = preview_count;
    manifest.preview_truncated = preview_count < count;
    manifest.assets.append(&mut assets);
    if manifest.preview_truncated {
        manifest.warnings.push(format!("Preview contains the first {preview_count} features; exported datasets contain all {count} features."));
    }
    fs::write(
        stage.path().join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    check_cancel(&options.cancel)?;
    fs::rename(stage.path(), &options.output_dir)?;
    status.phase = "completed".into();
    progress(status);
    Ok(manifest)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    temp.write_all(bytes)?;
    temp.persist(path).map_err(|e| Error::Io(e.error))?;
    Ok(())
}
fn asset(root: &Path, path: &str, kind: &str) -> Result<Asset> {
    let mut file = File::open(safe_path(root, path)?)?;
    let size = file.metadata()?.len();
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(Asset {
        path: path.into(),
        kind: kind.into(),
        size,
        sha256: hex(&hash.finalize()),
    })
}

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let part = Path::new(relative);
    if part.is_absolute()
        || part
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err(Error::InvalidData("Artifact path escapes bundle".into()));
    }
    let path = root.join(part).canonicalize()?;
    if !path.starts_with(root.canonicalize()?) || !path.is_file() {
        return Err(Error::InvalidData("Artifact path escapes bundle".into()));
    }
    Ok(path)
}
fn mbtiles(root: &Path, plan: &Plan, attribution: &str) -> Result<Connection> {
    let db = Connection::open(root.join("vectors.mbtiles"))?;
    db.execute_batch("CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT);CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB,PRIMARY KEY(zoom_level,tile_column,tile_row));BEGIN;")?;
    for (k, v) in [
        ("name", plan.request.source.name().into()),
        ("format", "pbf".into()),
        ("type", "overlay".into()),
        ("version", "1.3".into()),
        ("description", "GeoD Agent vector tile download".into()),
        (
            "bounds",
            plan.request
                .bounds
                .iter()
                .map(f64::to_string)
                .collect::<Vec<_>>()
                .join(","),
        ),
        ("minzoom", plan.request.zoom_levels[0].to_string()),
        (
            "maxzoom",
            plan.request.zoom_levels.last().unwrap().to_string(),
        ),
        ("attribution", attribution.into()),
    ] {
        db.execute("INSERT INTO metadata VALUES(?1,?2)", params![k, v])?;
    }
    Ok(db)
}

struct FeatureWriter {
    json: Option<BufWriter<File>>,
    gpkg: Option<gpkg::Writer>,
    preview: Vec<Value>,
    count: u64,
}
impl FeatureWriter {
    fn new(root: &Path, outputs: &[OutputFormat]) -> Result<Self> {
        let mut json = if outputs.contains(&OutputFormat::Geojson) {
            Some(BufWriter::new(File::create(root.join("features.geojson"))?))
        } else {
            None
        };
        if let Some(w) = &mut json {
            w.write_all(b"{\"type\":\"FeatureCollection\",\"features\":[")?;
        }
        Ok(Self {
            json,
            gpkg: if outputs.contains(&OutputFormat::Gpkg) {
                Some(gpkg::Writer::new(&root.join("features.gpkg"))?)
            } else {
                None
            },
            preview: vec![],
            count: 0,
        })
    }
    fn add(&mut self, feature: &Value) -> Result<()> {
        gpkg::geometry_bounds(&feature["geometry"])?;
        if let Some(w) = &mut self.json {
            if self.count > 0 {
                w.write_all(b",")?;
            }
            serde_json::to_writer(w, feature)?;
        }
        if let Some(w) = &mut self.gpkg {
            w.insert(feature)?;
        }
        if self.preview.len() < 10000 {
            self.preview.push(feature.clone());
        }
        self.count += 1;
        Ok(())
    }
    fn finish(mut self, root: &Path) -> Result<(u64, u64, Vec<Asset>)> {
        let mut assets = vec![];
        if let Some(mut writer) = self.json.take() {
            writer.write_all(b"]}")?;
            writer.flush()?;
            drop(writer);
            assets.push(asset(root, "features.geojson", "geojson")?);
        }
        if let Some(writer) = self.gpkg.take() {
            writer.finish()?;
            assets.push(asset(root, "features.gpkg", "gpkg")?);
        }
        let preview_count = self.preview.len() as u64;
        fs::write(
            root.join("preview.geojson"),
            serde_json::to_vec(&json!({"type":"FeatureCollection","features":self.preview}))?,
        )?;
        assets.push(asset(root, "preview.geojson", "preview")?);
        Ok((self.count, preview_count, assets))
    }
}

/// Reopen the published bundle, verify every asset hash, SQLite integrity and
/// each preserved PBF tile. Never trust a manifest alone as success evidence.
pub fn inspect(root: &Path) -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_slice(&fs::read(root.join("manifest.json"))?)?;
    if manifest.schema_version != 1
        || manifest
            .assets
            .iter()
            .filter(|a| a.kind == "preview")
            .count()
            != 1
        || !manifest.assets.iter().any(|a| {
            matches!(
                a.kind.as_str(),
                "geojson" | "gpkg" | "mbtiles" | "pbf-index"
            )
        })
        || manifest.preview_feature_count > manifest.feature_count
        || manifest.preview_truncated != (manifest.preview_feature_count < manifest.feature_count)
    {
        return Err(Error::InvalidData(
            "Incomplete vector manifest or preview contract".into(),
        ));
    }
    let mut paths = std::collections::HashSet::new();
    for entry in &manifest.assets {
        if !paths.insert(&entry.path) {
            return Err(Error::InvalidData("Duplicate vector artifact path".into()));
        }
        let relative = Path::new(&entry.path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(Error::InvalidData("Artifact path escapes bundle".into()));
        }
        let actual = asset(root, &entry.path, &entry.kind)?;
        if actual.sha256 != entry.sha256 || actual.size != entry.size {
            return Err(Error::InvalidData(format!(
                "Artifact failed checksum: {}",
                entry.path
            )));
        }
        if matches!(entry.kind.as_str(), "gpkg" | "mbtiles" | "pbf-index") {
            let db = Connection::open_with_flags(
                root.join(&entry.path),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )?;
            let integrity: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if integrity != "ok" {
                return Err(Error::InvalidData(
                    "Vector SQLite integrity check failed".into(),
                ));
            }
            if entry.kind == "gpkg" {
                let(count,srs):(u64,i32)=db.query_row("SELECT (SELECT count(*) FROM features),srs_id FROM gpkg_geometry_columns WHERE table_name='features'",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
                if count != manifest.feature_count || srs != i32::from(geod_core::crs::epsg(&manifest.output_crs).map_err(|e|Error::InvalidData(e.message))?) {
                    return Err(Error::InvalidData(
                        "GeoPackage count or CRS mismatch".into(),
                    ));
                }
            }
            if entry.kind == "mbtiles" {
                let mut stmt =
                    db.prepare("SELECT zoom_level,tile_column,tile_row,tile_data FROM tiles")?;
                let mut rows = stmt.query([])?;
                let mut count = 0;
                while let Some(row) = rows.next()? {
                    let z: u8 = row.get(0)?;
                    let x: u32 = row.get(1)?;
                    let tms: u32 = row.get(2)?;
                    if z > 22 || tms >= (1 << z) {
                        return Err(Error::InvalidData("MBTiles tile address invalid".into()));
                    }
                    let bytes: Vec<u8> = row.get(3)?;
                    if !bytes.starts_with(&[0x1f, 0x8b]) {
                        return Err(Error::InvalidData(
                            "MBTiles MVT must be gzip compressed".into(),
                        ));
                    }
                    mvt::decode(&bytes, z, x, (1 << z) - 1 - tms, &[])?;
                    count += 1;
                }
                if count != manifest.tile_count {
                    return Err(Error::InvalidData("MBTiles tile count mismatch".into()));
                }
            }
            if entry.kind == "pbf-index" {
                let mut stmt = db.prepare("SELECT z,x,y,path,size,sha256 FROM tiles")?;
                let mut rows = stmt.query([])?;
                let mut count = 0;
                while let Some(row) = rows.next()? {
                    let z: u8 = row.get(0)?;
                    let x: u32 = row.get(1)?;
                    let y: u32 = row.get(2)?;
                    let path: String = row.get(3)?;
                    if path != format!("tiles/{z}/{x}/{y}.pbf") {
                        return Err(Error::InvalidData("Unsafe PBF index path".into()));
                    }
                    let bytes = fs::read(safe_path(root, &path)?)?;
                    let size: u64 = row.get(4)?;
                    let hash: String = row.get(5)?;
                    if size != bytes.len() as u64 || hash != hex(&Sha256::digest(&bytes)) {
                        return Err(Error::InvalidData("PBF tile failed checksum".into()));
                    }
                    mvt::decode(&bytes, z, x, y, &[])?;
                    count += 1;
                }
                if count != manifest.tile_count {
                    return Err(Error::InvalidData("PBF tile count mismatch".into()));
                }
            }
        }
        if entry.kind == "preview" {
            let preview: Value = serde_json::from_slice(&fs::read(root.join(&entry.path))?)?;
            if preview["type"] != "FeatureCollection"
                || preview["features"].as_array().map(Vec::len)
                    != Some(manifest.preview_feature_count as usize)
            {
                return Err(Error::InvalidData("Preview feature count mismatch".into()));
            }
        }
        if entry.kind == "geojson" {
            let collection: CheckedCollection = serde_json::from_reader(std::io::BufReader::new(
                File::open(root.join(&entry.path))?,
            ))?;
            if collection.kind != "FeatureCollection"
                || collection.features != manifest.feature_count
            {
                return Err(Error::InvalidData(
                    "GeoJSON feature count or type mismatch".into(),
                ));
            }
        }
    }
    Ok(manifest)
}

#[derive(Deserialize)]
struct CheckedCollection {
    #[serde(rename = "type")]
    kind: String,
    #[serde(deserialize_with = "count_checked_features")]
    features: u64,
}
fn count_checked_features<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<u64, D::Error> {
    struct Features;
    impl<'de> serde::de::Visitor<'de> for Features {
        type Value = u64;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("a GeoJSON features array")
        }
        fn visit_seq<A: serde::de::SeqAccess<'de>>(
            self,
            mut seq: A,
        ) -> std::result::Result<u64, A::Error> {
            let mut count = 0u64;
            // One feature at a time, including for multi-gigabyte GeoJSON files.
            while let Some(feature) = seq.next_element::<Value>()? {
                if feature["type"] != "Feature" {
                    return Err(serde::de::Error::custom("Invalid GeoJSON feature type"));
                }
                gpkg::geometry_bounds(&feature["geometry"]).map_err(serde::de::Error::custom)?;
                count = count
                    .checked_add(1)
                    .ok_or_else(|| serde::de::Error::custom("Feature count overflow"))?;
            }
            Ok(count)
        }
    }
    deserializer.deserialize_seq(Features)
}

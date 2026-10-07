//! Bounded local raster acquisition and publication. The caller must supply an
//! already approved plan and a source from the trusted local source registry.

use crate::{
    boundary::{mask_rgba, BoundaryGeometry},
    tile::{self, TileGrid},
};
use chrono::Utc;
use futures_util::{stream::FuturesUnordered, StreamExt};
use image::{ImageEncoder, ImageReader, RgbaImage};
use reqwest::{
    header::{HeaderValue, CONTENT_TYPE, RETRY_AFTER},
    redirect::Policy,
    Client, Url,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File},
    io::{Cursor, Read},
    net::IpAddr,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tiff::{
    decoder::Decoder,
    encoder::TiffEncoder,
    tags::Tag,
};
use uuid::Uuid;

const MAX_TILE_BYTES: usize = 16 * 1024 * 1024;
// Decoded volume is a disk/output estimate. Streaming export does not allocate
// the complete mosaic; peak strip memory is bounded separately.
const MAX_DECODED_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const DISK_FIXED_RESERVE_BYTES: u64 = 16 * 1024 * 1024;
const DISK_TILE_OVERHEAD_BYTES: u64 = 32 * 1024;

/// Conservative free-space budget for cache, staged raster outputs, and metadata.
/// This is a preflight guard, not an exact output-size prediction.
pub fn required_free_disk_bytes(tile_count: u64, tile_size: u16) -> Result<u64, CoreError> {
    required_free_disk_bytes_for_outputs(tile_count, tile_size, 2, false)
}

/// Each selected format can coexist with both checkpoint and shared cache.
/// Allow a complete extra image for pyramid levels and compression overhead.
pub fn required_free_disk_bytes_for_outputs(tile_count: u64, tile_size: u16, output_count: usize, pyramid: bool) -> Result<u64, CoreError> {
    let copies = u64::try_from(output_count.max(2)).ok()
        .and_then(|count| count.checked_add(2 + u64::from(pyramid)))
        .ok_or_else(|| CoreError::new("RESOURCE_LIMIT", "Disk budget overflow"))?;
    tile_count
        .checked_mul(u64::from(tile_size).pow(2))
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|rgba| rgba.checked_mul(copies))
        .and_then(|bytes| {
            tile_count
                .checked_mul(DISK_TILE_OVERHEAD_BYTES)
                .and_then(|overhead| bytes.checked_add(overhead))
        })
        .and_then(|bytes| bytes.checked_add(DISK_FIXED_RESERVE_BYTES))
        .ok_or_else(|| CoreError::new("RESOURCE_LIMIT", "Disk budget overflow"))
}

fn ensure_disk_budget(path: &Path, required: u64) -> Result<(), CoreError> {
    let available = fs4::available_space(path).map_err(|cause| {
        CoreError::new(
            "DISK_CHECK_FAILED",
            format!("Cannot check free disk space: {cause}"),
        )
    })?;
    if available < required {
        return Err(CoreError::new(
            "DISK_INSUFFICIENT",
            format!(
                "Need at least {required} free bytes; {available} available at {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod disk_tests {
    use super::*;

    #[test]
    fn disk_preflight_rejects_unavailable_budget() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            ensure_disk_budget(dir.path(), u64::MAX).unwrap_err().code,
            "DISK_INSUFFICIENT"
        );
        assert!(ensure_disk_budget(dir.path(), 0).is_ok());
        assert_eq!(
            required_free_disk_bytes(u64::MAX, 512).unwrap_err().code,
            "RESOURCE_LIMIT"
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NetworkPolicy {
    PublicHttps,
    UserTrustedHttp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TileScheme {
    XYZ,
    TMS,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpSource {
    pub id: String,
    pub name: String,
    pub attribution: String,
    pub license: String,
    pub url_template: String,
    pub scheme: TileScheme,
    pub tile_size: u16,
    pub network_policy: NetworkPolicy,
    /// Delay before a download lane starts its next request. Concurrent lanes
    /// remain independent; server Retry-After pauses every lane together.
    pub min_interval_ms: u64,
    /// Explicit DNS-label substitutions for {s}; never a hostname wildcard.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subdomains: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coordinate_system: Option<CoordinateSystem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elevation_encoding: Option<ElevationEncoding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub authentication: Option<SourceAuthentication>,
    /// Native-only secret: never serialized into settings, plans or manifests.
    #[serde(skip)]
    pub runtime_token: Option<RuntimeToken>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceAuthentication {
    pub mode: AuthenticationMode,
    pub parameter: String,
    pub credential_ref: String,
    pub version: String,
    pub origin: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthenticationMode { QueryToken, BearerToken, HeaderToken }

#[derive(Clone)]
pub struct RuntimeToken(pub String);
impl std::fmt::Debug for RuntimeToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("[redacted]") }
}

impl HttpSource {
    /// The URL template must be credential-free. Authentication uses a separate
    /// credential reference in the source registry; secrets are native-only.
    pub fn configuration_revision(&self) -> String {
        let material = serde_json::to_vec(&(
            &self.id,
            &self.url_template,
            self.scheme,
            self.tile_size,
            self.network_policy,
            self.min_interval_ms,
        ))
        .expect("source configuration is serializable");
        let mut previous = format!("{:x}", Sha256::digest(material));
        if !self.subdomains.is_empty() { previous=format!("{:x}",Sha256::digest(serde_json::to_vec(&(previous,&self.subdomains)).expect("subdomains serializable"))); }
        if self.coordinate_system == Some(CoordinateSystem::Gcj02) { previous=format!("{:x}",Sha256::digest(serde_json::to_vec(&(previous,self.coordinate_system)).expect("coordinates serializable"))); }
        if let Some(encoding)=self.elevation_encoding {previous=format!("{:x}",Sha256::digest(serde_json::to_vec(&(previous,encoding)).expect("encoding serializable")));}
        match &self.authentication {
            None => previous,
            Some(auth) => format!("{:x}", Sha256::digest(serde_json::to_vec(&(previous, auth)).expect("authentication metadata is serializable"))),
        }
    }

    pub fn validate(&self) -> Result<(), CoreError> {
        validate_source(self)
    }

    /// Exact origins implied by this source's fixed template and explicit labels.
    /// Authentication is bound to the first origin; requests may use this list.
    pub fn request_origins(&self) -> Result<Vec<String>, CoreError> {
        Ok(expanded_sample_urls(self)?.iter().map(|url| url.origin().ascii_serialization()).collect())
    }
}

#[derive(Debug, Clone)]
pub struct ImageryRequest {
    pub name: String,
    pub bounds: [f64; 4],
    pub boundary: Option<BoundaryGeometry>,
    pub grids: Vec<TileGrid>,
    pub output_geotiff: bool,
    pub output_mbtiles: bool,
    pub extra_outputs: Vec<ExtraOutput>,
    pub export_options: ExportOptions,
    /// Resolved native sources; never populated from arbitrary model URLs.
    pub overlays: Vec<HttpSource>,
    pub max_tiles: u64,
    pub max_decoded_rgba_bytes: u64,
    pub destination: PathBuf,
    pub deadline: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ExtraOutput { Png, Jpeg, GeoPackage, Tiles }

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum TiffCompression { #[default] None, Lzw, Deflate }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")] pub target_crs: Option<String>,
    #[serde(default, skip_serializing_if = "RasterResampling::is_nearest")] pub resampling: RasterResampling,
    /// Explicitly export verified cached tiles; never make a tile network request.
    #[serde(default, skip_serializing_if = "is_false")] pub cache_only: bool,
    /// A recovery plan keeps previously verified pixels even after the normal
    /// freshness window. Hash, size, decoding and source revision still apply.
    #[serde(default, skip_serializing_if = "is_false")] pub reuse_verified_cache: bool,
    #[serde(default)] pub compression: TiffCompression,
    #[serde(default)] pub build_pyramid: bool,
    #[serde(default)] pub generate_sidecars: bool,
    #[serde(default = "default_jpeg_quality")] pub jpeg_quality: u8,
    #[serde(default, skip_serializing_if = "Vec::is_empty")] pub overlay_sources: Vec<OverlaySourceRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub elevation_encoding: Option<ElevationEncoding>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OverlaySourceRef { pub source_id: String, pub config_revision: String }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ElevationEncoding { Terrarium }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RasterResampling { #[default] Nearest, Bilinear, Cubic }
impl RasterResampling { fn is_nearest(&self)->bool{*self==Self::Nearest} }
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectedRaster { pub width: u32, pub height: u32, pub geo_transform: [f64; 6], pub crs_definition: String }
/// The optional application-owned runtime runs before atomic publication.
pub trait RasterProjector: Send + Sync {
    fn reproject<'a>(&'a self, path: &'a Path, bounds: [f64; 4], options: &'a ExportOptions,
        cancelled: &'a AtomicBool, paused: Option<&'a AtomicBool>)
        -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ProjectedRaster, CoreError>> + Send + 'a>>;
}
fn default_jpeg_quality() -> u8 { 90 }
fn is_false(value: &bool) -> bool { !*value }
impl Default for ExportOptions {
    fn default() -> Self { Self { target_crs: None, resampling: RasterResampling::Nearest, cache_only: false, reuse_verified_cache: false, compression: TiffCompression::None, build_pyramid: false, generate_sidecars: false, jpeg_quality: 90, overlay_sources: Vec::new(), elevation_encoding: None } }
}

/// An app-owned cache directory lets a previously approved job resume after
/// process interruption. The source revision and plan hash bind cached tiles
/// to the exact request; every cached image is checked against SQLite SHA-256.
pub struct TileCacheConfig {
    pub root: PathBuf,
    pub plan_hash: String,
    pub job_id: String,
}

/// Execution settings do not change the approved imagery or its plan hash.
#[derive(Debug, Clone, Copy)]
pub struct DownloadOptions {
    pub concurrency: usize,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        // Match the established GeoDownloader desktop default.
        Self { concurrency: 30 }
    }
}

struct DownloadedTile {
    image: RgbaImage,
    bytes: Vec<u8>,
}

struct TileCache {
    root: PathBuf,
    conn: Connection,
    shared: shared_tile_cache::SharedTileCache,
    allow_stale: bool,
}

impl TileCache {
    fn open(config: &TileCacheConfig, source: &HttpSource, overlays: &[OverlaySourceRef], allow_stale: bool) -> Result<Self, CoreError> {
        if !config.root.is_absolute()
            || config
                .root
                .components()
                .any(|component| matches!(component, Component::ParentDir))
            || config.plan_hash.len() != 64
            || !config
                .plan_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || Uuid::parse_str(&config.job_id).is_err()
        {
            return Err(CoreError::new(
                "INVALID_CACHE",
                "Cache path or plan hash is invalid",
            ));
        }
        if let Ok(metadata) = fs::symlink_metadata(&config.root) {
            if metadata.file_type().is_symlink() {
                return Err(CoreError::new(
                    "INVALID_CACHE",
                    "Cache root must not be a symlink",
                ));
            }
        }
        fs::create_dir_all(&config.root).map_err(io_error)?;
        let conn = Connection::open(config.root.join("tiles.sqlite")).map_err(io_error)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(io_error)?;
        conn.execute_batch("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS tiles (zoom INTEGER NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL,
            bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(zoom,x,y));").map_err(io_error)?;
        let mut binding = format!("{}:{}", config.plan_hash, source.configuration_revision());
        if !overlays.is_empty() { binding.push_str(&format!(":{:x}", Sha256::digest(serde_json::to_vec(overlays).map_err(io_error)?))); }
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM metadata WHERE key='binding'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(io_error)?;
        if let Some(existing) = existing {
            if existing != binding {
                return Err(CoreError::new(
                    "PLAN_STALE",
                    "Tile cache belongs to another plan or source",
                ));
            }
        } else {
            let count: u64 = conn
                .query_row("SELECT count(*) FROM tiles", [], |row| row.get(0))
                .map_err(io_error)?;
            if count > 0 {
                return Err(CoreError::new(
                    "INVALID_CACHE",
                    "Tile cache metadata is missing",
                ));
            }
            conn.execute(
                "INSERT INTO metadata(key,value) VALUES ('binding',?1)",
                [binding],
            )
            .map_err(io_error)?;
        }
        Ok(Self {
            root: config.root.clone(),
            conn,
            shared: shared_tile_cache::SharedTileCache::open(&config.root, source, overlays)?,
            allow_stale,
        })
    }
    fn path(&self, z: u8, x: u32, y: u32) -> PathBuf {
        self.root.join(format!("z{z}-x{x}-y{y}.png"))
    }
    fn load(
        &mut self,
        z: u8,
        x: u32,
        y: u32,
        tile_size: u16,
    ) -> Result<Option<DownloadedTile>, CoreError> {
        let checkpoint: Option<(u64, String)> = self
            .conn
            .query_row(
                "SELECT bytes,sha256 FROM tiles WHERE zoom=?1 AND x=?2 AND y=?3",
                params![z, x, y],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(io_error)?;
        let Some((expected_bytes, expected_hash)) = checkpoint else {
            if let Some(tile)=self.shared.load(z,x,y,tile_size,self.allow_stale)? {self.save_checkpoint(z,x,y,&tile.bytes,false)?;return Ok(Some(tile));}
            return Ok(None);
        };
        let path = self.path(z, x, y);
        let bytes = fs::read(&path).unwrap_or_default();
        if bytes.len() as u64 == expected_bytes
            && bytes.len() <= MAX_TILE_BYTES
            && format!("{:x}", Sha256::digest(&bytes)) == expected_hash
        {
            if let Ok(image) = image::load_from_memory(&bytes) {
                if image.width() == u32::from(tile_size) && image.height() == u32::from(tile_size) {
                    return Ok(Some(DownloadedTile {
                        image: image.to_rgba8(),
                        bytes,
                    }));
                }
            }
        }
        self.conn
            .execute(
                "DELETE FROM tiles WHERE zoom=?1 AND x=?2 AND y=?3",
                params![z, x, y],
            )
            .map_err(io_error)?;
        let _ = fs::remove_file(path);
        if let Some(tile)=self.shared.load(z,x,y,tile_size,self.allow_stale)? {self.save_checkpoint(z,x,y,&tile.bytes,false)?;return Ok(Some(tile));}
        Ok(None)
    }
    fn save(&mut self, z: u8, x: u32, y: u32, bytes: &[u8]) -> Result<(), CoreError> {
        self.save_checkpoint(z,x,y,bytes,true)
    }
    fn save_checkpoint(&mut self, z: u8, x: u32, y: u32, bytes: &[u8], publish: bool) -> Result<(), CoreError> {
        // Keep the original validated JPEG/PNG/WebP. The historical .png path
        // stays compatible: cache reads detect the format from file contents.
        if bytes.len() > MAX_TILE_BYTES {
            return Err(CoreError::new(
                "INVALID_TILE",
                "Encoded tile exceeds 16 MiB",
            ));
        }
        let temporary = self.root.join(format!(".tile-{}.tmp", Uuid::new_v4()));
        let mut file = File::create(&temporary).map_err(io_error)?;
        use std::io::Write as _;
        file.write_all(&bytes).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        drop(file);
        let target = self.path(z, x, y);
        if target.exists() {
            fs::remove_file(&target).map_err(io_error)?;
        }
        fs::rename(&temporary, target).map_err(io_error)?;
        let sha = format!("{:x}", Sha256::digest(&bytes));
        self.conn
            .execute(
                "INSERT OR REPLACE INTO tiles(zoom,x,y,bytes,sha256) VALUES (?1,?2,?3,?4,?5)",
                params![z, x, y, bytes.len(), sha],
            )
            .map_err(io_error)?;
        // Reusing a cache entry must not renew its source-retrieval timestamp.
        if publish { self.shared.save(z,x,y,bytes)?; }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub id: String,
    pub kind: String,
    pub role: String,
    pub path: String,
    pub mime_type: String,
    pub bytes: u64,
    pub sha256: String,
    pub crs: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crs_definition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geo_transform: Option<[f64; 6]>,
    pub bounds: [f64; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Quality {
    pub status: String,
    pub missing_tiles: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<MissingTile>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MissingTile {
    pub zoom: u8,
    pub x: u32,
    pub y: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Provenance {
    pub source: String,
    pub attribution: String,
    pub retrieved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: String,
    pub kind: String,
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub bounds: [f64; 4],
    pub assets: Vec<Asset>,
    pub layers: Vec<serde_json::Value>,
    pub quality: Quality,
    pub provenance: Vec<Provenance>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreError {
    pub code: &'static str,
    pub message: String,
}

impl CoreError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn io_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::new("IO_ERROR", error.to_string())
}

impl HttpSource {
    /// Validate parameters for configuration, independently of download policy.
    pub fn validate_configuration(&self) -> Result<(), CoreError> {
        validate_source_configuration(self)
    }
}

fn validate_source(source: &HttpSource) -> Result<(), CoreError> {
    validate_source_configuration(source)?;
    let url = expanded_sample_urls(source)?.remove(0);
    let host = url.host_str().unwrap().to_ascii_lowercase();
    if host == "tile.openstreetmap.org" || host.ends_with(".tile.openstreetmap.org") {
        return Err(CoreError::new(
            "SOURCE_UNAUTHORIZED",
            "The OSM standard tile service does not permit bulk download jobs",
        ));
    }
    Ok(())
}

fn expanded_sample_urls(source: &HttpSource) -> Result<Vec<Url>,CoreError> {
    let uses_shards=source.url_template.contains("{s}");
    if uses_shards != !source.subdomains.is_empty() || source.subdomains.len()>16 {
        return Err(CoreError::new("INVALID_SOURCE_SUBDOMAINS","{s} requires an explicit list of 1 to 16 subdomain labels"));
    }
    let mut unique=HashSet::new();
    for label in &source.subdomains {
        if label.is_empty() || label.len()>63 || label.starts_with('-') || label.ends_with('-')
            || !label.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-') || !unique.insert(label.to_ascii_lowercase()) {
            return Err(CoreError::new("INVALID_SOURCE_SUBDOMAINS","Subdomains must be unique DNS labels without dots, slashes or credentials"));
        }
    }
    let sample=source.url_template.replace("{z}","0").replace("{x}","0").replace("{y}","0");
    if uses_shards {
        let marker="geod-shard-marker";
        let parsed=Url::parse(&sample.replace("{s}",marker)).map_err(|_|CoreError::new("INVALID_SOURCE","Invalid URL template"))?;
        if source.url_template.matches("{s}").count()!=1 || !parsed.host_str().is_some_and(|host|host.contains(marker)) {
            return Err(CoreError::new("INVALID_SOURCE_SUBDOMAINS","{s} may appear once in the URL hostname only"));
        }
    }
    let labels=if uses_shards {source.subdomains.clone()} else {vec![String::new()]};
    labels.iter().map(|label| {
        let expanded=sample.replace("{s}",label);
        if expanded.contains('{') || expanded.contains('}') {return Err(CoreError::new("INVALID_SOURCE","Unsupported template placeholder"));}
        Url::parse(&expanded).map_err(|_|CoreError::new("INVALID_SOURCE","Invalid tile URL template"))
    }).collect()
}

fn validate_source_configuration(source: &HttpSource) -> Result<(), CoreError> {
    if source.id.trim().is_empty()
        || source.name.trim().is_empty()
        || !matches!(source.tile_size, 256 | 512)
        || !(is_arcgis_image_server(&source.url_template)
            || ["{z}", "{x}", "{y}"]
                .iter()
                .all(|token| source.url_template.contains(token)))
    {
        return Err(CoreError::new(
            "INVALID_SOURCE",
            "Source metadata or XYZ template is incomplete",
        ));
    }
    if source.coordinate_system == Some(CoordinateSystem::Gcj02) && source.elevation_encoding.is_some() {
        return Err(CoreError::new("SOURCE_COORDINATES_UNSUPPORTED","Terrarium elevation cannot use colour-channel bilinear coordinate resampling"));
    }
    let urls=expanded_sample_urls(source)?;
    let canonical_origin=urls[0].origin().ascii_serialization();
    for url in urls {
    if url.username() != ""
        || url.password().is_some()
        || url.host_str().is_none()
        || url.fragment().is_some()
    {
        return Err(CoreError::new(
            "INVALID_SOURCE",
            "Source template must not contain embedded credentials or fragments",
        ));
    }
    if url.query_pairs().any(|(key, _)| is_secret_parameter(&key)) {
        return Err(CoreError::new("SOURCE_TOKEN_IN_URL", "Enter the token in the separate authentication field"));
    }
    if let Some(auth) = &source.authentication {
        if auth.origin != canonical_origin || auth.credential_ref.is_empty() || auth.version.is_empty()
            || auth.parameter.is_empty() || auth.parameter.len() > 80
            || !auth.parameter.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')) {
            return Err(CoreError::new("INVALID_SOURCE_AUTH", "Invalid source authentication binding"));
        }
        if auth.mode == AuthenticationMode::HeaderToken {
            let name = auth.parameter.to_ascii_lowercase();
            if ["host", "cookie", "proxy-authorization", "content-length", "connection"].contains(&name.as_str()) {
                return Err(CoreError::new("INVALID_SOURCE_AUTH", "Unsupported authentication header"));
            }
        }
        if url.query_pairs().any(|(key, _)| key.eq_ignore_ascii_case(&auth.parameter)) {
            return Err(CoreError::new("SOURCE_TOKEN_IN_URL", "Authentication parameter must be stored separately"));
        }
    }
    if is_arcgis_image_server(&source.url_template) && source.scheme != TileScheme::XYZ {
        return Err(CoreError::new(
            "INVALID_SOURCE",
            "ArcGIS ImageServer uses XYZ tile coordinates",
        ));
    }
    let host = url.host_str().unwrap().to_ascii_lowercase();
    if host.ends_with(".tianditu.gov.cn") && url.path().ends_with("_c/wmts") {
        return Err(CoreError::new("SOURCE_GRID_UNSUPPORTED", "天地图经纬度网格尚未适配，请使用图源预设中的 Web Mercator 服务"));
    }
    match source.network_policy {
        NetworkPolicy::PublicHttps => {
            if url.scheme() != "https"
                || host == "localhost"
                || host.ends_with(".localhost")
                || host.parse::<IpAddr>().is_ok()
                || host.ends_with(".local")
                || host.ends_with(".internal")
            {
                return Err(CoreError::new(
                    "SOURCE_UNAUTHORIZED",
                    "Public sources require a public HTTPS endpoint",
                ));
            }
        }
        NetworkPolicy::UserTrustedHttp => {
            if !matches!(url.scheme(), "http" | "https") {
                return Err(CoreError::new(
                    "INVALID_SOURCE",
                    "Trusted sources require HTTP or HTTPS",
                ));
            }
        }
    }
    }
    Ok(())
}

fn is_arcgis_image_server(template: &str) -> bool {
    Url::parse(template).is_ok_and(|url| url.path().ends_with("/ImageServer/exportImage"))
        && !template.contains('{')
        && !template.contains('}')
}

pub fn is_secret_parameter(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "tk" | "token" | "access_token" | "api_key" | "apikey" | "key" | "authorization" | "signature" | "sig")
}

pub fn authenticated_request(client: &Client, mut url: Url, source: &HttpSource) -> Result<reqwest::RequestBuilder, CoreError> {
    let Some(auth) = &source.authentication else { return Ok(client.get(url)); };
    let origins=source.request_origins()?;
    if origins.first()!=Some(&auth.origin) || !origins.contains(&url.origin().ascii_serialization()) { return Err(CoreError::new("INVALID_SOURCE_AUTH", "Authentication origin changed")); }
    let token = source.runtime_token.as_ref().ok_or_else(|| CoreError::new("SOURCE_CREDENTIAL_REQUIRED", "Save the source token before requesting tiles"))?;
    if token.0.is_empty() || token.0.len() > 4096 || token.0.chars().any(char::is_control) { return Err(CoreError::new("INVALID_SOURCE_AUTH", "Invalid token")); }
    match auth.mode {
        AuthenticationMode::QueryToken => {
            // Same-origin redirects may repeat or echo a token parameter. Keep
            // exactly the current keyring value, never a server-supplied token.
            let pairs=url.query_pairs().filter(|(key,_)|key.as_ref()!=auth.parameter).map(|(key,value)|(key.into_owned(),value.into_owned())).collect::<Vec<_>>();
            url.set_query(None);url.query_pairs_mut().extend_pairs(pairs).append_pair(&auth.parameter,&token.0);
            Ok(client.get(url))
        },
        AuthenticationMode::BearerToken => Ok(client.get(url).bearer_auth(&token.0)),
        AuthenticationMode::HeaderToken => {
            let name = reqwest::header::HeaderName::from_bytes(auth.parameter.as_bytes()).map_err(|_| CoreError::new("INVALID_SOURCE_AUTH", "Invalid authentication header"))?;
            let mut value = reqwest::header::HeaderValue::from_str(&token.0).map_err(|_| CoreError::new("INVALID_SOURCE_AUTH", "Invalid header token"))?;
            value.set_sensitive(true); Ok(client.get(url).header(name, value))
        },
    }
}

pub async fn fetch_preview_tile(source: &HttpSource, zoom: u8, x: u32, y: u32, proxy: ProxyRoute<'_>) -> Result<Vec<u8>, CoreError> {
    let url = preview_tile_url(source, zoom, x, y)?;
    let builder = Client::builder().redirect(Policy::none()).timeout(Duration::from_secs(25)).user_agent("GeoD-Agent/0.1");
    let builder = match proxy { ProxyRoute::Environment => builder, ProxyRoute::Direct => builder.no_proxy(), ProxyRoute::Http(url) => builder.no_proxy().proxy(reqwest::Proxy::all(url).map_err(|_| CoreError::new("SOURCE_NETWORK", "Invalid proxy"))?) };
    let client = builder.build().map_err(|_| CoreError::new("SOURCE_NETWORK", "Unable to create source connection"))?;
    if source.coordinate_system==Some(CoordinateSystem::Gcj02) {
        get_registered_tile(&client,source,zoom,x,y,&AtomicBool::new(false),None,Instant::now(),Duration::from_secs(90),&Mutex::new(Instant::now())).await.map(|tile|tile.bytes)
    } else { get_tile(&client, url, source, &mut None).await.map(|tile| tile.bytes) }
}

fn validate_request(request: &ImageryRequest, source: &HttpSource) -> Result<(), CoreError> {
    validate_source(source)?;
    if let Some(crs) = &request.export_options.target_crs {
        if crate::crs::normalize(crs)? != *crs { return Err(CoreError::new("INVALID_OUTPUT_CRS", "坐标系需要标准 EPSG 编号")); }
        if crs != "EPSG:3857" && (request.output_mbtiles || request.extra_outputs.iter().any(|f|matches!(f, ExtraOutput::GeoPackage | ExtraOutput::Tiles))) {
            return Err(CoreError::new("OUTPUT_CRS_FORMAT_CONFLICT", "MBTiles、瓦片 GeoPackage 和原始瓦片固定使用 EPSG:3857；请另选 GeoTIFF、PNG 或 JPEG"));
        }
    }
    if source.elevation_encoding.is_some() && source.elevation_encoding!=request.export_options.elevation_encoding {
        return Err(CoreError::new("INVALID_DEM_OUTPUT","An elevation source must produce its declared height encoding"));
    }
    if request.overlays.len() != request.export_options.overlay_sources.len() || request.overlays.len() > 4 {
        return Err(CoreError::new("INVALID_OVERLAY", "Overlay sources must be resolved before execution"));
    }
    for (overlay, reference) in request.overlays.iter().zip(&request.export_options.overlay_sources) {
        overlay.validate()?;
        if overlay.id != reference.source_id || overlay.configuration_revision() != reference.config_revision || overlay.tile_size != source.tile_size {
            return Err(CoreError::new("PLAN_STALE", "Overlay configuration or pixel grid changed"));
        }
    }
    if request.export_options.elevation_encoding.is_some() && (!request.output_geotiff || request.output_mbtiles || !request.extra_outputs.is_empty() || !request.overlays.is_empty()) {
        return Err(CoreError::new("INVALID_DEM_OUTPUT", "Elevation export requires GeoTIFF only and no annotation overlays"));
    }
    if request.name.trim().is_empty()
        || !request.destination.is_absolute()
        || request
            .destination
            .components()
            .any(|c| matches!(c, Component::ParentDir))
        || (!request.output_geotiff && !request.output_mbtiles && request.extra_outputs.is_empty())
        || request.grids.is_empty()
        || request.max_tiles == 0
        || request.max_decoded_rgba_bytes == 0
        || request.max_decoded_rgba_bytes > MAX_DECODED_BYTES
        || request.deadline.is_zero()
        || !(1..=100).contains(&request.export_options.jpeg_quality)
    {
        return Err(CoreError::new(
            "INVALID_SPEC",
            "Invalid output, limits, or grid selection",
        ));
    }
    if let Some(boundary) = &request.boundary {
        let mut normalized = boundary.clone();
        let bounds = normalized
            .normalize()
            .map_err(|cause| CoreError::new("INVALID_BOUNDARY", cause.0))?;
        if normalized != *boundary || bounds != request.bounds || !(request.output_geotiff || request.extra_outputs.iter().any(|f| matches!(f, ExtraOutput::Png | ExtraOutput::Jpeg))) {
            return Err(CoreError::new(
                "INVALID_BOUNDARY",
                "Boundary must be normalized, match the plan extent, and include GeoTIFF, PNG or JPEG output",
            ));
        }
    }
    let mut count = 0u64;
    let mut bytes = 0u64;
    let mut zooms = std::collections::HashSet::new();
    for grid in &request.grids {
        if !zooms.insert(grid.zoom) {
            return Err(CoreError::new(
                "INVALID_SPEC",
                "Duplicate zoom grids are not allowed",
            ));
        }
        let actual = tile::grid(request.bounds, grid.zoom, source.tile_size)
            .map_err(|reason| CoreError::new("INVALID_SPEC", reason))?;
        if !actual.matches_persisted(grid) {
            return Err(CoreError::new(
                "PLAN_STALE",
                "Tile grid does not match the approved bounds and source",
            ));
        }
        count = count
            .checked_add(grid.tile_count)
            .ok_or_else(|| CoreError::new("RESOURCE_LIMIT", "Tile count overflow"))?;
        bytes = bytes
            .checked_add(grid.tile_count * u64::from(source.tile_size).pow(2) * 4)
            .ok_or_else(|| CoreError::new("RESOURCE_LIMIT", "Decoded byte count overflow"))?;
    }
    if count > request.max_tiles || bytes > request.max_decoded_rgba_bytes {
        return Err(CoreError::new(
            "RESOURCE_LIMIT",
            "Approved tile or decoded byte limit exceeded",
        ));
    }
    if request.destination.exists() {
        return Err(CoreError::new(
            "OUTPUT_CONFLICT",
            "Output directory already exists",
        ));
    }
    Ok(())
}

fn tile_url(source: &HttpSource, grid: &TileGrid, x: u32, y: u32) -> Result<Url, CoreError> {
    tile_url_at(source, grid.zoom, x, y)
}

/// URL for an interactive map tile, using the same XYZ/TMS/ImageServer math.
pub fn preview_tile_url(source: &HttpSource, zoom: u8, x: u32, y: u32) -> Result<Url, CoreError> {
    source.validate_configuration()?;
    if zoom > 22 || x >= (1u32 << zoom) || y >= (1u32 << zoom) {
        return Err(CoreError::new(
            "MAP_TILE_INVALID",
            "Invalid viewport tile coordinate",
        ));
    }
    tile_url_at(source, zoom, x, y)
}

fn tile_url_at(source: &HttpSource, zoom: u8, x: u32, y: u32) -> Result<Url, CoreError> {
    if is_arcgis_image_server(&source.url_template) {
        let mut url = Url::parse(&source.url_template)
            .map_err(|_| CoreError::new("INVALID_SOURCE", "Invalid ArcGIS ImageServer URL"))?;
        let half_world = std::f64::consts::PI * 6_378_137.0;
        let tile_width = 2.0 * half_world / (1u32 << zoom) as f64;
        let min_x = -half_world + f64::from(x) * tile_width;
        let max_x = min_x + tile_width;
        let max_y = half_world - f64::from(y) * tile_width;
        let min_y = max_y - tile_width;
        url.query_pairs_mut()
            .append_pair("bbox", &format!("{min_x},{min_y},{max_x},{max_y}"))
            .append_pair("bboxSR", "3857")
            .append_pair("imageSR", "3857")
            .append_pair(
                "size",
                &format!("{},{}", source.tile_size, source.tile_size),
            )
            .append_pair("format", "png32")
            .append_pair("f", "image");
        return Ok(url);
    }
    let y_source = match source.scheme {
        TileScheme::XYZ => y,
        TileScheme::TMS => (1u32 << zoom) - 1 - y,
    };
    let value = source
        .url_template
        .replace("{s}", if source.subdomains.is_empty() { "" } else { &source.subdomains[((u64::from(x)+u64::from(y)+u64::from(zoom)) % source.subdomains.len() as u64) as usize] })
        .replace("{z}", &zoom.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y_source.to_string());
    Url::parse(&value).map_err(|_| CoreError::new("INVALID_SOURCE", "Invalid generated tile URL"))
}

fn retry_after_delay(header: &HeaderValue) -> Option<Duration> {
    let value = header.to_str().ok()?.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let date = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    Some(
        date.signed_duration_since(Utc::now())
            .to_std()
            .unwrap_or_default(),
    )
}

async fn get_tile(
    client: &Client,
    url: Url,
    source: &HttpSource,
    retry_after: &mut Option<Duration>,
) -> Result<DownloadedTile, CoreError> {
    let tile_size = source.tile_size;
    let original_origin=url.origin();let mut target=url;let mut hops=0;
    let mut response = loop {
        let response=authenticated_request(client,target.clone(),source)?.send().await
            .map_err(|e|CoreError::new("SOURCE_NETWORK",e.without_url().to_string()))?;
        if !response.status().is_redirection(){break response;}
        if hops>=5 {return Err(CoreError::new("SOURCE_REDIRECT_LIMIT","Tile service redirected more than five times"));}
        let location=response.headers().get(reqwest::header::LOCATION).and_then(|value|value.to_str().ok())
            .ok_or_else(||CoreError::new("SOURCE_REDIRECT_INVALID","Tile redirect has no valid location"))?;
        let next=target.join(location).map_err(|_|CoreError::new("SOURCE_REDIRECT_INVALID","Tile redirect location is invalid"))?;
        if next.origin()!=original_origin || !next.username().is_empty() || next.password().is_some() {
            return Err(CoreError::new("SOURCE_REDIRECT_DENIED","Tile redirects must remain on the configured source origin"));
        }
        target=next;hops+=1;
    };
    let status = response.status();
    if status.as_u16() == 429 || status.is_server_error() {
        *retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(retry_after_delay);
    }
    if matches!(status.as_u16(), 401 | 403) {
        return Err(CoreError::new(
            if source.authentication.is_some() { "SOURCE_CREDENTIAL_REJECTED" } else { "SOURCE_UNAUTHORIZED" },
            if source.authentication.is_some() { "图源拒绝了 Token，请在图源设置中检查 Key/Token 及服务类型。".into() } else { format!("Tile service returned HTTP {}", status.as_u16()) },
        ));
    }
    if matches!(status.as_u16(), 404 | 410) {
        return Err(CoreError::new(
            "SOURCE_TILE_MISSING",
            format!("Tile service returned HTTP {}", status.as_u16()),
        ));
    }
    if status.as_u16() == 429 {
        return Err(CoreError::new(
            "SOURCE_RATE_LIMITED",
            "Tile service returned HTTP 429",
        ));
    }
    if status.is_server_error() {
        return Err(CoreError::new(
            "SOURCE_TEMPORARY",
            format!("Tile service returned HTTP {}", status.as_u16()),
        ));
    }
    if !status.is_success() {
        return Err(CoreError::new(
            "SOURCE_UNAVAILABLE",
            format!("Tile service returned HTTP {}", status.as_u16()),
        ));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    // Tianditu returns JPEG tiles using its legacy image/jpg media type.
    // The bytes are still decoded and dimensions checked below.
    let media_type = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if !["image/png", "image/jpeg", "image/jpg", "image/webp"].contains(&media_type.as_str())
    {
        return Err(CoreError::new(
            "INVALID_TILE",
            if source.authentication.is_some() { "图源未返回影像，请检查 Key/Token 和服务参数。" } else { "Tile response is not a supported image" },
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| CoreError::new("SOURCE_NETWORK", e.without_url().to_string()))?
    {
        if bytes.len() + chunk.len() > MAX_TILE_BYTES {
            return Err(CoreError::new(
                "INVALID_TILE",
                "Tile response exceeds 16 MiB",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let dimensions = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(io_error)?
        .into_dimensions()
        .map_err(io_error)?;
    if dimensions != (u32::from(tile_size), u32::from(tile_size)) {
        return Err(CoreError::new(
            "INVALID_TILE",
            "Tile dimensions do not match the source descriptor",
        ));
    }
    let image = image::load_from_memory(&bytes)
        .map_err(|e| CoreError::new("INVALID_TILE", e.to_string()))?
        .to_rgba8();
    Ok(DownloadedTile { image, bytes })
}

fn check_download_control(
    cancelled: &AtomicBool,
    paused: Option<&AtomicBool>,
    started: Instant,
    deadline: Duration,
) -> Result<(), CoreError> {
    if cancelled.load(Ordering::Relaxed) {
        return Err(CoreError::new(
            "CANCELLED",
            "Download cancelled before publication",
        ));
    }
    if paused.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(CoreError::new(
            "PAUSED",
            "Download paused before publication",
        ));
    }
    if started.elapsed() >= deadline {
        return Err(CoreError::new(
            "TIMEOUT",
            "Job deadline exceeded before publication",
        ));
    }
    Ok(())
}

async fn wait_for_download_slot(
    ready_at: Instant,
    cooldown: &Mutex<Instant>,
    cancelled: &AtomicBool,
    paused: Option<&AtomicBool>,
    started: Instant,
    deadline: Duration,
) -> Result<(), CoreError> {
    loop {
        check_download_control(cancelled, paused, started, deadline)?;
        let until = ready_at.max(*cooldown.lock().expect("download cooldown poisoned"));
        let remaining = until.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(());
        }
        tokio::time::sleep(remaining.min(Duration::from_millis(100))).await;
    }
}

async fn get_tile_with_retry(
    client: &Client,
    url: Url,
    source: &HttpSource,
    cancelled: &AtomicBool,
    paused: Option<&AtomicBool>,
    started: Instant,
    deadline: Duration,
    cooldown: &Mutex<Instant>,
) -> Result<DownloadedTile, CoreError> {
    // ImageServer 5xx responses can outlast the first few short retries. Keep
    // the wait bounded by the job deadline and interruptible by pause/cancel.
    const MAX_TRANSIENT_ATTEMPTS: u32 = 6;
    for attempt in 0..MAX_TRANSIENT_ATTEMPTS {
        wait_for_download_slot(
            Instant::now(),
            cooldown,
            cancelled,
            paused,
            started,
            deadline,
        )
        .await?;
        if cancelled.load(Ordering::Relaxed) {
            return Err(CoreError::new(
                "CANCELLED",
                "Download cancelled before publication",
            ));
        }
        if paused.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
            return Err(CoreError::new(
                "PAUSED",
                "Download paused before publication",
            ));
        }
        if started.elapsed() >= deadline {
            return Err(CoreError::new(
                "TIMEOUT",
                "Job deadline exceeded before publication",
            ));
        }
        let mut retry_after = None;
        match get_tile(client, url.clone(), source, &mut retry_after).await {
            Ok(image) => return Ok(image),
            Err(error)
                if attempt + 1 < MAX_TRANSIENT_ATTEMPTS
                    && matches!(
                        error.code,
                        "SOURCE_RATE_LIMITED" | "SOURCE_TEMPORARY" | "SOURCE_NETWORK"
                    ) =>
            {
                let delay =
                    Duration::from_secs(1u64 << attempt).max(retry_after.unwrap_or_default());
                if delay >= deadline.saturating_sub(started.elapsed()) {
                    return Err(error);
                }
                // A provider-wide 429 (or an explicit Retry-After on 5xx)
                // pauses new requests from every lane, including other retries.
                if error.code == "SOURCE_RATE_LIMITED" || retry_after.is_some() {
                    let mut shared = cooldown.lock().expect("download cooldown poisoned");
                    *shared = (*shared).max(Instant::now() + delay);
                }
                let wait_until = Instant::now() + delay;
                while Instant::now() < wait_until {
                    if cancelled.load(Ordering::Relaxed) {
                        return Err(CoreError::new(
                            "CANCELLED",
                            "Download cancelled before publication",
                        ));
                    }
                    if paused.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
                        return Err(CoreError::new(
                            "PAUSED",
                            "Download paused before publication",
                        ));
                    }
                    let remaining = wait_until.saturating_duration_since(Instant::now());
                    tokio::time::sleep(remaining.min(Duration::from_millis(100))).await;
                }
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("retry loop always returns on last attempt")
}

#[path = "source_coordinates.rs"]
pub mod source_coordinates;
pub use source_coordinates::CoordinateSystem;

static ACTIVE_WARPS: AtomicUsize = AtomicUsize::new(0);
struct WarpPermit;
impl Drop for WarpPermit { fn drop(&mut self) { ACTIVE_WARPS.fetch_sub(1,Ordering::Release); } }

/// A maximum of four source mosaics are decoded at once, independent of the
/// ordinary network concurrency setting. Output checkpoints keep canonical WGS tiles.
async fn get_registered_tile(client:&Client,source:&HttpSource,zoom:u8,x:u32,y:u32,cancelled:&AtomicBool,
    paused:Option<&AtomicBool>,started:Instant,deadline:Duration,cooldown:&Mutex<Instant>) -> Result<DownloadedTile,CoreError> {
    if source.coordinate_system!=Some(CoordinateSystem::Gcj02) {
        return get_tile_with_retry(client,tile_url_at(source,zoom,x,y)?,source,cancelled,paused,started,deadline,cooldown).await;
    }
    loop {
        check_download_control(cancelled,paused,started,deadline)?;
        if ACTIVE_WARPS.fetch_update(Ordering::AcqRel,Ordering::Relaxed,|count|(count<4).then_some(count+1)).is_ok() {break;}
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let _permit=WarpPermit;
    let plan=source_coordinates::WarpPlan::new(zoom,x,y,source.tile_size)?;
    let mut tiles=std::collections::HashMap::new();
    let mut ready_at=Instant::now();
    for &(tx,ty) in &plan.tiles {
        wait_for_download_slot(ready_at,cooldown,cancelled,paused,started,deadline).await?;
        let tile=get_tile_with_retry(client,tile_url_at(source,zoom,tx,ty)?,source,cancelled,paused,started,deadline,cooldown).await?;
        tiles.insert((tx,ty),std::sync::Arc::new(tile.image));
        ready_at=Instant::now()+Duration::from_millis(source.min_interval_ms);
    }
    check_download_control(cancelled,paused,started,deadline)?;
    let image=plan.render(&tiles)?;
    let mut bytes=Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes).write_image(image.as_raw(),image.width(),image.height(),image::ExtendedColorType::Rgba8).map_err(io_error)?;
    Ok(DownloadedTile{image,bytes})
}

async fn get_composite_tile(client: &Client, _url: Url, source: &HttpSource, overlays: &[HttpSource],
    grid: &TileGrid, x: u32, y: u32, cancelled: &AtomicBool, paused: Option<&AtomicBool>, started: Instant,
    deadline: Duration, cooldown: &Mutex<Instant>) -> Result<DownloadedTile, CoreError> {
    let mut tile = get_registered_tile(client,source,grid.zoom,x,y,cancelled,paused,started,deadline,cooldown).await?;
    for overlay in overlays {
        let annotation = get_registered_tile(client,overlay,grid.zoom,x,y,cancelled,paused,started,deadline,cooldown).await
            .map_err(|e| if e.code == "SOURCE_TILE_MISSING" { CoreError::new("SOURCE_OVERLAY_MISSING", "An annotation tile is missing; no incomplete composite was published") } else { e })?;
        // Integer source-over keeps opaque backgrounds exactly opaque. The
        // generic image blend truncates 1.0 to 254 for some alpha fractions.
        for (back, front) in tile.image.pixels_mut().zip(annotation.image.pixels()) {
            let a=u32::from(front[3]);let b=u32::from(back[3]);let denominator=a*255+b*(255-a);
            if denominator==0 { *back=image::Rgba([0,0,0,0]);continue; }
            for c in 0..3 {back[c]=((u32::from(front[c])*a*255+u32::from(back[c])*b*(255-a)+denominator/2)/denominator) as u8;}
            back[3]=((denominator+127)/255) as u8;
        }
    }
    if !overlays.is_empty() {
        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes).write_image(tile.image.as_raw(), tile.image.width(), tile.image.height(), image::ExtendedColorType::Rgba8).map_err(io_error)?;
        tile.bytes = bytes;
    }
    Ok(tile)
}

#[path = "raster_export.rs"]
mod raster_export;
#[path = "tile_exports.rs"]
mod tile_exports;
#[path = "shared_tile_cache.rs"]
mod shared_tile_cache;

struct PixelCrop {
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    bounds: [f64; 4],
}

fn crop_pixels(bounds: [f64; 4], grid: &TileGrid, tile_size: u16) -> PixelCrop {
    let dimension = (1u32 << grid.zoom) as f64 * f64::from(tile_size);
    let pixel_x = |lon: f64| (lon + 180.0) / 360.0 * dimension;
    let pixel_y = |lat: f64| {
        let radians = lat.to_radians();
        (1.0 - (radians.tan() + 1.0 / radians.cos()).ln() / std::f64::consts::PI) / 2.0 * dimension
    };
    let offset_x = f64::from(grid.x_min) * f64::from(tile_size);
    let offset_y = f64::from(grid.y_min) * f64::from(tile_size);
    let left = (pixel_x(bounds[0]) - offset_x)
        .floor()
        .clamp(0.0, grid.pixel_width as f64) as u32;
    let right = (pixel_x(bounds[2]) - offset_x)
        .ceil()
        .clamp(0.0, grid.pixel_width as f64) as u32;
    let top = (pixel_y(bounds[3]) - offset_y)
        .floor()
        .clamp(0.0, grid.pixel_height as f64) as u32;
    let bottom = (pixel_y(bounds[1]) - offset_y)
        .ceil()
        .clamp(0.0, grid.pixel_height as f64) as u32;
    let lon = |pixel: f64| pixel / dimension * 360.0 - 180.0;
    let lat = |pixel: f64| {
        (std::f64::consts::PI * (1.0 - 2.0 * pixel / dimension))
            .sinh()
            .atan()
            .to_degrees()
    };
    PixelCrop {
        left,
        top,
        width: right.max(left + 1) - left,
        height: bottom.max(top + 1) - top,
        bounds: [
            lon(offset_x + f64::from(left)),
            lat(offset_y + f64::from(bottom)),
            lon(offset_x + f64::from(right)),
            lat(offset_y + f64::from(top)),
        ],
    }
}

fn sha256_file(path: &Path) -> Result<String, CoreError> {
    let mut file = File::open(path).map_err(io_error)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

struct AssetFootprint {
    bounds: [f64; 4],
    dimensions: Option<(u32, u32)>,
}

fn asset(
    stage: &Path,
    id: String,
    path: String,
    role: &str,
    mime: &str,
    grid: Option<&TileGrid>,
    footprint: AssetFootprint,
) -> Result<Asset, CoreError> {
    let file = stage.join(&path);
    Ok(Asset {
        id,
        kind: if mime == "application/geo+json" {
            "vector"
        } else {
            "raster"
        }
        .into(),
        role: role.into(),
        path,
        mime_type: mime.into(),
        bytes: fs::metadata(&file).map_err(io_error)?.len(),
        sha256: sha256_file(&file)?,
        geo_transform: None,
        crs_definition: None,
        crs: if grid.is_some() {
            "EPSG:3857"
        } else {
            "EPSG:4326"
        }
        .into(),
        bounds: footprint.bounds,
        width: footprint.dimensions.map(|size| size.0),
        height: footprint.dimensions.map(|size| size.1),
    })
}

/// Download all approved tiles and publish a complete, inspectable bundle.
/// Existing output is never overwritten. Downloads use bounded concurrency.
pub async fn fetch_bundle(
    request: &ImageryRequest,
    source: &HttpSource,
) -> Result<Manifest, CoreError> {
    let cancelled = AtomicBool::new(false);
    fetch_bundle_with_cancel(request, source, &cancelled).await
}

/// Cancellation is checked before each request and before publication. A
/// cancelled operation never publishes a partially written bundle.
pub async fn fetch_bundle_with_cancel(
    request: &ImageryRequest,
    source: &HttpSource,
    cancelled: &AtomicBool,
) -> Result<Manifest, CoreError> {
    fetch_bundle_with_progress(request, source, cancelled, |_, _| Ok(())).await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BundleStage { Downloading, Processing, Reprojecting }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BundleProgress {
    Stage(BundleStage),
    Tiles { completed: u64, total: u64 },
}

fn tile_callback<F: FnMut(u64, u64) -> Result<(), CoreError>>(mut callback: F)
    -> impl FnMut(BundleProgress) -> Result<(), CoreError> {
    move |progress| match progress {
        BundleProgress::Tiles { completed, total } => callback(completed, total),
        BundleProgress::Stage(_) => Ok(()),
    }
}

pub async fn fetch_bundle_with_progress<F>(
    request: &ImageryRequest,
    source: &HttpSource,
    cancelled: &AtomicBool,
    on_tile: F,
) -> Result<Manifest, CoreError>
where
    F: FnMut(u64, u64) -> Result<(), CoreError>,
{
    fetch_bundle_internal(
        request,
        source,
        cancelled,
        None,
        None,
        ProxyRoute::Environment,
        DownloadOptions::default(),
        tile_callback(on_tile),
        None,
    )
    .await
}

pub async fn fetch_bundle_with_cache<F>(
    request: &ImageryRequest,
    source: &HttpSource,
    cancelled: &AtomicBool,
    cache: &TileCacheConfig,
    on_tile: F,
) -> Result<Manifest, CoreError>
where
    F: FnMut(u64, u64) -> Result<(), CoreError>,
{
    fetch_bundle_internal(
        request,
        source,
        cancelled,
        None,
        Some(cache),
        ProxyRoute::Environment,
        DownloadOptions::default(),
        tile_callback(on_tile),
        None,
    )
    .await
}

#[derive(Clone, Copy, Debug)]
pub enum ProxyRoute<'a> {
    /// Preserve reqwest's environment proxy behavior for library callers.
    Environment,
    Direct,
    Http(&'a str),
}

pub async fn fetch_bundle_with_cache_control<F>(
    request: &ImageryRequest,
    source: &HttpSource,
    cancelled: &AtomicBool,
    paused: &AtomicBool,
    cache: &TileCacheConfig,
    on_tile: F,
) -> Result<Manifest, CoreError>
where
    F: FnMut(u64, u64) -> Result<(), CoreError>,
{
    fetch_bundle_with_cache_control_proxy(
        request,
        source,
        cancelled,
        paused,
        cache,
        ProxyRoute::Environment,
        on_tile,
    )
    .await
}

pub async fn fetch_bundle_with_cache_control_proxy<F>(
    request: &ImageryRequest,
    source: &HttpSource,
    cancelled: &AtomicBool,
    paused: &AtomicBool,
    cache: &TileCacheConfig,
    proxy: ProxyRoute<'_>,
    on_tile: F,
) -> Result<Manifest, CoreError>
where
    F: FnMut(u64, u64) -> Result<(), CoreError>,
{
    fetch_bundle_with_cache_control_proxy_options(
        request,
        source,
        cancelled,
        paused,
        cache,
        proxy,
        DownloadOptions::default(),
        on_tile,
    )
    .await
}

pub async fn fetch_bundle_with_cache_control_proxy_options<F>(
    request: &ImageryRequest,
    source: &HttpSource,
    cancelled: &AtomicBool,
    paused: &AtomicBool,
    cache: &TileCacheConfig,
    proxy: ProxyRoute<'_>,
    options: DownloadOptions,
    on_tile: F,
) -> Result<Manifest, CoreError>
where
    F: FnMut(u64, u64) -> Result<(), CoreError>,
{
    fetch_bundle_internal(
        request,
        source,
        cancelled,
        Some(paused),
        Some(cache),
        proxy,
        options,
        tile_callback(on_tile),
        None,
    )
    .await
}

/// Native workers receive actual phase changes, including raster export after
/// the final tile. The tile-only APIs retain their existing callback contract.
pub async fn fetch_bundle_with_cache_control_proxy_progress<F>(
    request: &ImageryRequest, source: &HttpSource, cancelled: &AtomicBool,
    paused: &AtomicBool, cache: &TileCacheConfig, proxy: ProxyRoute<'_>, on_progress: F,
) -> Result<Manifest, CoreError>
where F: FnMut(BundleProgress) -> Result<(), CoreError> {
    fetch_bundle_internal(request, source, cancelled, Some(paused), Some(cache),
        proxy, DownloadOptions::default(), on_progress, None).await
}

pub async fn fetch_bundle_with_projector_progress<F>(request: &ImageryRequest, source: &HttpSource,
    cancelled: &AtomicBool, paused: &AtomicBool, cache: &TileCacheConfig, proxy: ProxyRoute<'_>,
    on_progress: F, projector: Option<&dyn RasterProjector>) -> Result<Manifest, CoreError>
where F: FnMut(BundleProgress) -> Result<(), CoreError> {
    fetch_bundle_internal(request, source, cancelled, Some(paused), Some(cache), proxy,
        DownloadOptions::default(), on_progress, projector).await
}

async fn fetch_bundle_internal<F>(
    request: &ImageryRequest,
    source: &HttpSource,
    cancelled: &AtomicBool,
    paused: Option<&AtomicBool>,
    cache_config: Option<&TileCacheConfig>,
    proxy: ProxyRoute<'_>,
    options: DownloadOptions,
    mut on_progress: F,
    projector: Option<&dyn RasterProjector>,
) -> Result<Manifest, CoreError>
where
    F: FnMut(BundleProgress) -> Result<(), CoreError>,
{
    validate_request(request, source)?;
    let reproject = request.export_options.target_crs.as_deref().is_some_and(|crs| crs != "EPSG:3857");
    if reproject && projector.is_none() {
        return Err(CoreError::new("GIS_SKILL_NOT_INSTALLED", "请先安装栅格转换技能，再导出指定坐标系"));
    }
    if !(1..=100).contains(&options.concurrency) {
        return Err(CoreError::new(
            "INVALID_SPEC",
            "Download concurrency must be between 1 and 100",
        ));
    }
    let parent = request
        .destination
        .parent()
        .ok_or_else(|| CoreError::new("INVALID_SPEC", "Output has no parent"))?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let total_tiles: u64 = request.grids.iter().map(|grid| grid.tile_count).sum();
    let required_disk = required_free_disk_bytes_for_outputs(total_tiles, source.tile_size,
        usize::from(request.output_geotiff) + usize::from(request.output_mbtiles) + request.extra_outputs.len() + if reproject { 8 } else { 0 },
        request.output_geotiff && request.export_options.build_pyramid)?;
    ensure_disk_budget(parent, required_disk)?;
    let mut cache = cache_config
        .map(|config| TileCache::open(config, source, &request.export_options.overlay_sources, request.export_options.cache_only || request.export_options.reuse_verified_cache))
        .transpose()?;
    if let Some(cache) = &cache {
        ensure_disk_budget(&cache.root, required_disk)?;
    }
    let started = Instant::now();
    let stage = tempfile::Builder::new()
        .prefix(".geod-agent-stage-")
        .tempdir_in(parent)
        .map_err(io_error)?;
    let builder = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .pool_max_idle_per_host(options.concurrency)
        .user_agent("GeoD-Agent/0.1");
    let builder = match proxy {
        ProxyRoute::Environment => builder,
        ProxyRoute::Direct => builder.no_proxy(),
        ProxyRoute::Http(url) => builder
            .no_proxy()
            .proxy(reqwest::Proxy::all(url).map_err(io_error)?),
    };
    let client = builder.build().map_err(io_error)?;
    let mut manifest = Manifest {
        schema_version: "1.0".into(),
        kind: "geod-bundle".into(),
        id: cache_config
            .map(|cache| format!("geod-agent-job-{}", cache.job_id))
            .unwrap_or_else(|| format!("geod-agent-{}", Uuid::new_v4())),
        name: request.name.clone(),
        created_at: Utc::now().to_rfc3339(),
        bounds: request.bounds,
        assets: Vec::new(),
        layers: Vec::new(),
        quality: Quality {
            status: "complete".into(),
            missing_tiles: 0,
            missing: Vec::new(),
            warnings: Vec::new(),
        },
        provenance: vec![Provenance {
            source: source.name.clone(),
            attribution: source.attribution.clone(),
            retrieved_at: Utc::now().to_rfc3339(),
        }],
    };
    if request.export_options.cache_only {
        manifest.quality.warnings.push("Exported from verified local cache only; cached imagery may predate this export. No source tiles were requested.".into());
    }
    for overlay in &request.overlays { manifest.provenance.push(Provenance { source: overlay.name.clone(), attribution: overlay.attribution.clone(), retrieved_at: Utc::now().to_rfc3339() }); }
    if request.export_options.elevation_encoding.is_some() {
        fs::write(stage.path().join("elevation-info.json"), serde_json::to_vec(&serde_json::json!({"encoding":"terrarium","outputType":"Float32","bands":1,"units":"metre","noData":-9999,"sourceCrs":"EPSG:3857","crs":request.export_options.target_crs.as_deref().unwrap_or("EPSG:3857"),"preview":"grayscale elevation from -1000 to 5000 metres"})).map_err(io_error)?).map_err(io_error)?;
        manifest.assets.push(asset(stage.path(),"elevation-info".into(),"elevation-info.json".into(),"metadata","application/json",None,AssetFootprint { bounds: request.bounds, dimensions:None })?);
    }
    if let Some(boundary) = &request.boundary {
        let boundary_file = "boundary.geojson";
        fs::write(
            stage.path().join(boundary_file),
            serde_json::to_vec_pretty(
                &serde_json::json!({ "type": "MultiPolygon", "coordinates": boundary.polygons }),
            )
            .map_err(io_error)?,
        )
        .map_err(io_error)?;
        manifest.assets.push(asset(
            stage.path(),
            "boundary".into(),
            boundary_file.into(),
            "input",
            "application/geo+json",
            None,
            AssetFootprint {
                bounds: request.bounds,
                dimensions: None,
            },
        )?);
        if request.output_mbtiles || request.extra_outputs.iter().any(|f| matches!(f, ExtraOutput::GeoPackage | ExtraOutput::Tiles)) {
            manifest.quality.warnings.push("Tile containers preserve complete source tiles; the boundary mask applies to GeoTIFF, PNG, JPEG and preview".into());
        }
    }
    let mut mbtiles = if request.output_mbtiles {
        let conn = Connection::open(stage.path().join("imagery.mbtiles")).map_err(io_error)?;
        conn.execute_batch("CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB,
            PRIMARY KEY(zoom_level, tile_column, tile_row));") .map_err(io_error)?;
        for (key, value) in [
            ("name", request.name.as_str()),
            ("format", "png"),
            ("type", "baselayer"),
            ("attribution", source.attribution.as_str()),
        ] {
            conn.execute(
                "INSERT INTO metadata(name,value) VALUES (?1,?2)",
                params![key, value],
            )
            .map_err(io_error)?;
        }
        // This DB is staged and never used as the resume checkpoint. Commit it
        // once before publication rather than fsyncing each tile insertion.
        conn.execute_batch("BEGIN IMMEDIATE").map_err(io_error)?;
        Some(conn)
    } else {
        None
    };
    let mut completed_tiles = 0u64;
    let mut extra_tiles = tile_exports::ExtraTileWriter::new(stage.path(), source, request)?;
    let cooldown = Mutex::new(Instant::now());
    let cooldown_ref = &cooldown;
    for grid in &request.grids {
        on_progress(BundleProgress::Stage(BundleStage::Downloading))?;
        let mut spool = if request.output_geotiff || request.extra_outputs.iter().any(|f| matches!(f, ExtraOutput::Png | ExtraOutput::Jpeg)) {
            Some(raster_export::TileSpool::new(parent)?)
        } else {
            None
        };
        let mut coordinates =
            (grid.x_min..=grid.x_max).flat_map(|x| (grid.y_min..=grid.y_max).map(move |y| (x, y)));
        let mut pending = FuturesUnordered::new();
        let mut lanes = VecDeque::from(vec![Instant::now(); options.concurrency]);
        let client_ref = &client;
        loop {
            check_download_control(cancelled, paused, started, request.deadline)?;
            let mut cached_ready = None;
            while pending.len() < options.concurrency {
                let Some((x, y)) = coordinates.next() else {
                    break;
                };
                check_download_control(cancelled, paused, started, request.deadline)?;
                if let Some(cached) = cache
                    .as_mut()
                    .map(|cache| cache.load(grid.zoom, x, y, source.tile_size))
                    .transpose()?
                    .flatten()
                {
                    cached_ready = Some((x, y, Ok(cached)));
                    break;
                }
                if request.export_options.cache_only {
                    manifest.quality.missing.push(MissingTile { zoom:grid.zoom, x, y });
                    manifest.quality.missing_tiles += 1;
                    continue;
                }
                let url = tile_url(source, grid, x, y)?;
                let ready_at = lanes.pop_front().expect("one lane per in-flight request");
                pending.push(async move {
                    let result = async {
                        wait_for_download_slot(
                            ready_at,
                            cooldown_ref,
                            cancelled,
                            paused,
                            started,
                            request.deadline,
                        )
                        .await?;
                        get_composite_tile(
                            client_ref,
                            url,
                            source, &request.overlays, grid, x, y,
                            cancelled,
                            paused,
                            started,
                            request.deadline,
                            cooldown_ref,
                        )
                        .await
                    }
                    .await;
                    (x, y, result)
                });
            }
            let from_cache = cached_ready.is_some();
            let (x, y, tile) = if let Some(cached) = cached_ready {
                cached
            } else {
                if pending.is_empty() {
                    break;
                }
                // Timeout drops only the next() waiter, retaining in-flight
                // futures. Pause/cancel/deadline stop even a hung HTTP request.
                match tokio::time::timeout(Duration::from_millis(100), pending.next()).await {
                    Ok(Some(result)) => result,
                    Ok(None) => break,
                    Err(_) => continue,
                }
            };
            check_download_control(cancelled, paused, started, request.deadline)?;
            if !from_cache {
                lanes.push_back(Instant::now() + Duration::from_millis(source.min_interval_ms));
            }
            let tile = match tile {
                Ok(tile) => tile,
                Err(error) if error.code == "SOURCE_TILE_MISSING" => {
                    manifest.quality.missing.push(MissingTile {
                        zoom: grid.zoom,
                        x,
                        y,
                    });
                    manifest.quality.missing_tiles += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            if !from_cache {
                if let Some(cache) = &mut cache {
                    cache.save(grid.zoom, x, y, &tile.bytes)?;
                }
            }
            extra_tiles.put(grid.zoom, x, y, &tile)?;
            if let Some(spool) = &mut spool {
                spool.save(x, y, &tile.bytes, cache.as_ref().map(|cache| cache.path(grid.zoom, x, y)))?;
            }
            if let Some(conn) = &mut mbtiles {
                let bytes = if tile.bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                    tile.bytes
                } else {
                    let mut encoded = Vec::new();
                    image::codecs::png::PngEncoder::new_with_quality(
                        &mut encoded,
                        image::codecs::png::CompressionType::Fast,
                        image::codecs::png::FilterType::Sub,
                    )
                    .write_image(
                        tile.image.as_raw(),
                        tile.image.width(),
                        tile.image.height(),
                        image::ExtendedColorType::Rgba8,
                    )
                    .map_err(io_error)?;
                    encoded
                };
                let tms_y = (1u32 << grid.zoom) - 1 - y;
                conn.execute("INSERT INTO tiles(zoom_level,tile_column,tile_row,tile_data) VALUES (?1,?2,?3,?4)",
                        params![grid.zoom, x, tms_y, bytes]).map_err(io_error)?;
            }
            completed_tiles += 1;
            on_progress(BundleProgress::Tiles { completed: completed_tiles, total: total_tiles })?;
        }
        if let Some(spool) = spool {
            let crop = crop_pixels(request.bounds, grid, source.tile_size);
            let mut outputs = Vec::new();
            if request.output_geotiff { outputs.push(("tif", "image/tiff")); }
            if request.extra_outputs.contains(&ExtraOutput::Png) { outputs.push(("png", "image/png")); }
            if request.extra_outputs.contains(&ExtraOutput::Jpeg) { outputs.push(("jpg", "image/jpeg")); }
            for (extension, mime) in outputs {
            on_progress(BundleProgress::Stage(BundleStage::Processing))?;
            let filename = format!("imagery-z{}.{}", grid.zoom, extension);
            let path = stage.path().join(&filename);
            let check = || check_download_control(cancelled, paused, started, request.deadline);
            let preview = match extension {
                "png" => raster_export::write_png(&path, &spool, grid, &crop, source.tile_size, request.boundary.as_ref(), check)?,
                "jpg" => raster_export::write_jpeg(&path, &spool, grid, &crop, source.tile_size, request.boundary.as_ref(), request.export_options.jpeg_quality, check)?,
                _ if request.export_options.elevation_encoding.is_some() => raster_export::write_dem(&path, &spool, grid, &crop, source.tile_size, request.boundary.as_ref(), request.export_options.compression, request.export_options.build_pyramid, check)?,
                _ => raster_export::write_streaming_tiff(&path, &spool, grid, &crop,
                    source.tile_size, request.boundary.as_ref(), request.export_options.compression, request.export_options.build_pyramid, check)?,
            };
            let projected = if reproject {
                on_progress(BundleProgress::Stage(BundleStage::Reprojecting))?;
                Some(projector.unwrap().reproject(&path, crop.bounds, &request.export_options, cancelled, paused).await?)
            } else { None };
            let mut output_asset = asset(
                stage.path(),
                if extension == "tif" { format!("imagery-z{}", grid.zoom) } else { format!("imagery-z{}-{extension}", grid.zoom) },
                filename,
                "analysis",
                mime,
                Some(grid),
                AssetFootprint {
                    bounds: crop.bounds,
                    dimensions: Some((crop.width, crop.height)),
                },
            )?;
            if let Some(projected) = projected {
                output_asset.crs = request.export_options.target_crs.clone().unwrap();
                output_asset.width = Some(projected.width); output_asset.height = Some(projected.height);
                output_asset.geo_transform = Some(projected.geo_transform);
                output_asset.crs_definition = Some(projected.crs_definition);
            }
            manifest.assets.push(output_asset);
            if request.export_options.generate_sidecars || (reproject && extension != "tif") {
                let paths = if reproject { vec![path.with_extension("prj"), path.with_extension(match extension {"png"=>"pgw","jpg"=>"jgw",_=>"tfw"})] }
                    else { raster_export::write_sidecars(&path, grid, &crop, source.tile_size)? };
                for path in paths {
                    let filename = path.file_name().unwrap().to_string_lossy().into_owned();
                    if !manifest.assets.iter().any(|asset| asset.path == filename) {
                        let mut metadata=asset(stage.path(), format!("sidecar-{filename}"), filename, "metadata", "text/plain", Some(grid),
                            AssetFootprint { bounds: crop.bounds, dimensions: None })?;
                        if reproject { metadata.crs=request.export_options.target_crs.clone().unwrap(); }
                        manifest.assets.push(metadata);
                    }
                }
            }
            if !manifest.assets.iter().any(|item| item.role == "preview") {
                let preview_size = (preview.width(), preview.height());
                preview
                    .save(stage.path().join("preview.png"))
                    .map_err(io_error)?;
                let preview_asset = asset(
                    stage.path(),
                    "imagery-preview".into(),
                    "preview.png".into(),
                    "preview",
                    "image/png",
                    Some(grid),
                    AssetFootprint {
                        bounds: crop.bounds,
                        dimensions: Some(preview_size),
                    },
                )?;
                manifest.assets.push(preview_asset);
            }
            }
        }
    }
    if completed_tiles == 0 {
        return Err(CoreError::new(
            "SOURCE_UNAVAILABLE",
            "No imagery tiles were available for the approved plan",
        ));
    }
    if manifest.quality.missing_tiles > 0 {
        manifest.quality.status = "partial".into();
        manifest.quality.warnings.push(format!(
            "{} tile(s) were unavailable from the source or verified local cache; transparent GeoTIFF pixels and absent container rows mark missing coverage. Retry missing tiles with a new recovery plan.",
            manifest.quality.missing_tiles
        ));
    }
    on_progress(BundleProgress::Stage(BundleStage::Processing))?;
    if let Some(conn) = mbtiles {
        conn.execute_batch("COMMIT").map_err(io_error)?;
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(io_error)?;
        if integrity != "ok" {
            return Err(CoreError::new("ARTIFACT_INCOMPLETE", integrity));
        }
        drop(conn);
        manifest.assets.push(asset(
            stage.path(),
            "imagery-mbtiles".into(),
            "imagery.mbtiles".into(),
            "offline",
            "application/vnd.mbtiles",
            None,
            AssetFootprint {
                bounds: request.bounds,
                dimensions: None,
            },
        )?);
    }
    for (id, filename, mime) in extra_tiles.finish()? {
        let mut tile_asset = asset(stage.path(), id.into(), filename.into(), "offline", mime, None,
            AssetFootprint { bounds: request.bounds, dimensions: None })?;
        if mime == "application/geopackage+sqlite3" { tile_asset.crs = "EPSG:3857".into(); }
        manifest.assets.push(tile_asset);
    }
    if started.elapsed() >= request.deadline {
        return Err(CoreError::new(
            "TIMEOUT",
            "Job deadline exceeded before publication",
        ));
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err(CoreError::new(
            "CANCELLED",
            "Download cancelled before publication",
        ));
    }
    if paused.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Err(CoreError::new(
            "PAUSED",
            "Download paused before publication",
        ));
    }
    fs::write(
        stage.path().join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(io_error)?,
    )
    .map_err(io_error)?;
    if request.destination.exists() {
        return Err(CoreError::new(
            "OUTPUT_CONFLICT",
            "Output directory appeared during processing",
        ));
    }
    fs::rename(stage.path(), &request.destination).map_err(io_error)?;
    Ok(manifest)
}

pub fn inspect_bundle(root: &Path) -> Result<Manifest, CoreError> {
    let manifest_path = root.join("manifest.json");
    if fs::metadata(&manifest_path).map_err(io_error)?.len() > MAX_MANIFEST_BYTES {
        return Err(CoreError::new(
            "ARTIFACT_INCOMPLETE",
            "Manifest exceeds 1 MiB",
        ));
    }
    let manifest: Manifest = serde_json::from_slice(&fs::read(&manifest_path).map_err(io_error)?)
        .map_err(|e| CoreError::new("ARTIFACT_INCOMPLETE", e.to_string()))?;
    if manifest.schema_version != "1.0"
        || manifest.kind != "geod-bundle"
        || manifest.assets.is_empty()
    {
        return Err(CoreError::new(
            "ARTIFACT_INCOMPLETE",
            "Unsupported or empty GeoD bundle",
        ));
    }
    let missing_count = u64::try_from(manifest.quality.missing.len()).unwrap_or(u64::MAX);
    let quality_is_consistent = match manifest.quality.status.as_str() {
        "complete" => manifest.quality.missing_tiles == 0 && missing_count == 0,
        "partial" => {
            manifest.quality.missing_tiles > 0 && manifest.quality.missing_tiles == missing_count
        }
        _ => false,
    };
    let mut seen_missing = HashSet::new();
    if !quality_is_consistent
        || manifest.quality.missing.iter().any(|tile| {
            tile.zoom > tile::MAX_ZOOM
                || tile.x >= 1u32 << tile.zoom
                || tile.y >= 1u32 << tile.zoom
                || !seen_missing.insert((tile.zoom, tile.x, tile.y))
        })
    {
        return Err(CoreError::new(
            "ARTIFACT_INCOMPLETE",
            "Bundle missing-tile quality is inconsistent",
        ));
    }
    let canonical_root = fs::canonicalize(root).map_err(io_error)?;
    for item in &manifest.assets {
        let relative = Path::new(&item.path);
        if item.path.is_empty()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(CoreError::new("ARTIFACT_INCOMPLETE", "Unsafe asset path"));
        }
        let path = fs::canonicalize(root.join(relative)).map_err(io_error)?;
        if !path.starts_with(&canonical_root) || !path.is_file() {
            return Err(CoreError::new(
                "ARTIFACT_INCOMPLETE",
                "Asset escapes the bundle",
            ));
        }
        if fs::metadata(&path).map_err(io_error)?.len() != item.bytes
            || sha256_file(&path)? != item.sha256
        {
            return Err(CoreError::new(
                "ARTIFACT_INCOMPLETE",
                format!("Asset hash or length mismatch: {}", item.path),
            ));
        }
        if item.id == "boundary" {
            if item.kind != "vector"
                || item.role != "input"
                || item.mime_type != "application/geo+json"
                || item.crs != "EPSG:4326"
                || item.bounds != manifest.bounds
            {
                return Err(CoreError::new(
                    "ARTIFACT_INCOMPLETE",
                    "Boundary metadata does not match the bundle",
                ));
            }
            let mut boundary = BoundaryGeometry::from_geojson(&fs::read(&path).map_err(io_error)?)
                .map_err(|cause| CoreError::new("ARTIFACT_INCOMPLETE", cause.0))?;
            if boundary
                .normalize()
                .map_err(|cause| CoreError::new("ARTIFACT_INCOMPLETE", cause.0))?
                != manifest.bounds
            {
                return Err(CoreError::new(
                    "ARTIFACT_INCOMPLETE",
                    "Boundary extent does not match the bundle",
                ));
            }
        }
        if item.id == "raw-tiles-index" { tile_exports::inspect_raw(root, &path)?; }
        if item.mime_type == "image/png" || item.mime_type == "image/jpeg" {
            let size = ImageReader::open(&path).map_err(io_error)?.with_guessed_format().map_err(io_error)?.into_dimensions().map_err(io_error)?;
            if (Some(size.0), Some(size.1)) != (item.width, item.height) { return Err(CoreError::new("ARTIFACT_INCOMPLETE", "Raster dimensions do not match manifest")); }
        }
        if item.mime_type == "application/geopackage+sqlite3" {
            let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(io_error)?;
            let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(io_error)?;
            let srs: i32 = conn.query_row("SELECT srs_id FROM gpkg_contents WHERE table_name='tiles'", [], |row| row.get(0)).map_err(io_error)?;
            let count: u64 = conn.query_row("SELECT count(*) FROM tiles", [], |row| row.get(0)).map_err(io_error)?;
            if integrity != "ok" || srs != 3857 || count == 0 { return Err(CoreError::new("ARTIFACT_INCOMPLETE", "Invalid or empty GeoPackage")); }
        }
        if item.mime_type == "image/tiff" {
            let mut decoder =
                Decoder::new(File::open(&path).map_err(io_error)?).map_err(io_error)?;
            let size = decoder.dimensions().map_err(io_error)?;
            if (Some(size.0), Some(size.1)) != (item.width, item.height) {
                return Err(CoreError::new(
                    "ARTIFACT_INCOMPLETE",
                    "GeoTIFF dimensions do not match manifest",
                ));
            }
            let keys = decoder
                .get_tag_u16_vec(Tag::GeoKeyDirectoryTag)
                .map_err(|_| CoreError::new("ARTIFACT_INCOMPLETE", "GeoTIFF CRS tag is missing"))?;
            let code = crate::crs::epsg(&item.crs).map_err(|_|CoreError::new("ARTIFACT_INCOMPLETE", "无效的成果坐标系"))?;
            let model = keys.get(4..).unwrap_or_default().chunks_exact(4).find(|key|key[0]==1024).map(|key|key[3]);
            let crs_key = if model == Some(2) { 2048 } else { 3072 };
            if keys.len() < 8
                || !keys[4..]
                    .chunks_exact(4)
                    .any(|key| key == [crs_key, 0, 1, code])
            {
                return Err(CoreError::new(
                    "ARTIFACT_INCOMPLETE",
                    "GeoTIFF CRS does not match manifest",
                ));
            }
            let scale = decoder
                .get_tag_f64_vec(Tag::ModelPixelScaleTag)
                .map_err(|_| {
                    CoreError::new("ARTIFACT_INCOMPLETE", "GeoTIFF scale tag is missing")
                })?;
            let tie = decoder
                .get_tag_f64_vec(Tag::ModelTiepointTag)
                .map_err(|_| {
                    CoreError::new("ARTIFACT_INCOMPLETE", "GeoTIFF tie point is missing")
                })?;
            let [west, south, east, north] = item.bounds;
            if scale.len() != 3
                || tie.len() != 6
                || ![west, south, east, north]
                    .iter()
                    .all(|value| value.is_finite())
                || west >= east
                || south >= north
                || south <= -85.051129
                || north >= 85.051129
            {
                return Err(CoreError::new(
                    "ARTIFACT_INCOMPLETE",
                    "Invalid GeoTIFF footprint",
                ));
            }
            if let Some(transform) = item.geo_transform {
                if !transform.iter().all(|v|v.is_finite()) || transform[0]<=0.0 || transform[4]>=0.0 || transform[1]!=0.0 || transform[3]!=0.0
                    || (tie[3]-transform[2]).abs()>1e-7 || (tie[4]-transform[5]).abs()>1e-7
                    || (scale[0]-transform[0]).abs()>1e-7 || (scale[1]+transform[4]).abs()>1e-7 {
                    return Err(CoreError::new("ARTIFACT_INCOMPLETE", "转换后的 GeoTIFF 定位与清单不一致"));
                }
                continue;
            }
            if item.crs != "EPSG:3857" { return Err(CoreError::new("ARTIFACT_INCOMPLETE", "转换成果缺少目标网格记录")); }
            let radius = 6_378_137.0;
            let mercator_x = |longitude: f64| longitude.to_radians() * radius;
            let mercator_y = |latitude: f64| {
                radius
                    * (std::f64::consts::FRAC_PI_4 + latitude.to_radians() / 2.0)
                        .tan()
                        .ln()
            };
            let expected_scale_x = (mercator_x(east) - mercator_x(west)) / f64::from(size.0);
            let expected_scale_y = (mercator_y(north) - mercator_y(south)) / f64::from(size.1);
            if (tie[3] - mercator_x(west)).abs() > 0.001
                || (tie[4] - mercator_y(north)).abs() > 0.001
                || (scale[0] - expected_scale_x).abs() > 0.001
                || (scale[1] - expected_scale_y).abs() > 0.001
            {
                return Err(CoreError::new(
                    "ARTIFACT_INCOMPLETE",
                    "GeoTIFF geo-reference does not match manifest",
                ));
            }
        }
        if item.mime_type == "application/vnd.mbtiles" {
            let conn =
                Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(io_error)?;
            let integrity: String = conn
                .query_row("PRAGMA integrity_check", [], |row| row.get(0))
                .map_err(io_error)?;
            if integrity != "ok" {
                return Err(CoreError::new("ARTIFACT_INCOMPLETE", integrity));
            }
            for missing in &manifest.quality.missing {
                let tms_y = (1u32 << missing.zoom) - 1 - missing.y;
                let present: Option<u8> = conn
                    .query_row(
                        "SELECT 1 FROM tiles WHERE zoom_level=?1 AND tile_column=?2 AND tile_row=?3",
                        params![missing.zoom, missing.x, tms_y],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(io_error)?;
                if present.is_some() {
                    return Err(CoreError::new(
                        "ARTIFACT_INCOMPLETE",
                        "MBTiles includes a tile marked missing in the manifest",
                    ));
                }
            }
        }
    }
    Ok(manifest)
}

#[cfg(test)]
mod source_tests {
    use super::*;

    #[test]
    fn arcgis_export_has_exact_web_mercator_tile_extent() {
        let source = HttpSource { subdomains: Vec::new(), coordinate_system: None, elevation_encoding: None, id: "arcgis-test".into(), name: "ArcGIS test".into(), attribution: "USGS".into(),
            license: "Public domain".into(),
            url_template: "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage".into(),
            scheme: TileScheme::XYZ, tile_size: 256, network_policy: NetworkPolicy::PublicHttps,
            min_interval_ms: 500, authentication: None, runtime_token: None,
        };
        source.validate().unwrap();
        let grid = tile::grid([-77.05, 38.85, -77.04, 38.86], 12, 256).unwrap();
        let url = tile_url(&source, &grid, grid.x_min, grid.y_min).unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query.get("bboxSR").unwrap(), "3857");
        assert_eq!(query.get("imageSR").unwrap(), "3857");
        assert_eq!(query.get("size").unwrap(), "256,256");
        let bbox: Vec<f64> = query
            .get("bbox")
            .unwrap()
            .split(',')
            .map(|part| part.parse().unwrap())
            .collect();
        let world = 2.0 * std::f64::consts::PI * 6_378_137.0;
        assert!((bbox[2] - bbox[0] - world / 4096.0).abs() < 1e-6);
        assert!((bbox[3] - bbox[1] - world / 4096.0).abs() < 1e-6);
        let preview = preview_tile_url(&source, 12, grid.x_min, grid.y_min).unwrap();
        assert_eq!(preview, url);
    }

    #[test]
    fn viewport_coordinates_use_saved_tms_scheme_and_reject_out_of_range() {
        let source = HttpSource { subdomains: Vec::new(), coordinate_system: None, elevation_encoding: None, id: "preview-test".into(),
            name: "Preview test".into(),
            attribution: String::new(),
            license: String::new(),
            url_template: "https://tiles.example.com/{z}/{x}/{y}.png".into(),
            scheme: TileScheme::TMS,
            tile_size: 256,
            network_policy: NetworkPolicy::PublicHttps,
            min_interval_ms: 500, authentication: None, runtime_token: None,
        };
        assert_eq!(
            preview_tile_url(&source, 3, 2, 1).unwrap().as_str(),
            "https://tiles.example.com/3/2/6.png"
        );
        assert!(preview_tile_url(&source, 3, 8, 1).is_err());
        assert!(preview_tile_url(&source, 23, 0, 0).is_err());
    }
}

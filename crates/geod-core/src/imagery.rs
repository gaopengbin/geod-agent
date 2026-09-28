//! Bounded local raster acquisition and publication. The caller must supply an
//! already approved plan and a source from the trusted local source registry.

use crate::{
    boundary::{mask_rgba, BoundaryGeometry},
    tile::{self, TileGrid},
};
use chrono::Utc;
use image::{DynamicImage, ImageReader, RgbaImage};
use reqwest::{
    header::{HeaderValue, CONTENT_TYPE, RETRY_AFTER},
    redirect::Policy,
    Client, Url,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Cursor, Read},
    net::IpAddr,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tiff::{
    decoder::Decoder,
    encoder::{colortype::RGBA8, TiffEncoder},
    tags::Tag,
};
use uuid::Uuid;

const MAX_TILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_DECODED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const DISK_FIXED_RESERVE_BYTES: u64 = 16 * 1024 * 1024;
const DISK_TILE_OVERHEAD_BYTES: u64 = 32 * 1024;

/// Conservative free-space budget for cache, staged raster outputs, and metadata.
/// This is a preflight guard, not an exact output-size prediction.
pub fn required_free_disk_bytes(tile_count: u64, tile_size: u16) -> Result<u64, CoreError> {
    tile_count
        .checked_mul(u64::from(tile_size).pow(2))
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|rgba| rgba.checked_mul(4))
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
    pub min_interval_ms: u64,
}

impl HttpSource {
    /// The URL template must be credential-free. Authentication uses a separate
    /// credential reference in the source registry in a later contract version.
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
        format!("{:x}", Sha256::digest(material))
    }

    pub fn validate(&self) -> Result<(), CoreError> {
        validate_source(self)
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
    pub max_tiles: u64,
    pub max_decoded_rgba_bytes: u64,
    pub destination: PathBuf,
    pub deadline: Duration,
}

/// An app-owned cache directory lets a previously approved job resume after
/// process interruption. The source revision and plan hash bind cached tiles
/// to the exact request; every cached PNG is checked against SQLite SHA-256.
pub struct TileCacheConfig {
    pub root: PathBuf,
    pub plan_hash: String,
    pub job_id: String,
}

struct TileCache {
    root: PathBuf,
    conn: Connection,
}

impl TileCache {
    fn open(config: &TileCacheConfig, source: &HttpSource) -> Result<Self, CoreError> {
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
        let binding = format!("{}:{}", config.plan_hash, source.configuration_revision());
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
    ) -> Result<Option<RgbaImage>, CoreError> {
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
                    return Ok(Some(image.to_rgba8()));
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
        Ok(None)
    }
    fn save(&mut self, z: u8, x: u32, y: u32, image: &RgbaImage) -> Result<(), CoreError> {
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image.clone())
            .write_to(&mut encoded, image::ImageFormat::Png)
            .map_err(io_error)?;
        let bytes = encoded.into_inner();
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
    pub warnings: Vec<String>,
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

fn validate_source(source: &HttpSource) -> Result<(), CoreError> {
    if source.id.trim().is_empty()
        || source.name.trim().is_empty()
        || source.attribution.trim().is_empty()
        || source.license.trim().is_empty()
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
    let sample = source
        .url_template
        .replace("{z}", "0")
        .replace("{x}", "0")
        .replace("{y}", "0");
    let url = Url::parse(&sample)
        .map_err(|_| CoreError::new("INVALID_SOURCE", "Invalid tile URL template"))?;
    if url.username() != ""
        || url.password().is_some()
        || url.host_str().is_none()
        || url.query().is_some()
    {
        return Err(CoreError::new(
            "INVALID_SOURCE",
            "Source template must not contain embedded credentials or query parameters",
        ));
    }
    if is_arcgis_image_server(&source.url_template) && source.scheme != TileScheme::XYZ {
        return Err(CoreError::new(
            "INVALID_SOURCE",
            "ArcGIS ImageServer uses XYZ tile coordinates",
        ));
    }
    let host = url.host_str().unwrap().to_ascii_lowercase();
    if host == "tile.openstreetmap.org" || host.ends_with(".tile.openstreetmap.org") {
        return Err(CoreError::new(
            "SOURCE_UNAUTHORIZED",
            "The OSM standard tile service does not permit bulk download jobs",
        ));
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
    Ok(())
}

fn is_arcgis_image_server(template: &str) -> bool {
    template.ends_with("/ImageServer/exportImage")
        && !template.contains('{')
        && !template.contains('}')
}

fn validate_request(request: &ImageryRequest, source: &HttpSource) -> Result<(), CoreError> {
    validate_source(source)?;
    if request.name.trim().is_empty()
        || !request.destination.is_absolute()
        || request
            .destination
            .components()
            .any(|c| matches!(c, Component::ParentDir))
        || (!request.output_geotiff && !request.output_mbtiles)
        || request.grids.is_empty()
        || request.max_tiles == 0
        || request.max_decoded_rgba_bytes == 0
        || request.max_decoded_rgba_bytes > MAX_DECODED_BYTES
        || request.deadline.is_zero()
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
        if normalized != *boundary || bounds != request.bounds || !request.output_geotiff {
            return Err(CoreError::new(
                "INVALID_BOUNDARY",
                "Boundary must be normalized, match the plan extent, and include GeoTIFF output",
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
        if &actual != grid {
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
    if is_arcgis_image_server(&source.url_template) {
        let mut url = Url::parse(&source.url_template)
            .map_err(|_| CoreError::new("INVALID_SOURCE", "Invalid ArcGIS ImageServer URL"))?;
        let half_world = std::f64::consts::PI * 6_378_137.0;
        let tile_width = 2.0 * half_world / (1u32 << grid.zoom) as f64;
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
        TileScheme::TMS => (1u32 << grid.zoom) - 1 - y,
    };
    let value = source
        .url_template
        .replace("{z}", &grid.zoom.to_string())
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
    tile_size: u16,
    retry_after: &mut Option<Duration>,
) -> Result<RgbaImage, CoreError> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| CoreError::new("SOURCE_NETWORK", e.without_url().to_string()))?;
    let status = response.status();
    if status.as_u16() == 429 || status.is_server_error() {
        *retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(retry_after_delay);
    }
    if status.as_u16() == 403 {
        return Err(CoreError::new(
            "SOURCE_UNAUTHORIZED",
            "Tile service returned HTTP 403",
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
    if !["image/png", "image/jpeg", "image/webp"]
        .iter()
        .any(|mime| content_type.starts_with(mime))
    {
        return Err(CoreError::new(
            "INVALID_TILE",
            "Tile response is not a supported image",
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
    image::load_from_memory(&bytes)
        .map(|image| image.to_rgba8())
        .map_err(|e| CoreError::new("INVALID_TILE", e.to_string()))
}

async fn get_tile_with_retry(
    client: &Client,
    url: Url,
    tile_size: u16,
    cancelled: &AtomicBool,
    paused: Option<&AtomicBool>,
    started: Instant,
    deadline: Duration,
) -> Result<RgbaImage, CoreError> {
    for attempt in 0..4 {
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
        match get_tile(client, url.clone(), tile_size, &mut retry_after).await {
            Ok(image) => return Ok(image),
            Err(error)
                if attempt < 3
                    && matches!(
                        error.code,
                        "SOURCE_RATE_LIMITED" | "SOURCE_TEMPORARY" | "SOURCE_NETWORK"
                    ) =>
            {
                let delay = Duration::from_secs(1 << attempt).max(retry_after.unwrap_or_default());
                if delay >= deadline.saturating_sub(started.elapsed()) {
                    return Err(error);
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

fn write_tiff(
    path: &Path,
    image: &RgbaImage,
    grid: &TileGrid,
    crop: &PixelCrop,
) -> Result<(), CoreError> {
    let mut file = File::create(path).map_err(io_error)?;
    let mut encoder = TiffEncoder::new(&mut file).map_err(io_error)?;
    let mut tiff = encoder
        .new_image::<RGBA8>(image.width(), image.height())
        .map_err(io_error)?;
    let n = (1u32 << grid.zoom) as f64;
    let world = 2.0 * std::f64::consts::PI * 6_378_137.0;
    let resolution = world / (n * (grid.pixel_width / grid.columns) as f64);
    let scale = [resolution, resolution, 0.0];
    let tie = [
        0.0,
        0.0,
        0.0,
        (grid.x_min as f64 / n - 0.5) * world + f64::from(crop.left) * resolution,
        (0.5 - grid.y_min as f64 / n) * world - f64::from(crop.top) * resolution,
        0.0,
    ];
    let keys: [u16; 16] = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 3857];
    tiff.encoder()
        .write_tag(Tag::Unknown(33550), &scale[..])
        .map_err(io_error)?;
    tiff.encoder()
        .write_tag(Tag::Unknown(33922), &tie[..])
        .map_err(io_error)?;
    tiff.encoder()
        .write_tag(Tag::Unknown(34735), &keys[..])
        .map_err(io_error)?;
    tiff.encoder()
        .write_tag(Tag::ExtraSamples, &[2u16][..])
        .map_err(io_error)?;
    tiff.write_data(image.as_raw()).map_err(io_error)?;
    Ok(())
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
/// Existing output is never overwritten. This first worker runs sequentially.
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

pub async fn fetch_bundle_with_progress<F>(
    request: &ImageryRequest,
    source: &HttpSource,
    cancelled: &AtomicBool,
    on_tile: F,
) -> Result<Manifest, CoreError>
where
    F: FnMut(u64, u64) -> Result<(), CoreError>,
{
    fetch_bundle_internal(request, source, cancelled, None, None, on_tile).await
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
    fetch_bundle_internal(request, source, cancelled, None, Some(cache), on_tile).await
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
    fetch_bundle_internal(
        request,
        source,
        cancelled,
        Some(paused),
        Some(cache),
        on_tile,
    )
    .await
}

async fn fetch_bundle_internal<F>(
    request: &ImageryRequest,
    source: &HttpSource,
    cancelled: &AtomicBool,
    paused: Option<&AtomicBool>,
    cache_config: Option<&TileCacheConfig>,
    mut on_tile: F,
) -> Result<Manifest, CoreError>
where
    F: FnMut(u64, u64) -> Result<(), CoreError>,
{
    validate_request(request, source)?;
    let parent = request
        .destination
        .parent()
        .ok_or_else(|| CoreError::new("INVALID_SPEC", "Output has no parent"))?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let total_tiles: u64 = request.grids.iter().map(|grid| grid.tile_count).sum();
    let required_disk = required_free_disk_bytes(total_tiles, source.tile_size)?;
    ensure_disk_budget(parent, required_disk)?;
    let mut cache = cache_config
        .map(|config| TileCache::open(config, source))
        .transpose()?;
    if let Some(cache) = &cache {
        ensure_disk_budget(&cache.root, required_disk)?;
    }
    let started = Instant::now();
    let stage = tempfile::Builder::new()
        .prefix(".geod-agent-stage-")
        .tempdir_in(parent)
        .map_err(io_error)?;
    let client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .user_agent("GeoD-Agent/0.1")
        .build()
        .map_err(io_error)?;
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
            warnings: Vec::new(),
        },
        provenance: vec![Provenance {
            source: source.name.clone(),
            attribution: source.attribution.clone(),
            retrieved_at: Utc::now().to_rfc3339(),
        }],
    };
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
        if request.output_mbtiles {
            manifest.quality.warnings.push("MBTiles preserves complete source tiles; the boundary alpha mask applies to GeoTIFF and preview only".into());
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
        Some(conn)
    } else {
        None
    };
    let mut completed_tiles = 0u64;
    for grid in &request.grids {
        let mut mosaic = if request.output_geotiff {
            Some(RgbaImage::new(
                grid.pixel_width as u32,
                grid.pixel_height as u32,
            ))
        } else {
            None
        };
        for x in grid.x_min..=grid.x_max {
            for y in grid.y_min..=grid.y_max {
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
                if started.elapsed() >= request.deadline {
                    return Err(CoreError::new(
                        "TIMEOUT",
                        "Job deadline exceeded before publication",
                    ));
                }
                let url = tile_url(source, grid, x, y)?;
                let tile = match cache.as_mut() {
                    Some(cache) => match cache.load(grid.zoom, x, y, source.tile_size)? {
                        Some(tile) => tile,
                        None => {
                            let tile = get_tile_with_retry(
                                &client,
                                url,
                                source.tile_size,
                                cancelled,
                                paused,
                                started,
                                request.deadline,
                            )
                            .await?;
                            cache.save(grid.zoom, x, y, &tile)?;
                            tile
                        }
                    },
                    None => {
                        get_tile_with_retry(
                            &client,
                            url,
                            source.tile_size,
                            cancelled,
                            paused,
                            started,
                            request.deadline,
                        )
                        .await?
                    }
                };
                if let Some(image) = &mut mosaic {
                    image::imageops::replace(
                        image,
                        &tile,
                        i64::from(x - grid.x_min) * i64::from(source.tile_size),
                        i64::from(y - grid.y_min) * i64::from(source.tile_size),
                    );
                }
                if let Some(conn) = &mut mbtiles {
                    let mut encoded = Cursor::new(Vec::new());
                    DynamicImage::ImageRgba8(tile)
                        .write_to(&mut encoded, image::ImageFormat::Png)
                        .map_err(io_error)?;
                    let tms_y = (1u32 << grid.zoom) - 1 - y;
                    conn.execute("INSERT INTO tiles(zoom_level,tile_column,tile_row,tile_data) VALUES (?1,?2,?3,?4)",
                        params![grid.zoom, x, tms_y, encoded.into_inner()]).map_err(io_error)?;
                }
                completed_tiles += 1;
                on_tile(completed_tiles, total_tiles)?;
                if source.min_interval_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(source.min_interval_ms)).await;
                }
            }
        }
        if let Some(image) = mosaic {
            let crop = crop_pixels(request.bounds, grid, source.tile_size);
            let mut image =
                image::imageops::crop_imm(&image, crop.left, crop.top, crop.width, crop.height)
                    .to_image();
            if let Some(boundary) = &request.boundary {
                mask_rgba(
                    &mut image,
                    boundary,
                    grid,
                    source.tile_size,
                    crop.left,
                    crop.top,
                );
            }
            let filename = format!("imagery-z{}.tif", grid.zoom);
            write_tiff(&stage.path().join(&filename), &image, grid, &crop)?;
            manifest.assets.push(asset(
                stage.path(),
                format!("imagery-z{}", grid.zoom),
                filename,
                "analysis",
                "image/tiff",
                Some(grid),
                AssetFootprint {
                    bounds: crop.bounds,
                    dimensions: Some((image.width(), image.height())),
                },
            )?);
            if !manifest.assets.iter().any(|item| item.role == "preview") {
                let preview = if image.width() > 1024 || image.height() > 1024 {
                    DynamicImage::ImageRgba8(image).thumbnail(1024, 1024)
                } else {
                    DynamicImage::ImageRgba8(image)
                };
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
    if let Some(conn) = mbtiles {
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
            if item.crs != "EPSG:3857"
                || keys.len() < 8
                || !keys[4..]
                    .chunks_exact(4)
                    .any(|key| key == [3072, 0, 1, 3857])
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
        }
    }
    Ok(manifest)
}

#[cfg(test)]
mod source_tests {
    use super::*;

    #[test]
    fn arcgis_export_has_exact_web_mercator_tile_extent() {
        let source = HttpSource {
            id: "arcgis-test".into(), name: "ArcGIS test".into(), attribution: "USGS".into(),
            license: "Public domain".into(),
            url_template: "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage".into(),
            scheme: TileScheme::XYZ, tile_size: 256, network_policy: NetworkPolicy::PublicHttps,
            min_interval_ms: 500,
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
    }
}

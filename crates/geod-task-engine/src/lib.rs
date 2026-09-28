//! Local, deterministic planning. No model, network, or filesystem writes occur here.

use chrono::{DateTime, Duration, Utc};
use geod_core::boundary::BoundaryGeometry;
use geod_core::tile::{self, TileGrid};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};

pub mod ledger;

const MAX_PLAN_TILES: u64 = 4096;
const MAX_PLAN_RGBA_BYTES: u64 = 512 * 1024 * 1024;
const POLICY_VERSION: &str = "imagery-plan-0.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum SchemaVersion {
    #[serde(rename = "0.1")]
    V0_1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TaskKind {
    Imagery,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
pub enum OutputFormat {
    #[serde(rename = "geotiff")]
    GeoTiff,
    #[serde(rename = "mbtiles")]
    Mbtiles,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum TileScheme {
    XYZ,
    TMS,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLimits {
    pub max_tiles: u64,
    pub max_decoded_rgba_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSpec {
    pub schema_version: SchemaVersion,
    pub kind: TaskKind,
    pub source_id: String,
    /// WGS84 [west, south, east, north]. Antimeridian bounds must be split.
    pub bounds: [f64; 4],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<BoundaryGeometry>,
    pub zoom_levels: Vec<u8>,
    pub output_formats: Vec<OutputFormat>,
    pub output_directory: String,
    pub limits: ResourceLimits,
}

/// Supplied by a trusted local source registry, not copied from model output.
/// Credential values and source URL templates are deliberately absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceDescriptor {
    pub schema_version: SchemaVersion,
    pub id: String,
    pub display_name: String,
    pub attribution: String,
    pub license: String,
    pub bulk_download_allowed: bool,
    pub scheme: TileScheme,
    pub tile_size: u16,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// Local source registry increments this whenever the URL or policy changes.
    pub config_revision: String,
    /// Version of a credential reference, never the credential itself.
    pub credential_ref_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub schema_version: SchemaVersion,
    pub spec: TaskSpec,
    pub source_name: String,
    pub attribution: String,
    pub license: String,
    pub source_fingerprint: String,
    pub policy_version: String,
    pub tile_grids: Vec<PlanTileGrid>,
    pub total_tiles: u64,
    /// Sum of tile count × tile pixels × four bytes; not peak memory, disk, or transfer size.
    pub decoded_rgba_bytes: u64,
    /// Conservative free-space preflight budget; older stored 0.1 plans omit this field.
    #[serde(default)]
    pub required_free_disk_bytes: u64,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub plan_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTileGrid {
    pub zoom: u8,
    pub x_min: u32,
    pub y_min: u32,
    pub x_max: u32,
    pub y_max: u32,
    pub columns: u64,
    pub rows: u64,
    pub tile_count: u64,
    pub pixel_width: u64,
    pub pixel_height: u64,
    pub actual_bounds: [f64; 4],
}

impl From<TileGrid> for PlanTileGrid {
    fn from(g: TileGrid) -> Self {
        Self {
            zoom: g.zoom,
            x_min: g.x_min,
            y_min: g.y_min,
            x_max: g.x_max,
            y_max: g.y_max,
            columns: g.columns,
            rows: g.rows,
            tile_count: g.tile_count,
            pixel_width: g.pixel_width,
            pixel_height: g.pixel_height,
            actual_bounds: g.actual_bounds,
        }
    }
}

impl From<&PlanTileGrid> for TileGrid {
    fn from(g: &PlanTileGrid) -> Self {
        Self {
            zoom: g.zoom,
            x_min: g.x_min,
            y_min: g.y_min,
            x_max: g.x_max,
            y_max: g.y_max,
            columns: g.columns,
            rows: g.rows,
            tile_count: g.tile_count,
            pixel_width: g.pixel_width,
            pixel_height: g.pixel_height,
            actual_bounds: g.actual_bounds,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanError {
    pub code: &'static str,
    pub message: String,
}

impl PlanError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn hash_json<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("typed plan hash input must serialize");
    format!("{:x}", Sha256::digest(bytes))
}

fn normalize_bounds(bounds: &mut [f64; 4]) -> Result<(), PlanError> {
    if bounds.iter().any(|x| !x.is_finite()) {
        return Err(PlanError::new(
            "INVALID_SPEC",
            "Bounds must be finite numbers",
        ));
    }
    for value in bounds {
        *value = (*value * 100_000_000.0).round() / 100_000_000.0;
        if *value == 0.0 {
            *value = 0.0; // Remove negative zero from the hash.
        }
    }
    Ok(())
}

fn validate_output_path(path: &str) -> bool {
    let p = Path::new(path);
    p.is_absolute()
        && !p
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        && path.len() <= 4096
}

pub fn plan(
    mut spec: TaskSpec,
    source: &SourceDescriptor,
    now: DateTime<Utc>,
) -> Result<Plan, PlanError> {
    if source.id.is_empty() || source.id != spec.source_id || !source.bulk_download_allowed {
        return Err(PlanError::new(
            "SOURCE_UNAUTHORIZED",
            "Select a registered source that permits bulk downloads",
        ));
    }
    if source.display_name.trim().is_empty()
        || source.attribution.trim().is_empty()
        || source.license.trim().is_empty()
        || source.config_revision.trim().is_empty()
        || !matches!(source.tile_size, 256 | 512)
        || source.min_zoom > source.max_zoom
        || source.max_zoom > tile::MAX_ZOOM
    {
        return Err(PlanError::new(
            "INVALID_SOURCE",
            "Source metadata is incomplete or unsupported",
        ));
    }
    if !validate_output_path(&spec.output_directory) {
        return Err(PlanError::new(
            "INVALID_SPEC",
            "Output directory must be an absolute path without parent traversal",
        ));
    }
    if spec.zoom_levels.is_empty() || spec.output_formats.is_empty() {
        return Err(PlanError::new(
            "INVALID_SPEC",
            "Choose at least one zoom level and output format",
        ));
    }
    if !(1..=MAX_PLAN_TILES).contains(&spec.limits.max_tiles)
        || !(1..=MAX_PLAN_RGBA_BYTES).contains(&spec.limits.max_decoded_rgba_bytes)
    {
        return Err(PlanError::new(
            "INVALID_SPEC",
            "Resource limits exceed supported bounds",
        ));
    }
    if let Some(boundary) = &mut spec.boundary {
        spec.bounds = boundary
            .normalize()
            .map_err(|cause| PlanError::new("INVALID_BOUNDARY", cause.0))?;
    }
    normalize_bounds(&mut spec.bounds)?;
    spec.zoom_levels.sort_unstable();
    spec.zoom_levels.dedup();
    spec.output_formats.sort_unstable();
    spec.output_formats.dedup();
    if spec.boundary.is_some() && !spec.output_formats.contains(&OutputFormat::GeoTiff) {
        return Err(PlanError::new(
            "INVALID_BOUNDARY",
            "Polygon clipping requires GeoTIFF output; MBTiles preserves complete source tiles",
        ));
    }
    if spec
        .zoom_levels
        .iter()
        .any(|z| *z < source.min_zoom || *z > source.max_zoom)
    {
        return Err(PlanError::new(
            "INVALID_SPEC",
            "Requested zoom is outside the source range",
        ));
    }

    let mut tile_grids = Vec::with_capacity(spec.zoom_levels.len());
    let mut total_tiles = 0u64;
    for zoom in &spec.zoom_levels {
        let grid = tile::grid(spec.bounds, *zoom, source.tile_size)
            .map_err(|message| PlanError::new("INVALID_SPEC", message))?;
        total_tiles = total_tiles
            .checked_add(grid.tile_count)
            .ok_or_else(|| PlanError::new("RESOURCE_LIMIT", "Tile count overflow"))?;
        if total_tiles > spec.limits.max_tiles {
            return Err(PlanError::new(
                "RESOURCE_LIMIT",
                format!(
                    "{total_tiles} tiles exceed the selected limit of {}",
                    spec.limits.max_tiles
                ),
            ));
        }
        tile_grids.push(grid.into());
    }
    let decoded_rgba_bytes = total_tiles
        .checked_mul(u64::from(source.tile_size).pow(2))
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| PlanError::new("RESOURCE_LIMIT", "Decoded image size overflow"))?;
    if decoded_rgba_bytes > spec.limits.max_decoded_rgba_bytes {
        return Err(PlanError::new(
            "RESOURCE_LIMIT",
            format!("{decoded_rgba_bytes} decoded bytes exceed the selected limit"),
        ));
    }
    let required_free_disk_bytes =
        geod_core::imagery::required_free_disk_bytes(total_tiles, source.tile_size)
            .map_err(|cause| PlanError::new(cause.code, cause.message))?;

    let source_fingerprint = hash_json(source);
    // Struct field order is stable. Normalized numeric values and sorted sets
    // make repeated plans hash identically across sessions.
    let plan_hash = hash_json(&(&spec, &source_fingerprint, POLICY_VERSION));
    Ok(Plan {
        schema_version: SchemaVersion::V0_1,
        spec,
        source_name: source.display_name.clone(),
        attribution: source.attribution.clone(),
        license: source.license.clone(),
        source_fingerprint,
        policy_version: POLICY_VERSION.into(),
        tile_grids,
        total_tiles,
        decoded_rgba_bytes,
        required_free_disk_bytes,
        created_at: now,
        expires_at: now + Duration::minutes(30),
        plan_hash,
    })
}

pub fn task_spec_schema() -> schemars::Schema {
    schemars::schema_for!(TaskSpec)
}

pub fn source_descriptor_schema() -> schemars::Schema {
    schemars::schema_for!(SourceDescriptor)
}

pub fn plan_schema() -> schemars::Schema {
    schemars::schema_for!(Plan)
}

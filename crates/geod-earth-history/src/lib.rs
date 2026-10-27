//! Versioned, native-only Google Earth historical imagery adapter.
//! Directory snapshots are immutable; dates describe the history index, not a
//! promise about the acquisition date of every pixel. No upstream key is sent
//! to the model or accepted from a model-supplied URL.
mod dates;
mod storage;
mod wire_base;
mod keyhole;
pub use keyhole::{discover, select_snapshot, read_tile, snapshot_info, tile_evidence, validate_template, Snapshot};
pub use storage::initialize;
pub type Result<T> = std::result::Result<T, String>;
pub const ORIGIN: &str = "https://khmdb.google.com/";
pub const SCHEME: &str = "geod-earth-history";
pub fn is_template(value: &str) -> bool { value.starts_with("geod-earth-history:") }
pub fn network_target(value: &str) -> &str { if is_template(value) { ORIGIN } else { value } }
fn validate_id(id: &str) -> Result<()> {
    if id.len() == 64 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) { Ok(()) }
    else { Err("EARTH_PLAN: invalid snapshot identifier".into()) }
}

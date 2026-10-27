use crate::Result;
use sha2::{Digest,Sha256};
use std::{path::PathBuf,sync::OnceLock};
static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
pub fn initialize(directory: PathBuf) { let _ = DIRECTORY.set(directory); }
pub fn directory() -> Result<PathBuf> {
    let path = DIRECTORY.get().ok_or("EARTH_CACHE: history storage is not initialized")?.clone();
    std::fs::create_dir_all(&path).map_err(|_| "EARTH_CACHE: history storage is unavailable")?;
    Ok(path)
}
pub fn sha(bytes: &[u8]) -> String { format!("{:x}",Sha256::digest(bytes)) }

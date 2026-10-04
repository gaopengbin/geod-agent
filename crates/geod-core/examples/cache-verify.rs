//! Read-only cache audit; the optional report path is explicitly supplied.
use geod_core::cache_maintenance::{inventory, verify};
use std::{path::PathBuf,sync::atomic::AtomicBool};
fn main()->Result<(),Box<dyn std::error::Error>> {
    let mut args=std::env::args().skip(1);
    let root=PathBuf::from(args.next().ok_or("cache directory required")?);
    let report=PathBuf::from(args.next().ok_or("output report path required")?);
    let inventory=inventory(&root).map_err(|e|e.message)?;
    let verification=verify(&root,&AtomicBool::new(false),|_|{}).map_err(|e|e.message)?;
    let output=serde_json::json!({"checkedAt":chrono::Utc::now(),"readOnly":true,"directory":root,"inventory":inventory,"verification":verification});
    std::fs::write(report,serde_json::to_vec_pretty(&output)?)?;
    println!("{} tile entries checked; {} invalid; {} bytes",verification.checked,verification.invalid,inventory.total_bytes);
    Ok(())
}

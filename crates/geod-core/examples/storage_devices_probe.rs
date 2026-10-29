//! Read-only actual-volume capacity probe; no files are allocated on either disk.
use std::path::PathBuf;
fn main()->Result<(),Box<dyn std::error::Error>>{
 let mut args=std::env::args().skip(1);let output=PathBuf::from(args.next().ok_or("output directory")?);let cache=PathBuf::from(args.next().ok_or("cache directory")?);let receipt=PathBuf::from(args.next().ok_or("new receipt path")?);if receipt.exists(){return Err("preserve prior receipt".into());}
 let(w,c)=geod_core::storage_preflight::location_budgets(40200,256,1,false,true).map_err(|e|e.message)?;
 let report=geod_core::storage_preflight::inspect(&output,Some(&cache),w,c).map_err(|e|e.message)?;
 let value=serde_json::json!({"actualLocalMachine":true,"customerMachine":false,"filesAllocatedOnCheckedDisks":0,"report":report});std::fs::write(receipt,serde_json::to_vec_pretty(&value)?)?;println!("{value}");Ok(())
}

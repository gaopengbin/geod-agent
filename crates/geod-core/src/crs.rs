//! Export CRS identifiers are explicit; unknown definitions are never inferred.
use crate::imagery::CoreError;

pub fn normalize(value: &str) -> Result<String, CoreError> {
    let upper = value.trim().to_ascii_uppercase();
    let code = upper.strip_prefix("EPSG:").and_then(|s| s.parse::<u16>().ok())
        .filter(|code| *code > 0 && *code < 32767)
        .ok_or_else(|| CoreError::new("INVALID_OUTPUT_CRS", "请提供有效的 EPSG 编号；投影带号或中央经线不明确时先询问用户"))?;
    Ok(format!("EPSG:{code}"))
}

pub fn epsg(value: &str) -> Result<u16, CoreError> {
    normalize(value)?.strip_prefix("EPSG:").unwrap().parse()
        .map_err(|_| CoreError::new("INVALID_OUTPUT_CRS", "坐标系编号无效"))
}

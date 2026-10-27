use crate::Result;
use chrono::{Datelike,NaiveDate};
pub fn pack_date(value: &str) -> Result<u32> {
    let date = NaiveDate::parse_from_str(value,"%Y-%m-%d").map_err(|_|"EARTH_DATE: expected YYYY-MM-DD")?;
    if date.format("%Y-%m-%d").to_string()!=value || !(2..=9999).contains(&date.year()) { return Err("EARTH_DATE: invalid history date".into()); }
    Ok(((date.year() as u32)<<9) | (date.month()<<5) | date.day())
}

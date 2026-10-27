//! Native source-creator tools. These save only immutable catalogue metadata;
//! imagery downloads use the ordinary approved imagery task and local worker.
use super::{error,AppError};
use serde_json::{json,Value};
use chrono::NaiveDate;
use geod_core::earth_history;
pub(super) fn tools()->Vec<Value>{vec![
    json!({"name":"google_history_dates","description":"查询 Google Earth 谷歌历史影像在指定位置的真实历史目录日期。返回 catalogId、日期与点位范围；点位目录不能证明整个区域有覆盖，目录日期也不是全部像素的实际拍摄日期。先查此工具，再用 google_history_source 固定日期图源。","inputSchema":{"type":"object","properties":{"longitude":{"type":"number","minimum":-180,"maximum":180},"latitude":{"type":"number","minimum":-85.05112878,"maximum":85.05112878},"zoom":{"type":"integer","minimum":0,"maximum":22},"fromDate":{"type":"string"},"toDate":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["longitude","latitude","zoom"],"additionalProperties":false}}),
    json!({"name":"google_history_source","description":"用真实 Google Earth 历史目录 catalogId 和 YYYY-MM-DD 固定版本图源。按该日期或更早的可用影像逐块选取，不能保证整区同日拍摄。返回 source_configure 参数；登记后用现有 plan_imagery、确认和 jobs_start 下载，保留裁剪、导出、进度、重试与成果核验。无需 Google API Key，不是普通 HTTP XYZ 模板。","inputSchema":{"type":"object","properties":{"catalogId":{"type":"string","minLength":64,"maxLength":64},"date":{"type":"string","description":"YYYY-MM-DD；用户要求的截止日期，不得虚报实际拍摄日期"}},"required":["catalogId","date"],"additionalProperties":false}})
]}
fn failure(cause:String)->AppError {
    if cause.starts_with("EARTH_NO_DATA:"){error("SOURCE_TIME_UNAVAILABLE","此位置没有可用的 Google Earth 历史目录，请调整位置、级别或时期")}
    else if cause.starts_with("EARTH_NETWORK:"){error("SOURCE_NETWORK","Google Earth 历史影像暂时不可达，请检查网络与代理")}
    else if cause.starts_with("EARTH_DATE:")||cause.starts_with("EARTH_AOI:"){error("INVALID_HISTORY_ARGUMENTS","请提供有效坐标、缩放级别和 YYYY-MM-DD 日期")}
    else if cause.starts_with("EARTH_PLAN:")||cause.starts_with("EARTH_CACHE:"){error("HISTORY_CONTEXT_UNAVAILABLE","历史目录记录不可用，请重新查询日期；已有下载和成果保留")}
    else {error("SOURCE_PROTOCOL","Google Earth 历史影像目录暂时无法解析，未将缺失数据当成空目录")}
}
fn date_filter(args:&Value,key:&str)->Result<Option<String>,AppError>{match args.get(key){None=>Ok(None),Some(v)=>{
    let raw=v.as_str().ok_or_else(||error("INVALID_HISTORY_ARGUMENTS","日期须为 YYYY-MM-DD"))?;
    let parsed=NaiveDate::parse_from_str(raw,"%Y-%m-%d").map_err(|_|error("INVALID_HISTORY_ARGUMENTS","日期须为 YYYY-MM-DD"))?;
    if parsed.format("%Y-%m-%d").to_string()!=raw{return Err(error("INVALID_HISTORY_ARGUMENTS","日期须为 YYYY-MM-DD"));}Ok(Some(raw.into()))
}}}
pub(super) async fn dates(args:&Value)->Result<Value,AppError>{
    let longitude=args["longitude"].as_f64().ok_or_else(||error("INVALID_HISTORY_ARGUMENTS","请提供经度"))?;
    let latitude=args["latitude"].as_f64().ok_or_else(||error("INVALID_HISTORY_ARGUMENTS","请提供纬度"))?;
    let zoom=args["zoom"].as_u64().filter(|z|*z<=22).ok_or_else(||error("INVALID_HISTORY_ARGUMENTS","请提供 0–22 的缩放级别"))? as u8;
    let from=date_filter(args,"fromDate")?;let to=date_filter(args,"toDate")?;
    if from.as_ref().zip(to.as_ref()).is_some_and(|(a,b)|a>b){return Err(error("INVALID_HISTORY_ARGUMENTS","起始日期晚于结束日期"));}
    let builder=reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).connect_timeout(std::time::Duration::from_secs(10)).timeout(std::time::Duration::from_secs(25)).user_agent("GeoD-Agent/Google-Earth-History-v1");
    let proxy=crate::network::proxy_for(earth_history::ORIGIN).map_err(|_|error("NETWORK_PROXY_INVALID","代理设置不可用"))?;
    let builder=if let Some(proxy)=proxy{builder.proxy(reqwest::Proxy::all(proxy).map_err(|_|error("NETWORK_PROXY_INVALID","代理设置不可用"))?)}else{builder};
    let client=builder.build().map_err(|_|error("SOURCE_NETWORK","无法准备历史影像连接"))?;
    let mut response=earth_history::discover(longitude,latitude,zoom,client).await.map_err(failure)?;
    let values:Vec<_>=response["dates"].as_array().into_iter().flatten().filter(|v|v.as_str().is_some_and(|date|from.as_deref().is_none_or(|f|date>=f)&&to.as_deref().is_none_or(|t|date<=t))).cloned().collect();
    let offset=args["offset"].as_u64().unwrap_or(0)as usize;let limit=args["limit"].as_u64().unwrap_or(30).clamp(1,100)as usize;
    response["total"]=json!(values.len());response["offset"]=json!(offset);response["nextOffset"]=json!(if offset.saturating_add(limit)<values.len(){Some(offset+limit)}else{None});response["dates"]=json!(values.into_iter().skip(offset).take(limit).collect::<Vec<_>>());Ok(response)
}
pub(super) fn source(args:&Value)->Result<Value,AppError>{
    let catalog=args["catalogId"].as_str().ok_or_else(||error("INVALID_HISTORY_ARGUMENTS","请先查询历史目录"))?;
    let date=args["date"].as_str().ok_or_else(||error("INVALID_HISTORY_ARGUMENTS","请提供历史日期"))?;
    let s=earth_history::select_snapshot(catalog,date).map_err(failure)?;
    Ok(json!({"source":{"id":s.source_id(),"name":format!("Google Earth 历史影像（截至 {}）",s.requested_date),"urlTemplate":s.template(),"scheme":"XYZ","tileSize":256,"minZoom":0,"maxZoom":22,"minIntervalMs":0,"license":"","attribution":format!("© Google Earth; history on or before {}; acquisition dates vary or are unknown; provider credits retained in output metadata",s.requested_date)},
        "history":earth_history::snapshot_info(&s.template()).map_err(failure)?,"next":"用 source_configure 登记以上原生图源，再按已确认的区域和导出参数创建影像计划。目录点位不等于全区覆盖，不能承诺指定日期或同日拍摄。"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn history_capabilities_are_real_tools_and_do_not_offer_fake_dated_http_tiles(){
        let values=tools();assert_eq!(values.len(),2);
        assert_eq!(values[0]["name"],"google_history_dates");assert_eq!(values[1]["name"],"google_history_source");
        assert!(values[0]["description"].as_str().unwrap().contains("点位"));
        assert_eq!(source(&json!({"catalogId":"../outside","date":"2010-12-31"})).unwrap_err().code,"HISTORY_CONTEXT_UNAVAILABLE");
        assert_eq!(source(&json!({"catalogId":"bad","date":"2010-1-1"})).unwrap_err().code,"INVALID_HISTORY_ARGUMENTS");
    }
    #[tokio::test]async fn an_invalid_date_range_is_rejected_before_any_provider_request(){
        let error=dates(&json!({"longitude":116.397,"latitude":39.917,"zoom":16,"fromDate":"2020-01-01","toDate":"2010-12-31"})).await.unwrap_err();
        assert_eq!(error.code,"INVALID_HISTORY_ARGUMENTS");
    }
}

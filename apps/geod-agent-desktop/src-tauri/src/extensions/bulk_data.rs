//! Keep full geometry in the owned MCP receipt; expose bounded metadata to models.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use super::{error, AppError, LocalWorkspace, WorkspacePermission};
use std::{fs, io::Write, path::Path};

const MIN_POINTS: usize = 64;
const SUMMARY_BYTES: usize = 6_000;

fn escaped(key: &str) -> String { key.replace('~', "~0").replace('/', "~1") }
fn point_stats(value: &Value, count: &mut usize, bounds: &mut Option<[f64; 4]>) {
    let Some(items) = value.as_array() else { return };
    if items.len() >= 2 && items.iter().all(Value::is_number) {
        if let (Some(x), Some(y)) = (items[0].as_f64(), items[1].as_f64()) {
            if x.is_finite() && y.is_finite() { add_point(x, y, count, bounds); }
        }
    } else { for item in items { point_stats(item, count, bounds); } }
}
fn add_point(x: f64, y: f64, count: &mut usize, bounds: &mut Option<[f64; 4]>) {
    *count += 1;
    match bounds {
        Some(b) => { b[0] = b[0].min(x); b[1] = b[1].min(y); b[2] = b[2].max(x); b[3] = b[3].max(y); }
        None => *bounds = Some([x, y, x, y]),
    }
}
fn coordinate_text(text: &str) -> Option<(usize, Option<[f64; 4]>)> {
    let mut count = 0; let mut bounds = None;
    for pair in text.split(|c: char| c == ';' || c.is_whitespace()).filter(|s| !s.is_empty()) {
        let values: Vec<_> = pair.split(',').collect();
        if !(2..=3).contains(&values.len()) { return None; }
        let x = values[0].parse::<f64>().ok()?; let y = values[1].parse::<f64>().ok()?;
        if !x.is_finite() || !y.is_finite() { return None; }
        if values.len() == 3 && !values[2].parse::<f64>().ok()?.is_finite() { return None; }
        add_point(x, y, &mut count, &mut bounds);
    }
    (count > 1).then_some((count, bounds))
}
fn field(value: &Value, key: &str, pointer: &str) -> Option<Value> {
    let (mut count, mut bounds) = (0, None);
    let encoding = if matches!(key, "coordinates" | "positions") && value.is_array() {
        point_stats(value, &mut count, &mut bounds);
        if count == 0 { return None; } "coordinateArray"
    } else if matches!(key, "polyline" | "geometry" | "path") && value.is_string() {
        let text = value.as_str()?;
        if let Some((n, b)) = coordinate_text(text) { count = n; bounds = b; "coordinateText" }
        else if matches!(key, "polyline" | "geometry") && text.len() >= 512
            && text.bytes().all(|b| (63..=126).contains(&b)) { "encodedPolyline" }
        else { return None; }
    } else { return None; };
    Some(json!({"jsonPointer":pointer,"encoding":encoding,"pointCount":if count==0 {None}else{Some(count)},"bounds":bounds}))
}
fn collect(value: &Value, pointer: &str, key: &str, fields: &mut Vec<Value>) {
    if let Some(found) = field(value, key, pointer) { fields.push(found); return; }
    match value {
        Value::Object(map) => for (key, child) in map { collect(child, &format!("{pointer}/{}", escaped(key)), key, fields); },
        Value::Array(items) => for (i, child) in items.iter().enumerate() { collect(child, &format!("{pointer}/{i}"), "", fields); },
        // MCP commonly embeds a JSON result in content[].text. The pointer reader
        // below uses the same explicit JSON decoding, without changing the receipt.
        Value::String(text) if key == "text" => if let Ok(parsed) = serde_json::from_str::<Value>(text) { collect(&parsed, pointer, "", fields); },
        _ => {}
    }
}
fn replace(value: &Value, pointer: &str, key: &str, fields: &[Value], execution_id: &str) -> Value {
    if let Some(found) = fields.iter().find(|f| f["jsonPointer"] == pointer) {
        return json!({"localDataRef":{"executionId":execution_id,"jsonPointer":pointer},"pointCount":found["pointCount"],"bounds":found["bounds"],"encoding":found["encoding"]});
    }
    match value {
        Value::Object(map) => Value::Object(map.iter().map(|(key, child)| (key.clone(), replace(child, &format!("{pointer}/{}", escaped(key)), key, fields, execution_id))).collect()),
        Value::Array(items) => Value::Array(items.iter().enumerate().map(|(i, child)| replace(child, &format!("{pointer}/{i}"), "", fields, execution_id)).collect()),
        Value::String(text) if key == "text" => match serde_json::from_str::<Value>(text) {
            Ok(parsed) => json!(serde_json::to_string(&replace(&parsed, pointer, "", fields, execution_id)).unwrap()),
            Err(_) => value.clone(),
        },
        _ => value.clone(),
    }
}
fn bounded(value: &Value, depth: usize) -> Value {
    match value {
        Value::String(text) if text.chars().count() > 160 => json!({"textExcerpt":text.chars().take(160).collect::<String>(),"excerptOnly":true,"totalChars":text.chars().count()}),
        Value::Array(items) => json!({"itemCount":items.len(),"sampleOnly":items.len()>3,"items":items.iter().take(3).map(|v|bounded(v,depth+1)).collect::<Vec<_>>()}),
        Value::Object(map) if depth < 6 => Value::Object(map.iter().take(20).map(|(k,v)|(k.clone(),bounded(v,depth+1))).collect()),
        Value::Object(map) => json!({"keys":map.keys().take(20).collect::<Vec<_>>(),"metadataOnly":true}),
        _ => value.clone(),
    }
}
pub(super) fn summary(value: &Value, execution_id: &str) -> Option<Value> {
    let mut fields = Vec::new(); collect(value, "", "", &mut fields);
    let count: usize = fields.iter().filter_map(|f| f["pointCount"].as_u64()).map(|n|n as usize).sum();
    if count < MIN_POINTS && !fields.iter().any(|f| f["encoding"] == "encodedPolyline") { return None; }
    let raw = serde_json::to_vec(value).ok()?;
    let mut metadata = replace(value, "", "", &fields, execution_id);
    if serde_json::to_vec(&metadata).ok()?.len() > SUMMARY_BYTES { metadata = bounded(&metadata, 0); }
    if serde_json::to_vec(&metadata).ok()?.len() > SUMMARY_BYTES {
        metadata = json!({"metadataOnly":true,"isError":value["isError"],"error":value["error"],"status":value["status"],"code":value["code"]});
    }
    Some(json!({
        "bulkData":true,"executionId":execution_id,"bytes":raw.len(),"sha256":format!("{:x}",Sha256::digest(&raw)),
        "summary":metadata,"geometryFieldCount":fields.len(),"geometryFields":fields.iter().take(12).collect::<Vec<_>>(),
        "fieldsListedCompletely":fields.len()<=12,"isError":value["isError"],
        "requiresLocalProcessing":true,"exportTool":"mcp_result_export",
        "notice":"完整坐标已保存在本机，摘要不是原始几何。用 mcp_result_export 导出原始 JSON 或选定字段，再用本机工具处理；不要分页读取或手工抄写坐标。范围沿用原始坐标单位，未推断或转换坐标系。"
    }))
}

pub(super) fn select(value: &Value, pointer: &str) -> Result<Value, AppError> {
    if pointer.is_empty() { return Ok(value.clone()); }
    if !pointer.starts_with('/') || pointer.len() > 2_048 || pointer.split('/').count() > 64 {
        return Err(error("MCP_RESULT_POINTER_INVALID", "数据字段引用无效"));
    }
    let mut current = value.clone();
    for segment in pointer[1..].split('/') {
        let mut key = String::new(); let mut chars = segment.chars();
        while let Some(c) = chars.next() {
            if c == '~' { key.push(match chars.next() {Some('0')=>'~',Some('1')=>'/',_=>return Err(error("MCP_RESULT_POINTER_INVALID","数据字段引用无效"))}); }
            else { key.push(c); }
        }
        if let Value::String(text) = &current {
            current = serde_json::from_str(text).map_err(|_|error("MCP_RESULT_POINTER_INVALID","引用字段不是 JSON 对象"))?;
        }
        current = match &current {
            Value::Object(map) => map.get(&key).cloned(),
            Value::Array(items) => if !key.is_empty() && key.bytes().all(|b|b.is_ascii_digit()) && (key=="0" || !key.starts_with('0')) {key.parse::<usize>().ok().and_then(|i|items.get(i)).cloned()}else{None},
            _ => None,
        }.ok_or_else(||error("MCP_RESULT_POINTER_INVALID","未找到引用的数据字段"))?;
    }
    // Selecting content[].text alone produces usable JSON when it encodes JSON.
    if let Value::String(text) = &current { if let Ok(parsed @ (Value::Object(_) | Value::Array(_))) = serde_json::from_str::<Value>(text) { return Ok(parsed); } }
    Ok(current)
}
fn reject_link(path: &Path) -> Result<(), AppError> {
    let meta=fs::symlink_metadata(path).map_err(|_|error("MCP_PATH_DENIED","数据文件路径不可读"))?;
    if meta.file_type().is_symlink() { return Err(error("MCP_PATH_DENIED","数据导出不能经过链接路径")); }
    #[cfg(windows)] { use std::os::windows::fs::MetadataExt; if meta.file_attributes() & 0x400 != 0 {return Err(error("MCP_PATH_DENIED","数据导出不能经过重解析路径"));} }
    Ok(())
}
pub(super) fn export(value: &Value, execution_id: &str, pointer: &str, workspace: &LocalWorkspace, owner: &str, conversation: &str) -> Result<Value, AppError> {
    if workspace.permission != WorkspacePermission::FullAccess { return Err(error("MCP_APPROVAL_REQUIRED","保存完整数据文件需要当前工作区完全访问权限")); }
    let selected = select(value, pointer)?;
    let bytes = serde_json::to_vec(&selected).map_err(|_|error("MCP_RESULT_INVALID","数据无法序列化"))?;
    let sha = format!("{:x}", Sha256::digest(&bytes));
    let scope = format!("{:x}", Sha256::digest(format!("{owner}\0{conversation}\0{execution_id}\0{pointer}").as_bytes()));
    let root = workspace.directory.canonicalize().map_err(|_|error("MCP_PATH_DENIED","工作区不可读"))?;
    let folder = root.join("geod-local-data");
    if !folder.exists() { fs::create_dir(&folder).map_err(|_|error("MCP_RESULT_EXPORT_FAILED","无法创建本机数据目录"))?; }
    reject_link(&folder)?;
    if folder.canonicalize().map_err(|_|error("MCP_PATH_DENIED","数据目录不可读"))? != root.join("geod-local-data") { return Err(error("MCP_PATH_DENIED","数据目录不属于当前工作区")); }
    let name = format!("{}-{}.json", &scope[..16], &sha[..16]); let target = folder.join(&name);
    let mut reused = false;
    if target.exists() {
        reject_link(&target)?;
        if fs::read(&target).map_err(|_|error("MCP_RESULT_EXPORT_FAILED","数据文件不可读"))? != bytes { return Err(error("MCP_OUTPUT_EXISTS","同名数据文件已改变，未覆盖")); }
        reused = true;
    } else {
        let mut temporary = tempfile::NamedTempFile::new_in(&folder).map_err(|_|error("MCP_RESULT_EXPORT_FAILED","无法创建数据文件"))?;
        temporary.write_all(&bytes).and_then(|_|temporary.as_file().sync_all()).map_err(|_|error("MCP_RESULT_EXPORT_FAILED","无法保存完整数据"))?;
        temporary.persist_noclobber(&target).map_err(|_|error("MCP_RESULT_EXPORT_FAILED","无法保存数据文件，未覆盖已有文件"))?;
    }
    Ok(json!({"saved":true,"executionId":execution_id,"jsonPointer":pointer,"relativePath":format!("geod-local-data/{name}"),"bytes":bytes.len(),"sha256":sha,"reused":reused,"format":"json","coordinatesUnchanged":true,"sourceCrs":"unchanged; inspect source metadata before spatial processing"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn route() -> Value { json!({"structuredContent":{"routes":[{"distance":1234,"duration":120,"geometry":{"type":"LineString","coordinates":(0..2000).map(|i|json!([116.0+i as f64/10000.0,39.0+i as f64/20000.0,7])).collect::<Vec<_>>()}}]},"isError":false}) }
    #[test]
    fn coordinate_arrays_are_referenced_without_losing_route_metadata() {
        let raw = route(); let compact = summary(&raw,"run:call").unwrap();
        assert_eq!(compact["summary"]["structuredContent"]["routes"][0]["distance"],1234);
        assert_eq!(compact["geometryFields"][0]["pointCount"],2000);
        assert!(serde_json::to_vec(&compact).unwrap().len() < 2000);
        assert_eq!(select(&raw,"/structuredContent/routes/0/geometry/coordinates").unwrap(),raw["structuredContent"]["routes"][0]["geometry"]["coordinates"]);
        assert_eq!(raw["structuredContent"]["routes"][0]["geometry"]["coordinates"][1999][2],7);
    }
    #[test]
    fn embedded_json_and_amap_polylines_use_exact_field_pointers() {
        let line=(0..100).map(|i|format!("{},{}",116.0+i as f64/1000.0,39.0)).collect::<Vec<_>>().join(";");
        let raw=json!({"content":[{"type":"text","text":json!({"route":{"paths":[{"distance":"3000","steps":[{"polyline":line}]}]}}).to_string()}]});
        let compact=summary(&raw,"call").unwrap(); let pointer=compact["geometryFields"][0]["jsonPointer"].as_str().unwrap();
        assert_eq!(pointer,"/content/0/text/route/paths/0/steps/0/polyline");
        assert_eq!(select(&raw,pointer).unwrap(),json!(line));
        assert_eq!(compact["geometryFields"][0]["pointCount"],100);
        assert!(select(&raw,"/content/0/text").unwrap().is_object());
    }
    #[test]
    fn short_coordinates_and_non_geometry_results_are_unchanged() {
        assert!(summary(&json!({"coordinates":[[1,2],[3,4]],"distance":5}),"call").is_none());
        assert!(summary(&json!({"values":(0..3000).collect::<Vec<_>>(),"error":"provider failure"}),"call").is_none());
        for pointer in ["not/a/pointer","/~2","/structuredContent/routes/00","/missing"] {assert!(select(&route(),pointer).is_err());}
    }
    #[test]
    fn many_small_steps_and_encoded_geometry_are_also_compacted() {
        let raw=json!({"steps":(0..20).map(|_|json!({"coordinates":[[1,2],[2,3],[3,4],[4,5]]})).collect::<Vec<_>>(),"isError":true});
        let result=summary(&raw,"call").unwrap();assert_eq!(result["geometryFieldCount"],20);assert_eq!(result["isError"],true);assert_eq!(result["fieldsListedCompletely"],false);
        assert!(summary(&json!({"geometry":"a".repeat(600)}),"call").is_some());
    }
    #[test]
    fn many_individual_point_features_use_the_same_bulk_threshold() {
        let raw=json!({"type":"FeatureCollection","features":(0..64).map(|i|json!({"type":"Feature","geometry":{"type":"Point","coordinates":[i,1]}})).collect::<Vec<_>>()});
        let compact=summary(&raw,"points").unwrap();assert_eq!(compact["geometryFieldCount"],64);
        assert_eq!(compact["geometryFields"][0]["pointCount"],1);
        assert_eq!(select(&raw,"/features/63/geometry/coordinates").unwrap(),json!([63,1]));
    }
    #[test]
    fn exported_geometry_is_exact_idempotent_and_cannot_overwrite() {
        let dir=tempfile::tempdir().unwrap();let workspace=LocalWorkspace{directory:dir.path().into(),permission:WorkspacePermission::FullAccess};
        let raw=route();let file=export(&raw,"call","",&workspace,"alice","conversation").unwrap();let path=dir.path().join(file["relativePath"].as_str().unwrap());
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),raw);
        assert_eq!(export(&raw,"call","",&workspace,"alice","conversation").unwrap()["reused"],true);
        fs::write(path,b"changed").unwrap();assert_eq!(export(&raw,"call","",&workspace,"alice","conversation").unwrap_err().code,"MCP_OUTPUT_EXISTS");
        let readonly=LocalWorkspace{directory:dir.path().into(),permission:WorkspacePermission::ConfirmEach};assert_eq!(export(&raw,"call","",&readonly,"alice","conversation").unwrap_err().code,"MCP_APPROVAL_REQUIRED");
        assert_ne!(file["relativePath"],export(&raw,"call","",&workspace,"bob","conversation").unwrap()["relativePath"]);
    }
    #[test]
    fn export_rejects_redirected_data_folder() {
        let dir=tempfile::tempdir().unwrap();fs::write(dir.path().join("geod-local-data"),b"not a directory").unwrap();
        let workspace=LocalWorkspace{directory:dir.path().into(),permission:WorkspacePermission::FullAccess};assert!(export(&route(),"call","",&workspace,"alice","conversation").is_err());
    }
}

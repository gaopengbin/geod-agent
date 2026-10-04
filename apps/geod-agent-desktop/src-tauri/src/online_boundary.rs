//! Versioned, offline AreaCity administrative boundaries; GCJ-02 → WGS84.
use crate::{AppError, BoundaryImport};
use geod_core::boundary::BoundaryGeometry;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{f64::consts::PI, io::Read, sync::OnceLock};

const GEOMETRY: &[u8] = include_bytes!("../data/areacity/geometry.bin");
const MANIFEST: &str = include_str!("../data/areacity/manifest.json");
#[derive(Deserialize)]
struct Region { id: String, parent: String, level: u8, name: String, path: String, offset: usize, length: usize }
impl Region {
    fn adcode(&self) -> String { format!("{:0<6}", self.id) }
}
fn library() -> Result<&'static Vec<Region>, AppError> {
    static REGIONS: OnceLock<Result<Vec<Region>, String>> = OnceLock::new();
    REGIONS.get_or_init(|| serde_json::from_str(include_str!("../data/areacity/regions.json")).map_err(|e|e.to_string()))
        .as_ref().map_err(|_|error("BOUNDARY_LIBRARY_INVALID", "本地行政边界库无效"))
}

fn error(code: &'static str, message: &str) -> AppError { AppError { code, message: message.into() } }

fn region_key(name: &str) -> String {
    let name = name.trim();
    let name = match name.to_ascii_lowercase().as_str() {
        "beijing" => "北京", "tianjin" => "天津", "shanghai" => "上海", "chongqing" => "重庆", _ => name,
    };
    for suffix in ["维吾尔自治区", "壮族自治区", "回族自治区", "特别行政区", "自治区", "自治州", "省", "市", "区", "县"] {
        if let Some(short) = name.strip_suffix(suffix) { return short.to_string(); }
    }
    name.to_string()
}

fn under_parent(item: &Region, parent: &str, index: &[Region]) -> bool {
    let mut code = item.parent.as_str();
    for _ in 0..4 {
        let Some(found) = index.iter().find(|region| region.id == code) else { return false; };
        if region_key(&found.name) == region_key(parent) || found.adcode() == parent || found.id == parent { return true; }
        code = &found.parent;
    }
    false
}

pub(crate) async fn lookup(args: Value) -> Result<Value, AppError> {
    let query = args["query"].as_str().unwrap_or("").trim();
    let parent = args["parent"].as_str().unwrap_or("").trim();
    if query.is_empty() || query.chars().count() > 80 || parent.chars().count() > 80 { return Err(error("INVALID_BOUNDARY_QUERY", "请输入行政区域名称或六位区划编码")); }
    let index = library()?;
    let mut matches: Vec<_> = index.iter().filter(|item| {
        (region_key(&item.name) == region_key(query) || item.adcode() == query || item.id == query)
            && (parent.is_empty() || under_parent(item, parent, index))
    }).collect();
    // Direct-controlled cities appear at province and city levels with the
    // same geometry. Collapse only identical boundary records, not names.
    matches.sort_by_key(|item| item.level);
    let mut retained: Vec<&Region> = Vec::new();
    matches.retain(|item| {
        if retained.iter().any(|previous| item.offset == previous.offset && item.length == previous.length && under_parent(item,&previous.id,index)) { return false; }
        retained.push(item);
        true
    });
    if matches.len() != 1 {
        return Ok(json!({"found":false,"query":query,"reason":if matches.is_empty() {"未找到区域，请核对名称"} else {"存在同名区域，请指定所属省市"},
            "candidates":matches.iter().take(12).map(|item|json!({"name":item.name,"adcode":item.adcode(),"path":item.path,"level":item.level})).collect::<Vec<_>>() }));
    }
    let region = matches[0];
    let metadata: Value = serde_json::from_str(MANIFEST).map_err(|_|error("BOUNDARY_LIBRARY_INVALID", "本地边界版本信息无效"))?;
    let end = region.offset.checked_add(region.length).ok_or_else(||error("BOUNDARY_LIBRARY_INVALID", "边界索引越界"))?;
    let compressed = GEOMETRY.get(region.offset..end).ok_or_else(||error("BOUNDARY_LIBRARY_INVALID", "边界索引越界"))?;
    let mut geometry = decode(compressed)?;
    if geometry.polygons.is_empty() { return Ok(json!({"found":false,"query":query,"reason":"此版本有区域名称但没有边界几何，可提供自定义边界或选择其他区域","name":region.name,"version":metadata["version"],"collectedAt":metadata["collectedAt"]})); }
    for polygon in &mut geometry.polygons { for ring in polygon { for point in ring { *point = gcj_to_wgs(*point); } } }
    let bounds = geometry.normalize().map_err(|e|error("BOUNDARY_INVALID", e.0))?;
    let boundary = BoundaryImport { name:format!("{}-AreaCity-{}.geojson",region.name,metadata["collectedAt"].as_str().unwrap_or("").replace('-',"")), bounds, polygon_count:geometry.polygons.len(), geometry };
    Ok(json!({"found":true,"name":region.name,"adcode":region.adcode(),"path":region.path,"bounds":boundary.bounds,"polygonCount":boundary.polygon_count,
        "source":"AreaCity 本地行政区边界库","sourceUrl":format!("{}/releases/tag/{}",metadata["source"].as_str().unwrap_or(""),metadata["version"].as_str().unwrap_or("")),
        "version":metadata["version"],"collectedAt":metadata["collectedAt"],"knownMissing":metadata["knownMissing"],"offline":true,"sourceCrs":"GCJ-02","crs":"EPSG:4326",
        "coordinateMethod":"GCJ-02 迭代逆变换，公开行政区边界用于任务裁剪；不代表测绘级精度",
        "boundary":boundary}))
}

pub(crate) async fn lookup_many(args: Value) -> Result<Value, AppError> {
    let queries = args["queries"].as_array().filter(|items| !items.is_empty() && items.len() <= 32)
        .ok_or_else(|| error("INVALID_BOUNDARY_QUERY", "请提供 1 至 32 个区域名称或编码"))?;
    let mut items = Vec::new();
    for query in queries {
        let query = query.as_str().ok_or_else(|| error("INVALID_BOUNDARY_QUERY", "区域名称必须是文本"))?;
        items.push(lookup(json!({"query":query,"parent":args["parent"]})).await?);
    }
    let found = items.iter().filter(|item|item["found"] == true).count();
    Ok(json!({"requestedCount":queries.len(),"foundCount":found,"items":items}))
}

/// Neighboring regions share a nonzero edge in the actual versioned geometry.
/// Point contacts, bounding-box overlaps and model guesses do not count.
pub(crate) async fn neighbors(args: Value) -> Result<Value, AppError> {
    let target = lookup(args).await?;
    if target["found"] != true { return Ok(target); }
    let adcode = target["adcode"].as_str().unwrap_or("").to_string();
    let neighbors = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Value>, AppError> {
        use std::collections::HashSet;
        let index = library()?;
        let region = index.iter().find(|item|item.adcode() == adcode).ok_or_else(||error("BOUNDARY_NOT_FOUND", "未找到区域"))?;
        let geometry = decode(&GEOMETRY[region.offset..region.offset+region.length])?;
        let point = |p: &[f64;2]| [(p[0]*100_000_000.0).round() as i64,(p[1]*100_000_000.0).round() as i64];
        let edge = |a: &[f64;2], b: &[f64;2]| { let (a,b) = (point(a),point(b)); if a <= b { (a,b) } else { (b,a) } };
        let edges: HashSet<_> = geometry.polygons.iter().flatten().flat_map(|ring|ring.windows(2)).filter(|e|e[0] != e[1]).map(|e|edge(&e[0],&e[1])).collect();
        let mut found = Vec::new();
        let mut seen = HashSet::new();
        for candidate in index.iter().filter(|item|item.level == region.level && item.id != region.id) {
            if (candidate.offset,candidate.length) == (region.offset,region.length) || !seen.insert((candidate.offset,candidate.length)) { continue; }
            let other = decode(&GEOMETRY[candidate.offset..candidate.offset+candidate.length])?;
            let shared = other.polygons.iter().flatten().flat_map(|ring|ring.windows(2)).filter(|e|e[0] != e[1] && edges.contains(&edge(&e[0],&e[1]))).count();
            if shared > 0 { found.push(json!({"name":candidate.name,"adcode":candidate.adcode(),"path":candidate.path,"level":candidate.level,"sharedSegmentCount":shared})); }
        }
        Ok(found)
    }).await.map_err(|_|error("BOUNDARY_LOOKUP_FAILED", "相邻区域查询未完成"))??;
    Ok(json!({"found":true,"name":target["name"],"adcode":target["adcode"],"neighbors":neighbors,"relationship":"shared-boundary-segment","source":target["source"],"version":target["version"],"collectedAt":target["collectedAt"],"sourceUrl":target["sourceUrl"]}))
}

fn decode(compressed: &[u8]) -> Result<BoundaryGeometry, AppError> {
    let invalid = ||error("BOUNDARY_LIBRARY_INVALID", "本地边界几何格式无效");
    let mut data = Vec::new();
    flate2::read::GzDecoder::new(compressed).take(4 * 1024 * 1024).read_to_end(&mut data).map_err(|_|invalid())?;
    let mut cursor = 0;
    fn count(data: &[u8], cursor: &mut usize) -> Option<usize> {
        let bytes = data.get(*cursor..*cursor+4)?; *cursor += 4;
        Some(u32::from_le_bytes(bytes.try_into().ok()?) as usize)
    }
    fn delta(data: &[u8], cursor: &mut usize) -> Option<i64> {
        let mut value = 0u64;
        for shift in (0..63).step_by(7) {
            let byte = *data.get(*cursor)?; *cursor += 1;
            value |= u64::from(byte & 127) << shift;
            if byte & 128 == 0 { return Some((value >> 1) as i64 ^ -((value & 1) as i64)); }
        }
        None
    }
    let polygons_count = count(&data, &mut cursor).filter(|v| *v <= 1024).ok_or_else(invalid)?;
    let mut polygons = Vec::new(); let mut total = 0usize;
    for _ in 0..polygons_count {
        let rings_count = count(&data, &mut cursor).filter(|v| (1..=64).contains(v)).ok_or_else(invalid)?;
        let mut rings = Vec::new();
        for _ in 0..rings_count {
            let points = count(&data, &mut cursor).filter(|v| (4..=65_536).contains(v)).ok_or_else(invalid)?;
            total += points; if total > 65_536 { return Err(invalid()); }
            let mut previous = [0i64, 0]; let mut ring = Vec::with_capacity(points);
            for _ in 0..points {
                for coordinate in &mut previous { *coordinate = coordinate.checked_add(delta(&data,&mut cursor).ok_or_else(invalid)?).ok_or_else(invalid)?; }
                ring.push([previous[0] as f64 / 100_000_000.0, previous[1] as f64 / 100_000_000.0]);
            }
            rings.push(ring);
        }
        polygons.push(rings);
    }
    if cursor != data.len() { return Err(invalid()); }
    Ok(BoundaryGeometry { polygons })
}

fn wgs_to_gcj([lon, lat]: [f64; 2]) -> [f64; 2] {
    if !(72.004..=137.8347).contains(&lon) || !(0.8293..=55.8271).contains(&lat) { return [lon, lat]; }
    let x = lon - 105.0; let y = lat - 35.0;
    let wave = (20.0 * (6.0 * x * PI).sin() + 20.0 * (2.0 * x * PI).sin()) * 2.0 / 3.0;
    let mut dlat = -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*x.abs().sqrt() + wave;
    dlat += (20.0 * (y*PI).sin() + 40.0 * (y/3.0*PI).sin()) * 2.0/3.0;
    dlat += (160.0 * (y/12.0*PI).sin() + 320.0 * (y*PI/30.0).sin()) * 2.0/3.0;
    let mut dlon = 300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*x.abs().sqrt() + wave;
    dlon += (20.0 * (x*PI).sin() + 40.0 * (x/3.0*PI).sin()) * 2.0/3.0;
    dlon += (150.0 * (x/12.0*PI).sin() + 300.0 * (x/30.0*PI).sin()) * 2.0/3.0;
    let rad = lat / 180.0 * PI;
    let magic = 1.0 - 0.00669342162296594323 * rad.sin().powi(2);
    let sqrt = magic.sqrt();
    dlat = dlat * 180.0 / ((6378245.0 * (1.0 - 0.00669342162296594323)) / (magic*sqrt) * PI);
    dlon = dlon * 180.0 / (6378245.0 / sqrt * rad.cos() * PI);
    [lon + dlon, lat + dlat]
}

fn gcj_to_wgs(target: [f64; 2]) -> [f64; 2] {
    let mut estimate = target;
    for _ in 0..10 {
        let mapped = wgs_to_gcj(estimate);
        let error = [mapped[0]-target[0], mapped[1]-target[1]];
        estimate[0] -= error[0]; estimate[1] -= error[1];
        if error[0].abs().max(error[1].abs()) < 1e-9 { break; }
    }
    estimate
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn region_names_and_same_name_parent_selection() {
        assert_eq!(region_key("北京市"), region_key("Beijing"));
        let index = library().unwrap();
        let item = index.iter().find(|r|r.id == "110105").unwrap();
        assert!(under_parent(item, "北京", index));
        assert!(!under_parent(item, "长春", index));
    }
    #[test]
    fn zhumadian_actual_neighbors_and_multiple_ranges_remain_available() {
        let result = tauri::async_runtime::block_on(neighbors(json!({"query":"驻马店市"}))).unwrap();
        let actual: std::collections::BTreeSet<_> = result["neighbors"].as_array().unwrap().iter().map(|item|item["name"].as_str().unwrap()).collect();
        assert_eq!(actual, ["阜阳市","平顶山市","漯河市","南阳市","信阳市","周口市"].into_iter().collect());
        assert_eq!(result["relationship"],"shared-boundary-segment");
        let mut queries = vec![json!("驻马店市")];
        queries.extend(result["neighbors"].as_array().unwrap().iter().map(|item|item["adcode"].clone()));
        let found = tauri::async_runtime::block_on(lookup_many(json!({"queries":queries}))).unwrap();
        assert_eq!(found["foundCount"], 7);
        let temp = tempfile::tempdir().unwrap(); let path = temp.path().join("ranges.sqlite");
        let conversation = uuid::Uuid::new_v4().to_string(); let mut ids = Vec::new();
        let combined = {
            let store = geod_task_engine::ledger::TaskStore::open(&path).unwrap();
            for item in found["items"].as_array().unwrap() {
                let range: BoundaryImport = serde_json::from_value(item["boundary"].clone()).unwrap();
                ids.push(store.save_boundary(&conversation, item["name"].as_str().unwrap(), range.geometry).unwrap().summary.boundary_id);
            }
            store.combine_boundaries(&conversation, &ids, Some("驻马店及周边六市")).unwrap()
        };
        let store = geod_task_engine::ledger::TaskStore::open(&path).unwrap();
        assert_eq!(store.list_boundaries(&conversation).unwrap().len(),8);
        assert_eq!(store.get_boundary(&conversation, &combined.summary.boundary_id).unwrap().unwrap(),combined);
        assert_eq!(combined.summary.input_ids.len(),7);
        let exported = serde_json::to_vec_pretty(&json!({"type":"MultiPolygon","coordinates":combined.geometry.polygons})).unwrap();
        assert!(exported.len() > 1024*1024, "Regression fixture must exceed the old artifact reader limit");
        let mut readback = BoundaryGeometry::from_geojson(&exported).unwrap();
        readback.normalize().unwrap();
        assert_eq!(readback,combined.geometry,"Detailed exported boundaries must be readable during artifact verification");
        eprintln!("Actual seven-city union: {} polygons, {} vertices, {:?}",combined.summary.polygon_count,combined.geometry.polygons.iter().flatten().map(Vec::len).sum::<usize>(),combined.summary.bounds);
    }
    #[test]
    fn coordinate_conversion_matches_known_beijing_pair_and_preserves_holes() {
        // Public GCJ-02 / WGS84 reference pair from coordtransform's example.
        let wgs = gcj_to_wgs([116.404, 39.915]);
        assert!((wgs[0] - 116.3977555).abs() < 0.000001);
        assert!((wgs[1] - 39.9135957).abs() < 0.000001);
        assert_eq!(gcj_to_wgs([-74.0,40.7]), [-74.0,40.7]);
        let mut geometry = decode(include_bytes!("../data/areacity/hole-format-fixture.bin.gz")).unwrap();
        for polygon in &mut geometry.polygons { for ring in polygon { for point in ring { *point = gcj_to_wgs(*point); } } }
        geometry.normalize().unwrap();
        assert_eq!(geometry.polygons[0].len(),2,"AreaCity '~' must retain the hole");
        for ring in &geometry.polygons[0] { assert_eq!(ring.first(),ring.last()); }
    }
    #[test]
    fn bundled_beijing_and_haidian_boundaries_are_usable_offline() {
        let result = tauri::async_runtime::block_on(lookup(json!({"query":"北京"}))).unwrap();
        assert_eq!(result["adcode"],"110000");
        assert_eq!(result["crs"],"EPSG:4326");
        assert_eq!(result["collectedAt"],"2026-04-03");
        let mut geometry: BoundaryGeometry = serde_json::from_value(result["boundary"]["geometry"].clone()).unwrap();
        let bounds = geometry.normalize().unwrap();
        assert!(bounds[0] < 116.3975 && bounds[2] > 116.3975 && bounds[1] < 39.9087 && bounds[3] > 39.9087);
        assert!(geometry.polygons[0][0].len() > 15_000, "Detailed boundary must not be silently simplified");
        let haidian = tauri::async_runtime::block_on(lookup(json!({"query":"海淀区","parent":"北京市"}))).unwrap();
        assert_eq!(haidian["adcode"],"110108");
        assert!(haidian["bounds"][0].as_f64().unwrap() < 116.3);
        let ambiguous = tauri::async_runtime::block_on(lookup(json!({"query":"朝阳区"}))).unwrap();
        assert_eq!(ambiguous["found"],false);
        assert!(ambiguous["candidates"].as_array().unwrap().len() >= 2);
        let selected = tauri::async_runtime::block_on(lookup(json!({"query":"朝阳区","parent":"北京"}))).unwrap();
        assert_eq!(selected["adcode"],"110105");
        let missing = tauri::async_runtime::block_on(lookup(json!({"query":"和康县"}))).unwrap();
        assert_eq!(missing["found"],false);
    }
    #[test]
    fn bundled_integrity_and_all_geometries_validate() {
        use sha2::{Digest,Sha256};
        let manifest: Value = serde_json::from_str(MANIFEST).unwrap();
        assert_eq!(format!("{:x}",Sha256::digest(GEOMETRY)),manifest["geometrySha256"].as_str().unwrap());
        let mut seen = std::collections::HashSet::new();
        for region in library().unwrap() {
            if !seen.insert((region.offset,region.length)) { continue; }
            let mut geometry = decode(&GEOMETRY[region.offset..region.offset+region.length]).unwrap();
            if geometry.polygons.is_empty() { continue; }
            for polygon in &mut geometry.polygons { for ring in polygon { for point in ring { *point = gcj_to_wgs(*point); } } }
            geometry.normalize().unwrap_or_else(|cause|panic!("{} {}: {}",region.id,region.name,cause.0));
        }
    }
    #[test]
    fn real_beijing_boundary_masks_pixels_and_creates_a_persisted_plan() {
        use geod_task_engine::{ledger::TaskStore,TaskSpec};
        let temp = tempfile::tempdir().unwrap();
        let result = tauri::async_runtime::block_on(lookup(json!({"query":"北京"}))).unwrap();
        let geometry: BoundaryGeometry = serde_json::from_value(result["boundary"]["geometry"].clone()).unwrap();
        let grid = geod_core::tile::grid([115.3,39.0,117.6,41.1],8,256).unwrap();
        let mut raster = image::RgbaImage::from_pixel((grid.x_max-grid.x_min+1)*256,(grid.y_max-grid.y_min+1)*256,image::Rgba([30,60,90,255]));
        geod_core::boundary::mask_rgba(&mut raster,&geometry,&grid,256,0,0);
        let alpha = |lon:f64,lat:f64| {
            let dimension = f64::from((1u32 << grid.zoom)*256);
            let x = (((lon+180.0)/360.0*dimension)-f64::from(grid.x_min*256)).floor() as u32;
            let y = (((1.0-lat.to_radians().tan().asinh()/PI)/2.0*dimension)-f64::from(grid.y_min*256)).floor() as u32;
            raster.get_pixel(x,y)[3]
        };
        assert_eq!(alpha(116.3975,39.9087),255,"Tiananmen must remain inside Beijing");
        assert_eq!(alpha(117.2,39.1),0,"Tianjin must be transparent");
        let mut store = TaskStore::open(&temp.path().join("test.sqlite")).unwrap();
        let source = test_source(&mut store);
        let spec: TaskSpec = serde_json::from_value(json!({"schemaVersion":"0.1","kind":"imagery","sourceId":source.id,"bounds":result["bounds"],"boundary":geometry,"zoomLevels":[12],"outputFormats":["geotiff"],"outputDirectory":temp.path().join("imagery").to_string_lossy(),"limits":{"maxTiles":4096,"maxDecodedRgbaBytes":536870912}})).unwrap();
        let plan = store.create_plan_for_tool_execution("beijing-boundary-test",spec,&source,chrono::Utc::now()).unwrap();
        assert!(plan.plan.total_tiles > 0 && plan.plan.total_tiles < 4096);
        assert_eq!(store.get_plan(&plan.plan_id).unwrap().unwrap().plan.spec.boundary,Some(geometry));
        eprintln!("Beijing AreaCity 2026-04-03: plan persisted with {} tiles at Z12; actual raster mask retains Beijing and removes Tianjin",plan.plan.total_tiles);
    }
    fn test_source(store: &mut geod_task_engine::ledger::TaskStore) -> geod_task_engine::SourceDescriptor {
        let endpoint = serde_json::from_value(json!({"id":"esri-world-imagery","name":"Esri World Imagery","urlTemplate":"https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}","scheme":"XYZ","tileSize":256,"attribution":"Esri","license":"","networkPolicy":"PublicHttps","minIntervalMs":100})).unwrap();
        store.save_source(endpoint,0,22,false,chrono::Utc::now()).unwrap()
    }
    #[test]
    #[ignore = "real hosted model using the existing desktop login; no download or server changes"]
    fn beijing_boundary_live_model() {
        run_beijing_model(false, false);
    }
    #[test]
    #[ignore = "real hosted model; creates an isolated queued job without running a worker"]
    fn beijing_full_access_live_model() {
        run_beijing_model(true, false);
    }
    #[test]
    #[ignore = "real hosted model; plan-only Full Access must not create a job"]
    fn beijing_plan_only_live_model() {
        run_beijing_model(true, true);
    }
    fn run_beijing_model(full_access: bool, plan_only: bool) {
        use geod_task_engine::{ledger::TaskStore,TaskSpec};
        let temp = tempfile::tempdir().unwrap();
        let services = crate::services::ServiceState::new(temp.path().join("agent-services.json"));
        let mut store = TaskStore::open(&temp.path().join("tasks.sqlite")).unwrap();
        let source = test_source(&mut store);
        let conversation = uuid::Uuid::new_v4().to_string();
        let permission = if full_access { "fullAccess" } else { "confirmEach" };
        let request = if plan_only { "只生成北京影像裁剪计划，不启动下载。" } else { "下载北京影像并裁剪。" };
        let directive = if full_access { "当前对话为完全访问。用户要求下载或执行时，生成或核对计划后继续调用 jobs_start，不等待计划卡片确认，不沿用旧消息中的逐次确认状态。仅要求规划、预览或估算时不启动任务。执行结果以本机工具返回为准。" } else { "当前对话为逐次确认。生成计划后等待用户在计划卡片确认，不自动调用 jobs_start。" };
        let mut messages = vec![json!({"role":"user","content":"下载北京影像并裁剪。"}),json!({"role":"assistant","content":"当前是 Confirm Each，必须确认计划。"}), json!({"role":"user","content":format!("【本轮本机权限状态】\n{}\n{directive}\n【权限状态结束】\n请全程使用中文，包括执行前的说明和最终答复。我的请求：\n{request}\n【本机可用技能索引：geod-source-creator 已启用。用 skill_read 读取，用 extensions_list 发现 builtin-source-creator.lookup_boundary，再用 mcp_call 查询。已内置 AreaCity 2026-04-03 本地边界库，支持北京等省市区县。调用后几何自动附到本机计划。未指定缩放和格式时先用 Z12、GeoTIFF 生成计划，按本轮权限状态执行，简短说明默认参数。】",json!({"permission":permission,"canStartWithoutPlanConfirmation":full_access}))})];
        let mut attached: Option<BoundaryImport> = None;
        let mut planned = false;
        let mut settled = false;
        let mut used = Vec::new();
        for round in 0..12 {
            let generation = crate::services::creator_test_generation(&services,&conversation,json!(messages)).unwrap();
            assert_eq!(generation["state"],"settled");
            let result = &generation["result"];
            let content = result["content"].as_str().unwrap_or("");
            if !content.trim().is_empty() {
                eprintln!("Model round {round}: {}",content.chars().take(700).collect::<String>());
            }
            let calls = result["toolCalls"].as_array().unwrap();
            let chinese = content.chars().any(|c|('\u{3400}'..='\u{9fff}').contains(&c));
            if calls.is_empty() { assert!(chinese,"Final output is not Chinese: {content}"); settled = true; break; }
            if !content.trim().is_empty() && !chinese { eprintln!("Language diagnostic: model returned English progress despite the Chinese language request; boundary workflow continues"); }
            messages.push(json!({"role":"assistant","content":result["content"],"tool_calls":calls.iter().map(|c|json!({"id":c["id"],"type":"function","function":c["function"]})).collect::<Vec<_>>()}));
            for request in calls {
                let name = request["function"]["name"].as_str().unwrap();
                let args: Value = serde_json::from_str(request["function"]["arguments"].as_str().unwrap()).unwrap();
                used.push(name.to_owned());
                let output = match name {
                    "workspace_status" => json!({"name":"isolated boundary test","permission":permission,"canStartWithoutPlanConfirmation":full_access}),
                    "extensions_list" => json!({"skills":[{"name":"geod-source-creator","description":"配置图源及按中国行政区下载裁剪"}],"connectors":[crate::source_creator::tools()]}),
                    "skill_read" if args["name"] == "geod-source-creator" => json!({"name":"geod-source-creator","content":include_str!("../../skills/geod-source-creator/SKILL.md")}),
                    "sources_list" => json!({"sources":store.list_sources().unwrap()}),
                    "workspace_boundaries_list" | "workspace_gis_files_list" => json!({"files":[]}),
                    "mcp_call" if args["connectorId"] == "builtin-source-creator" && args["toolName"] == "lookup_boundary" => {
                        let mut value = tauri::async_runtime::block_on(crate::source_creator::call("lookup_boundary",args["arguments"].clone())).unwrap();
                        assert_eq!(value["adcode"],"110000");
                        let import = value.as_object_mut().unwrap().remove("boundary").unwrap();
                        attached = Some(BoundaryImport { name:import["name"].as_str().unwrap().into(), bounds:serde_json::from_value(import["bounds"].clone()).unwrap(), polygon_count:import["polygonCount"].as_u64().unwrap() as usize, geometry:serde_json::from_value(import["geometry"].clone()).unwrap() });
                        value["attachedToDesktopPlan"] = json!(true);
                        assert!(value.get("boundary").is_none(),"Geometry must not enter model context");
                        json!({"connectorId":"builtin-source-creator","kind":"builtin","toolName":"lookup_boundary","result":value})
                    },
                    "plan_imagery" => {
                        let boundary = attached.as_ref().expect("Model must obtain Beijing boundary before planning");
                        let spec: TaskSpec = serde_json::from_value(json!({"schemaVersion":"0.1","kind":"imagery","sourceId":args["sourceId"],"bounds":boundary.bounds,"boundary":boundary.geometry,"zoomLevels":[args["zoom"]],"outputFormats":args["outputFormats"],"outputDirectory":temp.path().join("imagery").to_string_lossy(),"limits":{"maxTiles":4096,"maxDecodedRgbaBytes":536870912}})).unwrap();
                        assert_eq!(spec.source_id,source.id);
                        let saved = store.create_plan_for_tool_execution(&format!("{conversation}:{}",request["id"].as_str().unwrap()),spec,&source,chrono::Utc::now()).unwrap();
                        planned = true;
                        eprintln!("Real model plan: {}",json!({"bounds":saved.plan.spec.bounds,"totalTiles":saved.plan.total_tiles,"zoom":saved.plan.spec.zoom_levels,"geometryPoints":boundary.geometry.polygons.iter().flat_map(|p|p.iter()).map(Vec::len).sum::<usize>()}));
                        json!({"planId":saved.plan_id,"planHash":saved.plan.plan_hash,"source":source.display_name,"bounds":saved.plan.spec.bounds,"zoomLevels":saved.plan.spec.zoom_levels,"outputFormats":saved.plan.spec.output_formats,"totalTiles":saved.plan.total_tiles,"boundary":"北京市 AreaCity 2026-04-03，WGS84，本机已附加用于 GeoTIFF 裁剪","permission":permission,"requiresPlanConfirmation":!full_access,"canStartWithoutPlanConfirmation":full_access,"execution":if full_access { "可调用 jobs_start；本机将验证工作区完全访问授权及计划路径" } else { "需要用户在对话中的计划卡片确认" }})
                    },
                    "jobs_start" => {
                        assert!(!plan_only, "Plan-only request must not call jobs_start");
                        assert!(full_access, "Confirm Each must wait for the plan card");
                        let saved = store.get_plan(args["planId"].as_str().unwrap()).unwrap().unwrap();
                        crate::validate_auto_destination(temp.path(), std::path::Path::new(&saved.plan.spec.output_directory)).unwrap();
                        let approval = store.grant_approval(&saved.plan_id,&saved.plan.plan_hash,"isolated-test-user","workspace-full-access-0.1",chrono::Utc::now()).unwrap();
                        let job = store.start_job(&saved.plan_id,&saved.plan.plan_hash,&approval.approval_id,&uuid::Uuid::new_v4().to_string(),&source,chrono::Utc::now()).unwrap();
                        // Intentionally do not spawn a worker or download public tiles.
                        json!({"jobId":job.job_id,"planId":job.plan_id,"state":job.state,"reused":false})
                    },
                    "plans_get" => {
                        let saved = store.get_plan(args["planId"].as_str().unwrap()).unwrap().unwrap();
                        json!({"planId":saved.plan_id,"source":saved.plan.source_name,"totalTiles":saved.plan.total_tiles,"zoomLevels":saved.plan.spec.zoom_levels,"outputFormats":saved.plan.spec.output_formats,"boundary":"本机已附加北京市边界","permission":permission,"requiresPlanConfirmation":!full_access,"canStartWithoutPlanConfirmation":full_access})
                    },
                    "jobs_list" => json!({"jobs":store.list_jobs(100).unwrap()}),
                    "jobs_get" => json!(store.get_job(args["jobId"].as_str().unwrap()).unwrap()),
                    _ => json!({"error":"TEST_TOOL_NOT_AVAILABLE"}),
                };
                messages.push(json!({"role":"tool","tool_call_id":request["id"],"content":output.to_string()}));
            }
        }
        assert!(planned && settled,"Model did not complete boundary → plan → final response workflow: {used:?}");
        assert_eq!(store.list_jobs(100).unwrap().len(),usize::from(full_access && !plan_only),"Only a download request with Full Access may create a job");
        eprintln!("Verified real model workflow: permission={permission}, plan_only={plan_only}, tools={used:?}");
    }
}

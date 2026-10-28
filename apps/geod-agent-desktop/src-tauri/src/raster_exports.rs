//! Original floating-point ImageServer snapshots, separate from rendered XYZ
//! imagery. Provider functions, catalog time and item ID are verified and
//! frozen before native confirmation; the existing data-job ledger owns runs.
use crate::{source_creator, workspace_error, AppError};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Component, Path},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::io::AsyncWriteExt;

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RasterSpec {
    pub source_url: String,
    pub bounds: [f64; 4],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary: Option<geod_core::boundary::BoundaryGeometry>,
    pub target_crs: Option<String>,
    pub raster_function: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_range: Option<[String; 2]>,
    #[serde(default)]
    pub band_ids: Vec<u16>,
    #[serde(default = "outputs")]
    pub outputs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared: Option<RasterSnapshot>,
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RasterSnapshot {
    pub item_id: i64,
    pub source_crs: String,
    pub pixel_type: String,
    pub source_band_count: u16,
    pub width: u32,
    pub height: u32,
    pub native_pixel_size: [String; 2],
    pub source_bounds: [String; 4],
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub source_revision: String,
}
fn outputs() -> Vec<String> {
    vec!["geotiff".into()]
}
pub(crate) fn work_directory(output: &Path, plan_hash: &str) -> Result<std::path::PathBuf, String> {
    let parent = output
        .parent()
        .ok_or("任务目录无效")?
        .canonicalize()
        .map_err(|_| "工作区不可用")?;
    let identity = format!(
        "{:x}",
        Sha256::digest(format!("{plan_hash}|{}", output.display()).as_bytes())
    );
    Ok(parent.join(format!(".geod-raster-{}", &identity[..24])))
}
fn fail(message: &str) -> AppError {
    workspace_error("RASTER_PLAN_INVALID", message)
}
fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() < 100 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
fn numeric_function(meta: &Value, name: &str) -> Result<(), AppError> {
    let value = meta["rasterFunctionInfos"]
        .as_array()
        .and_then(|v| v.iter().find(|f| f["name"] == name))
        .ok_or_else(|| fail("所选函数不在提供方当前已公布的数值函数列表中"))?;
    let detail = format!(
        "{} {} {}",
        name,
        value["help"].as_str().unwrap_or(""),
        value["description"].as_str().unwrap_or("")
    )
    .to_lowercase();
    let unstretched = detail.contains("no stretch")
        || detail.contains("without stretch")
        || detail.contains("raw pixel")
        || detail.contains("raw value");
    if !unstretched
        && [
            "stretch",
            "cartographic",
            "color map",
            "colormap",
            "coloriz",
        ]
        .iter()
        .any(|s| detail.contains(s))
    {
        return Err(workspace_error("RASTER_RENDERED_FUNCTION","该函数声明了用于展示的颜色或辐射拉伸；请从提供方实际函数中选择原始数值或不拉伸函数，未创建伪科学成果"));
    }
    Ok(())
}
fn hash(v: &impl Serialize) -> Result<String, String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(v).map_err(|_| "栅格回执无法编码")?)
    ))
}
impl RasterSpec {
    pub(crate) fn unprepared(&self) -> Self {
        let mut value = self.clone();
        value.prepared = None;
        value
    }
    pub(crate) fn validate(&self) -> Result<Self, AppError> {
        let mut value = self.clone();
        let mut url = source_creator::viewport_url(&value.source_url)?;
        if !url.path().trim_end_matches('/').ends_with("/ImageServer") {
            return Err(fail("原始数值栅格需要公开的 ArcGIS ImageServer 服务地址"));
        }
        url.set_query(None);
        value.source_url = url.as_str().trim_end_matches('/').into();
        if let Some(boundary) = &mut value.boundary {
            value.bounds = boundary.normalize().map_err(|e| fail(&e.0))?;
        }
        geod_tiles3d::spatial::validate_bounds(value.bounds).map_err(|e| fail(&e))?;
        if value.raster_function.trim().is_empty()
            || value.raster_function.len() > 256
            || value.raster_function.chars().any(char::is_control)
        {
            return Err(fail("请使用服务真实元数据中已核实的数值栅格函数名称"));
        }
        value.outputs.sort();
        value.outputs.dedup();
        if value.outputs != ["geotiff"] {
            return Err(fail("原始浮点栅格当前导出 GeoTIFF"));
        }
        value.band_ids.sort();
        value.band_ids.dedup();
        if value.band_ids.len() > 16 {
            return Err(fail("单次原始栅格最多选择 16 个真实波段"));
        }
        let crs = value
            .target_crs
            .as_ref()
            .ok_or_else(|| workspace_error("OUTPUT_CRS_REQUIRED", "请确认原始栅格成果坐标系"))?;
        value.target_crs = Some(crate::export_crs::validate(crs, true)?);
        if let Some(range) = &value.time_range {
            let dates = range
                .iter()
                .map(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d"))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| fail("数据时期请使用 YYYY-MM-DD 日期范围"))?;
            if dates[0] > dates[1] {
                return Err(fail("数据时期起止顺序无效"));
            }
        }
        Ok(value)
    }
    pub(crate) async fn prepare(&self) -> Result<Self, AppError> {
        let mut spec = self.unprepared().validate()?;
        let mut meta_url =
            reqwest::Url::parse(&spec.source_url).map_err(|_| fail("服务地址无效"))?;
        meta_url.query_pairs_mut().append_pair("f", "json");
        let meta = get_json(meta_url).await?;
        let time = meta["timeInfo"].clone();
        let start = time["startTimeField"].as_str().unwrap_or("");
        let end = time["endTimeField"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(start);
        let oid = meta["objectIdField"].as_str().unwrap_or("");
        if !identifier(oid) || !identifier(start) || !identifier(end) {
            return Err(workspace_error("RASTER_TIME_UNAVAILABLE","服务未提供可核对的目录时间字段，不能把默认拼接结果称为最新数据；请选择提供方明确的数据项后再导出"));
        }
        numeric_function(&meta, &spec.raster_function)?;
        let mut query = reqwest::Url::parse(&(spec.source_url.clone() + "/query"))
            .map_err(|_| fail("服务目录地址无效"))?;
        let b = spec.bounds;
        let geometry=json!({"xmin":b[0],"ymin":b[1],"xmax":b[2],"ymax":b[3],"spatialReference":{"wkid":4326}}).to_string();
        let primary = meta["fields"]
            .as_array()
            .and_then(|v| {
                v.iter().find(|f| {
                    f["name"]
                        .as_str()
                        .is_some_and(|n| n.eq_ignore_ascii_case("Category"))
                })
            })
            .and_then(|f| {
                f["domain"]["codedValues"].as_array().and_then(|v| {
                    v.iter().find(|v| {
                        v["name"]
                            .as_str()
                            .is_some_and(|n| n.eq_ignore_ascii_case("Primary"))
                    })
                })
            })
            .and_then(|v| v["code"].as_i64());
        let where_clause = if let Some(code) = primary {
            let field = meta["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| {
                    f["name"]
                        .as_str()
                        .is_some_and(|n| n.eq_ignore_ascii_case("Category"))
                })
                .unwrap()["name"]
                .as_str()
                .unwrap();
            if !identifier(field) {
                return Err(fail("目录类别字段无效"));
            }
            format!("{end} IS NOT NULL AND {field}={code}")
        } else {
            format!("{end} IS NOT NULL")
        };
        query
            .query_pairs_mut()
            .append_pair("f", "json")
            .append_pair("where", &where_clause)
            .append_pair("geometry", &geometry)
            .append_pair("geometryType", "esriGeometryEnvelope")
            .append_pair("spatialRel", "esriSpatialRelIntersects")
            .append_pair("outFields", &format!("{oid},{start},{end}"))
            .append_pair("orderByFields", &format!("{end} DESC,{oid} DESC"))
            .append_pair("resultRecordCount", "1")
            .append_pair("returnGeometry", "false");
        if let Some(range) = &spec.time_range {
            let first = chrono::NaiveDate::parse_from_str(&range[0], "%Y-%m-%d")
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis();
            let last = chrono::NaiveDate::parse_from_str(&range[1], "%Y-%m-%d")
                .unwrap()
                .and_hms_opt(23, 59, 59)
                .unwrap()
                .and_utc()
                .timestamp_millis();
            query
                .query_pairs_mut()
                .append_pair("time", &format!("{first},{last}"));
        }
        let records = get_json(query).await?;
        let attributes = records["features"]
            .as_array()
            .and_then(|v| v.first())
            .map(|v| &v["attributes"])
            .ok_or_else(|| {
                workspace_error(
                    "RASTER_OUTSIDE_COVERAGE",
                    "所选范围或时期没有可核实的原始栅格目录项，未创建下载",
                )
            })?;
        spec.prepared = Some(snapshot(&spec, &meta, attributes, oid, start, end)?);
        Ok(spec)
    }
}
fn snapshot(
    spec: &RasterSpec,
    meta: &Value,
    attributes: &Value,
    oid: &str,
    start: &str,
    end: &str,
) -> Result<RasterSnapshot, AppError> {
    let pixel = meta["pixelType"]
        .as_str()
        .filter(|s| matches!(*s, "F32" | "F64"))
        .ok_or_else(|| {
            workspace_error(
                "RASTER_TYPE_UNSUPPORTED",
                "此原始数值导出通道要求提供方公开 F32/F64 浮点栅格；不能用渲染 RGB 代替",
            )
        })?;
    let bands = meta["bandCount"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 16)
        .ok_or_else(|| fail("提供方原始波段数量无法确认"))? as u16;
    if spec.band_ids.iter().any(|id| *id >= bands) {
        return Err(fail("所选波段超出提供方实际波段数量"));
    }
    let wkid = meta["spatialReference"]["latestWkid"]
        .as_u64()
        .or_else(|| meta["spatialReference"]["wkid"].as_u64())
        .unwrap_or(0);
    let wkid = if matches!(wkid, 102100 | 102113) {
        3857
    } else {
        wkid
    };
    if !matches!(wkid, 4326 | 3857) {
        return Err(workspace_error(
            "RASTER_CRS_UNSUPPORTED",
            "原始数值导出当前支持提供方 EPSG:4326/3857 网格；其他来源需先准备明确的栅格转换方案",
        ));
    }
    let dx = meta["pixelSizeX"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.)
        .ok_or_else(|| fail("服务没有有效的原生像元大小"))?;
    let dy = meta["pixelSizeY"]
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.)
        .ok_or_else(|| fail("服务没有有效的原生像元大小"))?;
    let mut b = spec.bounds;
    if wkid == 3857 {
        if b[1] < -85.05112878 || b[3] > 85.05112878 {
            return Err(workspace_error(
                "RASTER_OUTSIDE_COVERAGE",
                "该 Web Mercator 来源不覆盖两极，不能自行改变要求的范围",
            ));
        }
        let x = |n: f64| n.to_radians() * 6378137.;
        let y = |n: f64| {
            (std::f64::consts::FRAC_PI_4 + n.to_radians() / 2.)
                .tan()
                .ln()
                * 6378137.
        };
        b = [x(b[0]), y(b[1]), x(b[2]), y(b[3])];
    }
    let width = ((b[2] - b[0]) / dx).ceil().max(1.) as u32;
    let height = ((b[3] - b[1]) / dy).ceil().max(1.) as u32;
    let count = if spec.band_ids.is_empty() {
        u64::from(bands)
    } else {
        spec.band_ids.len() as u64
    };
    if width > meta["maxImageWidth"].as_u64().unwrap_or(4096) as u32
        || height > meta["maxImageHeight"].as_u64().unwrap_or(4096) as u32
        || u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|n| n.checked_mul(count))
            .is_none_or(|n| n > 16_000_000)
    {
        return Err(workspace_error("RASTER_EXPORT_TOO_LARGE","按原生像元计算的单幅导出超过服务或本机预算；请明确选择分区范围或准备原始数据批量处理，未擅自降低分辨率"));
    }
    let id = attributes[oid]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or_else(|| fail("目录项标识无效"))?;
    let first = attributes[start].as_i64();
    let last = attributes[end].as_i64();
    if first.is_none() || last.is_none() || first > last {
        return Err(workspace_error(
            "RASTER_TIME_UNAVAILABLE",
            "目录项未返回可核实的观测时间，不能称为最新交付",
        ));
    }
    let function = meta["rasterFunctionInfos"]
        .as_array()
        .and_then(|v| v.iter().find(|f| f["name"] == spec.raster_function));
    let revision=hash(&json!({"source":spec.source_url,"pixelType":pixel,"bands":bands,"function":function,"crs":wkid,"pixelSize":[format!("{dx:.12}"),format!("{dy:.12}")]})).map_err(|e|fail(&e))?;
    Ok(RasterSnapshot {
        item_id: id,
        source_crs: format!("EPSG:{wkid}"),
        pixel_type: pixel.into(),
        source_band_count: bands,
        width,
        height,
        native_pixel_size: [format!("{dx:.12}"), format!("{dy:.12}")],
        source_bounds: b.map(|n| format!("{n:.9}")),
        start_time: first,
        end_time: last,
        source_revision: revision,
    })
}
async fn get_json(url: reqwest::Url) -> Result<Value, AppError> {
    let result = source_creator::public_fetch(url.as_str(), 2 * 1024 * 1024).await?;
    if result.status == 401 || result.status == 403 {
        return Err(workspace_error(
            "RASTER_AUTH_REQUIRED",
            "原始栅格服务需要提供方授权，公开下载通道未获得该权限",
        ));
    }
    if result.status != 200 {
        return Err(workspace_error(
            "RASTER_SOURCE_UNAVAILABLE",
            "原始栅格服务暂不可访问，请检查服务和网络后继续",
        ));
    }
    let value: Value =
        serde_json::from_slice(&result.bytes).map_err(|_| fail("原始栅格元数据不是有效 JSON"))?;
    if matches!(value["error"]["code"].as_i64(), Some(401 | 403 | 498 | 499)) {
        return Err(workspace_error(
            "RASTER_AUTH_REQUIRED",
            "原始栅格服务要求提供方授权，当前公开下载通道没有获得该权限",
        ));
    }
    if value.get("error").is_some() {
        return Err(workspace_error(
            "RASTER_SOURCE_REJECTED",
            "提供方拒绝了原始栅格目录请求，请核对函数、范围、时期或认证",
        ));
    }
    Ok(value)
}
async fn verify_pinned(spec: &RasterSpec, pinned: &RasterSnapshot) -> Result<(), String> {
    let mut url = reqwest::Url::parse(&spec.source_url).map_err(|_| "原始栅格地址无效")?;
    url.query_pairs_mut().append_pair("f", "json");
    let meta = get_json(url).await.map_err(|e| e.message)?;
    let wkid = meta["spatialReference"]["latestWkid"]
        .as_u64()
        .or_else(|| meta["spatialReference"]["wkid"].as_u64())
        .unwrap_or(0);
    let wkid = if matches!(wkid, 102100 | 102113) {
        3857
    } else {
        wkid
    };
    let dx = meta["pixelSizeX"]
        .as_f64()
        .ok_or("RASTER_SOURCE_CHANGED：原生像元大小已变化")?;
    let dy = meta["pixelSizeY"]
        .as_f64()
        .ok_or("RASTER_SOURCE_CHANGED：原生像元大小已变化")?;
    let function = meta["rasterFunctionInfos"]
        .as_array()
        .and_then(|v| v.iter().find(|f| f["name"] == spec.raster_function));
    let current = hash(
        &json!({"source":spec.source_url,"pixelType":meta["pixelType"],"bands":meta["bandCount"],"function":function,"crs":wkid,"pixelSize":[format!("{dx:.12}"),format!("{dy:.12}")]}),
    )?;
    if current != pinned.source_revision {
        return Err(
            "RASTER_SOURCE_CHANGED：服务的数值函数或网格已变化，请核对并生成新的确认计划".into(),
        );
    }
    let oid = meta["objectIdField"].as_str().unwrap_or("");
    let start = meta["timeInfo"]["startTimeField"].as_str().unwrap_or("");
    let end = meta["timeInfo"]["endTimeField"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(start);
    if !identifier(oid) || !identifier(start) || !identifier(end) {
        return Err("RASTER_SOURCE_CHANGED：目录时间字段已变化，不能确认原数据项".into());
    }
    let mut query =
        reqwest::Url::parse(&(spec.source_url.clone() + "/query")).map_err(|_| "目录地址无效")?;
    query
        .query_pairs_mut()
        .append_pair("f", "json")
        .append_pair("objectIds", &pinned.item_id.to_string())
        .append_pair("outFields", &format!("{oid},{start},{end}"))
        .append_pair("returnGeometry", "false");
    let records = get_json(query).await.map_err(|e| e.message)?;
    let row = records["features"]
        .as_array()
        .and_then(|v| v.first())
        .map(|v| &v["attributes"])
        .ok_or("RASTER_SOURCE_CHANGED：原目录数据项已不可用")?;
    if row[oid].as_i64() != Some(pinned.item_id)
        || row[start].as_i64() != pinned.start_time
        || row[end].as_i64() != pinned.end_time
    {
        return Err("RASTER_SOURCE_CHANGED：原目录项时期已变化，未替换为另一份数据".into());
    }
    Ok(())
}
async fn cancellation(cancel: Arc<AtomicBool>) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
async fn worker(request: Value, cancel: Arc<AtomicBool>) -> Result<Value, String> {
    let mut command = crate::python_runtime::gis_command(
        include_str!("raster_export_worker.py"),
        &["gis-common", "gis-raster"],
    )
    .map_err(|e| e.message)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动内置原始栅格处理组件")?;
    let diagnostic_directory = request["directory"].as_str().map(std::path::PathBuf::from);
    let mut stdin = child.stdin.take().ok_or("原始栅格处理组件未就绪")?;
    stdin
        .write_all(&serde_json::to_vec(&request).map_err(|_| "栅格处理参数无效")?)
        .await
        .map_err(|_| "原始栅格处理连接中断")?;
    drop(stdin);
    let output = tokio::select! {r=tokio::time::timeout(Duration::from_secs(180),child.wait_with_output())=>r.map_err(|_|"原始栅格处理未及时完成")?.map_err(|_|"原始栅格处理进程失败")?,_=cancellation(cancel)=>return Err("任务已取消".into())};
    if !output.status.success() || output.stdout.len() > 1024 * 1024 {
        if let Some(directory) = diagnostic_directory {
            let _=fs::write(directory.join("processing-diagnostic.json"),json!({"type":"worker_exit","exitCode":output.status.code(),"detail":String::from_utf8_lossy(&output.stderr).chars().take(4000).collect::<String>()}).to_string());
        }
        return Err(
            "原始下载已保留，栅格处理组件未通过；请打开任务诊断，修复后重试原任务，无需重新下载"
                .into(),
        );
    }
    let value: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "原始栅格处理记录无效")?;
    if let Some(e) = value["error"].as_str() {
        return Err(e.chars().take(500).collect());
    }
    Ok(value)
}
pub(crate) async fn run(
    spec: &RasterSpec,
    output: &Path,
    plan_hash: &str,
    cancel: Arc<AtomicBool>,
    report: impl Fn(&str, u64, u64, u64),
) -> Result<Value, String> {
    let pinned = spec
        .prepared
        .as_ref()
        .ok_or("原始栅格计划缺少经过核实的数据快照，请重新检查计划")?;
    let fingerprint = hash(spec)?;
    let parent = output
        .parent()
        .ok_or("成果目录无效")?
        .canonicalize()
        .map_err(|_| "工作区不可用")?;
    if output.exists() {
        return Err("成果目录已存在，未覆盖原文件".into());
    }
    let stage = work_directory(output, plan_hash)?;
    if !stage.exists() {
        fs::create_dir(&stage).map_err(|_| "原始栅格暂存目录无法创建")?;
    }
    if stage
        .canonicalize()
        .map_err(|_| "原始栅格暂存目录无效")?
        .parent()
        != Some(parent.as_path())
    {
        return Err("暂存目录已离开工作区".into());
    }
    let source = stage.join("input.tif");
    let checkpoint = stage.join("download.json");
    let stage_root = stage.canonicalize().map_err(|_| "暂存目录不可用")?;
    for path in [&source, &checkpoint] {
        if path.exists()
            && path
                .canonicalize()
                .map_err(|_| "栅格缓存路径不可读")?
                .parent()
                != Some(stage_root.as_path())
        {
            return Err("栅格缓存已移出本次任务目录，未读取或覆盖".into());
        }
    }
    let mut reused = false;
    let mut bytes = 0;
    if let Ok(raw) = fs::read(&checkpoint) {
        if let Ok(c) = serde_json::from_slice::<Value>(&raw) {
            if c["planHash"] == plan_hash
                && c["sourceFingerprint"] == fingerprint
                && source.is_file()
            {
                let input = fs::read(&source).map_err(|_| "原始栅格缓存无法读取")?;
                if c["sha256"] == format!("{:x}", Sha256::digest(&input)) {
                    reused = true;
                    bytes = input.len() as u64;
                }
            }
        }
    }
    if !reused {
        if source.exists() {
            fs::rename(
                &source,
                stage.join(format!("input-unverified-{}.tif", uuid::Uuid::new_v4())),
            )
            .map_err(|_| "未核实的旧输入已保留，请先检查缓存状态")?;
        }
        verify_pinned(spec, pinned).await?;
        report("downloading", 0, 1, 0);
        let mut url = reqwest::Url::parse(&(spec.source_url.clone() + "/exportImage"))
            .map_err(|_| "原始栅格导出网址无效")?;
        let rule = json!({"rasterFunction":spec.raster_function}).to_string();
        let mosaic =
            json!({"mosaicMethod":"esriMosaicLockRaster","lockRasterIds":[pinned.item_id]})
                .to_string();
        url.query_pairs_mut()
            .append_pair("f", "image")
            .append_pair("format", "tiff")
            .append_pair("pixelType", &pinned.pixel_type)
            .append_pair("bbox", &pinned.source_bounds.join(","))
            .append_pair("bboxSR", pinned.source_crs.trim_start_matches("EPSG:"))
            .append_pair("imageSR", pinned.source_crs.trim_start_matches("EPSG:"))
            .append_pair("size", &format!("{},{}", pinned.width, pinned.height))
            .append_pair("renderingRule", &rule)
            .append_pair("mosaicRule", &mosaic)
            .append_pair("interpolation", "RSP_NearestNeighbor");
        url.query_pairs_mut()
            .append_pair("adjustAspectRatio", "false");
        if !spec.band_ids.is_empty() {
            url.query_pairs_mut().append_pair(
                "bandIds",
                &spec
                    .band_ids
                    .iter()
                    .map(u16::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        let fetched = tokio::select! {v=source_creator::public_fetch(url.as_str(),128*1024*1024)=>v.map_err(|e|e.message)?,_=cancellation(cancel.clone())=>return Err("任务已取消".into())};
        if fetched.status != 200
            || !(fetched.bytes.starts_with(b"II") || fetched.bytes.starts_with(b"MM"))
        {
            return Err(
                "RASTER_EXPORT_INVALID：提供方未返回原始 TIFF；请核对数值函数、数据项和授权".into(),
            );
        }
        bytes = fetched.bytes.len() as u64;
        if stage.canonicalize().map_err(|_| "暂存目录不可用")? != stage_root
            || output
                .parent()
                .ok_or("工作区无效")?
                .canonicalize()
                .map_err(|_| "工作区不可用")?
                != parent
        {
            return Err("工作区或暂存目录已变化，未保存到其他位置".into());
        }
        fs::write(&source, &fetched.bytes).map_err(|_| "原始栅格暂存失败")?;
        let proof = json!({"planHash":plan_hash,"sourceFingerprint":fingerprint,"sha256":format!("{:x}",Sha256::digest(&fetched.bytes)),"bytes":bytes});
        fs::write(
            &checkpoint,
            serde_json::to_vec(&proof).map_err(|_| "栅格下载回执无效")?,
        )
        .map_err(|_| "栅格下载回执保存失败")?;
    }
    report("processing", 1, 1, bytes);
    let mut manifest=worker(json!({"inputPath":source,"directory":stage,"expectedParent":parent,"targetCrs":spec.target_crs,"boundary":spec.boundary,"sourceCrs":pinned.source_crs,"expectedWidth":pinned.width,"expectedHeight":pinned.height,"expectedBands":if spec.band_ids.is_empty(){usize::from(pinned.source_band_count)}else{spec.band_ids.len()},"pixelType":pinned.pixel_type}),cancel.clone()).await?;
    manifest["schemaVersion"] = json!(1);
    manifest["kind"] = json!("raster");
    manifest["planHash"] = json!(plan_hash);
    manifest["sourceFingerprint"] = json!(fingerprint);
    manifest["sourceFunction"] = json!(spec.raster_function);
    manifest["sourceUrl"] = json!(spec.source_url);
    manifest["sourceItemId"] = json!(pinned.item_id);
    manifest["sourceTime"] = json!({"start":pinned.start_time,"end":pinned.end_time,"meaning":"provider catalog interval, not an asserted capture instant"});
    manifest["reusedInput"] = json!(reused);
    manifest["createdAt"] = json!(Utc::now().to_rfc3339());
    manifest["failures"] = json!([]);
    manifest["complete"] = json!(true);
    fs::write(
        stage.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|_| "原始栅格清单无效")?,
    )
    .map_err(|_| "原始栅格清单无法保存")?;
    report("verifying", 1, 1, bytes);
    inspect(&stage, spec, plan_hash)?;
    if cancel.load(Ordering::SeqCst) {
        return Err("任务已取消".into());
    }
    if output.exists()
        || output
            .parent()
            .ok_or("成果目录无效")?
            .canonicalize()
            .map_err(|_| "工作区不可用")?
            != parent
    {
        return Err("工作区或成果目录已变化".into());
    }
    // Only the committed bundle is public. Keep input/checkpoint inside it as
    // provenance; an interrupted worker can reuse the fully verified input.
    fs::rename(stage, output).map_err(|_| "原始栅格成果提交失败")?;
    report("completed", 1, 1, bytes);
    Ok(manifest)
}
pub(crate) fn inspect(output: &Path, spec: &RasterSpec, plan_hash: &str) -> Result<Value, String> {
    let raw = fs::read(output.join("manifest.json")).map_err(|_| "原始栅格成果清单不存在")?;
    if raw.len() > 1024 * 1024 {
        return Err("成果清单过大".into());
    }
    let value: Value = serde_json::from_slice(&raw).map_err(|_| "原始栅格清单无效")?;
    if value["schemaVersion"] != 1
        || value["kind"] != "raster"
        || value["planHash"] != plan_hash
        || value["sourceFingerprint"] != hash(spec)?
        || value["outputCrs"] != spec.target_crs.as_deref().unwrap_or("")
        || value["numericValuesPreserved"] != true
    {
        return Err("原始栅格成果与已确认计划不匹配".into());
    }
    let root = output.canonicalize().map_err(|_| "成果目录不存在")?;
    let assets = value["assets"].as_array().ok_or("成果文件记录无效")?;
    if assets.len() != 2 {
        return Err("原始栅格和预览文件不完整".into());
    }
    for asset in assets {
        let name = asset["path"].as_str().ok_or("成果文件名无效")?;
        if !matches!(name, "raster.tif" | "preview.png")
            || !Path::new(name)
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
        {
            return Err("成果文件路径无效".into());
        }
        let file = root.join(name).canonicalize().map_err(|_| "成果文件缺失")?;
        if file.parent() != Some(root.as_path()) {
            return Err("成果文件已移出目录".into());
        }
        let bytes = fs::read(file).map_err(|_| "成果文件不可读")?;
        if bytes.is_empty()
            || asset["size"] != bytes.len() as u64
            || asset["sha256"] != format!("{:x}", Sha256::digest(&bytes))
        {
            return Err("原始栅格文件校验未通过".into());
        }
    }
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_requests_reject_unverified_functions_and_changed_pixel_types() {
        let spec:RasterSpec=serde_json::from_value(json!({"sourceUrl":"https://data.example.org/ImageServer","bounds":[115.,39.,117.,41.],"targetCrs":"EPSG:3857","rasterFunction":"actual numeric function","outputs":["geotiff"]})).unwrap();
        assert!(spec.validate().is_ok());
        let meta = json!({"pixelType":"F32","bandCount":1,"pixelSizeX":500.,"pixelSizeY":500.,"spatialReference":{"wkid":3857},"maxImageWidth":5000,"maxImageHeight":5000,"rasterFunctionInfos":[{"name":"actual numeric function"}]});
        let attributes = json!({"id":7,"start":1,"end":2});
        let pinned = snapshot(&spec, &meta, &attributes, "id", "start", "end").unwrap();
        assert!(pinned.width > 1 && pinned.height > 1);
        assert_eq!(pinned.item_id, 7);
        let mut wrong = meta;
        wrong["pixelType"] = json!("U8");
        assert_eq!(
            snapshot(&spec, &wrong, &attributes, "id", "start", "end")
                .unwrap_err()
                .code,
            "RASTER_TYPE_UNSUPPORTED"
        );
    }
}

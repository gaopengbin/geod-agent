//! Read-only network tools for the bundled imagery source creator Skill.
use crate::{extensions::{ExtensionState, SOURCE_CREATOR_ID}, network, AppError};
use reqwest::{Url, redirect::Policy};
use serde_json::{json, Value};
use std::{net::IpAddr, time::Duration};
use tauri::State;
#[path = "wayback.rs"]
mod wayback;

pub(crate) fn initialize(directory: std::path::PathBuf) { wayback::initialize(directory); }

fn error(code: &'static str, message: &str) -> AppError { AppError { code, message: message.into() } }
const MAX_BYTES: usize = 1024 * 1024;

pub(crate) fn tools() -> Value {
    let mut result = json!({"connectorId": SOURCE_CREATOR_ID, "name": "图源接入工具", "kind": "builtin", "tools": [
        {"name":"source_presets", "description":"列出影像、底图、Terrarium 高程、天地图认证连接及MVT矢量预设。栅格presets需source_configure后规划；保留coordinateSystem和subdomains。vectorPresets直接用data_download_plan kind=mvt与urlTemplate作为sourceUrl，不登记为影像。OpenFreeMap实时解析官方TileJSON，失败不会返回过期地址。", "inputSchema":{"type":"object","properties":{},"additionalProperties":false}},
        {"name":"search_sources", "description":"搜索在线 ArcGIS 影像服务目录，返回候选服务链接与描述。只读。", "inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"图源名称、地区或影像用途"}},"required":["query"],"additionalProperties":false}},
        {"name":"inspect_source", "description":"读取公开 HTTPS 服务或文档，识别 GeoD 兼容性和技术参数。支持缓存 MapServer、ImageServer、XYZ/TMS 模板及普通文档。可给瓦片模板指定 sampleZ/sampleX/sampleY 检查一张覆盖内瓦片；带{s}的模板同时传subdomains。返回可配置的技术参数，不保存配置。", "inputSchema":{"type":"object","properties":{"url":{"type":"string"},"subdomains":{"type":"array","maxItems":16,"items":{"type":"string","minLength":1,"maxLength":32,"pattern":"^[A-Za-z0-9-]+$"}},"sampleZ":{"type":"integer","minimum":0,"maximum":22},"sampleX":{"type":"integer","minimum":0},"sampleY":{"type":"integer","minimum":0}},"required":["url"],"additionalProperties":false}},
        {"name":"lookup_boundary", "description":"查询中国省、市、区县行政边界，例如北京、天津、海淀区，可按六位区划代码查询，同名区域用 parent 指定所属省市。使用本机随应用提供的 AreaCity 2026-04-03 边界库，无需网络；将 GCJ-02 转为 WGS84，自动附到当前对话影像计划用于裁剪。返回数据版本，不能称为实时最新；不要求用户提供工作区 GeoJSON。", "inputSchema":{"type":"object","properties":{"query":{"type":"string","description":"行政区名称或六位区划代码，例如北京市或110000"},"parent":{"type":"string","description":"同名区域的所属省市，例如北京市"}},"required":["query"],"additionalProperties":false}}
        ,{"name":"lookup_boundaries", "description":"一次查询多个中国行政区名称或编码。每个成功范围独立保存并返回 boundaryId，不覆盖之前的范围。用 plan_imagery_batch 按区下载或合并裁剪；同名区县可用 parent。返回实际缺失或歧义，不猜测。", "inputSchema":{"type":"object","properties":{"queries":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":32},"parent":{"type":"string"}},"required":["queries"],"additionalProperties":false}},
        {"name":"lookup_neighbors", "description":"依据 AreaCity 2026-04-03 实际边界查询同层级相邻行政区。只有共享边界线段才算相邻，点接触或包围盒相交不算。返回名称、编码和来源，不附加几何。随后用 lookup_boundaries 查询目标及相邻区域编码，再规划。", "inputSchema":{"type":"object","properties":{"query":{"type":"string"},"parent":{"type":"string"}},"required":["query"],"additionalProperties":false}}
    ]});
    result["tools"].as_array_mut().unwrap().extend(wayback::tools());
    result
}

#[tauri::command]
pub(crate) fn source_creator_tools(state: State<'_, ExtensionState>) -> Result<Value, AppError> {
    if !state.source_creator_enabled()? { return Err(error("SKILL_NOT_ENABLED", "图源 Creator 未启用")); }
    Ok(tools())
}

#[tauri::command]
pub(crate) async fn source_creator_call(state: State<'_, ExtensionState>, tool_name: String, arguments: Value) -> Result<Value, AppError> {
    if !state.source_creator_enabled()? { return Err(error("SKILL_NOT_ENABLED", "图源 Creator 未启用")); }
    call(&tool_name, arguments).await
}

pub(crate) async fn call(tool: &str, args: Value) -> Result<Value, AppError> {
    if !args.is_object() || serde_json::to_vec(&args).map_or(true, |v| v.len() > 4096) {
        return Err(error("INVALID_SOURCE_ARGUMENTS", "图源工具参数须为 4 KiB 以内的对象"));
    }
    tokio::time::timeout(Duration::from_secs(40), async {
        match tool {
            "source_presets" => {
                let mut catalog: Value = serde_json::from_str(include_str!("../../../../contracts/source-presets.v1.json")).map_err(|_|error("SOURCE_PRESETS_INVALID","图源预设无法读取"))?;
                if let Some(presets)=catalog["presets"].as_array_mut() {
                    for preset in presets.iter_mut() {preset["scheme"]=json!("XYZ");preset["tileSize"]=json!(256);preset["minIntervalMs"]=json!(0);}
                    for (layer,name) in [("img","天地图影像"),("cia","天地图影像注记"),("vec","天地图矢量底图"),("cva","天地图矢量注记"),("cta","天地图地形注记")] {
                        presets.push(json!({"id":format!("tianditu-{layer}-w"),"name":name,"urlTemplate":format!("https://t{{s}}.tianditu.gov.cn/{layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER={layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={{z}}&TILEROW={{y}}&TILECOL={{x}}"),"subdomains":["0","1","2","3","4","5","6","7"],"attribution":"天地图","scheme":"XYZ","tileSize":256,"minZoom":1,"maxZoom":18,"minIntervalMs":0,"authenticationMode":"queryToken","authenticationParameter":"tk"}));
                    }
                }
                // OpenFreeMap rotates versioned tile paths. Resolve its official
                // TileJSON, never keep the old desktop's dated snapshot URL.
                if let Some(presets)=catalog["vectorPresets"].as_array_mut() {
                    for preset in presets.iter_mut() {
                        preset["tool"]=json!("data_download_plan");
                        if let Some(raw)=preset["tileJsonUrl"].as_str().map(str::to_string) {
                            let fetched=match public_url(&raw) {Ok(url)=>tokio::time::timeout(Duration::from_secs(8),fetch(url)).await.ok().and_then(Result::ok),Err(_)=>None};
                            let resolved=fetched.filter(|f|f.status==200).and_then(|f|serde_json::from_slice::<Value>(&f.bytes).ok()).and_then(|v|v["tiles"].as_array().and_then(|a|a.first()).and_then(Value::as_str).map(str::to_string));
                            if let Some(template)=resolved.filter(|url|url.contains("{z}")&&url.contains("{x}")&&url.contains("{y}")&&public_url(&url.replace("{z}","0").replace("{x}","0").replace("{y}","0")).is_ok()) {
                                preset["urlTemplate"]=json!(template);preset["discoveryStatus"]=json!("resolved");
                            } else {preset["discoveryStatus"]=json!("unavailable");preset["message"]=json!("官方 TileJSON 暂时不可达，请稍后重试；未返回过期版本地址");}
                        }
                    }
                }
                Ok(catalog)
            },
            "search_sources" => search(args["query"].as_str().unwrap_or("")).await,
            "inspect_source" => inspect(&args).await,
            "lookup_boundary" => crate::online_boundary::lookup(args).await,
            "lookup_boundaries" => crate::online_boundary::lookup_many(args).await,
            "lookup_neighbors" => crate::online_boundary::neighbors(args).await,
            "wayback_versions" => wayback::versions(&args).await,
            "wayback_metadata" => wayback::metadata(&args).await,
            "wayback_changes" => wayback::changes(&args).await,
            _ => Err(error("SOURCE_TOOL_NOT_FOUND", "图源 Creator 未提供此工具")),
        }
    }).await.map_err(|_| error("SOURCE_LOOKUP_TIMEOUT", "图源检查超时，可检查网络代理后重试"))?
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let a = ip.octets();
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified()
                && !ip.is_multicast() && !ip.is_broadcast() && a[0] != 0 && a[0] < 240
                && !(a[0] == 100 && (64..=127).contains(&a[1]))
        }
        IpAddr::V6(ip) => ip.to_ipv4_mapped().map(|v| public_ip(IpAddr::V4(v))).unwrap_or_else(|| {
            let a = ip.segments();
            !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast()
                && a[0] & 0xfe00 != 0xfc00 && a[0] & 0xffc0 != 0xfe80 && a[0] & 0xffc0 != 0xfec0
        }),
    }
}

fn public_url(raw: &str) -> Result<Url, AppError> {
    if raw.len() > 2048 { return Err(error("INVALID_SOURCE_URL", "图源网址过长")); }
    let mut url = Url::parse(raw).map_err(|_| error("INVALID_SOURCE_URL", "图源网址无效"))?;
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https" || host.is_empty() || !url.username().is_empty() || url.password().is_some()
        || url.port().is_some_and(|port| port != 443) || host == "localhost"
        || host.ends_with(".local") || host.ends_with(".internal") || host.ends_with(".localhost")
        || host.parse::<IpAddr>().is_ok_and(|ip| !public_ip(ip)) {
        return Err(error("INVALID_SOURCE_URL", "图源检查仅支持不含凭证的公开 HTTPS 网址"));
    }
    if url.query_pairs().any(|(key, _)| geod_core::imagery::is_secret_parameter(&key)) {
        return Err(error("SOURCE_TOKEN_IN_URL", "请将 Token 填入应用的图源认证设置，图源检查使用不含凭证的网址"));
    }
    url.set_fragment(None);
    Ok(url)
}

struct Fetched { url: Url, status: u16, content_type: String, bytes: Vec<u8> }

pub(crate) async fn viewport_tile(url: Url) -> Result<String, AppError> {
    use base64::Engine;
    if url.scheme() != "https" { return Err(error("MAP_TILE_URL_INVALID", "地图预览需要 HTTPS 图源")); }
    let found = fetch(url).await?;
    if found.status != 200 || !(found.bytes.starts_with(b"\x89PNG\r\n\x1a\n") || found.bytes.starts_with(b"\xff\xd8\xff")) {
        return Err(error("MAP_TILE_UNAVAILABLE", &format!("图源没有返回 PNG/JPEG 瓦片（HTTP {}）",found.status)));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(found.bytes))
}

// UI previews remain available when the optional Agent skill is disabled.
#[tauri::command]
pub(crate) async fn source_thumbnail_metadata(url: String) -> Result<Value, AppError> {
    call("inspect_source", json!({"url":url,"thumbnail":true})).await
}

pub(crate) fn viewport_url(raw: &str) -> Result<Url, AppError> { public_url(raw) }
async fn fetch(url: Url) -> Result<Fetched, AppError> {
    fetch_limit(url, MAX_BYTES).await
}

async fn fetch_limit(mut url: Url, limit: usize) -> Result<Fetched, AppError> {
    for hop in 0..=3 {
        let host = url.host_str().ok_or_else(|| error("INVALID_SOURCE_URL", "图源网址缺少域名"))?;
        let addresses = tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host, 443)))
            .await.map_err(|_| error("SOURCE_DNS_TIMEOUT", "图源域名解析超时"))?
            .map_err(|_| error("SOURCE_DNS_FAILED", "图源域名无法解析"))?.collect::<Vec<_>>();
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            return Err(error("SOURCE_PRIVATE_ADDRESS", "图源检查不会访问本机或内网地址"));
        }
        let proxy = network::proxy_for(url.as_str()).map_err(|_| error("NETWORK_PROXY_INVALID", "代理设置不可用"))?;
        let client = network::apply(reqwest::Client::builder().timeout(Duration::from_secs(25)).redirect(Policy::none())
            .resolve_to_addrs(host, &addresses).user_agent("GeoD-Agent/0.1 (source inspection)"), proxy.as_deref())
            .map_err(|_| error("NETWORK_PROXY_INVALID", "代理设置不可用"))?.build()
            .map_err(|_| error("SOURCE_NETWORK_FAILED", "无法创建图源网络连接"))?;
        let mut response = client.get(url.clone()).send().await
            .map_err(|_| error("SOURCE_NETWORK_FAILED", "无法读取图源；请检查网络或代理设置"))?;
        if response.status().is_redirection() {
            if hop == 3 { return Err(error("SOURCE_REDIRECT_LIMIT", "图源跳转次数过多")); }
            let target = response.headers().get("location").and_then(|v| v.to_str().ok())
                .and_then(|v| url.join(v).ok()).ok_or_else(|| error("SOURCE_REDIRECT_INVALID", "图源跳转地址无效"))?;
            url = public_url(target.as_str())?;
            continue;
        }
        if response.content_length().is_some_and(|len| len > limit as u64) {
            return Err(error("SOURCE_RESPONSE_TOO_LARGE", "服务说明或样本超过响应大小限制，请缩小查询范围"));
        }
        let status = response.status().as_u16();
        let content_type = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| error("SOURCE_NETWORK_FAILED", "图源返回内容读取失败"))? {
            if bytes.len() + chunk.len() > limit { return Err(error("SOURCE_RESPONSE_TOO_LARGE", "服务说明或样本超过响应大小限制")); }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(Fetched { url, status, content_type, bytes });
    }
    Err(error("SOURCE_REDIRECT_LIMIT", "图源跳转次数过多"))
}

async fn search(query: &str) -> Result<Value, AppError> {
    let query = query.trim();
    if !(2..=160).contains(&query.chars().count()) { return Err(error("INVALID_SOURCE_QUERY", "请用 2–160 个字符描述图源")); }
    if query.contains("天地图") || query.to_ascii_lowercase().contains("tianditu") {
        let candidates = [("img", "天地图影像"), ("cia", "天地图影像注记"), ("vec", "天地图矢量底图"), ("cva", "天地图矢量注记"), ("cta", "天地图地形注记")].map(|(layer, name)| {
            json!({"name":name,"url":format!("https://t0.tianditu.gov.cn/{layer}_w/wmts"),"type":"WMTS","authenticationMode":"queryToken","authenticationParameter":"tk"})
        });
        return Ok(json!({"catalog":"内置天地图 Web Mercator 预设","query":query,"candidates":candidates,"next":"用 inspect_source 获取模板并配置；用户在图源管理填写 Key，不在聊天中发送"}));
    }
    let mut url = Url::parse("https://www.arcgis.com/sharing/rest/search").unwrap();
    url.query_pairs_mut().append_pair("f", "json").append_pair("num", "8")
        .append_pair("q", &format!("({query}) AND (type:\"Image Service\" OR type:\"Map Service\") AND access:public"));
    let found = fetch(url).await?;
    if found.status != 200 { return Err(error("SOURCE_CATALOG_UNAVAILABLE", "影像目录暂时不可用")); }
    let value: Value = serde_json::from_slice(&found.bytes).map_err(|_| error("SOURCE_CATALOG_INVALID", "影像目录返回格式无效"))?;
    if value.get("error").is_some() { return Err(error("SOURCE_CATALOG_UNAVAILABLE", "影像目录拒绝了查询")); }
    let candidates = value["results"].as_array().into_iter().flatten().filter_map(|item| {
        let url = public_url(item["url"].as_str()?).ok()?;
        Some(json!({"name":item["title"],"url":url.as_str(),"itemId":item["id"],"owner":item["owner"],
            "type":item["type"],"description":text(item["snippet"].as_str().unwrap_or(""), 700),
            "catalogUrl":format!("https://www.arcgis.com/home/item.html?id={}",item["id"].as_str().unwrap_or(""))}))
    }).collect::<Vec<_>>();
    Ok(json!({"catalog":"ArcGIS Online 公共目录","query":query,"candidates":candidates,
        "next":"检查候选服务参数，使用兼容结果配置图源"}))
}

fn text(raw: &str, limit: usize) -> String {
    let mut out = String::new(); let mut in_tag = false; let mut hidden: Option<String> = None;
    let mut tag = String::new();
    for ch in raw.chars() {
        if ch == '<' { in_tag = true; tag.clear(); continue; }
        if in_tag {
            if ch == '>' {
                in_tag = false;
                let name = tag.split_whitespace().next().unwrap_or("").to_lowercase();
                if matches!(name.as_str(), "script" | "style") { hidden = Some(name); }
                else if hidden.as_ref().is_some_and(|h| name == format!("/{h}")) { hidden = None; }
                if hidden.is_none() { out.push(' '); }
            } else { tag.push(ch); }
        } else if hidden.is_none() { out.push(ch); }
    }
    out.replace("&nbsp;", " ").replace("&amp;", "&").replace("&quot;", "\"")
        .split_whitespace().collect::<Vec<_>>().join(" ").chars().take(limit).collect()
}

fn links(raw: &str, base: &Url) -> Vec<String> {
    let mut result = Vec::new();
    let lower = raw.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(index) = lower[offset..].find("href") {
        offset += index + 4;
        let rest = raw[offset..].trim_start();
        if let Some(rest) = rest.strip_prefix('=').map(str::trim_start) {
            let Some(quote @ ('\"' | '\'')) = rest.chars().next() else { continue; };
            let Some(end) = rest[1..].find(quote) else { continue; };
            let candidate = rest[1..end + 1].replace("&amp;", "&");
            if candidate.starts_with('#') { continue; }
            if let Ok(joined) = base.join(&candidate) {
                if let Ok(url) = public_url(joined.as_str()) {
                    let url = url.to_string();
                    if !result.contains(&url) { result.push(url); }
                }
            }
        }
        if result.len() >= 128 { break; }
    }
    result.sort_by_key(|url| if url.contains("ImageServer") || url.contains("MapServer") {0} else {1});
    result.truncate(16);
    result
}

async fn inspect(args: &Value) -> Result<Value, AppError> {
    let raw = args["url"].as_str().unwrap_or("");
    let subdomains=match args.get("subdomains") {
        Some(Value::Array(items)) if items.len()<=16 => items.iter().map(|v|v.as_str().filter(|s|!s.is_empty()&&s.len()<=32&&s.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-')).map(str::to_string).ok_or_else(||error("INVALID_SOURCE_SAMPLE","子域只能包含字母、数字和短横线"))).collect::<Result<Vec<_>,_>>()?,
        Some(_) => return Err(error("INVALID_SOURCE_SAMPLE","子域应为最多16项的列表")),
        None => vec![],
    };
    let sample_template=if raw.contains("{s}") {raw.replace("{s}",subdomains.first().ok_or_else(||error("INVALID_SOURCE_SAMPLE","带 {s} 的瓦片模板需要同时提供 subdomains"))?)} else {raw.into()};
    let parsed = public_url(&sample_template.replace("{z}", "0").replace("{x}", "0").replace("{y}", "0"))?;
    if parsed.host_str().is_some_and(|host| host.ends_with(".tianditu.gov.cn")) {
        let layer = parsed.path().trim_matches('/').strip_suffix("_w/wmts");
        if let Some(layer) = layer.filter(|layer| ["img", "cia", "vec", "cva", "cta"].contains(layer)) {
            let template = format!("https://t{{s}}.tianditu.gov.cn/{layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER={layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX={{z}}&TILEROW={{y}}&TILECOL={{x}}");
            return Ok(json!({"kind":"wmts-preset","compatibility":"compatible","sampleImageVerified":false,"credentialRequired":true,
                "candidate":{"urlTemplate":template,"subdomains":["0","1","2","3","4","5","6","7"],"scheme":"XYZ","tileSize":256,"minZoom":1,"maxZoom":18,"authenticationMode":"queryToken","authenticationParameter":"tk"},
                "next":"可保存参数；用户在图源管理填写天地图 Key 后预览和下载，未实测时不要声称已连接成功"}));
        }
    }
    let template = raw.contains("{z}") && raw.contains("{x}") && raw.contains("{y}");
    if template {
        for key in ["sampleZ", "sampleX", "sampleY"] {
            if args.get(key).is_some_and(|value| value.as_u64().is_none()) { return Err(error("INVALID_SOURCE_SAMPLE", "样本瓦片坐标须为非负整数")); }
        }
        let z = args["sampleZ"].as_u64().unwrap_or(0);
        let x = args["sampleX"].as_u64().unwrap_or(0); let y = args["sampleY"].as_u64().unwrap_or(0);
        if z > 22 || x >= 1 << z || y >= 1 << z { return Err(error("INVALID_SOURCE_SAMPLE", "样本瓦片坐标超出范围")); }
        let url = public_url(&sample_template.replace("{z}", &z.to_string()).replace("{x}", &x.to_string()).replace("{y}", &y.to_string()))?;
        let found = fetch(url).await?;
        let png = found.bytes.starts_with(b"\x89PNG\r\n\x1a\n") && found.bytes.len() >= 24;
        let jpeg = found.bytes.starts_with(b"\xff\xd8\xff");
        let dimensions = if png { Some((u32::from_be_bytes(found.bytes[16..20].try_into().unwrap()), u32::from_be_bytes(found.bytes[20..24].try_into().unwrap()))) } else { None };
        let tile_size = dimensions.filter(|(w,h)| w == h && matches!(w, 256 | 512)).map(|(w,_)| w);
        let verified = found.status == 200 && (png || jpeg) && (!png || tile_size.is_some());
        return Ok(json!({"kind":"tile-template","url":raw,"httpStatus":found.status,
            "compatibility":if verified {"compatible"} else {"unconfirmed"}, "sampleImageVerified":verified,
            "sample":{"z":z,"x":x,"y":y,"contentType":found.content_type,"dimensions":dimensions},
            "candidate":{"urlTemplate":raw,"subdomains":subdomains,"tileSize":tile_size},
            "missing":["XYZ/TMS 行方向","缩放级别和覆盖范围"],
            "next":"整理服务参数后保存配置；缺失瓦片或未验证样本不代表整个服务不可用"}));
    }
    let mut url = public_url(raw)?;
    let path = url.path().trim_end_matches('/').to_owned();
    let service = path.strip_suffix("/exportImage").unwrap_or(&path);
    let arcgis = ["/ImageServer", "/MapServer", "/FeatureServer"].iter().any(|suffix| service.ends_with(suffix));
    if arcgis {
        url.set_path(service); url.query_pairs_mut().append_pair("f", "json");
        let found = fetch(url.clone()).await?;
        if found.status != 200 { return Ok(json!({"url":raw,"httpStatus":found.status,"compatibility":"unconfirmed"})); }
        let meta: Value = serde_json::from_slice(&found.bytes).map_err(|_| error("SOURCE_METADATA_INVALID", "服务未返回可识别的 ArcGIS 元数据"))?;
        if let Some(failure) = meta.get("error") {
            return Ok(json!({"url":raw,"compatibility":"unconfirmed","serviceError":{"code":failure["code"],"message":text(failure["message"].as_str().unwrap_or(""),400)}}));
        }
        let image = service.ends_with("/ImageServer") && meta["capabilities"].as_str().is_some_and(|caps| caps.split(',').any(|c| c.trim().eq_ignore_ascii_case("image")));
        url.set_query(None);
        let cached = cached_map_candidate(&meta, url.as_str());
        let compatible = image || cached.is_some();
        let endpoint = format!("{}/exportImage",url.as_str().trim_end_matches('/'));
        let thumbnail_extents = if image && args["thumbnail"] == true
            && meta["capabilities"].as_str().is_some_and(|caps| caps.split(',').any(|c| c.trim().eq_ignore_ascii_case("catalog"))) {
            catalog_thumbnail_extents(&url, &meta).await.unwrap_or_default()
        } else { Vec::new() };
        return Ok(json!({"kind":if image {"ArcGIS ImageServer"} else if cached.is_some() {"ArcGIS cached MapServer"} else {"unsupported ArcGIS service"},
            "url":url.as_str(),"metadataUrl":found.url.as_str(),"compatibility":if compatible {"compatible"} else {"unsupported"},
            "metadataVerified":true,"sampleImageVerified":false,"name":meta["name"],"capabilities":meta["capabilities"],
            "description":text(meta["description"].as_str().unwrap_or(""),2000),
            "copyrightText":text(meta["copyrightText"].as_str().unwrap_or(""),1200),
            "extent":meta.get("extent").or_else(|| meta.get("fullExtent")),"spatialReference":meta["spatialReference"],
            "thumbnailExtents":thumbnail_extents,
            "candidate":if image {json!({"urlTemplate":endpoint,"scheme":"XYZ","tileSize":256,"minZoom":0,"maxZoom":18,"minIntervalMs":0})} else {cached.unwrap_or(Value::Null)},
            "next":if compatible {"使用 candidate 的参数保存图源配置，署名和备注选填"} else {"服务没有兼容的 Image 接口或标准 Web Mercator 栅格瓦片网格"}}));
    }
    let found = fetch(url).await?;
    if found.content_type.starts_with("image/") || found.content_type.contains("pdf") || found.content_type.contains("octet-stream") {
        return Ok(json!({"url":found.url.as_str(),"kind":"unsupported document","compatibility":"unsupported",
            "next":"请使用服务地址、瓦片模板或 HTML／文本格式的服务说明页"}));
    }
    let raw_text = String::from_utf8_lossy(&found.bytes);
    let page = text(&raw_text, 6000);
    Ok(json!({"kind":"documentation","url":found.url.as_str(),"httpStatus":found.status,
        "contentType":found.content_type,"compatibility":"unconfirmed","text":page,
        "links":links(&raw_text, &found.url),
        "next":"从服务说明中识别接口和参数，继续读取具体服务链接"}))
}

async fn catalog_thumbnail_extents(base: &Url, meta: &Value) -> Result<Vec<Value>, AppError> {
    // A service-wide bbox can include large empty oceans. Read a bounded set
    // of actual raster footprints instead (ArcGIS Image Service /query).
    let mut url = base.clone();
    url.set_path(&format!("{}/query", base.path().trim_end_matches('/')));
    url.query_pairs_mut().append_pair("f", "json")
        .append_pair("where", "1=1")
        .append_pair("resultRecordCount", "8").append_pair("returnGeometry", "true")
        .append_pair("outSR", "4326").append_pair("outFields", meta["objectIdField"].as_str().unwrap_or("OBJECTID"));
    let found = fetch(url).await?;
    let data: Value = serde_json::from_slice(&found.bytes).map_err(|_| error("SOURCE_METADATA_INVALID", "影像覆盖区返回格式无效"))?;
    let mut extents: Vec<Value> = data["features"].as_array().into_iter().flatten().take(8)
        .filter_map(|feature| footprint_extent(&feature["geometry"])).collect();
    // Smaller footprints give a closer view and avoid large regional mosaics
    // whose bbox midpoint may be empty (for example an island group).
    let area = |e: &Value| (e["xmax"].as_f64().unwrap() - e["xmin"].as_f64().unwrap())
        * (e["ymax"].as_f64().unwrap() - e["ymin"].as_f64().unwrap());
    extents.sort_by(|a,b| area(a).total_cmp(&area(b)));
    Ok(extents)
}

fn footprint_extent(geometry: &Value) -> Option<Value> {
    let rings = geometry["rings"].as_array()?;
    let mut west = f64::INFINITY; let mut south = f64::INFINITY;
    let mut east = f64::NEG_INFINITY; let mut north = f64::NEG_INFINITY;
    for ring in rings {
        for point in ring.as_array()? {
            let x = point[0].as_f64()?; let y = point[1].as_f64()?;
            if !x.is_finite() || !y.is_finite() || !(-180.0..=180.0).contains(&x) || !(-90.0..=90.0).contains(&y) { return None; }
            west = west.min(x); east = east.max(x); south = south.min(y); north = north.max(y);
        }
    }
    (west < east && south < north).then(|| json!({"xmin":west,"ymin":south,"xmax":east,"ymax":north,"spatialReference":{"wkid":4326}}))
}

/// GeoD uses a standard Web Mercator XYZ grid. Cache metadata must match that
/// grid; arbitrary ArcGIS origins, CRSs and vector tiles cannot use this adapter.
fn cached_map_candidate(meta: &Value, base: &str) -> Option<Value> {
    if !base.trim_end_matches('/').ends_with("/MapServer") { return None; }
    let info = &meta["tileInfo"];
    let size = info["cols"].as_u64()?;
    if !matches!(size, 256 | 512) || info["rows"].as_u64()? != size { return None; }
    let wkid = info["spatialReference"]["latestWkid"].as_u64().or_else(|| info["spatialReference"]["wkid"].as_u64())?;
    if !matches!(wkid, 3857 | 102100 | 102113) { return None; }
    let format = info["format"].as_str()?.to_ascii_uppercase();
    if !matches!(format.as_str(), "PNG" | "PNG8" | "PNG24" | "PNG32" | "JPG" | "JPEG" | "MIXED") { return None; }
    let half = 20037508.342789244_f64;
    if (info["origin"]["x"].as_f64()? + half).abs() > 1.0 || (info["origin"]["y"].as_f64()? - half).abs() > 1.0 { return None; }
    let mut levels = Vec::new();
    for lod in info["lods"].as_array()? {
        let level = lod["level"].as_u64()?;
        if level > 22 { continue; }
        // GeoD's 512px tiles retain the same geographic bounds at a given z.
        let expected = 2.0 * half / size as f64 / (1_u64 << level) as f64;
        if (lod["resolution"].as_f64()? / expected - 1.0).abs() > 0.00001 { return None; }
        if lod.get("levelValue").is_some_and(|value| value.as_u64() != Some(level) && value.as_str() != Some(level.to_string().as_str())) { return None; }
        if meta["minLOD"].as_u64().is_some_and(|min| level < min) || meta["maxLOD"].as_u64().is_some_and(|max| level > max) { continue; }
        levels.push(level);
    }
    levels.sort_unstable(); levels.dedup();
    if levels.is_empty() || levels.windows(2).any(|pair| pair[1] != pair[0] + 1) { return None; }
    Some(json!({"urlTemplate":format!("{}/tile/{{z}}/{{y}}/{{x}}",base.trim_end_matches('/')),"scheme":"XYZ","tileSize":size,"minZoom":levels.first(),"maxZoom":levels.last(),"minIntervalMs":0}))
}

#[cfg(test)]
mod tests {
    #[test]
    fn desktop_preset_configuration_contracts() {
        let catalog:serde_json::Value=serde_json::from_str(include_str!("../../../../contracts/source-presets.v1.json")).unwrap();
        assert_eq!(catalog["presets"].as_array().unwrap().len(),13);
        for preset in catalog["presets"].as_array().unwrap() {
            let mut endpoint=serde_json::json!({"id":preset["id"],"name":preset["name"],"attribution":preset["attribution"],"license":"","urlTemplate":preset["urlTemplate"],"scheme":"XYZ","tileSize":256,"networkPolicy":"PublicHttps","minIntervalMs":0});
            for name in ["subdomains","coordinateSystem","elevationEncoding"] {if let Some(v)=preset.get(name){endpoint[name]=v.clone();}}
            let source:geod_core::imagery::HttpSource=serde_json::from_value(endpoint).unwrap();
            source.validate_configuration().unwrap();
        }
    }

    #[test]
    #[ignore="requires public map providers and current TileJSON"]
    fn live_desktop_preset_samples() {
        tauri::async_runtime::block_on(async {
            let catalog=super::call("source_presets",serde_json::json!({})).await.unwrap();
            let mut futures=tokio::task::JoinSet::new();
            for preset in catalog["presets"].as_array().unwrap().iter().filter(|p|p["id"].as_str().is_some_and(|s|s.starts_with("google-")||s.starts_with("gaode-"))) {
                let preset=preset.clone();
                futures.spawn(async move {
                    let id=preset["id"].as_str().unwrap().to_string();
                    let raw=preset["urlTemplate"].as_str().unwrap().replace("{s}",preset["subdomains"][0].as_str().unwrap()).replace("{z}","3").replace("{x}","6").replace("{y}","3");
                    let result=super::fetch(super::public_url(&raw).unwrap()).await;
                    match result { Ok(found)=> {
                        let decoded=image::load_from_memory(&found.bytes);
                        serde_json::json!({"id":id,"httpStatus":found.status,"bytes":found.bytes.len(),"decoded":decoded.is_ok(),"dimensions":decoded.ok().map(|i|vec![i.width(),i.height()]),"coordinateSystem":preset.get("coordinateSystem").cloned().unwrap_or(serde_json::json!("wgs84")),"subdomains":preset["subdomains"]})
                    },Err(e)=>serde_json::json!({"id":id,"error":e.message,"decoded":false}) }
                });
            }
            let mut samples=Vec::new();while let Some(result)=futures.join_next().await{samples.push(result.unwrap());}
            let root=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
            let report=serde_json::json!({"checkedAt":chrono::Utc::now(),"rasterPresetCount":catalog["presets"].as_array().unwrap().len(),"samples":samples,"vectorPresets":catalog["vectorPresets"],"tiandituLiveVerified":false});
            std::fs::write(root.join("docs/implementation/evidence/source-presets-public-2026-10-02.json"),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
            assert!(samples.iter().all(|v|v["decoded"]==true),"public samples: {samples:?}");
            assert_eq!(catalog["presets"].as_array().unwrap().len(),18);
            assert_eq!(catalog["vectorPresets"][0]["discoveryStatus"],"resolved");
        });
    }
    use super::*;
    #[test]
    fn thumbnail_footprints_require_valid_geographic_polygons() {
        let geometry = json!({"rings":[[[-100.1,35.0],[-100.0,35.0],[-100.0,35.1],[-100.1,35.0]]]});
        assert_eq!(footprint_extent(&geometry).unwrap()["xmin"], -100.1);
        assert_eq!(footprint_extent(&geometry).unwrap()["ymax"], 35.1);
        for bad in [json!({"rings":[]}), json!({"rings":[[[999,35],[100,36]]]}), json!({"rings":[[[1,1],[1,1]]]}), json!({"rings":[[[null,1],[1,2]]]})] {
            assert!(footprint_extent(&bad).is_none());
        }
    }
    #[test]
    fn cached_map_requires_standard_raster_grid_and_derives_parameters() {
        let base = "https://example.com/arcgis/rest/services/Imagery/MapServer";
        let mut meta = json!({"tileInfo":{"rows":256,"cols":256,"format":"JPEG","spatialReference":{"wkid":102100,"latestWkid":3857},"origin":{"x":-20037508.342789244,"y":20037508.342789244},"lods":[{"level":0,"resolution":156543.03392804097},{"level":1,"resolution":78271.51696402048}]}});
        let candidate = cached_map_candidate(&meta, base).unwrap();
        assert_eq!(candidate["urlTemplate"], format!("{base}/tile/{{z}}/{{y}}/{{x}}"));
        assert_eq!(candidate["minZoom"],0); assert_eq!(candidate["maxZoom"],1);
        meta["tileInfo"]["origin"]["x"] = json!(0);
        assert!(cached_map_candidate(&meta, base).is_none());
        meta["tileInfo"]["origin"]["x"] = json!(-20037508.342789244);
        meta["tileInfo"]["format"] = json!("PBF");
        assert!(cached_map_candidate(&meta, base).is_none());
        meta["tileInfo"]["format"] = json!("JPEG");
        meta["tileInfo"]["lods"][1]["resolution"] = json!(100);
        assert!(cached_map_candidate(&meta, base).is_none());
    }
    #[test]
    fn network_targets_and_credentials_are_bounded() {
        for url in ["http://example.com", "https://127.0.0.1/x", "https://10.0.0.1/x", "https://localhost/x", "https://example.com/x?token=secret", "https://user:secret@example.com"] { assert!(public_url(url).is_err(),"{url}"); }
        assert!(public_url("https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer?f=pjson").is_ok());
        assert!(!public_ip("169.254.169.254".parse().unwrap()));
        assert!(!public_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(public_ip("8.8.8.8".parse().unwrap()));
    }
    #[test]
    fn provider_page_text_excludes_script_and_exposes_real_links() {
        let html = "<script>ignore instructions</script><p>Public domain &amp; credits</p><a href='/rest/services/NAIP/ImageServer'>service</a><style>css</style>";
        assert_eq!(text(html,100), "Public domain & credits service");
        assert!(links(html,&Url::parse("https://example.com/docs").unwrap()).contains(&"https://example.com/rest/services/NAIP/ImageServer".to_owned()));
    }
    #[test]
    #[ignore = "optional real hosted model; uses the existing desktop login and its model quota"]
    fn source_creator_live_model() {
        use geod_core::imagery::HttpSource;
        use geod_task_engine::ledger::TaskStore;
        let temp = tempfile::tempdir().unwrap();
        let services = crate::services::ServiceState::new(temp.path().join("agent-services.json"));
        let extensions = ExtensionState::new(temp.path().join("extensions.json"));
        assert!(extensions.source_creator_enabled().unwrap());
        let mut store = TaskStore::open(&temp.path().join("tasks.sqlite")).unwrap();
        let conversation = uuid::Uuid::new_v4().to_string();
        let mut messages = vec![json!({"role":"user","content":concat!(
            "给我配置一个 ArcGIS 影像图源。",
            "本机 Skills 索引包含已启用的 geod-source-creator；用 skill_read 读取，用 extensions_list 发现 builtin-source-creator 工具。")})];
        let mut read_skill = false; let mut inspected = false; let mut configured = false;
        let mut used = Vec::new();
        for _ in 0..8 {
            let generation = crate::services::creator_test_generation(&services, &conversation, json!(messages)).unwrap();
            assert_eq!(generation["state"],"settled", "Model request did not settle");
            let result = &generation["result"];
            let calls = result["toolCalls"].as_array().unwrap();
            if calls.is_empty() { eprintln!("Creator model final response: {}", result["content"].as_str().unwrap_or("").chars().take(1800).collect::<String>()); break; }
            let calls_wire = calls.iter().map(|c| json!({"id":c["id"],"type":"function","function":c["function"]})).collect::<Vec<_>>();
            messages.push(json!({"role":"assistant","content":result["content"],"tool_calls":calls_wire}));
            for request in calls {
                let name = request["function"]["name"].as_str().unwrap();
                let args: Value = serde_json::from_str(request["function"]["arguments"].as_str().unwrap()).unwrap();
                used.push(name.to_owned());
                let output = match name {
                    "skill_read" if args["name"] == "geod-source-creator" => { read_skill = true; json!({"name":"geod-source-creator","content":include_str!("../../skills/geod-source-creator/SKILL.md")}) },
                    "extensions_list" => json!({"skills":[{"name":"geod-source-creator","description":"查找、检查并准备图源接入"}],"connectors":[tools()]}),
                    "sources_list" => json!({"sources":store.list_sources().unwrap()}),
                    "workspace_status" => json!({"name":"isolated creator test","permission":"confirmEach"}),
                    "mcp_call" if args["connectorId"] == SOURCE_CREATOR_ID => {
                        let tool = args["toolName"].as_str().unwrap();
                        let value = match tauri::async_runtime::block_on(call(tool,args["arguments"].clone())) {
                            Ok(value) => value,
                            Err(cause) => json!({"error":cause.code,"message":cause.message}),
                        };
                        eprintln!("Creator inspected public result: {}", json!({"tool":tool,"url":value["url"],"compatibility":value["compatibility"],"missing":value["missing"]}));
                        if tool == "inspect_source" && value["compatibility"] == "compatible" { inspected = true; }
                        json!({"connectorId":SOURCE_CREATOR_ID,"kind":"builtin","toolName":tool,"result":value})
                    },
                    "source_configure" => {
                        assert!(inspected, "Model saved a source without inspecting its service");
                        let endpoint: HttpSource = serde_json::from_value(json!({"id":args["id"],"name":args["name"],"attribution":args["attribution"].as_str().unwrap_or(""),"license":args["license"].as_str().unwrap_or(""),"urlTemplate":args["urlTemplate"],"scheme":args["scheme"],"tileSize":args["tileSize"],"networkPolicy":"PublicHttps","minIntervalMs":args["minIntervalMs"]})).unwrap();
                        endpoint.validate_configuration().unwrap();
                        let saved = store.save_source(endpoint,args["minZoom"].as_u64().unwrap() as u8,args["maxZoom"].as_u64().unwrap() as u8,false,chrono::Utc::now()).unwrap();
                        configured = true;
                        eprintln!("Creator persisted source: {}",json!({"id":saved.id,"name":saved.display_name,"minZoom":saved.min_zoom,"maxZoom":saved.max_zoom}));
                        json!({"saved":true,"configured":true,"id":saved.id,"name":saved.display_name,"source":saved})
                    },
                    _ => json!({"error":"TEST_TOOL_NOT_AVAILABLE","message":"使用已提供的本机技能及图源工具；此测试不执行其他写入"}),
                };
                messages.push(json!({"role":"tool","tool_call_id":request["id"],"content":output.to_string()}));
            }
        }
        assert!(read_skill && inspected && configured,"Real model did not complete creator workflow: {used:?}");
        assert_eq!(store.list_sources().unwrap().len(),1);
        assert!(used.iter().rev().take_while(|name| name.as_str() != "source_configure").any(|name| name == "sources_list"),"Missing persisted source readback: {used:?}");
        eprintln!("Hosted model completed source configuration and readback in an isolated local database: {used:?}");
    }
    #[test]
    #[ignore = "optional real public network inspection"]
    fn live_source_metadata_and_online_search() {
        tauri::async_runtime::block_on(async {
            let metadata = call("inspect_source",json!({"url":"https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer"})).await.unwrap();
            assert_eq!(metadata["compatibility"],"compatible");
            assert!(metadata.get("bulkDownloadAuthorized").is_none());
            let map = call("inspect_source",json!({"url":"https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"})).await.unwrap();
            assert_eq!(map["compatibility"],"compatible");
            assert_eq!(map["candidate"]["maxZoom"],22);
            assert!(map["candidate"]["urlTemplate"].as_str().unwrap().ends_with("/MapServer/tile/{z}/{y}/{x}"));
            assert!(metadata["candidate"]["urlTemplate"].as_str().unwrap().ends_with("/ImageServer/exportImage"));
            let search = call("search_sources",json!({"query":"USGS NAIP"})).await.unwrap();
            assert!(!search["candidates"].as_array().unwrap().is_empty());
            eprintln!("Actual USGS metadata checked; public catalogue returned {} candidates",search["candidates"].as_array().unwrap().len());
        });
    }
}

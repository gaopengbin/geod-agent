//! Wayback catalogue and regional capture metadata, using the public Esri API.
//! Release dates and capture dates are deliberately separate in every response.
use super::{error, fetch_limit, public_url, AppError};
use chrono::{DateTime, NaiveDate, Utc};
use geo::{Area, BooleanOps, Coord, LineString, MultiPolygon, Polygon};
use geod_core::boundary::BoundaryGeometry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::PathBuf, sync::{Mutex, OnceLock}};

const CONFIG: &str = "https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json";
const MAX_FEATURES: usize = 2048;
static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static CACHE: OnceLock<Mutex<Option<Catalog>>> = OnceLock::new();
pub(super) fn initialize(directory: PathBuf) { let _ = DIRECTORY.set(directory); }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Release { release_id: String, release_date: String, title: String, metadata_url: String, tile_url: String, #[serde(default)] catalog_url: Option<String> }
impl Release {
    fn source(&self) -> Value {
        // Esri's Wayback client uses this public tile alias. It follows the
        // service's same-origin tile deduplication redirects, while the raw
        // catalogue URL remains available in summary() for provenance.
        let preferred=self.tile_url.replacen("https://wayback.maptiles.arcgis.com/","https://wayback-a.maptiles.arcgis.com/",1);
        json!({"id":format!("wayback-{}",self.release_id),"name":format!("Esri 历史影像 {}",self.release_date),
            "urlTemplate":preferred,"scheme":"XYZ","tileSize":256,"minZoom":0,"maxZoom":22,"minIntervalMs":0,
            "attribution":"Esri, Maxar, Earthstar Geographics, and the GIS User Community","license":""})
    }
    fn summary(&self) -> Value { json!({"releaseId":self.release_id,"releaseDate":self.release_date,"metadataUrl":self.metadata_url,"catalogTileUrl":self.catalog_url.as_deref().unwrap_or(&self.tile_url),"source":self.source()}) }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
struct Catalog { fetched_at: DateTime<Utc>, releases: Vec<Release> }

pub(super) fn tools() -> Vec<Value> {
    let bounds=json!({"type":"array","items":{"type":"number"},"minItems":4,"maxItems":4,"description":"WGS84 [west,south,east,north]"});
    vec![
        json!({"name":"wayback_versions","description":"查询 Esri Wayback 历史影像版本，按发布日期倒序，支持日期范围和分页。返回可用 source_configure 登记的参数。releaseDate 是地图发布日期，拍摄日期须查 wayback_metadata。", "inputSchema":{"type":"object","properties":{"fromDate":{"type":"string"},"toDate":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100},"refresh":{"type":"boolean"}},"additionalProperties":false}}),
        json!({"name":"wayback_metadata","description":"读取一个真实 Wayback 版本在指定范围和级别下的影像拍摄日期、提供方、分辨率和覆盖面。返回覆盖率和缺失元数据区域；空结果不代表没有影像。", "inputSchema":{"type":"object","properties":{"releaseId":{"type":"string"},"bounds":bounds,"zoom":{"type":"integer","minimum":0,"maximum":22}},"required":["releaseId","bounds","zoom"],"additionalProperties":false}}),
        json!({"name":"wayback_changes","description":"比较两个 Wayback 版本的区域拍摄元数据，扣除相同拍摄日期、提供方和分辨率的覆盖面，生成可用于增量下载的裁剪范围。更新范围自动保存到对话并返回 boundaryId；按新版 source 配置并用普通 plan_imagery 下载，支持批量和定时。元数据缺失部分保守保留，并明确标为未知；这不是像素变化检测。", "inputSchema":{"type":"object","properties":{"fromReleaseId":{"type":"string"},"toReleaseId":{"type":"string"},"bounds":bounds,"zoom":{"type":"integer","minimum":0,"maximum":22}},"required":["fromReleaseId","toReleaseId","bounds","zoom"],"additionalProperties":false}})
    ]
}

fn parse_catalog(raw: &Value) -> Result<Vec<Release>,AppError> {
    let object=raw.as_object().ok_or_else(||error("WAYBACK_CATALOG_INVALID","历史影像目录格式无效"))?;
    let mut releases=Vec::new();
    for (id,item) in object {
        if id.is_empty() || !id.bytes().all(|c|c.is_ascii_digit()) { continue; }
        let title=item["itemTitle"].as_str().unwrap_or("");
        let Some(date)=title.split("Wayback ").nth(1).and_then(|s|s.get(..10)) else { continue; };
        if NaiveDate::parse_from_str(date,"%Y-%m-%d").is_err() { continue; }
        let Some(metadata)=item["metadataLayerUrl"].as_str() else { continue; };
        let checked=public_url(metadata)?;
        if !checked.host_str().is_some_and(|host|host.ends_with(".maptiles.arcgis.com")) || !checked.path().ends_with("/MapServer") { continue; }
        let Some(tile_url)=item["itemURL"].as_str() else { continue; };
        let tile=public_url(&tile_url.replace("{level}","0").replace("{row}","0").replace("{col}","0"))?;
        if !tile.host_str().is_some_and(|host|host.ends_with(".maptiles.arcgis.com")) || !tile_url.contains("{level}/{row}/{col}") { continue; }
        releases.push(Release {release_id:id.clone(),release_date:date.into(),title:title.into(),metadata_url:metadata.into(),
            tile_url:tile_url.replace("{level}","{z}").replace("{row}","{y}").replace("{col}","{x}"),catalog_url:Some(tile_url.into())});
    }
    releases.sort_by(|a,b|b.release_date.cmp(&a.release_date).then(a.release_id.cmp(&b.release_id)));
    if releases.is_empty() {return Err(error("WAYBACK_CATALOG_INVALID","历史影像目录没有有效版本"));}
    Ok(releases)
}
async fn catalog(refresh: bool) -> Result<(Catalog,bool),AppError> {
    let cache=CACHE.get_or_init(||Mutex::new(None));
    let memory=cache.lock().map_err(|_|error("WAYBACK_CACHE_ERROR","目录缓存不可用"))?.clone();
    let saved=memory.or_else(||DIRECTORY.get().and_then(|d|fs::read(d.join("catalog.json")).ok()).and_then(|b|serde_json::from_slice::<Catalog>(&b).ok()))
        .filter(|c|c.releases.iter().all(|r|r.tile_url.contains("/WMTS/")));
    if !refresh { if let Some(c)=&saved {if Utc::now().signed_duration_since(c.fetched_at).num_seconds()<3600 {return Ok((c.clone(),false));}} }
    let downloaded=async {
        let r=fetch_limit(public_url(CONFIG)?,4*1024*1024).await?;
        if r.status!=200 {return Err(error("WAYBACK_CATALOG_UNAVAILABLE","历史影像目录暂时不可用"));}
        let raw:Value=serde_json::from_slice(&r.bytes).map_err(|_|error("WAYBACK_CATALOG_INVALID","历史影像目录格式无效"))?;
        Ok::<_,AppError>(Catalog{fetched_at:Utc::now(),releases:parse_catalog(&raw)?})
    }.await;
    match downloaded {
        Ok(c)=>{
            *cache.lock().map_err(|_|error("WAYBACK_CACHE_ERROR","目录缓存不可用"))?=Some(c.clone());
            if let Some(dir)=DIRECTORY.get() {
                if fs::create_dir_all(dir).is_ok() {let tmp=dir.join(format!("catalog-{}.tmp",uuid::Uuid::new_v4()));if fs::write(&tmp,serde_json::to_vec(&c).unwrap()).is_ok(){if fs::rename(&tmp,dir.join("catalog.json")).is_err(){let _=fs::remove_file(tmp);}}}
            }
            Ok((c,false))
        },
        Err(cause)=>saved.map(|c|(c,true)).ok_or(cause),
    }
}
fn date_filter(args:&Value,key:&str)->Result<Option<String>,AppError>{
    match args.get(key){None=>Ok(None),Some(v)=>{let s=v.as_str().ok_or_else(||error("WAYBACK_ARGUMENTS","日期须为 YYYY-MM-DD"))?;NaiveDate::parse_from_str(s,"%Y-%m-%d").map_err(|_|error("WAYBACK_ARGUMENTS","日期须为 YYYY-MM-DD"))?;Ok(Some(s.into()))}}
}
pub(super) async fn versions(args:&Value)->Result<Value,AppError>{
    let from=date_filter(args,"fromDate")?;let to=date_filter(args,"toDate")?;
    if from.as_ref().zip(to.as_ref()).is_some_and(|(a,b)|a>b){return Err(error("WAYBACK_ARGUMENTS","起始日期晚于结束日期"));}
    let limit=args["limit"].as_u64().unwrap_or(30).clamp(1,100) as usize;let offset=args["offset"].as_u64().unwrap_or(0) as usize;
    let (c,stale)=catalog(args["refresh"]==true).await?;
    let selected:Vec<_>=c.releases.iter().filter(|r|from.as_ref().is_none_or(|f|r.release_date>=*f)&&to.as_ref().is_none_or(|t|r.release_date<=*t)).collect();
    Ok(json!({"total":selected.len(),"offset":offset,"nextOffset":if offset.saturating_add(limit)<selected.len(){Some(offset+limit)}else{None},"catalogUrl":CONFIG,"fetchedAt":c.fetched_at,"staleCache":stale,
        "dateMeaning":"releaseDate 是版本发布日期；实际拍摄时间由区域元数据提供","versions":selected.into_iter().skip(offset).take(limit).map(Release::summary).collect::<Vec<_>>()}))
}
fn find_release(c:&Catalog,id:&str)->Result<Release,AppError>{c.releases.iter().find(|r|r.release_id==id).cloned().ok_or_else(||error("WAYBACK_RELEASE_UNKNOWN","此版本不在真实 Wayback 目录中，请先查询版本"))}
fn scope(args:&Value)->Result<([f64;4],u8),AppError>{
    let b:[f64;4]=serde_json::from_value(args["bounds"].clone()).map_err(|_|error("WAYBACK_ARGUMENTS","请提供四个 WGS84 边界坐标"))?;
    if !b.iter().all(|v|v.is_finite()) || b[0]< -180. || b[2]>180. || b[1]< -85.05112878 || b[3]>85.05112878 || b[0]>=b[2] || b[1]>=b[3] || b[2]-b[0]>=180. {return Err(error("WAYBACK_ARGUMENTS","区域范围无效，跨日期变更线的范围需拆分"));}
    let z=args["zoom"].as_u64().filter(|z|*z<=22).ok_or_else(||error("WAYBACK_ARGUMENTS","请提供 0–22 的缩放级别"))? as u8;Ok((b,z))
}
fn layer(z:u8)->u8{match z{22=>0,21=>1,20=>2,18..=19=>3,17=>4,16=>5,14..=15=>6,13=>7,11..=12=>9,10=>10,9=>11,_=>12}}
fn rect(b:[f64;4])->MultiPolygon<f64>{MultiPolygon(vec![Polygon::new(LineString::from(vec![(b[0],b[1]),(b[2],b[1]),(b[2],b[3]),(b[0],b[3]),(b[0],b[1])]),vec![])])}
fn from_geo(g:&MultiPolygon<f64>)->Result<BoundaryGeometry,AppError>{
    let mut b=BoundaryGeometry{polygons:g.0.iter().filter(|p|p.unsigned_area()>1e-14).map(|p|std::iter::once(p.exterior()).chain(p.interiors().iter()).map(|r|r.0.iter().map(|p|[p.x,p.y]).collect()).collect()).collect()};
    b.normalize().map_err(|e|error("WAYBACK_GEOMETRY_INVALID",e.0))?;Ok(b)
}
async fn query(mut url:reqwest::Url)->Result<Value,AppError>{
    url.query_pairs_mut().append_pair("f","json");
    let r=fetch_limit(url,8*1024*1024).await?;
    if r.status!=200 {return Err(error("WAYBACK_METADATA_UNAVAILABLE","此版本区域元数据暂时无法读取"));}
    let v:Value=serde_json::from_slice(&r.bytes).map_err(|_|error("WAYBACK_METADATA_INVALID","区域元数据格式无效"))?;
    if let Some(e)=v.get("error"){return Err(error("WAYBACK_METADATA_UNAVAILABLE",&format!("区域元数据服务错误 {}：{}",e["code"],e["message"].as_str().unwrap_or("查询失败"))));}
    Ok(v)
}
#[derive(Clone)]
struct Footprint{capture:Option<String>,provider:String,resolution:Option<f64>,geometry:MultiPolygon<f64>}
impl Footprint{
    fn key(&self)->Option<String>{self.capture.as_ref().filter(|_|!self.provider.is_empty()).map(|date|format!("{date}|{}|{:?}",self.provider,self.resolution))}
    fn value(&self)->Result<Value,AppError>{
        use geo::BoundingRect;
        let bounds=self.geometry.bounding_rect().map(|b|[b.min().x,b.min().y,b.max().x,b.max().y]);
        Ok(json!({"captureDate":self.capture,"provider":self.provider,"resolutionMeters":self.resolution,"bounds":bounds,"polygonCount":self.geometry.0.len()}))
    }
}
async fn footprints(release:&Release,b:[f64;4],z:u8)->Result<Vec<Footprint>,AppError>{
    let base=public_url(&format!("{}/{}/query",release.metadata_url,layer(z)))?;
    let mut url=base.clone();url.query_pairs_mut().append_pair("geometry",&b.iter().map(ToString::to_string).collect::<Vec<_>>().join(","))
        .append_pair("geometryType","esriGeometryEnvelope").append_pair("inSR","4326").append_pair("spatialRel","esriSpatialRelIntersects").append_pair("where","1=1").append_pair("returnIdsOnly","true");
    let ids=query(url).await?;
    let mut ids:Vec<i64>=serde_json::from_value(ids.get("objectIds").filter(|v|!v.is_null()).cloned().unwrap_or(json!([]))).map_err(|_|error("WAYBACK_METADATA_INVALID","区域要素索引无效"))?;
    ids.sort_unstable();ids.dedup();
    if ids.len()>MAX_FEATURES{return Err(error("WAYBACK_REGION_TOO_LARGE","此范围包含超过 2048 个影像覆盖面，请按地区拆分查询"));}
    let mut result=Vec::new();let clip=rect(b);
    for ids in ids.chunks(64){
        let mut url=base.clone();url.query_pairs_mut().append_pair("objectIds",&ids.iter().map(ToString::to_string).collect::<Vec<_>>().join(","))
            .append_pair("outFields","*").append_pair("returnGeometry","true").append_pair("outSR","4326");
        let v=query(url).await?;
        if v["exceededTransferLimit"]==true{return Err(error("WAYBACK_METADATA_TRUNCATED","元数据服务截断了查询，无法完整比较此区域"));}
        let features=v["features"].as_array().ok_or_else(||error("WAYBACK_METADATA_INVALID","元数据缺少覆盖面"))?;
        if features.len()!=ids.len(){return Err(error("WAYBACK_METADATA_TRUNCATED","元数据要素返回不完整，请重试"));}
        for feature in features {
            let rings=feature["geometry"]["rings"].as_array().ok_or_else(||error("WAYBACK_METADATA_INVALID","覆盖面几何无效"))?;
            // ArcGIS rings: clockwise outer rings, counter-clockwise holes.
            let geometry=arcgis_rings(rings)?.intersection(&clip);
            if geometry.unsigned_area()<=1e-14{continue;}
            let a=&feature["attributes"];
            let capture=a["SRC_DATE2"].as_i64().and_then(DateTime::<Utc>::from_timestamp_millis).map(|d|d.format("%Y-%m-%d").to_string());
            let provider=a["NICE_NAME"].as_str().or_else(||a["SRC_DESC"].as_str()).unwrap_or("").to_owned();
            result.push(Footprint{capture,provider,resolution:a["SRC_RES"].as_f64(),geometry});
        }
    }
    Ok(result)
}
fn arcgis_rings(rings:&[Value])->Result<MultiPolygon<f64>,AppError>{
    use geo::{Contains,InteriorPoint};
    let mut outers:Vec<Polygon<f64>>=Vec::new();let mut holes=Vec::new();
    for value in rings{
        let ring:Vec<[f64;2]>=serde_json::from_value(value.clone()).map_err(|_|error("WAYBACK_METADATA_INVALID","覆盖面坐标无效"))?;
        let mut normalized=BoundaryGeometry{polygons:vec![vec![ring]]};normalized.normalize().map_err(|e|error("WAYBACK_METADATA_INVALID",e.0))?;
        let ring=&normalized.polygons[0][0];
        let area:f64=ring.windows(2).map(|p|p[0][0]*p[1][1]-p[1][0]*p[0][1]).sum();
        let line=LineString(ring.iter().map(|p|Coord{x:p[0],y:p[1]}).collect());
        if area<0. {outers.push(Polygon::new(line,vec![]));}else{holes.push(line);}
    }
    for hole in holes{
        let p=Polygon::new(hole.clone(),vec![]);let point=p.interior_point().ok_or_else(||error("WAYBACK_METADATA_INVALID","覆盖面孔洞无效"))?;
        let index=outers.iter().enumerate().filter(|(_,o)|o.contains(&point)).min_by(|(_,a),(_,b)|a.unsigned_area().total_cmp(&b.unsigned_area())).map(|(i,_)|i).ok_or_else(||error("WAYBACK_METADATA_INVALID","覆盖面孔洞缺少外环"))?;
        outers[index].interiors_push(hole);
    }
    Ok(MultiPolygon(outers))
}
fn coverage(items:&[Footprint])->MultiPolygon<f64>{items.iter().fold(MultiPolygon(vec![]),|g,item|g.union(&item.geometry))}
pub(super) async fn metadata(args:&Value)->Result<Value,AppError>{
    let (bounds,z)=scope(args)?;let(c,stale)=catalog(false).await?;let release=find_release(&c,args["releaseId"].as_str().unwrap_or(""))?;
    let items=footprints(&release,bounds,z).await?;let fraction=(coverage(&items).unsigned_area()/rect(bounds).unsigned_area()).clamp(0.,1.);
    Ok(json!({"release":release.summary(),"catalogFetchedAt":c.fetched_at,"staleCatalog":stale,"bounds":bounds,"zoom":z,"metadataLayer":layer(z),"metadataCoverageFraction":fraction,
        "footprints":items.iter().map(Footprint::value).collect::<Result<Vec<_>,_>>()?,"dateMeaning":"captureDate 是该覆盖面的拍摄日期；缺失值表示服务没有提供。releaseDate 是版本发布日期。"}))
}
fn incremental(before:&[Footprint],after:&[Footprint],aoi:&MultiPolygon<f64>)->MultiPolygon<f64>{
    let mut previous:BTreeMap<String,MultiPolygon<f64>>=BTreeMap::new();
    for item in before{if let Some(key)=item.key(){let g=previous.entry(key).or_insert_with(||MultiPolygon(vec![]));*g=g.union(&item.geometry);}}
    let mut unchanged=MultiPolygon(vec![]);
    for item in after{if let Some(old)=item.key().and_then(|key|previous.get(&key)){unchanged=unchanged.union(&item.geometry.intersection(old));}}
    // Unknown metadata remains in the result so incremental downloads do not
    // silently omit locations whose image identity could not be established.
    aoi.difference(&unchanged)
}
pub(super) async fn changes(args:&Value)->Result<Value,AppError>{
    let (bounds,z)=scope(args)?;let(c,stale)=catalog(false).await?;
    let before=find_release(&c,args["fromReleaseId"].as_str().unwrap_or(""))?;let after=find_release(&c,args["toReleaseId"].as_str().unwrap_or(""))?;
    if before.release_date>=after.release_date{return Err(error("WAYBACK_ARGUMENTS","增量比较需要从较旧版本到较新版本"));}
    let (a,b)=tokio::try_join!(footprints(&before,bounds,z),footprints(&after,bounds,z))?;
    let aoi=rect(bounds);let changed=incremental(&a,&b,&aoi);
    let known=|items:&[Footprint]|items.iter().filter(|f|f.key().is_some()).fold(MultiPolygon(vec![]),|g,f|g.union(&f.geometry));
    let unknown=aoi.difference(&known(&a).intersection(&known(&b)));
    let fraction=(changed.unsigned_area()/aoi.unsigned_area()).clamp(0.,1.);let found=changed.unsigned_area()>1e-14;
    let mut result=json!({"found":found,"fromRelease":before.summary(),"toRelease":after.summary(),"source":after.source(),"bounds":bounds,"zoom":z,
        "catalogFetchedAt":c.fetched_at,"staleCatalog":stale,"changedFraction":fraction,"unknownMetadataFraction":(unknown.unsigned_area()/aoi.unsigned_area()).clamp(0.,1.),
        "comparison":"capture metadata footprint difference","dateMeaning":"比较拍摄日期、提供方、分辨率与覆盖几何；未知元数据范围保留在增量范围中","before":a.iter().map(Footprint::value).collect::<Result<Vec<_>,_>>()?,"after":b.iter().map(Footprint::value).collect::<Result<Vec<_>,_>>()?});
    if found{let mut geometry=from_geo(&changed)?;let bounds=geometry.normalize().map_err(|e|error("WAYBACK_GEOMETRY_INVALID",e.0))?;
        result["boundary"]=json!({"name":format!("Wayback-{}-至-{}-更新范围.geojson",before.release_date,after.release_date),"bounds":bounds,"polygonCount":geometry.polygons.len(),"geometry":geometry});
    }
    Ok(result)
}

#[cfg(test)]
mod tests{
    use super::*;
    fn footprint(b:[f64;4],date:Option<&str>)->Footprint{Footprint{capture:date.map(str::to_owned),provider:"Maxar".into(),resolution:Some(0.3),geometry:rect(b)}}
    #[test]fn incremental_subtracts_only_matching_capture_geometry(){
        let aoi=rect([0.,0.,10.,10.]);let old=[footprint([0.,0.,10.,10.],Some("2020-01-01"))];
        let new=[footprint([0.,0.,5.,10.],Some("2020-01-01")),footprint([5.,0.,10.,10.],Some("2025-01-01"))];
        assert!((incremental(&old,&new,&aoi).unsigned_area()-50.).abs()<1e-9);
        assert!(incremental(&old,&old,&aoi).unsigned_area()<1e-9);
        assert!((incremental(&old,&[footprint([0.,0.,5.,10.],None)],&aoi).unsigned_area()-100.).abs()<1e-9);
    }
    #[test]fn arcgis_hole_is_preserved(){let g=arcgis_rings(&[
        json!([[0.,0.],[0.,10.],[10.,10.],[10.,0.],[0.,0.]]),json!([[2.,2.],[8.,2.],[8.,8.],[2.,8.],[2.,2.]])]).unwrap();assert!((g.unsigned_area()-64.).abs()<1e-9);assert_eq!(from_geo(&g).unwrap().polygons[0].len(),2);}
    #[test]fn release_id_is_not_used_as_date_order(){
        let item=|date:&str,id:&str|json!({"itemTitle":format!("World Imagery (Wayback {date})"),"metadataLayerUrl":"https://metadata.maptiles.arcgis.com/x/MapServer","itemURL":format!("https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{id}/{{level}}/{{row}}/{{col}}")});
        let releases=parse_catalog(&json!({"99000":item("2020-01-01","99000"),"100":item("2025-01-01","100")})).unwrap();
        assert_eq!(releases[0].release_id,"100");assert_eq!(layer(12),9);
        assert!(releases[0].tile_url.ends_with("/tile/100/{z}/{y}/{x}"));assert!(releases[0].tile_url.contains("/WMTS/1.0.0/default028mm/MapServer/"));
        let summary=releases[0].summary();
        assert!(summary["source"]["urlTemplate"].as_str().unwrap().starts_with("https://wayback-a.maptiles.arcgis.com/"));
        assert_eq!(summary["catalogTileUrl"],item("2025-01-01","100")["itemURL"]);
    }
    #[tokio::test]
    #[ignore = "requests public Esri catalogue and regional metadata"]
    async fn public_wayback_metadata_and_incremental_scope(){
        let(c,stale)=catalog(true).await.unwrap();assert!(!stale);assert!(c.releases.len()>2);
        let bounds=[116.395,39.895,116.405,39.905];
        let old=c.releases.last().unwrap();let new=&c.releases[0];
        let data=metadata(&json!({"releaseId":new.release_id,"bounds":bounds,"zoom":16})).await.unwrap();
        assert!(!data["footprints"].as_array().unwrap().is_empty(),"{data}");
        let changed=changes(&json!({"fromReleaseId":old.release_id,"toReleaseId":new.release_id,"bounds":bounds,"zoom":16})).await.unwrap();
        let report=json!({"pass":true,"checkedAt":Utc::now(),"versions":c.releases.len(),"metadata":data,"changes":changed});
        let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/implementation/evidence/wayback-public-2026-10-02.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();fs::write(path,serde_json::to_vec_pretty(&report).unwrap()).unwrap();
        println!("{}",json!({"versions":c.releases.len(),"latest":new.release_date,"oldest":old.release_date,"footprints":report["metadata"]["footprints"].as_array().unwrap().len(),"changedFraction":report["changes"]["changedFraction"]}));
    }
}

//! Native online vector discovery and complete, bounded feature retrieval.
//! Credentials never cross origins, enter the model, or reach GDAL.
use crate::{network, services, workspace_error, AppError};
use reqwest::{header::{HeaderMap, HeaderName, HeaderValue}, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{BTreeMap, HashSet}, fs, path::{Path, PathBuf}, time::Duration};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_PAGES: usize = 200;
const MAX_FEATURES: usize = 10_000;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Connection { id: String, name: String, url: String, header_names: Vec<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Draft { name: String, url: String, #[serde(default)] headers: BTreeMap<String, String> }
#[derive(Default, Deserialize, Serialize)]
struct Secret { headers: BTreeMap<String, String>, query: BTreeMap<String, String> }
#[derive(Default, Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadOptions { pub(crate) bounds: Option<[f64;4]>, pub(crate) max_features: Option<usize>, pub(crate) page_size: Option<usize> }
struct Session { client: reqwest::Client, origin: Url, secret: Secret, bytes: usize, pages: usize }

fn root(app: &AppHandle, services: &services::ServiceState) -> Result<PathBuf, AppError> {
    let user=services::current_user_id(services).map_err(|e|workspace_error(e.code,e.message))?;
    root_for_owner(app,&user)
}
fn root_for_owner(app:&AppHandle,user:&str)->Result<PathBuf,AppError>{
    let root=app.path().app_data_dir().map_err(|_|workspace_error("INPUT_STORAGE_FAILED","连接目录不可用"))?
        .join("online-inputs").join(format!("{:x}",Sha256::digest(user.as_bytes())));
    fs::create_dir_all(&root).map_err(|_|workspace_error("INPUT_STORAGE_FAILED","连接目录不可用"))?;
    Ok(root)
}
pub(crate) fn binding(app:&AppHandle,user:&str,id:&str)->Result<(String,String),AppError>{
    let root=root_for_owner(app,user)?;
    let connection=connections(&root)?.into_iter().find(|c|c.id==id).ok_or_else(||workspace_error("INPUT_CONNECTION_NOT_FOUND","在线连接不存在"))?;
    let revision=format!("{:x}",Sha256::digest(serde_json::to_vec(&connection).unwrap()));
    Ok((connection.url,revision))
}
pub(crate) fn public_url(url:&str)->Result<String,AppError>{
    let url=target(url)?;
    if url.query_pairs().any(|(k,_)|secret_key(&k)){return Err(workspace_error("INPUT_CREDENTIAL_REQUIRED","请在在线数据连接中保存认证信息，再使用连接创建下载任务"));}
    Ok(url.to_string())
}
pub(crate) fn validate_options(options:&ReadOptions)->Result<(),AppError>{limits(options).map(|_|())}
fn connections(root:&Path)->Result<Vec<Connection>,AppError> {
    crate::connection_registry::load(root)
}
fn credential(root:&Path,id:&str)->Result<keyring::Entry,AppError> {
    keyring::Entry::new("GeoD-online-input",&format!("{}:{id}",root.file_name().unwrap().to_string_lossy()))
        .map_err(|_|workspace_error("INPUT_CREDENTIAL_FAILED","无法访问在线数据凭据"))
}
fn target(url:&str)->Result<Url,AppError> {
    let url=Url::parse(url).map_err(|_|workspace_error("INPUT_URL_INVALID","请输入有效的数据网址"))?;
    if !["http","https"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(workspace_error("INPUT_URL_INVALID","请输入不含用户密码或片段的 HTTP / HTTPS 数据网址"));
    }
    Ok(url)
}
fn secret_key(key:&str)->bool { matches!(key.to_ascii_lowercase().as_str(),"token"|"access_token"|"key"|"api_key"|"apikey"|"tk"|"auth"|"signature"|"sig") }
fn split_secret(url:Url,headers:BTreeMap<String,String>)->(Url,Secret) {
    let mut secret=Secret{headers,query:BTreeMap::new()};
    let pairs:Vec<_>=url.query_pairs().map(|(k,v)|(k.into_owned(),v.into_owned())).collect();
    let mut url=url;
    url.set_query(None);
    for (k,v) in pairs { if secret_key(&k) {secret.query.insert(k,v);} else {url.query_pairs_mut().append_pair(&k,&v);} }
    (url,secret)
}
fn headers(secret:&Secret)->Result<HeaderMap,AppError> {
    if secret.headers.len()>20 || secret.headers.iter().map(|(k,v)|k.len()+v.len()).sum::<usize>()>16*1024 {
        return Err(workspace_error("INPUT_AUTH_INVALID","认证请求头过多或过长"));
    }
    let mut result=HeaderMap::new();
    for (key,value) in &secret.headers {
        let key=HeaderName::from_bytes(key.as_bytes()).map_err(|_|workspace_error("INPUT_AUTH_INVALID","请求头名称无效"))?;
        if matches!(key.as_str(),"host"|"connection"|"content-length"|"transfer-encoding"|"upgrade"|"proxy-authorization") {return Err(workspace_error("INPUT_AUTH_INVALID","此请求头由应用管理"));}
        result.insert(key,HeaderValue::from_str(value).map_err(|_|workspace_error("INPUT_AUTH_INVALID","认证请求头内容无效"))?);
    }
    Ok(result)
}
impl Session {
    async fn setup(app:&AppHandle,url:Option<String>,id:Option<String>)->Result<(Self,Url),AppError> {
        Self::setup_bound(app,url,id,None).await
    }
    async fn setup_bound(app:&AppHandle,url:Option<String>,id:Option<String>,binding:Option<(String,String)>)->Result<(Self,Url),AppError> {
        if url.is_some()==id.is_some() {return Err(workspace_error("INPUT_INVALID","请选择数据网址或已保存的在线连接"));}
        let app=app.clone();
        let (url,secret)=tauri::async_runtime::spawn_blocking(move|| -> Result<(Url,Secret),AppError>{
            if let Some(id)=id {
                let root=if let Some((owner,_))=&binding{root_for_owner(&app,owner)?}else{root(&app,&app.state::<services::ServiceState>())?};
                let connection=connections(&root)?.into_iter().find(|c|c.id==id).ok_or_else(||workspace_error("INPUT_CONNECTION_NOT_FOUND","在线连接不存在"))?;
                if let Some((_,revision))=&binding{if format!("{:x}",Sha256::digest(serde_json::to_vec(&connection).unwrap()))!=*revision{return Err(workspace_error("INPUT_CONNECTION_CHANGED","在线连接发生变化，请重新创建任务"));}}
                let secret=credential(&root,&id)?.get_password().map_err(|_|workspace_error("INPUT_CREDENTIAL_FAILED","请重新保存在线数据认证"))?;
                let secret:Secret=serde_json::from_str(&secret).map_err(|_|workspace_error("INPUT_CREDENTIAL_FAILED","在线数据认证不可读"))?;
                Ok((target(&connection.url)?,secret))
            } else {Ok(split_secret(target(&url.unwrap())?,BTreeMap::new()))}
        }).await.map_err(|_|workspace_error("INPUT_READ_FAILED","在线连接初始化中断"))??;
        let proxy=network::proxy_for(url.as_str()).map_err(|_|workspace_error("INPUT_NETWORK_FAILED","在线数据网络配置无效"))?;
        let client=network::apply(reqwest::Client::builder(),proxy.as_deref()).map_err(|_|workspace_error("INPUT_NETWORK_FAILED","在线数据网络配置无效"))?
            .redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(45)).build().map_err(|_|workspace_error("INPUT_NETWORK_FAILED","在线数据网络初始化失败"))?;
        Ok((Self{client,origin:url.clone(),secret,bytes:0,pages:0},url))
    }
    async fn get(&mut self,mut url:Url)->Result<(Vec<u8>,String,Option<String>),AppError> {
        self.pages+=1;
        if self.pages>MAX_PAGES {return Err(workspace_error("INPUT_TOO_LARGE","服务分页超过 200 次，请缩小范围"));}
        for _ in 0..6 {
            if url.origin()!=self.origin.origin() {return Err(workspace_error("INPUT_REDIRECT","服务跳转到其他地址，请为该地址另建连接"));}
            for (k,v) in &self.secret.query {set_query(&mut url,k,v);}
            let mut response=self.client.get(url.clone()).headers(headers(&self.secret)?).send().await
                .map_err(|_|workspace_error("INPUT_NETWORK_FAILED","无法连接在线数据服务"))?;
            if response.status().is_redirection() {
                let location=response.headers().get("location").and_then(|v|v.to_str().ok()).ok_or_else(||workspace_error("INPUT_REDIRECT","服务返回无效跳转"))?;
                url=target(url.join(location).map_err(|_|workspace_error("INPUT_REDIRECT","服务返回无效跳转"))?.as_str())?;
                continue;
            }
            if !response.status().is_success() {return Err(workspace_error(if matches!(response.status().as_u16(),401|403){"INPUT_AUTH_REQUIRED"}else{"INPUT_NETWORK_FAILED"},format!("在线数据返回 HTTP {}",response.status().as_u16())));}
            let content_type=response.headers().get("content-type").and_then(|v|v.to_str().ok()).unwrap_or("").to_owned();
            let content_crs=response.headers().get("content-crs").and_then(|v|v.to_str().ok()).map(str::to_owned);
            let mut bytes=vec![];
            while let Some(chunk)=response.chunk().await.map_err(|_|workspace_error("INPUT_NETWORK_FAILED","在线数据读取中断"))? {
                self.bytes+=chunk.len();
                if self.bytes>MAX_BYTES {return Err(workspace_error("INPUT_TOO_LARGE","在线数据合计超过 32 MiB，请缩小范围"));}
                bytes.extend_from_slice(&chunk);
            }
            return Ok((bytes,content_type,content_crs));
        }
        Err(workspace_error("INPUT_REDIRECT","服务跳转次数过多"))
    }
    async fn json(&mut self,url:Url)->Result<Value,AppError> {
        let (bytes,_,crs)=self.get(url).await?;
        let mut value:Value=serde_json::from_slice(&bytes).map_err(|_|workspace_error("INPUT_FORMAT_UNSUPPORTED","服务未返回 JSON 数据"))?;
        crate::wfs_inputs::response_crs(&mut value,crs.as_deref())?;
        if value.get("error").is_some() {return Err(workspace_error("INPUT_NETWORK_FAILED","在线服务返回查询错误，请检查图层、条件或认证"));}
        Ok(value)
    }
}
fn set_query(url:&mut Url,key:&str,value:&str) {
    let pairs:Vec<_>=url.query_pairs().filter(|(k,_)|!k.eq_ignore_ascii_case(key)).map(|(k,v)|(k.into_owned(),v.into_owned())).collect();
    url.set_query(None); let mut query=url.query_pairs_mut(); for (k,v) in pairs {query.append_pair(&k,&v);} query.append_pair(key,value);
}
fn remove_query(url:&mut Url,key:&str) {
    let pairs:Vec<_>=url.query_pairs().filter(|(k,_)|!k.eq_ignore_ascii_case(key)).map(|(k,v)|(k.into_owned(),v.into_owned())).collect();
    url.set_query(None); if !pairs.is_empty(){let mut query=url.query_pairs_mut();for(k,v)in pairs{query.append_pair(&k,&v);}}
}
fn child(base:&Url,parts:&[&str])->Result<Url,AppError> {
    let mut url=base.clone();
    {let mut path=url.path_segments_mut().map_err(|_|workspace_error("INPUT_URL_INVALID","服务网址无效"))?;path.pop_if_empty();for part in parts{path.push(part);}}
    Ok(url)
}
fn clean(url:&Url)->String {split_secret(url.clone(),BTreeMap::new()).0.to_string()}
fn limits(options:&ReadOptions)->Result<(usize,usize),AppError> {
    let max=options.max_features.unwrap_or(MAX_FEATURES);let page=options.page_size.unwrap_or(500);
    if max==0||max>MAX_FEATURES||page==0||page>1000{return Err(workspace_error("INPUT_INVALID","要素上限为 1 至 10,000，分页大小为 1 至 1,000"));}
    if options.bounds.is_some_and(|b|b.iter().any(|v|!v.is_finite())||b[0]< -180.||b[2]>180.||b[1]< -90.||b[3]>90.||b[0]>=b[2]||b[1]>=b[3]){return Err(workspace_error("INPUT_INVALID","查询范围需要有效的 WGS84 边界框"));}
    Ok((max,page))
}
async fn discover(session:&mut Session,mut url:Url)->Result<Value,AppError> {
    if crate::wfs_inputs::is_wfs(&url){
        let requested=url.query_pairs().find(|(k,_)|k.eq_ignore_ascii_case("typenames")||k.eq_ignore_ascii_case("typename")).map(|(_,v)|v.into_owned());
        let mut result=wfs_capabilities(session,&url).await?;
        if let Some(layer)=requested.filter(|s|!s.contains(',')) {
            let mut schema=target(result["layers"].as_array().unwrap().iter().find(|l|l["name"]==layer).ok_or_else(||workspace_error("INPUT_LAYER_NOT_FOUND","WFS 目录中没有此图层"))?["describeUrl"].as_str().unwrap())?;
            set_query(&mut schema,"service","WFS");set_query(&mut schema,"version",result["version"].as_str().unwrap());set_query(&mut schema,"request","DescribeFeatureType");set_query(&mut schema,if result["version"]=="2.0.0"{"typeNames"}else{"typeName"},&layer);
            let (bytes,_,_)=session.get(schema).await?;result["fields"]=json!(crate::wfs_inputs::fields(&bytes)?);result["selectedLayer"]=json!(layer);
        }
        return Ok(result);
    }
    set_query(&mut url,"f","json");
    let mut value=session.json(url.clone()).await?;
    if value.get("collections").is_none() && value["links"].as_array().is_some_and(|links|links.iter().any(|l|l["rel"]=="data")) {
        let href=value["links"].as_array().unwrap().iter().find(|l|l["rel"]=="data").and_then(|l|l["href"].as_str()).ok_or_else(||workspace_error("INPUT_FORMAT_UNSUPPORTED","服务没有集合入口"))?;
        url=url.join(href).map_err(|_|workspace_error("INPUT_URL_INVALID","服务集合入口无效"))?;
        value=session.json(url.clone()).await?;
    }
    if let Some(items)=value["collections"].as_array() {
        let layers:Vec<_>=items.iter().map(|c| {
            let id=c["id"].as_str().unwrap_or("");
            let href=c["links"].as_array().and_then(|links|links.iter().find(|l|l["rel"]=="items" && (l["type"].as_str().unwrap_or("").contains("json")||l.get("type").is_none()))).and_then(|l|l["href"].as_str());
            let link=href.and_then(|s|url.join(s).ok()).or_else(|| {
                let mut base=url.clone();if base.path().trim_end_matches('/').ends_with("/collections") {let p=base.path().trim_end_matches('/').trim_end_matches("/collections").to_owned();base.set_path(&p);} child(&base,&["collections",id,"items"]).ok()
            });
            json!({"name":id,"title":c["title"].as_str().unwrap_or(id),"geometryType":"FeatureCollection","queryUrl":link.as_ref().map(clean),"crs":c["crs"]})
        }).collect();
        return Ok(json!({"kind":"ogc-features","layers":layers}));
    }
    if let Some(items)=value["layers"].as_array() {
        let layers:Vec<_>=items.iter().filter(|l|l.get("id").is_some()).map(|l|json!({"name":l["id"].to_string(),"title":l["name"],"geometryType":l["geometryType"],"queryUrl":child(&url,&[&l["id"].to_string(),"query"]).ok().as_ref().map(clean)})).collect();
        return Ok(json!({"kind":"arcgis-service","layers":layers}));
    }
    if value.get("fields").is_some() {
        return Ok(json!({"kind":"arcgis-layer","name":value["name"],"fields":value["fields"],"geometryType":value["geometryType"],"queryUrl":child(&url,&["query"]).ok().as_ref().map(clean)}));
    }
    if value.get("folders").is_some()||value.get("services").is_some(){return Ok(json!({"kind":"arcgis-directory","folders":value["folders"],"services":value["services"]}));}
    Err(workspace_error("INPUT_FORMAT_UNSUPPORTED","未发现可查询的要素图层，请提供 ArcGIS 服务、OGC 集合或要素网址"))
}

async fn wfs_capabilities(session:&mut Session,base:&Url)->Result<Value,AppError>{
    let mut url=base.clone();for key in ["f","outputFormat","count","maxFeatures","startIndex","typeNames","typeName","bbox","srsName","filter","cql_filter","propertyName","sortBy","resultType"]{remove_query(&mut url,key);}
    set_query(&mut url,"service","WFS");set_query(&mut url,"request","GetCapabilities");
    let (bytes,_,_)=session.get(url.clone()).await?;let mut result=crate::wfs_inputs::capabilities(&bytes,&url)?;
    for layer in result["layers"].as_array_mut().unwrap(){for key in ["queryUrl","describeUrl"]{let url=target(layer[key].as_str().unwrap())?;layer[key]=json!(clean(&url));}}
    Ok(result)
}
fn total(value:&Value)->Option<u64>{value.as_u64().or_else(||value.as_str().and_then(|s|s.parse().ok()))}

#[tauri::command]
pub(crate) fn online_connections_list(app:AppHandle,services:State<'_,services::ServiceState>)->Result<Vec<Connection>,AppError>{connections(&root(&app,&services)?)}
#[tauri::command]
pub(crate) fn online_connection_save(app:AppHandle,services:State<'_,services::ServiceState>,draft:Draft)->Result<Connection,AppError>{
    if draft.name.trim().is_empty()||draft.name.len()>80{return Err(workspace_error("INPUT_INVALID","请输入在线连接名称"));}
    let (url,secret)=split_secret(target(&draft.url)?,draft.headers);headers(&secret)?;
    let root=root(&app,&services)?;
    let connection=Connection{id:Uuid::new_v4().to_string(),name:draft.name.trim().into(),url:clean(&url),header_names:secret.headers.keys().cloned().collect()};
    credential(&root,&connection.id)?.set_password(&serde_json::to_string(&secret).unwrap()).map_err(|_|workspace_error("INPUT_CREDENTIAL_FAILED","认证信息未能保存到系统凭据库"))?;
    if let Err(e)=crate::connection_registry::update(&root,|all|{all.push(connection.clone());Ok(())}){let _=credential(&root,&connection.id)?.delete_credential();return Err(e);}
    Ok(connection)
}
#[tauri::command]
pub(crate) fn online_connection_remove(app:AppHandle,services:State<'_,services::ServiceState>,connection_id:String)->Result<(),AppError>{
    let root=root(&app,&services)?;crate::connection_registry::update::<Connection>(&root,|all|{all.retain(|c|c.id!=connection_id);Ok(())})?;
    let _=credential(&root,&connection_id)?.delete_credential();Ok(())
}
#[tauri::command]
pub(crate) async fn online_services_discover(app:AppHandle,url:Option<String>,connection_id:Option<String>)->Result<Value,AppError>{
    let (mut session,url)=Session::setup(&app,url,connection_id).await?;discover(&mut session,url).await
}

pub(crate) async fn read(app:&AppHandle,url:Option<String>,id:Option<String>,layer:Option<&str>,options:ReadOptions)->Result<(String,Vec<u8>,Value),AppError>{
    let (session,url)=Session::setup(app,url,id).await?;
    read_session(session,url,layer,options).await
}
pub(crate) async fn read_bound(app:&AppHandle,owner:String,url:Option<String>,id:Option<String>,revision:String,layer:Option<&str>,options:ReadOptions)->Result<(String,Vec<u8>,Value),AppError>{
    let (session,url)=Session::setup_bound(app,url,id,Some((owner,revision))).await?;
    read_session(session,url,layer,options).await
}
async fn read_session(mut session:Session,mut url:Url,layer:Option<&str>,options:ReadOptions)->Result<(String,Vec<u8>,Value),AppError>{
    let (max,page)=limits(&options)?;
    let arcgis=url.path().to_ascii_lowercase().contains("/featureserver")||url.path().to_ascii_lowercase().contains("/mapserver");
    if arcgis {
        if !url.path().trim_end_matches('/').ends_with("/query") {
            if let Some(layer)=layer {if !layer.bytes().all(|b|b.is_ascii_digit()) {return Err(workspace_error("INPUT_INVALID","ArcGIS 图层需要实际数字 ID"));}url=child(&url,&[layer,"query"])?;}
            else if url.path_segments().and_then(|s|s.last()).is_some_and(|s|s.bytes().all(|b|b.is_ascii_digit())&&!s.is_empty()){url=child(&url,&["query"])?;}
            else {return Err(workspace_error("INPUT_LAYER_REQUIRED","请先发现图层，再指定 ArcGIS 图层 ID"));}
        }
        if !url.query_pairs().any(|(k,_)|k.eq_ignore_ascii_case("where")){set_query(&mut url,"where","1=1");}
        if let Some(b)=options.bounds {set_query(&mut url,"geometry",&b.iter().map(ToString::to_string).collect::<Vec<_>>().join(","));set_query(&mut url,"geometryType","esriGeometryEnvelope");set_query(&mut url,"inSR","4326");set_query(&mut url,"spatialRel","esriSpatialRelIntersects");}
        remove_query(&mut url,"resultOffset");remove_query(&mut url,"resultRecordCount");set_query(&mut url,"f","json");set_query(&mut url,"returnCountOnly","false");set_query(&mut url,"returnGeometry","false");set_query(&mut url,"returnIdsOnly","true");
        let ids_value=session.json(url.clone()).await?;
        let ids=ids_value["objectIds"].as_array().ok_or_else(||workspace_error("INPUT_PAGED_RESULT","该 ArcGIS 查询不支持完整 ID 获取，未导入不完整范围"))?;
        if ids.len()>max{return Err(workspace_error("INPUT_TOO_LARGE",format!("查询含 {} 个要素，超过当前 {} 个上限，请缩小范围",ids.len(),max)));}
        let mut unique=HashSet::new();if ids.iter().any(|id|!unique.insert(id.to_string())){return Err(workspace_error("INPUT_PAGED_RESULT","服务返回重复要素 ID"));}
        let field=ids_value["objectIdFieldName"].as_str().ok_or_else(||workspace_error("INPUT_PAGED_RESULT","服务未返回要素 ID 字段，无法核对完整性"))?;
        set_query(&mut url,"returnIdsOnly","false");set_query(&mut url,"returnGeometry","true");set_query(&mut url,"outFields","*");set_query(&mut url,"outSR","4326");
        let mut start=0;let mut chunk_size=page.min(100);let mut merged=json!({"features":[],"objectIdFieldName":field,"spatialReference":{"wkid":4326}});let mut features=vec![];
        while start<ids.len() {
            let end=(start+chunk_size).min(ids.len());let wanted:HashSet<_>=ids[start..end].iter().map(Value::to_string).collect();
            set_query(&mut url,"objectIds",&ids[start..end].iter().map(Value::to_string).collect::<Vec<_>>().join(","));
            let response=session.json(url.clone()).await?;
            if response["exceededTransferLimit"]==true && chunk_size>1{chunk_size=(chunk_size/2).max(1);continue;}
            let values=response["features"].as_array().ok_or_else(||workspace_error("INPUT_PAGED_RESULT","服务未返回完整要素"))?;
            let returned:HashSet<_>=values.iter().map(|f|f["attributes"][field].to_string()).collect();
            if returned!=wanted||values.len()!=wanted.len()||response["exceededTransferLimit"]==true{return Err(workspace_error("INPUT_PAGED_RESULT","查询期间要素缺失或变化，请重新读取"));}
            for key in ["geometryType","fields","spatialReference"] {if response.get(key).is_some(){merged[key]=response[key].clone();}}
            features.extend(values.iter().cloned());start=end;
        }
        merged["features"]=json!(features);
        let bytes=serde_json::to_vec(&merged).unwrap();if bytes.len()>MAX_BYTES{return Err(workspace_error("INPUT_TOO_LARGE","完整在线数据超过 32 MiB"));}
        let source_layer=url.path_segments().and_then(|s|s.rev().nth(1)).map(str::to_owned);
        return Ok(("online.json".into(),bytes,json!({"complete":true,"featureCount":features.len(),"requests":session.pages,"protocol":"arcgis","strategy":"objectIds","remoteLayer":true,"sourceLayer":source_layer})));
    }
    let wfs=crate::wfs_inputs::is_wfs(&url);let mut wfs_version=String::new();let mut wfs_expected=None;let mut source_layer=layer.map(str::to_owned);let mut source_name=None;
    if wfs {
        let metadata=wfs_capabilities(&mut session,&url).await?;wfs_version=metadata["version"].as_str().unwrap().into();
        let selected=layer.map(str::to_owned).or_else(||url.query_pairs().find(|(k,_)|k.eq_ignore_ascii_case("typename")||k.eq_ignore_ascii_case("typenames")).map(|(_,v)|v.into_owned())).or_else(||metadata["layers"].as_array().filter(|l|l.len()==1).map(|l|l[0]["name"].as_str().unwrap().into())).ok_or_else(||workspace_error("INPUT_LAYER_REQUIRED","请先发现并指定 WFS 图层"))?;
        let chosen=metadata["layers"].as_array().unwrap().iter().find(|l|l["name"]==selected).ok_or_else(||workspace_error("INPUT_LAYER_NOT_FOUND","WFS 目录中没有此图层"))?;
        source_layer=Some(selected.clone());source_name=chosen["title"].as_str().map(str::to_owned);
        let original:Vec<_>=url.query_pairs().map(|(k,v)|(k.into_owned(),v.into_owned())).collect();url=target(chosen["queryUrl"].as_str().unwrap())?;
        for (k,v) in original {set_query(&mut url,&k,&v);}
        set_query(&mut url,"service","WFS");set_query(&mut url,"request","GetFeature");set_query(&mut url,"version",&wfs_version);
        remove_query(&mut url,"f");remove_query(&mut url,"typeName");remove_query(&mut url,"typeNames");set_query(&mut url,if wfs_version=="2.0.0"{"typeNames"}else{"typeName"},&selected);
        if !url.query_pairs().any(|(k,_)|k.eq_ignore_ascii_case("outputFormat")){
            let formats=metadata["outputFormats"].as_array().unwrap();if let Some(format)=formats.iter().filter_map(Value::as_str).find(|s|s.eq_ignore_ascii_case("application/json")).or_else(||formats.iter().filter_map(Value::as_str).find(|s|s.eq_ignore_ascii_case("json"))){set_query(&mut url,"outputFormat",format);}
        }
        if !url.query_pairs().any(|(k,_)|k.eq_ignore_ascii_case("srsName")){if let Some(crs)=chosen["defaultCrs"].as_str(){set_query(&mut url,"srsName",crs);}}
        // Servers without a published primary key require a stable sort for WFS 2 paging.
        // Use only an identifier actually declared by DescribeFeatureType.
        if !url.query_pairs().any(|(k,_)|k.eq_ignore_ascii_case("sortBy")){
            let mut schema=target(chosen["describeUrl"].as_str().unwrap())?;
            set_query(&mut schema,"service","WFS");set_query(&mut schema,"version",&wfs_version);set_query(&mut schema,"request","DescribeFeatureType");set_query(&mut schema,if wfs_version=="2.0.0"{"typeNames"}else{"typeName"},&selected);
            let (bytes,_,_)=session.get(schema).await?;let fields=crate::wfs_inputs::fields(&bytes)?;
            if let Some(name)=fields.iter().filter_map(|f|f["name"].as_str()).find(|n|matches!(n.to_ascii_lowercase().as_str(),"id"|"fid"|"objectid"|"gid")){set_query(&mut url,"sortBy",name);}
        }
    }
    let file=url.path_segments().and_then(|s|s.last()).is_some_and(|s|s.rsplit_once('.').is_some_and(|(_,ext)|["geojson","json","shp","zip","gpkg","sqlite","db","kml","kmz","gml","fgb","gpx","wkt","csv"].contains(&ext.to_ascii_lowercase().as_str())));
    let remote_layer=layer.is_some()&&!wfs&&!file;
    if let Some(layer)=layer.filter(|_|remote_layer) {
        let mut base=url.clone();if base.path().trim_end_matches('/').ends_with("/collections"){let p=base.path().trim_end_matches('/').trim_end_matches("/collections").to_owned();base.set_path(&p);}url=child(&base,&["collections",layer,"items"])?;
    }
    let ogc=url.path().trim_end_matches('/').ends_with("/items");
    if ogc&&source_layer.is_none(){source_layer=url.path_segments().and_then(|s|s.rev().nth(1)).map(str::to_owned);}
    if ogc {set_query(&mut url,"limit",&page.to_string());set_query(&mut url,"f","json");}
    if wfs {remove_query(&mut url,"count");remove_query(&mut url,"maxFeatures");set_query(&mut url,if wfs_version=="2.0.0"{"count"}else{"maxFeatures"},&page.to_string());set_query(&mut url,"startIndex","0");}
    if let Some(b)=options.bounds {let bbox=if wfs&&wfs_version!="1.0.0"{format!("{},{},{},{},urn:ogc:def:crs:EPSG::4326",b[1],b[0],b[3],b[2])}else if wfs{format!("{},{},{},{},EPSG:4326",b[0],b[1],b[2],b[3])}else{b.iter().map(ToString::to_string).collect::<Vec<_>>().join(",")};set_query(&mut url,"bbox",&bbox);}
    if wfs&&wfs_version!="1.0.0"{
        let mut hit_url=url.clone();for key in ["outputFormat","startIndex","count","maxFeatures","sortBy"]{remove_query(&mut hit_url,key);}set_query(&mut hit_url,"resultType","hits");
        match session.get(hit_url).await{
            Ok((bytes,_,_))=>{wfs_expected=crate::wfs_inputs::hits(&bytes)?;if wfs_expected.is_some_and(|n|n>max as u64){return Err(workspace_error("INPUT_TOO_LARGE","查询要素超过当前上限，请缩小范围"));}}
            Err(e)=>return Err(e),
        }
    }
    if wfs{remove_query(&mut url,"resultType");}
    let (mut bytes,content_type,content_crs)=session.get(url.clone()).await?;
    let Ok(mut value)=serde_json::from_slice::<Value>(&bytes) else {
        if wfs&&(content_type.contains("xml")||content_type.contains("gml")||bytes.iter().find(|b|!b.is_ascii_whitespace())==Some(&b'<')){
            let first=crate::wfs_inputs::gml_page(&bytes)?;let mut count=0usize;let mut members=vec![];let mut seen_ids=HashSet::new();let mut seen_pages=HashSet::new();let mut expected=wfs_expected.or(first.expected);let mut current=crate::wfs_inputs::gml_page(&bytes)?;
            loop{
                if !seen_pages.insert(url.to_string()){return Err(workspace_error("INPUT_PAGED_RESULT","WFS 分页形成循环"));}
                if current.namespaces!=first.namespaces{return Err(workspace_error("INPUT_PAGED_RESULT","WFS 分页的命名空间变化，请重新读取"));}
                if count+current.count>max||current.expected.is_some_and(|n|n>max as u64){return Err(workspace_error("INPUT_TOO_LARGE","查询要素超过当前上限，请缩小范围"));}
                if let Some(n)=current.expected{if expected.is_some_and(|old|old!=n){return Err(workspace_error("INPUT_PAGED_RESULT","WFS 查询期间要素数量变化"));}expected=Some(n);}
                for id in &current.ids{if !seen_ids.insert(id.clone()){return Err(workspace_error("INPUT_PAGED_RESULT","WFS 分页返回重复要素"));}}
                count+=current.count;members.extend(current.members.clone());
                let more=expected.is_some_and(|n|n>count as u64)||(expected.is_none()&&current.count==page);
                let next=if let Some(href)=current.next{Some(target(url.join(&href).map_err(|_|workspace_error("INPUT_URL_INVALID","WFS 下一页网址无效"))?.as_str())?)}else if more{let mut next=url.clone();set_query(&mut next,"startIndex",&count.to_string());Some(next)}else{None};
                let Some(next)=next else{if expected.is_some_and(|n|n!=count as u64){return Err(workspace_error("INPUT_PAGED_RESULT","WFS 未返回完整要素"));}break;};
                if current.count==0{return Err(workspace_error("INPUT_PAGED_RESULT","WFS 空页仍声明有后续要素"));}
                // Query filters are retained; credentials remain inside Session.
                for key in ["bbox","srsName","filter","cql_filter","typeNames","typeName","outputFormat","version"]{if let Some((_,value))=url.query_pairs().find(|(k,_)|k.eq_ignore_ascii_case(key)){if next.query_pairs().any(|(k,v)|k.eq_ignore_ascii_case(key)&&v!=value){return Err(workspace_error("INPUT_PAGED_RESULT","WFS 下一页改变了查询条件"));}}}
                let mut next=next;for (key,value) in url.query_pairs().filter(|(k,_)|!k.eq_ignore_ascii_case("startIndex")){if !next.query_pairs().any(|(k,_)|k.eq_ignore_ascii_case(&key)){set_query(&mut next,&key,&value);}}
                url=next;let (data,_,_)=session.get(url.clone()).await?;current=crate::wfs_inputs::gml_page(&data)?;
            }
            let merged=crate::wfs_inputs::gml_merged(&first,&members,count);if merged.len()>MAX_BYTES{return Err(workspace_error("INPUT_TOO_LARGE","完整 WFS 数据超过 32 MiB"));}
            return Ok(("online.gml".into(),merged,json!({"complete":true,"featureCount":count,"requests":session.pages,"remoteLayer":true,"protocol":"wfs","version":wfs_version,"format":"gml","sourceLayer":source_layer,"sourceName":source_name})));
        }
        // Direct GML/file reads retain the existing worker's truncation check.
        return Ok((if content_type.contains("xml"){"online.gml".into()}else{url.path_segments().and_then(|s|s.last()).filter(|s|s.contains('.')).unwrap_or("online.geojson").into()},bytes,json!({"complete":null,"requests":session.pages})));
    };
    crate::wfs_inputs::response_crs(&mut value,content_crs.as_deref())?;
    if value.get("error").is_some(){return Err(workspace_error("INPUT_NETWORK_FAILED","服务返回查询错误"));}
    if value["type"]!="FeatureCollection" {return Ok(("online.geojson".into(),bytes,json!({"complete":true,"requests":session.pages})));}
    let filters:Vec<_>=url.query_pairs().filter(|(k,_)|matches!(k.to_ascii_lowercase().as_str(),"bbox"|"bbox-crs"|"datetime"|"filter"|"filter-lang"|"filter-crs"|"properties"|"sortby"|"typenames"|"typename"|"cql_filter"|"srsname")).map(|(k,v)|(k.into_owned(),v.into_owned())).collect();
    let mut features=vec![];let mut seen_urls=HashSet::new();let mut seen_ids=HashSet::new();let mut expected=wfs_expected;let mut crs=None;
    loop {
        if !seen_urls.insert(url.to_string()){return Err(workspace_error("INPUT_PAGED_RESULT","服务分页形成循环，未导入不完整范围"));}
        let page_features=value["features"].as_array().ok_or_else(||workspace_error("INPUT_FORMAT_UNSUPPORTED","要素集合无效"))?;
        if features.len()+page_features.len()>max{return Err(workspace_error("INPUT_TOO_LARGE",format!("要素超过当前 {} 个上限，请缩小范围",max)));}
        if let Some(n)=total(&value["numberMatched"]).or_else(||total(&value["totalFeatures"])) {if n as usize>max{return Err(workspace_error("INPUT_TOO_LARGE","查询要素超过当前上限，请缩小范围"));}if expected.is_some_and(|old|old!=n){return Err(workspace_error("INPUT_PAGED_RESULT","查询期间要素数量变化，请重新读取"));}expected=Some(n);}
        if let Some(current)=value.get("crs").filter(|v|!v.is_null()){if crs.as_ref().is_some_and(|old|old!=current){return Err(workspace_error("INPUT_CRS_REQUIRED","服务分页的坐标系不一致"));}crs=Some(current.clone());}
        for feature in page_features {if let Some(id)=feature.get("id"){if !seen_ids.insert(id.to_string()){return Err(workspace_error("INPUT_PAGED_RESULT","服务分页返回重复要素，请重新读取"));}}}
        features.extend(page_features.iter().cloned());
        let next=value["links"].as_array().and_then(|links|links.iter().find(|l|l["rel"]=="next")).and_then(|l|l["href"].as_str()).map(str::to_owned).or_else(||value["next"].as_str().map(str::to_owned));
        let next=if let Some(href)=next {Some(target(url.join(&href).map_err(|_|workspace_error("INPUT_URL_INVALID","下一页网址无效"))?.as_str())?)}
            else if wfs&&(expected.is_some_and(|n|n as usize>features.len())||(expected.is_none()&&page_features.len()==page)) {let mut next=url.clone();set_query(&mut next,"startIndex",&features.len().to_string());Some(next)}else{None};
        if next.is_some()&&page_features.is_empty(){return Err(workspace_error("INPUT_PAGED_RESULT","服务空页仍有后续结果"));}
        let Some(mut next)=next else {if value["exceededTransferLimit"]==true||expected.is_some_and(|n|n as usize!=features.len()){return Err(workspace_error("INPUT_PAGED_RESULT","未获得完整要素集合，请使用可分页的服务或缩小范围"));}break;};
        for (k,v) in &filters {if next.query_pairs().any(|(nk,nv)|nk.eq_ignore_ascii_case(k)&&nv!=v.as_str()){return Err(workspace_error("INPUT_PAGED_RESULT","服务下一页改变了查询范围或条件"));}if !next.query_pairs().any(|(nk,_)|nk.eq_ignore_ascii_case(k)){set_query(&mut next,k,v);}}
        url=next;value=session.json(url.clone()).await?;if value["type"]!="FeatureCollection"{return Err(workspace_error("INPUT_PAGED_RESULT","下一页不是有效的要素集合"));}
    }
    let mut merged=json!({"type":"FeatureCollection","features":features});if let Some(crs)=crs{merged["crs"]=crs;}
    bytes=serde_json::to_vec(&merged).unwrap();if bytes.len()>MAX_BYTES{return Err(workspace_error("INPUT_TOO_LARGE","完整在线数据超过 32 MiB"));}
    Ok(("online.geojson".into(),bytes,json!({"complete":true,"featureCount":features.len(),"requests":session.pages,"remoteLayer":remote_layer||wfs||ogc,"sourceLayer":source_layer,"sourceName":source_name,"protocol":if wfs{"wfs"}else if ogc{"ogc-features"}else{"geojson"},"version":if wfs{Some(wfs_version)}else{None}})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn credentials_are_removed_from_metadata_and_origin_is_exact(){
        let (url,secret)=split_secret(target("https://example.org/data?token=hidden&where=id%3D1").unwrap(),BTreeMap::from([("Authorization".into(),"Bearer secret".into())]));
        assert!(!url.as_str().contains("hidden"));assert_eq!(secret.query["token"],"hidden");assert!(url.query_pairs().any(|(k,v)|k=="where"&&v=="id=1"));
        assert_ne!(url.origin(),target("https://example.org:444/data").unwrap().origin());
        assert!(target("https://user:password@example.org/data").is_err());assert!(headers(&Secret{headers:BTreeMap::from([("Host".into(),"other".into())]),query:BTreeMap::new()}).is_err());
    }
    #[test]fn limits_reject_invalid_extent_and_query_replacement_preserves_filter(){
        assert!(limits(&ReadOptions{bounds:Some([30.,0.,20.,10.]),..Default::default()}).is_err());
        let mut url=target("https://example.org/query?where=id%3D1&f=geojson").unwrap();set_query(&mut url,"f","json");assert!(url.query_pairs().any(|(k,v)|k=="where"&&v=="id=1"));assert_eq!(url.query_pairs().filter(|(k,_)|k=="f").count(),1);
    }
}

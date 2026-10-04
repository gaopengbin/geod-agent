//! Cesium terrain resources with opaque local URLs. Ion account/endpoint secrets stay native.
use crate::{data_credentials, network, services, workspace_error, AppError, AppState};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::{Arc, Mutex}, time::Duration};
use tauri::{http::{Request, Response}, AppHandle, Manager};
use uuid::Uuid;

#[derive(Clone)]
struct Resource { url: String, metadata: bool, version: String }
struct Resources { entries: HashMap<String, Resource>, metadata: HashMap<String, Vec<u8>> }
struct Session {
    owner: String, conversation: String, connection: String, revision: String, asset: u64,
    client: Client, origin: Url, endpoint: Mutex<Url>, headers: Mutex<HashMap<String,String>>, credits: Vec<String>,
    resources: Mutex<Resources>, refresh: tokio::sync::Mutex<()>, requests: Mutex<(u64,u64,u16)>,
}
#[derive(Default)]
pub struct TerrainSessions(Mutex<HashMap<String, Arc<Session>>>);
fn error(code: &'static str, message: impl Into<String>) -> AppError { workspace_error(code, message) }
fn client(proxy: Option<&str>) -> Result<Client, AppError> {
    let mut builder=Client::builder().gzip(true).connect_timeout(Duration::from_secs(15)).timeout(Duration::from_secs(30)).redirect(reqwest::redirect::Policy::none());
    if let Some(proxy)=proxy { builder=builder.proxy(reqwest::Proxy::all(proxy).map_err(|_|error("TERRAIN_NETWORK","地形代理设置不可用"))?); }
    builder.build().map_err(|_|error("TERRAIN_NETWORK","无法建立地形连接"))
}
fn current(app:&AppHandle, session:&Session) -> Result<(),AppError> {
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|_|error("AUTH_REQUIRED","请先登录 GeoD"))?;
    if owner!=session.owner { return Err(error("TERRAIN_SESSION_CHANGED","地形连接属于另一个账号")); }
    let profile=data_credentials::bind(&app.state::<AppState>(),&owner,&session.connection)?;
    if profile.revision!=session.revision { return Err(error("TERRAIN_CONNECTION_CHANGED","地形连接已更新，请重新加载")); }
    crate::read_workspace(app,&app.state::<AppState>(),&app.state::<services::ServiceState>(),&session.conversation)?;
    Ok(())
}
#[tauri::command]
pub async fn ion_terrain_open(app:AppHandle, conversation_id:String, connection_id:String, asset_id:Option<u64>) -> Result<Value,AppError> {
    let copy=app.clone();
    let (owner,profile,credential,proxy)=tauri::async_runtime::spawn_blocking(move||{
        let state=copy.state::<AppState>();let service=copy.state::<services::ServiceState>();
        let owner=services::current_user_id(&service).map_err(|_|error("AUTH_REQUIRED","请先登录 GeoD"))?;
        crate::read_workspace(&copy,&state,&service,&conversation_id)?;
        let profile=data_credentials::bind(&state,&owner,&connection_id)?;
        let credential=data_credentials::resolve(&state,&owner,&connection_id,&profile.revision)?;
        let proxy=network::proxy_for(&profile.source_url()).map_err(|_|error("TERRAIN_NETWORK","网络设置不可用"))?;
        Ok::<_,AppError>((owner,profile,credential,proxy,conversation_id))
    }).await.map_err(|_|error("TERRAIN_CONNECTION","地形连接检查中断"))?.map(|(a,b,c,d,e)|((a,e),b,c,d))?;
    let (owner,conversation)=owner;
    let asset=asset_id.or(profile.asset_id).unwrap_or(0);
    let endpoint=credential.resolve_terrain(Some(asset),proxy.as_deref()).await.map_err(|e|error("TERRAIN_CONNECTION",e))?;
    let root=Url::parse(&endpoint.layer_url).map_err(|_|error("TERRAIN_CONNECTION","地形地址无效"))?;
    let session=Arc::new(Session { owner, conversation, connection:profile.id,revision:profile.revision,asset,
        client:client(proxy.as_deref())?,origin:root.clone(),endpoint:Mutex::new(root.clone()),headers:Mutex::new(endpoint.headers.into_iter().collect()),credits:endpoint.credits,
        resources:Mutex::new(Resources{entries:HashMap::from([("root".into(),Resource{url:root.to_string(),metadata:true,version:String::new()})]),metadata:HashMap::new()}),refresh:tokio::sync::Mutex::new(()),requests:Mutex::new((0,0,0)) });
    let token=Uuid::new_v4().to_string();
    // Resolve the actual layer before exposing a provider; errors never replace the current scene.
    let (_,_,status)=session.fetch(&token,"root","layer.json",None).await.map_err(|_|error("TERRAIN_CONNECTION","无法读取 Ion 地形元数据"))?;
    if status!=200{return Err(error("TERRAIN_CONNECTION",format!("Ion 地形服务返回 HTTP {status}")));}
    let check=app.clone();let checked=Arc::clone(&session);
    tauri::async_runtime::spawn_blocking(move||current(&check,&checked)).await.map_err(|_|error("TERRAIN_CONNECTION","地形连接检查中断"))??;
    let result=json!({"sessionId":token,"resourcePath":format!("{token}/root/"),"connectionId":session.connection,"assetId":session.asset});
    let registry=app.state::<TerrainSessions>();let mut sessions=registry.0.lock().map_err(|_|error("TERRAIN_STORAGE","地形会话不可用"))?;
    // The old provider remains usable until the frontend commits the ready replacement.
    sessions.retain(|_,s|s.owner==session.owner);
    sessions.insert(token,session);Ok(result)
}
#[tauri::command]
pub fn ion_terrain_close(app:AppHandle, session_id:String) -> Result<(),AppError> {
    let owner=services::current_user_id(&app.state::<services::ServiceState>()).map_err(|_|error("AUTH_REQUIRED","请先登录 GeoD"))?;
    let registry=app.state::<TerrainSessions>();let mut sessions=registry.0.lock().map_err(|_|error("TERRAIN_STORAGE","地形会话不可用"))?;
    if sessions.get(&session_id).is_some_and(|s|s.owner==owner) { sessions.remove(&session_id); } Ok(())
}
#[tauri::command]
pub fn ion_terrain_status(app:AppHandle,session_id:String) -> Result<Value,AppError> {
    let session=app.state::<TerrainSessions>().0.lock().ok().and_then(|s|s.get(&session_id).cloned()).ok_or_else(||error("TERRAIN_SESSION_CHANGED","地形会话已关闭"))?;
    current(&app,&session)?;let counts=*session.requests.lock().map_err(|_|error("TERRAIN_STORAGE","地形状态不可用"))?;
    Ok(json!({"connectionId":session.connection,"assetId":session.asset,"requests":counts.0,"loaded":counts.1,"lastHttpStatus":counts.2}))
}
fn reference(base:&Url,value:&str) -> Result<String,String> {
    let mut url=base.join(value).map_err(|_|"Invalid terrain reference")?;
    if !url.username().is_empty()||url.password().is_some()||url.fragment().is_some()||url.host_str().is_none()||!(url.scheme()=="https"||base.scheme()=="http"&&url.scheme()=="http") { return Err("Invalid terrain reference".into()); }
    if url.origin()==base.origin() {
        let existing:HashMap<String,String>=url.query_pairs().into_owned().collect();
        let add:Vec<_>=base.query_pairs().filter(|(key,_)|!existing.contains_key(key.as_ref())).map(|(k,v)|(k.into_owned(),v.into_owned())).collect();
        for(k,v)in add{url.query_pairs_mut().append_pair(&k,&v);}
    }
    // URL parsing encodes braces; Cesium's coordinate/version placeholders are kept only natively.
    Ok(url.to_string().replace("%7B","{").replace("%7D","}"))
}
impl Session {
    fn replace_endpoint(&self,endpoint:geod_tiles3d::ion::TerrainEndpoint)->Result<(),String>{
        let next=Url::parse(&endpoint.layer_url).map_err(|_|"Invalid terrain endpoint")?;
        if next.origin()!=self.origin.origin()||next.path()!=self.origin.path(){return Err("Terrain endpoint moved".into());}
        let mut previous=self.endpoint.lock().map_err(|_|"Terrain registry unavailable")?;
        let old:HashMap<String,String>=previous.query_pairs().into_owned().collect();
        let new:HashMap<String,String>=next.query_pairs().into_owned().collect();
        let mut resources=self.resources.lock().map_err(|_|"Terrain registry unavailable")?;
        for resource in resources.entries.values_mut(){
            let mut url=Url::parse(&resource.url).map_err(|_|"Invalid terrain resource")?;
            if url.origin()!=next.origin(){continue;}
            let mut query:Vec<(String,String)>=url.query_pairs().into_owned().collect();
            // Rotate only query values inherited from the endpoint; explicit tile values
            // (such as a content version) and references to other origins stay intact.
            query.retain(|(k,v)|old.get(k)!=Some(v));
            for(k,v)in &new{if !query.iter().any(|(key,_)|key==k){query.push((k.clone(),v.clone()));}}
            url.set_query(None);if !query.is_empty(){url.query_pairs_mut().extend_pairs(query);}
            resource.url=url.to_string().replace("%7B","{").replace("%7D","}");
        }
        *self.headers.lock().map_err(|_|"Terrain registry unavailable")?=endpoint.headers.into_iter().collect();
        *previous=next;Ok(())
    }
    async fn fetch_refreshing<F,Fut>(&self,token:&str,id:&str,path:&str,accept:Option<String>,resolve:F)->Result<(Vec<u8>,bool,u16),String>
    where F:FnOnce()->Fut,Fut:std::future::Future<Output=Result<geod_tiles3d::ion::TerrainEndpoint,String>>{
        let previous=self.headers.lock().map_err(|_|"Terrain registry unavailable")?.clone();
        let endpoint=self.endpoint.lock().map_err(|_|"Terrain registry unavailable")?.clone();
        let result=self.fetch(token,id,path,accept.clone()).await?;
        if result.2!=401{return Ok(result);}
        let _guard=self.refresh.lock().await;
        let changed=*self.headers.lock().map_err(|_|"Terrain registry unavailable")?!=previous||*self.endpoint.lock().map_err(|_|"Terrain registry unavailable")?!=endpoint;
        if !changed{
            let Ok(endpoint)=resolve().await else{return Ok(result);};
            if self.replace_endpoint(endpoint).is_err(){return Ok(result);}
        }
        // One retry per request. Another denial is returned without its upstream body.
        self.fetch(token,id,path,accept).await
    }
    fn metadata(&self,token:&str,id:&str,bytes:&[u8],base:&Url)->Result<Vec<u8>,String>{
        let mut value:Value=serde_json::from_slice(bytes).map_err(|_|"Invalid terrain layer")?;
        if !matches!(value["format"].as_str(),Some("quantized-mesh-1.0"|"heightmap-1.0")) { return Err("Unsupported terrain format".into()); }
        let version=value["version"].as_str().unwrap_or("").to_owned();
        let tiles=value["tiles"].as_array_mut().ok_or("Terrain has no tile templates")?;
        if tiles.is_empty()||tiles.len()>16{return Err("Invalid terrain tile templates".into());}
        let mut resources=self.resources.lock().map_err(|_|"Terrain registry unavailable")?;
        if resources.entries.len()+tiles.len()+1>128{return Err("Terrain layer nesting is too large".into());}
        for tile in tiles{
            let upstream=reference(base,tile.as_str().ok_or("Invalid terrain template")?)?;
            let resource=Uuid::new_v4().to_string();resources.entries.insert(resource.clone(),Resource{url:upstream,metadata:false,version:version.clone()});
            *tile=Value::String(format!("../{resource}/{{z}}/{{x}}/{{y}}.terrain"));
        }
        if let Some(parent)=value["parentUrl"].as_str(){
            let parent=reference(base,parent)?;let parent=Url::parse(&parent).map_err(|_|"Invalid terrain parent")?;
            let url=reference(&parent,"layer.json")?;let resource=Uuid::new_v4().to_string();
            resources.entries.insert(resource.clone(),Resource{url,metadata:true,version:String::new()});value["parentUrl"]=Value::String(format!("../{resource}/"));
        }
        if !self.credits.is_empty(){value["attribution"]=Value::String(self.credits.join(" "));}
        let result=serde_json::to_vec(&value).map_err(|_|"Invalid terrain layer")?;
        // Metadata fields other than the rewritten templates must never echo an endpoint credential.
        let text=std::str::from_utf8(&result).map_err(|_|"Invalid terrain layer")?;
        for secret in self.headers.lock().map_err(|_|"Terrain registry unavailable")?.values(){
            let secret=secret.strip_prefix("Bearer ").unwrap_or(secret);if secret.len()>8&&text.contains(secret){return Err("Terrain metadata contains credential values".into());}
        }
        resources.metadata.insert(id.to_owned(),result.clone());let _=token;Ok(result)
    }
    async fn fetch(&self,token:&str,id:&str,path:&str,accept:Option<String>)->Result<(Vec<u8>,bool,u16),String>{
        let resource=self.resources.lock().map_err(|_|"Terrain registry unavailable")?.entries.get(id).cloned().ok_or("Unknown terrain resource")?;
        if resource.metadata && path!="layer.json"{return Err("Invalid terrain metadata path".into());}
        if resource.metadata{if let Some(bytes)=self.resources.lock().map_err(|_|"Terrain registry unavailable")?.metadata.get(id).cloned(){return Ok((bytes,true,200));}}
        let url=if resource.metadata{resource.url.clone()}else{
            let parts:Vec<_>=path.split('/').collect();if parts.len()!=3{return Err("Invalid terrain coordinate".into());}
            let z=parts[0].parse::<u32>().map_err(|_|"Invalid terrain level")?;let x=parts[1].parse::<u64>().map_err(|_|"Invalid terrain x")?;
            let y=parts[2].strip_suffix(".terrain").ok_or("Invalid terrain path")?.parse::<u64>().map_err(|_|"Invalid terrain y")?;
            if z>30||x>=(1u64<<(z+1))||y>=(1u64<<z){return Err("Invalid terrain coordinate".into());}
            resource.url.replace("{z}",&z.to_string()).replace("{x}",&x.to_string()).replace("{y}",&y.to_string()).replace("{version}",&resource.version)
        };
        let mut url=Url::parse(&url).map_err(|_|"Invalid terrain resource")?;
        if !resource.metadata&&url.origin()==self.origin.origin(){
            // This opaque Resource is not an IonResource. Translate its standard Accept
            // extension request to the query parameter expected by Ion's terrain endpoint.
            if let Some(extensions)=accept.as_deref().and_then(|a|a.split("extensions=").nth(1)).map(|v|v.split([',',';',' ']).next().unwrap_or("").trim_matches('"')){
                if !extensions.is_empty()&&extensions.split('-').all(|v|matches!(v,"octvertexnormals"|"vertexnormals"|"watermask"|"metadata")){url.query_pairs_mut().append_pair("extensions",extensions);}
            }
        }
        let mut request=self.client.get(url.clone());
        if url.origin()==self.origin.origin(){for(k,v)in self.headers.lock().map_err(|_|"Terrain registry unavailable")?.iter(){request=request.header(k,v);}}
        if let Some(accept)=accept.filter(|a|a.len()<1024&&!a.chars().any(char::is_control)){request=request.header("Accept",accept);}
        let mut response=request.send().await.map_err(|_|"Terrain request failed")?;let status=response.status().as_u16();
        {let mut counts=self.requests.lock().map_err(|_|"Terrain registry unavailable")?;counts.0+=1;counts.2=status;}
        if status!=200{return Ok((Vec::new(),resource.metadata,status));}
        let mut bytes=Vec::new();while let Some(chunk)=response.chunk().await.map_err(|_|"Terrain response failed")?{if bytes.len()+chunk.len()>16*1024*1024{return Err("Terrain response is too large".into());}bytes.extend_from_slice(&chunk);}
        if resource.metadata{bytes=self.metadata(token,id,&bytes,&url)?;}
        self.requests.lock().map_err(|_|"Terrain registry unavailable")?.1+=1;
        Ok((bytes,resource.metadata,status))
    }
}
pub async fn respond(app:AppHandle,request:Request<Vec<u8>>)->Response<Vec<u8>>{
    let origin=request.headers().get("origin").and_then(|v|v.to_str().ok()).unwrap_or("http://tauri.localhost").to_owned();
    let allowed=matches!(origin.as_str(),"http://tauri.localhost"|"https://tauri.localhost"|"tauri://localhost"|"http://127.0.0.1:1420"|"http://localhost:1420");
    let mut response=if !allowed{reply(403)}else if request.method()=="OPTIONS"{reply(204)}else if request.method()!="GET"{reply(405)}else{read(app,request).await};
    if allowed{let h=response.headers_mut();h.insert("access-control-allow-origin",origin.parse().unwrap());h.insert("access-control-allow-methods","GET, OPTIONS".parse().unwrap());h.insert("access-control-allow-headers","accept".parse().unwrap());}
    response.headers_mut().insert("cache-control","private, no-store".parse().unwrap());response.headers_mut().insert("x-content-type-options","nosniff".parse().unwrap());response
}
async fn read(app:AppHandle,request:Request<Vec<u8>>)->Response<Vec<u8>>{
    let path=request.uri().path().trim_start_matches('/');let mut parts=path.splitn(3,'/');let(token,id,relative)=(parts.next().unwrap_or(""),parts.next().unwrap_or(""),parts.next().unwrap_or(""));
    if request.uri().query().is_some()||path.contains('%')||Uuid::parse_str(token).is_err(){return reply(400);}
    let session=app.state::<TerrainSessions>().0.lock().ok().and_then(|s|s.get(token).cloned());let Some(session)=session else{return reply(404);};
    let check=app.clone();let checked=session.clone();if tauri::async_runtime::spawn_blocking(move||current(&check,&checked)).await.ok().and_then(Result::ok).is_none(){return reply(403);}
    let accept=request.headers().get("accept").and_then(|v|v.to_str().ok()).map(str::to_owned);
    let result=session.fetch_refreshing(token,id,relative,accept,||async{
        let checked=session.clone();let check=app.clone();
        let credential=tauri::async_runtime::spawn_blocking(move||{current(&check,&checked)?;let state=check.state::<AppState>();let profile=data_credentials::bind(&state,&checked.owner,&checked.connection)?;let proxy=network::proxy_for(&profile.source_url()).map_err(|_|error("TERRAIN_NETWORK","网络设置不可用"))?;Ok::<_,AppError>((data_credentials::resolve(&state,&checked.owner,&checked.connection,&checked.revision)?,proxy))}).await;
        let (credential,proxy)=credential.map_err(|_|"Terrain refresh interrupted".to_owned())?.map_err(|_|"Terrain credential changed".to_owned())?;
        credential.resolve_terrain(Some(session.asset),proxy.as_deref()).await
    }).await;
    let check=app;let checked=session.clone();if tauri::async_runtime::spawn_blocking(move||current(&check,&checked)).await.ok().and_then(Result::ok).is_none(){return reply(403);}
    match result{Ok((bytes,metadata,200))=>Response::builder().status(200).header("Content-Type",if metadata{"application/json"}else{"application/vnd.quantized-mesh"}).body(bytes).unwrap(),Ok((_,_,status))=>reply(status),Err(_)=>reply(502)}
}
fn reply(status:u16)->Response<Vec<u8>>{Response::builder().status(status).body(Vec::new()).unwrap()}

#[cfg(test)]mod tests{
    use super::*;
    fn session(url:String)->Session{let origin=Url::parse(&url).unwrap();Session{owner:"owner".into(),conversation:"conversation".into(),connection:"connection".into(),revision:"revision".into(),asset:1,client:client(None).unwrap(),origin:origin.clone(),endpoint:Mutex::new(origin.clone()),headers:Mutex::new(HashMap::from([("Authorization".into(),"Bearer fixture-terrain-token".into()),("X-Private-Key".into(),"fixture-private-key".into())])),credits:vec![],resources:Mutex::new(Resources{entries:HashMap::from([("root".into(),Resource{url:origin.to_string(),metadata:true,version:String::new()})]),metadata:HashMap::new()}),refresh:tokio::sync::Mutex::new(()),requests:Mutex::new((0,0,0))}}
    #[tokio::test]
    async fn expired_endpoint_refreshes_once_with_new_header_and_signed_query(){
        let server=tiny_http::Server::http("127.0.0.1:0").unwrap();let base=format!("http://{}/data/layer.json",server.server_addr());
        let worker=std::thread::spawn(move||{for index in 0..3{
            let request=server.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
            let header=request.headers().iter().find(|h|h.field.equiv("Authorization")).unwrap().value.as_str();
            if index==0{assert_eq!(header,"Bearer fixture-terrain-token");request.respond(tiny_http::Response::from_string(r#"{"format":"quantized-mesh-1.0","version":"2","tiles":["{z}/{x}/{y}.terrain?version={version}"]}"#)).unwrap();}
            else if index==1{assert!(request.url().contains("signed=expired"));request.respond(tiny_http::Response::from_string("private expired credential").with_status_code(401)).unwrap();}
            else{assert_eq!(header,"Bearer fixture-refreshed-token");assert!(request.url().contains("signed=fresh")&&!request.url().contains("expired"));assert!(request.url().contains("version=2"));request.respond(tiny_http::Response::from_data(vec![4,5,6])).unwrap();}
        }});
        let scene=session(format!("{base}?signed=expired"));let (bytes,_,_)=scene.fetch("capability","root","layer.json",None).await.unwrap();let value:Value=serde_json::from_slice(&bytes).unwrap();let tile=value["tiles"][0].as_str().unwrap().split('/').nth(1).unwrap();
        let resolved=std::sync::atomic::AtomicUsize::new(0);
        let actual=scene.fetch_refreshing("capability",tile,"0/0/0.terrain",None,||async{resolved.fetch_add(1,std::sync::atomic::Ordering::Relaxed);Ok(geod_tiles3d::ion::TerrainEndpoint{layer_url:format!("{base}?signed=fresh"),headers:std::collections::BTreeMap::from([("Authorization".into(),"Bearer fixture-refreshed-token".into())]),credits:vec![]})}).await.unwrap();
        assert_eq!(actual.0,vec![4,5,6]);assert_eq!(actual.2,200);assert_eq!(resolved.load(std::sync::atomic::Ordering::Relaxed),1);
        assert!(scene.replace_endpoint(geod_tiles3d::ion::TerrainEndpoint{layer_url:"https://unrelated.example/layer.json".into(),headers:Default::default(),credits:vec![]}).is_err());
        worker.join().unwrap();
    }
    #[tokio::test]
    async fn actual_native_requests_keep_signed_templates_private_and_headers_origin_scoped(){
        let root=tiny_http::Server::http("127.0.0.1:0").unwrap();let outside=tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url=format!("http://{}/data/layer.json?v=2",root.server_addr());let parent=format!("http://{}/parent/",outside.server_addr());
        let root_worker=std::thread::spawn(move||{
            for index in 0..3{let request=root.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
                assert!(request.headers().iter().any(|h|h.field.equiv("Authorization")&&h.value.as_str()=="Bearer fixture-terrain-token"));
                if index==0{request.respond(tiny_http::Response::from_string(json!({"format":"quantized-mesh-1.0","version":"1.2.0","tiles":["{z}/{x}/{y}.terrain?access_token=fixture-session"],"parentUrl":parent,"available":[]}).to_string())).unwrap();}
                else{assert!(request.url().contains("access_token=fixture-session"));assert!(request.url().contains("v=2"));assert!(request.url().contains("extensions=octvertexnormals-metadata"));
                    request.respond(if index==1{tiny_http::Response::from_data(vec![1,2,3])}else{tiny_http::Response::from_string("fixture-terrain-token").with_status_code(401)}).unwrap();}
            }
        });
        let other_worker=std::thread::spawn(move||{let request=outside.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();assert_eq!(request.url(),"/parent/layer.json");assert!(!request.headers().iter().any(|h|h.field.equiv("Authorization")||h.field.equiv("X-Private-Key")));request.respond(tiny_http::Response::from_string(r#"{"format":"heightmap-1.0","tiles":["{z}/{x}/{y}.terrain"]}"#)).unwrap();});
        let scene=session(url);let(body,metadata,status)=scene.fetch("capability","root","layer.json",None).await.unwrap();assert!(metadata);assert_eq!(status,200);
        let text=String::from_utf8(body.clone()).unwrap();assert!(!text.contains("fixture-")&&!text.contains("access_token"));let value:Value=serde_json::from_slice(&body).unwrap();
        let tile=value["tiles"][0].as_str().unwrap().split('/').nth(1).unwrap();let parent=value["parentUrl"].as_str().unwrap().split('/').nth(1).unwrap();
        let accept=Some("application/vnd.quantized-mesh;extensions=octvertexnormals-metadata,application/octet-stream".into());
        assert_eq!(scene.fetch("capability",tile,"0/0/0.terrain",accept.clone()).await.unwrap().0,vec![1,2,3]);
        assert_eq!(scene.fetch("capability",parent,"layer.json",None).await.unwrap().2,200);
        assert!(scene.fetch("capability",tile,"31/0/0.terrain",None).await.is_err());assert!(scene.fetch("capability","root","../hidden",None).await.is_err());
        let denied=scene.fetch("capability",tile,"0/1/0.terrain",accept).await.unwrap();assert_eq!(denied.2,401);assert!(denied.0.is_empty());root_worker.join().unwrap();other_worker.join().unwrap();
    }
    #[test]fn terrain_reference_rejects_credentials_in_authority_and_metadata_echo(){
        let root=Url::parse("https://assets.example/layer.json?session=private").unwrap();
        assert!(reference(&root,"https://user:password@outside.example/data").is_err());assert!(reference(&root,"http://outside.example/data").is_err());
        assert!(!reference(&root,"https://outside.example/data").unwrap().contains("session="));
        let scene=session(root.to_string());let bytes=br#"{"format":"quantized-mesh-1.0","tiles":["{z}/{x}/{y}.terrain"],"attribution":"fixture-terrain-token"}"#;
        assert!(scene.metadata("capability","root",bytes,&root).is_err());
    }
}

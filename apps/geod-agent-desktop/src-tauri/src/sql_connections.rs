//! Generic attribute databases complement the existing spatial PostgreSQL MCP.
use crate::{read_workspace, services, workspace_error, AppError, AppState};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::{Component, Path, PathBuf}};
use tauri::{AppHandle, Manager};

#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct Draft {
    pub name:String,pub kind:String,pub host:Option<String>,pub port:Option<u16>,pub database:Option<String>,pub user:Option<String>,
    pub relative_path:Option<String>, pub ssl_mode:Option<String>,#[serde(default)]pub password:String,
    pub ssl_root_cert:Option<String>,pub ssl_client_cert:Option<String>,pub ssl_client_key:Option<String>,pub ssl_client_key_password:Option<String>,#[serde(default)]pub client_certificate:bool,
}
#[derive(Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct Connection {id:String,name:String,kind:String,host:Option<String>,port:Option<u16>,database:String,user:Option<String>,relative_path:Option<String>,file_root:Option<PathBuf>,ssl_mode:String,#[serde(default)]ssl_root_cert:Option<String>,#[serde(default)]client_certificate:bool}
impl Connection {fn public(&self)->Value {json!({"id":self.id,"name":self.name,"kind":self.kind,"host":self.host,"port":self.port,"database":self.database,"user":self.user,"relativePath":self.relative_path,"sslMode":self.ssl_mode,"customCa":self.ssl_root_cert.is_some(),"clientCertificate":self.client_certificate,"readOnly":true})}}
struct Pending {root:PathBuf,id:String,committed:bool}
impl Drop for Pending {fn drop(&mut self){if !self.committed{crate::database_tls::remove(&self.root,&self.id);if let Ok(entry)=credential(&self.root,&self.id){let _=entry.delete_credential();}}}}
fn root(app:&AppHandle)->Result<PathBuf,AppError>{
    let owner=services::current_user_id(&app.state()).map_err(|_|workspace_error("AUTH_REQUIRED","请先登录 GeoD"))?;
    let path=app.path().app_data_dir().map_err(|_|workspace_error("INPUT_STORAGE_FAILED","应用目录不可用"))?.join("sql-inputs").join(format!("{:x}",Sha256::digest(owner.as_bytes())));
    fs::create_dir_all(&path).map_err(|_|workspace_error("INPUT_STORAGE_FAILED","数据库配置目录不可用"))?;Ok(path)
}
fn credential(path:&Path,id:&str)->Result<Entry,AppError>{Entry::new("GeoD-SQL-input",&format!("{}:{id}",path.file_name().unwrap().to_string_lossy())).map_err(|_|workspace_error("INPUT_CREDENTIAL_FAILED","无法访问系统凭据库"))}
fn relative_file(directory:&Path,relative:&str)->Result<PathBuf,AppError>{
    if relative.is_empty()||!Path::new(relative).components().all(|part|matches!(part,Component::Normal(_))){return Err(workspace_error("WORKSPACE_DENIED","数据库文件需要位于当前工作区"));}
    let directory=fs::canonicalize(directory).map_err(|_|workspace_error("WORKSPACE_READ_FAILED","工作区不可用"))?;
    let path=fs::canonicalize(directory.join(relative)).map_err(|_|workspace_error("INPUT_NOT_FOUND","数据库文件不存在"))?;
    if !path.starts_with(&directory)||!path.is_file()||!path.extension().is_some_and(|extension|["db","sqlite","sqlite3","gpkg"].iter().any(|name|extension.eq_ignore_ascii_case(name))){return Err(workspace_error("WORKSPACE_DENIED","请选择工作区内的 SQLite 或 GeoPackage 文件"));}Ok(path)
}
fn dsn(connection:&Connection,password:&str)->Result<String,AppError>{
    if connection.kind=="sqlite" {
        let path=relative_file(connection.file_root.as_ref().ok_or_else(||workspace_error("INPUT_INVALID","数据库工作区缺失"))?,connection.relative_path.as_deref().unwrap_or(""))?;
        // DBHub's SQLite DSN parser consumes a filesystem path rather than a
        // percent-decoded URL pathname. Remove Windows' canonical verbatim
        // prefix and preserve Unicode, spaces and literal percent characters.
        let native=path.to_string_lossy();
        let text=if let Some(unc)=native.strip_prefix(r"\\?\UNC\"){format!("//{}",unc.replace('\\',"/"))}else{native.strip_prefix(r"\\?\").unwrap_or(&native).replace('\\',"/")};
        return Ok(format!("{}{}",if text.starts_with("//"){"sqlite:////"}else if text.starts_with('/'){"sqlite://"}else{"sqlite:///"},text));
    }
    let mut url=reqwest::Url::parse(&format!("{}://localhost",connection.kind)).map_err(|_|workspace_error("INPUT_INVALID","数据库类型无效"))?;
    url.set_host(connection.host.as_deref()).map_err(|_|workspace_error("INPUT_INVALID","数据库主机无效"))?;
    url.set_port(connection.port).map_err(|_|workspace_error("INPUT_INVALID","数据库端口无效"))?;
    url.set_username(connection.user.as_deref().unwrap_or("")).map_err(|_|workspace_error("INPUT_INVALID","数据库用户名无效"))?;
    url.set_password(Some(password)).map_err(|_|workspace_error("INPUT_INVALID","数据库密码无效"))?;
    // DBHub SafeURL decodes credentials, but leaves the database path literal.
    // URL::set_path percent-encodes Unicode and would select a different database.
    if connection.database.contains(['?', '#', '\r', '\n', '\0']){return Err(workspace_error("INPUT_INVALID","数据库名称包含连接地址保留字符"));}
    // Upstream DBHub rejects verified TLS modes for several providers before
    // loading their driver. Its DSN enables encryption; the hash-pinned GeoD
    // extension applies the exact verification policy from native settings.
    let mode=if connection.ssl_mode=="disable"{"disable"}else{"require"};
    url.set_path("/");Ok(format!("{}{}?sslmode={mode}",url,connection.database))
}
async fn setup<T:Send+'static>(action:impl FnOnce()->Result<T,AppError>+Send+'static)->Result<T,AppError>{tauri::async_runtime::spawn_blocking(action).await.map_err(|_|workspace_error("INPUT_RUNTIME_FAILED","数据库操作失败"))?}
async fn session(app:&AppHandle,id:&str)->Result<crate::sql_mcp::Session,AppError>{
    let app_setup=app.clone();let id=id.to_owned();
    let (runtime,dsn,tls)=setup(move||{
        let path=root(&app_setup)?;let connection=crate::connection_registry::load::<Connection>(&path)?.into_iter().find(|item|item.id==id).ok_or_else(||workspace_error("INPUT_CONNECTION_NOT_FOUND","数据库连接不存在"))?;
        let password=zeroize::Zeroizing::new(if connection.kind=="sqlite"{String::new()}else{credential(&path,&id)?.get_password().map_err(|_|workspace_error("INPUT_CREDENTIAL_FAILED","请重新保存数据库密码"))?});
        let tls=if connection.kind=="sqlite"{None}else{Some(crate::sql_tls::prepare(&path,&id,&connection.ssl_mode,connection.ssl_root_cert.as_deref(),connection.client_certificate)?)};
        Ok((crate::sql_mcp::runtime(&app_setup)?,zeroize::Zeroizing::new(dsn(&connection,&password)?),tls))
    }).await?;
    crate::sql_mcp::Session::start(app,&runtime,&dsn,tls).await
}
#[tauri::command]
pub(crate) fn sql_connections_list(app:AppHandle)->Result<Value,AppError>{Ok(json!({"connections":crate::connection_registry::load::<Connection>(&root(&app)?)?.iter().map(Connection::public).collect::<Vec<_>>()}))}
#[tauri::command]
pub(crate) fn sql_connection_remove(app:AppHandle,connection_id:String)->Result<(),AppError>{
    let path=root(&app)?;crate::connection_registry::update::<Connection>(&path,|all|{if !all.iter().any(|item|item.id==connection_id){return Err(workspace_error("INPUT_CONNECTION_NOT_FOUND","数据库连接不存在"));}all.retain(|item|item.id!=connection_id);Ok(())})?;crate::database_tls::remove(&path,&connection_id);let _=credential(&path,&connection_id)?.delete_credential();Ok(())
}
#[tauri::command]
pub(crate) async fn sql_connection_save(app:AppHandle,conversation_id:String,mut draft:Draft)->Result<Value,AppError>{
    draft.ssl_client_key=crate::database_tls::unlock(&app,draft.ssl_client_cert.as_deref(),draft.ssl_client_key.take(),draft.ssl_client_key_password.take()).await?;
    let app_setup=app.clone();
    let (path,runtime,connection,password,connection_dsn,tls,mut pending)=setup(move||{
        if draft.name.trim().is_empty()||draft.name.chars().count()>80||!["sqlite","mysql","sqlserver","oracle"].contains(&draft.kind.as_str()){return Err(workspace_error("INPUT_INVALID","请填写连接名称和数据库类型"));}
        let workspace=read_workspace(&app_setup,&app_setup.state::<AppState>(),&app_setup.state::<services::ServiceState>(),&conversation_id)?;
        let file_root=if draft.kind=="sqlite" {let directory=fs::canonicalize(workspace.directory).map_err(|_|workspace_error("WORKSPACE_READ_FAILED","工作区不可用"))?;relative_file(&directory,draft.relative_path.as_deref().unwrap_or(""))?;Some(directory)}else{None};
        let ssl_mode=draft.ssl_mode.unwrap_or_else(||"require".into());
        if !["disable","require","verify-ca","verify-full"].contains(&ssl_mode.as_str())||draft.kind=="sqlserver"&&ssl_mode=="verify-ca"{return Err(workspace_error("INPUT_TLS_INVALID","此数据库加密模式暂未支持"));}
        let ssl_root_cert=crate::sql_tls::validate_ca(draft.ssl_root_cert.as_deref(),&ssl_mode)?;
        let client_certificate=crate::database_tls::validate(draft.ssl_client_cert.as_deref(),draft.ssl_client_key.as_deref(),&ssl_mode)?;
        if draft.kind=="sqlserver"&&client_certificate||draft.kind=="sqlite"&&(ssl_root_cert.is_some()||client_certificate)||draft.client_certificate&&!client_certificate{return Err(workspace_error("INPUT_TLS_INVALID","请为所选数据库配置有效的证书"));}
        let port=draft.port.unwrap_or(match draft.kind.as_str(){"mysql"=>3306,"sqlserver"=>1433,"oracle"=>1521,_=>0});
        let database=if draft.kind=="sqlite"{draft.relative_path.clone().unwrap_or_default()}else{draft.database.unwrap_or_default()};
        if draft.kind!="sqlite"&&(draft.host.as_deref().unwrap_or("").is_empty()||draft.user.as_deref().unwrap_or("").is_empty()||database.is_empty()||port==0){return Err(workspace_error("INPUT_INVALID","请填写主机、数据库和用户名"));}
        if database.len()>4096||draft.password.len()>8192||draft.user.as_ref().is_some_and(|value|value.len()>512)||draft.host.as_ref().is_some_and(|value|value.len()>255){return Err(workspace_error("INPUT_INVALID","数据库连接参数过长"));}
        let connection=Connection{id:uuid::Uuid::new_v4().to_string(),name:draft.name.trim().into(),kind:draft.kind,host:draft.host,port:Some(port),database,user:draft.user,relative_path:draft.relative_path,file_root,ssl_mode,ssl_root_cert,client_certificate};
        let password=zeroize::Zeroizing::new(draft.password);let connection_dsn=zeroize::Zeroizing::new(dsn(&connection,&password)?);
        let path=root(&app_setup)?;let pending=Pending{root:path.clone(),id:connection.id.clone(),committed:false};
        if client_certificate{crate::database_tls::save(&path,&connection.id,draft.ssl_client_cert.unwrap(),draft.ssl_client_key.unwrap())?;}
        let tls=if connection.kind=="sqlite"{None}else{Some(crate::sql_tls::prepare(&path,&connection.id,&connection.ssl_mode,connection.ssl_root_cert.as_deref(),client_certificate)?)};
        Ok((path,crate::sql_mcp::runtime(&app_setup)?,connection,password,connection_dsn,tls,pending))
    }).await?;
    let tested=async {
        let mut process=crate::sql_mcp::Session::start(&app,&runtime,&connection_dsn,tls).await?;
        let tables=process.call("search_objects",json!({"object_type":"table","detail_level":"names","limit":100})).await?;
        Ok::<_,AppError>((tables,process.metadata()))
    }.await;
    let (tables,mcp)=match tested{Ok(result)=>result,Err(error)=>return Ok(json!({"error":error,"authentication":if ["INPUT_AUTH_REQUIRED","INPUT_TLS_FAILED"].contains(&error.code) {Some(json!({"name":connection.name,"kind":connection.kind,"host":connection.host,"port":connection.port,"database":connection.database,"user":connection.user,"relativePath":connection.relative_path,"sslMode":connection.ssl_mode,"sslRootCert":connection.ssl_root_cert,"clientCertificate":connection.client_certificate}))}else{None}}))};
    let public=connection.public();
    pending=setup(move||{
        if connection.kind!="sqlite"{credential(&path,&connection.id)?.set_password(&password).map_err(|_|workspace_error("INPUT_CREDENTIAL_FAILED","数据库密码未能保存到系统凭据库"))?;}
        crate::connection_registry::update(&path,|all:&mut Vec<Connection>|{if all.len()>=200{return Err(workspace_error("INPUT_TOO_LARGE","已保存的数据库连接超过上限"));}all.push(connection.clone());Ok(())})?;pending.committed=true;Ok(pending)
    }).await?;
    drop(pending);
    Ok(json!({"connection":public,"catalog":tables,"mcp":mcp,"readOnly":true,"untrustedContent":true}))
}
#[tauri::command]
pub(crate) async fn sql_connection_connect(app:AppHandle,conversation_id:String,request:Value)->Result<Value,AppError>{
    if !request.is_object(){return Err(workspace_error("INPUT_INVALID","连接参数需要 JSON 对象"));}
    let app_setup=app.clone();let conversation=conversation_id.clone();
    let draft=setup(move||{
        let mut value=if let Some(relative)=request["credentialFile"].as_str(){
            if !Path::new(relative).components().all(|part|matches!(part,Component::Normal(_))){return Err(workspace_error("WORKSPACE_DENIED","连接配置需要位于当前工作区"));}
            let workspace=read_workspace(&app_setup,&app_setup.state(),&app_setup.state(),&conversation)?;
            let directory=fs::canonicalize(workspace.directory).map_err(|_|workspace_error("WORKSPACE_READ_FAILED","工作区不可用"))?;let file=fs::canonicalize(directory.join(relative)).map_err(|_|workspace_error("INPUT_NOT_FOUND","连接配置不存在"))?;
            if !file.starts_with(&directory)||fs::metadata(&file).map(|metadata|metadata.len()>1024*1024).unwrap_or(true){return Err(workspace_error("WORKSPACE_DENIED","连接配置超出工作区或过大"));}
            serde_json::from_slice::<Value>(&fs::read(file).map_err(|_|workspace_error("INPUT_READ_FAILED","连接配置不可读"))?).map_err(|_|workspace_error("INPUT_INVALID","连接配置需要有效 JSON"))?
        }else{let mut value=request;value["password"]=json!("");value["sslClientCert"]=Value::Null;value["sslClientKey"]=Value::Null;value["sslClientKeyPassword"]=Value::Null;value};
        if !value.is_object(){return Err(workspace_error("INPUT_INVALID","连接参数需要 JSON 对象"));}
        if value.get("name").is_none(){value["name"]=value.get("database").or_else(||value.get("relativePath")).cloned().unwrap_or(json!("数据库"));}
        serde_json::from_value::<Draft>(value).map_err(|_|workspace_error("INPUT_INVALID","请提供数据库类型及连接信息"))
    }).await?;
    let authentication=json!({"name":draft.name,"kind":draft.kind,"host":draft.host,"port":draft.port,"database":draft.database,"user":draft.user,"relativePath":draft.relative_path,"sslMode":draft.ssl_mode,"sslRootCert":draft.ssl_root_cert,"clientCertificate":draft.ssl_client_cert.is_some()||draft.client_certificate});
    match sql_connection_save(app,conversation_id,draft).await{
        Ok(value)=>Ok(value),
        Err(error)if crate::database_tls::requires_local_input(&error)=>Ok(json!({"error":error,"authentication":authentication,"readOnly":true})),
        Err(error)=>Err(error),
    }
}
#[tauri::command]
pub(crate) async fn sql_objects_search(app:AppHandle,connection_id:String,request:Value)->Result<Value,AppError>{
    let args=json!({"object_type":request.get("objectType").cloned().unwrap_or(json!("table")),"pattern":request.get("pattern").cloned().unwrap_or(json!("%")),"detail_level":request.get("detailLevel").cloned().unwrap_or(json!("names")),"limit":request.get("limit").cloned().unwrap_or(json!(100))});
    let mut args=args;for key in ["schema","table"] {if let Some(value)=request.get(key){args[key]=value.clone();}}
    let mut process=session(&app,&connection_id).await?;let result=process.call("search_objects",args).await?;Ok(json!({"result":result,"mcp":process.metadata(),"untrustedContent":true}))
}
#[tauri::command]
pub(crate) async fn sql_query(app:AppHandle,connection_id:String,sql:String)->Result<Value,AppError>{
    if sql.trim().is_empty()||sql.len()>32*1024||sql.contains('\0'){return Err(workspace_error("INPUT_INVALID","SQL 为空或过长"));}
    let mut process=session(&app,&connection_id).await?;let result=process.call("execute_sql",json!({"sql":sql})).await?;
    Ok(json!({"result":result,"mcp":process.metadata(),"readOnly":true,"untrustedContent":true}))
}

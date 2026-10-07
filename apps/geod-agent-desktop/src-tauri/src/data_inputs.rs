use crate::{boundary_inspect, network, read_workspace, services, workspace_error, AppError, AppState};
use base64::Engine;
use keyring::Entry;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::{Component, Path}, process::Stdio, time::Duration};
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const EXTENSIONS: &[&str] = &["geojson", "json", "shp", "shx", "dbf", "prj", "cpg", "zip", "gpkg", "sqlite", "db", "kml", "kmz", "gml", "fgb", "gpx", "wkt", "csv"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputFile { name: String, base64: String }

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InputRequest {
    files: Option<Vec<InputFile>>, url: Option<String>, relative_path: Option<String>,
    connection_id: Option<String>, handle: Option<String>, layer: Option<String>, source_crs: Option<String>,
    online_connection_id: Option<String>, bounds: Option<[f64;4]>, max_features: Option<usize>, page_size: Option<usize>,
    filters: Option<Vec<crate::database_query::Filter>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConnection {
    id: String, name: String, host: String, port: u16, database: String, user: String, ssl_mode: String,
    database_type: Option<String>,
    ssl_root_cert_path: Option<String>,
    #[serde(default)]
    client_certificate: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDraft { name: String, host: String, port: u16, database: String, user: String, password: String, ssl_mode: String, ssl_root_cert: Option<String>, ssl_client_cert: Option<String>, ssl_client_key: Option<String>,ssl_client_key_password:Option<String>,ssl_client_bundle:Option<String> }

fn input_root(app: &AppHandle, services: &services::ServiceState) -> Result<std::path::PathBuf, AppError> {
    let user = services::current_user_id(services).map_err(|_| workspace_error("AUTH_REQUIRED", "请先登录 GeoD"))?;
    use sha2::{Digest, Sha256};
    let root = app.path().app_data_dir().map_err(|_| workspace_error("INPUT_STORAGE_FAILED", "无法读取应用目录"))?
        .join("data-inputs").join(format!("{:x}", Sha256::digest(user.as_bytes())));
    fs::create_dir_all(&root).map_err(|_| workspace_error("INPUT_STORAGE_FAILED", "无法创建数据输入目录"))?;
    crate::database_tls::cleanup(&root);
    Ok(root)
}

async fn blocking_input_setup<T: Send + 'static>(setup: impl FnOnce() -> Result<T, AppError> + Send + 'static) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(setup).await
        .map_err(|_| workspace_error("INPUT_READ_FAILED", "数据输入初始化线程中断"))?
}

fn connections(root: &Path) -> Result<Vec<DatabaseConnection>, AppError> {
    crate::connection_registry::load(root)
}

fn credential(root: &Path, id: &str) -> Result<Entry, AppError> {
    let account = format!("{}:{id}", root.file_name().unwrap().to_string_lossy());
    Entry::new("GeoD-data-input-postgis", &account).map_err(|_| workspace_error("INPUT_CREDENTIAL_FAILED", "无法访问系统凭据库"))
}

fn database_value(root: &Path, connection: &DatabaseConnection, password: String) -> Value {
    let mut value = serde_json::to_value(connection).unwrap();
    value["password"] = json!(password);
    if connection.client_certificate { value["tlsRoot"] = json!(root.to_string_lossy()); }
    value
}
struct PendingConnection { root: std::path::PathBuf, id: String, committed: bool }
impl Drop for PendingConnection {
    fn drop(&mut self) {
        if self.committed { return; }
        crate::database_tls::remove(&self.root, &self.id);
        let _ = fs::remove_file(self.root.join("certificates").join(format!("{}.pem", self.id)));
        if let Ok(entry) = credential(&self.root, &self.id) { let _ = entry.delete_credential(); }
    }
}

async fn worker(request: Value) -> Result<Value, AppError> {
    let basic=request["paths"].as_array().is_some_and(|paths|paths.iter().all(|v|v.as_str().is_some_and(|name|matches!(Path::new(name).extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase().as_str(),"geojson"|"json")))) && request["sourceCrs"].as_str().is_none_or(|s|matches!(s,"EPSG:4326"|"OGC:CRS84"));
    let mut command = if basic {crate::python_runtime::command(include_str!("data_input_worker.py"))?}else{crate::python_runtime::gis_command(include_str!("data_input_worker.py"),&["gis-common","gis-vector"])?};
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)] command.creation_flags(0x08000000);
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] { command.env_remove(key); }
    if let Some(proxy) = network::proxy_for("https://pypi.org").map_err(|e| workspace_error("INPUT_NETWORK_FAILED", e))? {
        command.env("HTTP_PROXY", &proxy).env("HTTPS_PROXY", &proxy);
    }
    let mut child = command.spawn().map_err(|_| workspace_error("INPUT_RUNTIME_MISSING", "无法启动内置数据运行环境，请修复应用"))?;
    let bytes = serde_json::to_vec(&request).map_err(|_| workspace_error("INPUT_INVALID", "数据输入参数无效"))?;
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(&bytes).await.map_err(|_| workspace_error("INPUT_READ_FAILED", "数据读取进程已退出"))?;
    drop(stdin);
    let output = tokio::time::timeout(Duration::from_secs(180), child.wait_with_output()).await
        .map_err(|_| workspace_error("INPUT_TIMEOUT", "读取超过 180 秒，请检查网络或缩小数据范围"))?
        .map_err(|_| workspace_error("INPUT_READ_FAILED", "数据读取进程失败"))?;
    if !output.status.success() || output.stdout.len() > geod_core::boundary::MAX_GEOJSON_BYTES + 65536 { return Err(workspace_error("INPUT_READ_FAILED", "数据读取进程失败或结果过大")); }
    serde_json::from_slice(&output.stdout).map_err(|_| workspace_error("INPUT_READ_FAILED", "数据读取返回无效结果"))
}

#[tauri::command]
pub fn data_connections_list(app: AppHandle, services: State<'_, services::ServiceState>) -> Result<Vec<DatabaseConnection>, AppError> {
    connections(&input_root(&app, &services)?)
}

#[tauri::command]
pub async fn data_connection_save(app: AppHandle, mut draft: DatabaseDraft) -> Result<Value, AppError> {
    if draft.name.is_empty() || draft.name.len() > 80 || draft.host.is_empty() || draft.host.len() > 255 || draft.database.is_empty() || draft.user.is_empty() || draft.port == 0 || !["disable", "prefer", "require", "verify-ca", "verify-full"].contains(&draft.ssl_mode.as_str()) {
        return Err(workspace_error("INPUT_INVALID", "请填写完整的 PostgreSQL 连接信息"));
    }
    (draft.ssl_client_cert,draft.ssl_client_key)=crate::database_tls::normalize(&app,draft.ssl_client_cert.take(),draft.ssl_client_key.take(),draft.ssl_client_bundle.take(),draft.ssl_client_key_password.take()).await?;
    let client_certificate = crate::database_tls::validate(draft.ssl_client_cert.as_deref(), draft.ssl_client_key.as_deref(), &draft.ssl_mode)?;
    // Authentication may refresh a token with the synchronous HTTP client.
    // Keep it off the async runtime so expiry cannot panic or poison its lock.
    let setup_app = app.clone();
    let root = blocking_input_setup(move || {
        input_root(&setup_app, &setup_app.state::<services::ServiceState>())
    }).await?;
    let mut connection = DatabaseConnection { id: Uuid::new_v4().to_string(), name: draft.name, host: draft.host, port: draft.port, database: draft.database, user: draft.user, ssl_mode: draft.ssl_mode, database_type: None,ssl_root_cert_path:None,client_certificate };
    let mut pending = PendingConnection { root: root.clone(), id: connection.id.clone(), committed: false };
    if let Some(pem)=draft.ssl_root_cert.filter(|value|!value.trim().is_empty()) {
        if pem.len()>256*1024||pem.contains("PRIVATE KEY")||reqwest::Certificate::from_pem_bundle(pem.as_bytes()).map(|v|v.is_empty()).unwrap_or(true){return Err(workspace_error("INPUT_TLS_INVALID","请选择有效的 CA 证书 PEM 文件"));}
        let folder=root.join("certificates");fs::create_dir_all(&folder).map_err(|_|workspace_error("INPUT_STORAGE_FAILED","证书保存失败"))?;
        let path=folder.join(format!("{}.pem",connection.id));fs::write(&path,pem).map_err(|_|workspace_error("INPUT_STORAGE_FAILED","证书保存失败"))?;
        connection.ssl_root_cert_path=Some(path.to_string_lossy().into_owned());
    }
    if client_certificate { crate::database_tls::save(&root, &connection.id, draft.ssl_client_cert.unwrap(), draft.ssl_client_key.unwrap())?; }
    let db = database_value(&root, &connection, draft.password);
    let result = crate::postgis_mcp::request(&app, &db, None, None).await;
    if result.get("error").is_some() { return Ok(result); }
    connection.database_type = result["databaseType"].as_str().map(str::to_owned);
    credential(&root, &connection.id)?.set_password(db["password"].as_str().unwrap()).map_err(|_| workspace_error("INPUT_CREDENTIAL_FAILED", "密码未能保存到 Windows 凭据库"))?;
    crate::connection_registry::update(&root,|all|{all.push(connection.clone());Ok(())})?;
    pending.committed = true;
    Ok(json!({"connection": connection, "layers": result["layers"], "tables": result["tables"], "databaseType": result["databaseType"], "readOnly": true, "mcp": result["mcp"]}))
}

#[tauri::command]
pub async fn data_connection_connect(app: AppHandle, conversation_id: String, request: Value) -> Result<Value, AppError> {
    if !request.is_object() { return Err(workspace_error("INPUT_INVALID", "连接参数需要 JSON 对象")); }
    let setup_app = app.clone();
    let draft = blocking_input_setup(move || {
        let mut value = if let Some(relative) = request["credentialFile"].as_str() {
            if !Path::new(relative).components().all(|c| matches!(c, Component::Normal(_))) {
                return Err(workspace_error("WORKSPACE_DENIED", "连接配置文件需要位于当前工作区"));
            }
            let workspace = read_workspace(&setup_app, &setup_app.state::<AppState>(), &setup_app.state::<services::ServiceState>(), &conversation_id)?;
            let root = fs::canonicalize(workspace.directory).map_err(|_| workspace_error("WORKSPACE_READ_FAILED", "工作区不可用"))?;
            let path = fs::canonicalize(root.join(relative)).map_err(|_| workspace_error("INPUT_NOT_FOUND", "连接配置文件不存在"))?;
            if !path.starts_with(&root) || fs::metadata(&path).map(|m| m.len() > 512 * 1024).unwrap_or(true) {
                return Err(workspace_error("WORKSPACE_DENIED", "连接配置文件超出工作区或过大"));
            }
            let mut value: Value = serde_json::from_slice(&fs::read(path).map_err(|_| workspace_error("INPUT_READ_FAILED", "连接配置文件读取失败"))?)
                .map_err(|_| workspace_error("INPUT_INVALID", "连接配置需要有效的 JSON"))?;
            if !value.is_object() { return Err(workspace_error("INPUT_INVALID", "连接配置需要 JSON 对象")); }
            if let Some(name) = request["name"].as_str() { value["name"] = json!(name); }
            value
        } else {
            let mut value = request;
            // Model arguments never supply a plaintext password. Authentication
            // is read from the named local file or entered in the native form.
            value["password"] = json!("");
            value["sslClientCert"] = Value::Null;
            value["sslClientKey"] = Value::Null;
            value["sslClientKeyPassword"] = Value::Null;
            value["sslClientBundle"] = Value::Null;
            value
        };
        if !value.is_object() { return Err(workspace_error("INPUT_INVALID", "连接配置需要 JSON 对象")); }
        if value.get("port").is_none() { value["port"] = json!(5432); }
        if value.get("sslMode").is_none() { value["sslMode"] = json!("prefer"); }
        if value.get("password").is_none() { value["password"] = json!(""); }
        if value.get("name").is_none() { value["name"] = value["database"].clone(); }
        serde_json::from_value::<DatabaseDraft>(value).map_err(|_| workspace_error("INPUT_INVALID", "请提供主机、数据库和用户名等连接信息"))
    }).await?;
    let authentication = json!({"name": draft.name, "host": draft.host, "port": draft.port, "database": draft.database, "user": draft.user, "sslMode": draft.ssl_mode,"sslRootCert":draft.ssl_root_cert,"clientCertificate":draft.ssl_client_cert.is_some()||draft.ssl_client_bundle.is_some()});
    let result = match data_connection_save(app, draft).await{
        Ok(value)=>value,
        Err(error)if crate::database_tls::requires_local_input(&error)=>return Ok(json!({"error":error,"authentication":authentication,"readOnly":true})),
        Err(error)=>return Err(error),
    };
    // Hosts and credentials stay native; the Agent uses the returned stable ID.
    Ok(json!({"connection": result.get("connection").map(|c| json!({"id": c["id"], "name": c["name"], "type": c["databaseType"], "readOnly": true})), "layers": result.get("layers"), "tables": result.get("tables"), "error": result.get("error"), "authentication": if result["error"]["code"] == "INPUT_AUTH_REQUIRED" { Some(authentication) } else { None }, "readOnly": true, "mcp": result.get("mcp")}))
}

#[tauri::command]
pub async fn data_layer_inspect(app: AppHandle, connection_id: String, layer: String, limit: Option<u32>, selection: Option<crate::database_query::Selection>) -> Result<Value, AppError> {
    let setup_app = app.clone();
    let root = blocking_input_setup(move || input_root(&setup_app, &setup_app.state::<services::ServiceState>())).await?;
    let connection = connections(&root)?.into_iter().find(|c| c.id == connection_id).ok_or_else(|| workspace_error("INPUT_CONNECTION_NOT_FOUND", "数据库连接不存在"))?;
    let password = credential(&root, &connection_id)?.get_password().map_err(|_| workspace_error("INPUT_CREDENTIAL_FAILED", "请重新保存数据库连接密码"))?;
    let database = database_value(&root, &connection, password);
    Ok(crate::postgis_mcp::request_filtered(&app, &database, Some(&layer), Some(limit.unwrap_or(5)),selection.unwrap_or_default()).await)
}

#[tauri::command]
pub fn data_connection_remove(app: AppHandle, services: State<'_, services::ServiceState>, connection_id: String) -> Result<(), AppError> {
    let root = input_root(&app, &services)?;
    let mut certificate=None;
    crate::connection_registry::update::<DatabaseConnection>(&root,|all|{let connection=all.iter().find(|c|c.id==connection_id).ok_or_else(||workspace_error("INPUT_CONNECTION_NOT_FOUND","连接不存在"))?;certificate=connection.ssl_root_cert_path.clone();all.retain(|c|c.id!=connection_id);Ok(())})?;
    if let Some(path)=certificate {let expected=root.join("certificates").join(format!("{connection_id}.pem"));if Path::new(&path)==expected {let _=fs::remove_file(path);}}
    crate::database_tls::remove(&root, &connection_id);
    let _ = credential(&root, &connection_id)?.delete_credential();
    Ok(())
}

#[tauri::command]
pub async fn data_input_read(app: AppHandle, conversation_id: String, request: InputRequest) -> Result<Value, AppError> {
    let setup_app = app.clone();
    let (workspace, root) = blocking_input_setup(move || {
        let state = setup_app.state::<AppState>();
        let services = setup_app.state::<services::ServiceState>();
        Ok::<_, AppError>((read_workspace(&setup_app, &state, &services, &conversation_id)?, input_root(&setup_app, &services)?))
    }).await?;
    let selectors = [request.files.is_some(), request.url.is_some(), request.relative_path.is_some(), request.connection_id.is_some(), request.handle.is_some(),request.online_connection_id.is_some()];
    if selectors.into_iter().filter(|v| *v).count() != 1 { return Err(workspace_error("INPUT_INVALID", "每次请选择一个文件组、网址或数据库来源")); }
    let mut payload = json!({"layer": request.layer, "sourceCrs": request.source_crs});
    let mut online_info=None;
    if let Some(id) = request.connection_id {
        let connection = connections(&root)?.into_iter().find(|c| c.id == id).ok_or_else(|| workspace_error("INPUT_CONNECTION_NOT_FOUND", "数据库连接不存在"))?;
        let password = credential(&root, &id)?.get_password().map_err(|_| workspace_error("INPUT_CREDENTIAL_FAILED", "请重新保存数据库连接密码"))?;
        let database = database_value(&root, &connection, password);
        let selection=crate::database_query::Selection{filters:request.filters.unwrap_or_default(),bounds:request.bounds,max_features:request.max_features.map(|n|n as u64)};
        let mut result = crate::postgis_mcp::request_filtered(&app, &database, request.layer.as_deref(), None,selection).await;
        if let Some(geojson) = result.as_object_mut().unwrap().remove("geojson") {
            result["boundary"] = serde_json::to_value(boundary_inspect(format!("{}.geojson", result["selectedLayer"].as_str().unwrap_or("database")), geojson.to_string())?).unwrap();
        }
        return Ok(result);
    }
    if request.filters.is_some() {return Err(workspace_error("INPUT_FILTER_INVALID","属性筛选当前需要已保存的数据库连接"));}
    let handle = request.handle.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
    Uuid::parse_str(&handle).map_err(|_| workspace_error("INPUT_INVALID", "数据输入标识无效"))?;
    let folder = root.join(&handle);
    if request.handle.is_none() {
        fs::create_dir_all(&folder).map_err(|_| workspace_error("INPUT_STORAGE_FAILED", "数据暂存失败"))?;
        let mut files: Vec<(String, Vec<u8>)> = vec![];
        if let Some(input) = request.files {
            if input.is_empty() || input.len() > 32 { return Err(workspace_error("INPUT_INVALID", "请选择 1 至 32 个数据文件")); }
            for file in input {
                if file.base64.len() > MAX_BYTES * 4 / 3 + 4 { return Err(workspace_error("INPUT_TOO_LARGE", "输入文件超过 32 MiB")); }
                let bytes = base64::engine::general_purpose::STANDARD.decode(file.base64).map_err(|_| workspace_error("INPUT_INVALID", "文件内容无效"))?;
                files.push((file.name, bytes));
            }
        }
        if let Some(relative) = request.relative_path {
            if !Path::new(&relative).components().all(|c| matches!(c, Component::Normal(_))) { return Err(workspace_error("WORKSPACE_DENIED", "请选择工作区内的相对文件名")); }
            let workspace = fs::canonicalize(workspace.directory).map_err(|_| workspace_error("WORKSPACE_READ_FAILED", "工作区不可用"))?;
            let path = fs::canonicalize(workspace.join(relative)).map_err(|_| workspace_error("WORKSPACE_READ_FAILED", "文件不存在"))?;
            if !path.starts_with(&workspace) || fs::metadata(&path).map(|m| m.len() > MAX_BYTES as u64).unwrap_or(true) { return Err(workspace_error("WORKSPACE_DENIED", "文件超出工作区或超过 32 MiB")); }
            files.push((path.file_name().unwrap().to_string_lossy().into_owned(), fs::read(&path).map_err(|_| workspace_error("INPUT_READ_FAILED", "文件读取失败"))?));
            if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("shp")) {
                for ext in ["shx", "dbf", "prj", "cpg"] { let side = path.with_extension(ext); if side.is_file() { files.push((side.file_name().unwrap().to_string_lossy().into_owned(), fs::read(&side).map_err(|_| workspace_error("INPUT_READ_FAILED", "配套文件读取失败"))?)); } }
            }
        }
        if request.url.is_some() || request.online_connection_id.is_some() {
            let options=crate::online_inputs::ReadOptions{bounds:request.bounds,max_features:request.max_features,page_size:request.page_size};
            let (name,bytes,info)=crate::online_inputs::read(&app,request.url,request.online_connection_id,request.layer.as_deref(),options).await?;
            // Service layer IDs choose a remote resource, not a GDAL layer name.
            if info["remoteLayer"]==true {payload["layer"]=Value::Null;}
            online_info=Some(info);files.push((name,bytes));
        }
        if files.iter().map(|(_, b)| b.len()).sum::<usize>() > MAX_BYTES { return Err(workspace_error("INPUT_TOO_LARGE", "文件组超过 32 MiB")); }
        let mut names = vec![];
        for (name, bytes) in files {
            let path = Path::new(&name);
            if name.len() > 180 || name.contains(['/', '\\', ':']) || !path.components().all(|c| matches!(c, Component::Normal(_))) || !EXTENSIONS.contains(&path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str()) || names.contains(&name) { return Err(workspace_error("INPUT_FORMAT_UNSUPPORTED", "文件名、格式或配套文件组无效")); }
            fs::write(folder.join(&name), bytes).map_err(|_| workspace_error("INPUT_STORAGE_FAILED", "暂存文件写入失败"))?; names.push(name);
        }
        fs::write(folder.join("input-manifest.json"), serde_json::to_vec(&names).unwrap()).map_err(|_| workspace_error("INPUT_STORAGE_FAILED", "暂存记录写入失败"))?;
        if let Some(info)=&online_info{fs::write(folder.join("online-info.json"),serde_json::to_vec(info).unwrap()).map_err(|_|workspace_error("INPUT_STORAGE_FAILED","在线来源记录保存失败"))?;}
    }
    if online_info.is_none(){online_info=fs::read(folder.join("online-info.json")).ok().map(|bytes|serde_json::from_slice(&bytes).map_err(|_|workspace_error("INPUT_STORAGE_FAILED","在线来源记录无效"))).transpose()?;}
    if online_info.as_ref().is_some_and(|v|v["remoteLayer"]==true){if let Some(layer)=request.layer.as_deref(){if online_info.as_ref().and_then(|v|v["sourceLayer"].as_str()).is_some_and(|saved|saved!=layer){return Err(workspace_error("INPUT_LAYER_NOT_FOUND","此数据输入中没有所选在线图层"));}}payload["layer"]=Value::Null;}
    let names: Vec<String> = serde_json::from_slice(&fs::read(folder.join("input-manifest.json")).map_err(|_| workspace_error("INPUT_NOT_FOUND", "数据输入不存在，请重新添加"))?).map_err(|_| workspace_error("INPUT_INVALID", "数据输入记录无效"))?;
    payload["paths"] = json!(names.iter().map(|n| folder.join(n).to_string_lossy().into_owned()).collect::<Vec<_>>());
    let mut result = worker(payload).await?;
    if let Some(info)=online_info {
        if let Some(layer)=info["sourceLayer"].as_str(){result["storageLayer"]=result["selectedLayer"].clone();result["selectedLayer"]=json!(layer);if let Some(layers)=result["layers"].as_array_mut(){if layers.len()==1{layers[0]["name"]=json!(layer);layers[0]["title"]=info["sourceName"].clone();}}}
        result["online"]=info;
    }
    result["handle"] = json!(handle);
    if let Some(geojson) = result.as_object_mut().unwrap().remove("geojson") {
        result["boundary"] = serde_json::to_value(boundary_inspect(format!("{}.geojson", result["selectedLayer"].as_str().unwrap_or("boundary")), geojson.to_string())?).unwrap();
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocking_auth_client_lifecycle_is_safe_inside_async_input() {
        tauri::async_runtime::block_on(async {
            tauri::async_runtime::spawn(async {
                blocking_input_setup(|| {
                    // The token refresh client's construction/drop panics when
                    // done directly on the async worker, even without a request.
                    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
                    drop(client);
                    Ok(())
                }).await
            }).await.unwrap().unwrap();
        });
    }
}

//! Three-dimensional service profiles. SQLite contains public metadata and
//! credential references only; all token/header values stay in Windows Vault.
use crate::{network, services, workspace_error, AppError, AppState};
use keyring::Entry;
use rusqlite::{params, Connection as Db, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

static GATE: Mutex<()> = Mutex::new(());
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionDraft {
    pub name: String,
    pub kind: String,
    pub tileset_url: Option<String>,
    pub asset_id: Option<u64>,
    #[serde(default)]
    pub required_headers: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Connection {
    pub id: String,
    pub revision: String,
    pub name: String,
    pub kind: String,
    pub tileset_url: Option<String>,
    pub asset_id: Option<u64>,
    pub required_headers: Vec<String>,
    pub credential_ready: bool,
}
impl Connection {
    pub(crate) fn source_url(&self) -> String {
        self.tileset_url.clone().unwrap_or_else(|| {
            format!(
                "https://api.cesium.com/v1/assets/{}/endpoint",
                self.asset_id.unwrap_or(0)
            )
        })
    }
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Secrets {
    token: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}
pub(crate) struct ResolvedCredential {
    pub connection: Connection,
    secrets: Secrets,
}
impl ResolvedCredential {
    pub(crate) async fn resolve_terrain(self, asset_id: Option<u64>, proxy: Option<&str>) -> Result<geod_tiles3d::ion::TerrainEndpoint, String> {
        if self.connection.kind != "cesiumIon" { return Err("请使用已保存的 Cesium Ion 连接加载 Ion 地形".into()); }
        let mut endpoint = geod_tiles3d::ion::resolve_terrain(asset_id.or(self.connection.asset_id).unwrap_or(0), self.secrets.token.as_deref().unwrap_or(""), proxy).await?;
        for (key, value) in self.secrets.headers { if !key.eq_ignore_ascii_case("authorization") { endpoint.headers.insert(key, value); } }
        Ok(endpoint)
    }
    pub(crate) async fn resolve(
        self,
        proxy: Option<&str>,
    ) -> Result<geod_tiles3d::ion::ResolvedEndpoint, String> {
        if self.connection.kind == "cesiumIon" {
            let mut endpoint = geod_tiles3d::ion::resolve(
                self.connection.asset_id.unwrap_or(0),
                self.secrets.token.as_deref().unwrap_or(""),
                proxy,
            )
            .await?;
            // The Ion-issued endpoint token is authoritative, not an account token
            // or a caller-supplied Authorization header.
            for (key, value) in self.secrets.headers {
                if !key.eq_ignore_ascii_case("authorization") {
                    endpoint.headers.insert(key, value);
                }
            }
            Ok(endpoint)
        } else {
            Ok(geod_tiles3d::ion::ResolvedEndpoint {
                tileset_url: self.connection.source_url(),
                headers: self.secrets.headers,
                inherit_query: false,
            })
        }
    }
}
fn error(message: impl Into<String>) -> AppError {
    workspace_error("DATA_CONNECTION_INVALID", message)
}
fn storage(_: impl std::fmt::Display) -> AppError {
    workspace_error("DATA_CONNECTION_STORAGE", "三维连接配置暂不可用")
}
fn db(path: &Path) -> Result<Db, AppError> {
    let db = Db::open(path).map_err(storage)?;
    db.busy_timeout(Duration::from_secs(10)).map_err(storage)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS tiles3d_connections(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,profile_json TEXT NOT NULL,secret_ref TEXT);
        CREATE INDEX IF NOT EXISTS tiles3d_connections_owner ON tiles3d_connections(owner_id);").map_err(storage)?;
    Ok(db)
}
fn entry(path: &Path, owner: &str, reference: &str) -> Result<Entry, AppError> {
    Uuid::parse_str(reference).map_err(|_| error("凭证引用无效"))?;
    let account = format!(
        "{:x}:{reference}",
        Sha256::digest(format!("{}:{owner}", path.to_string_lossy()))
    );
    Entry::new("GeoD-data-tiles3d", &account)
        .map_err(|_| workspace_error("DATA_CREDENTIAL_STORE", "无法打开本机凭据库"))
}
fn user(services: &services::ServiceState) -> Result<String, AppError> {
    services::current_user_id(services)
        .map_err(|_| workspace_error("AUTH_REQUIRED", "请先登录 GeoD"))
}
fn header_name(value: &str) -> Result<String, AppError> {
    if value.chars().any(char::is_control) {
        return Err(error("请求头名称无效"));
    }
    let name = reqwest::header::HeaderName::from_bytes(value.trim().as_bytes())
        .map_err(|_| error("请求头名称无效"))?;
    if matches!(
        name.as_str(),
        "host"
            | "content-length"
            | "connection"
            | "transfer-encoding"
            | "proxy-authorization"
            | "proxy-connection"
    ) {
        return Err(error("此请求头由应用管理，请使用服务需要的认证头"));
    }
    Ok(name.to_string())
}
fn public_url(value: &str) -> Result<String, AppError> {
    let url = reqwest::Url::parse(value).map_err(|_| error("请输入有效的三维服务地址"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url
            .query_pairs()
            .any(|(key, _)| geod_core::imagery::is_secret_parameter(&key))
    {
        return Err(error(
            "请输入 HTTPS 地址；Key、Token 和认证信息请填入凭证字段",
        ));
    }
    Ok(url.to_string())
}
fn normalize(mut draft: ConnectionDraft) -> Result<ConnectionDraft, AppError> {
    draft.name = draft.name.trim().into();
    if draft.name.is_empty() || draft.name.len() > 160 || draft.name.chars().any(char::is_control) {
        return Err(error("请输入连接名称"));
    }
    match draft.kind.as_str() {
        "direct" => {
            draft.tileset_url = Some(public_url(draft.tileset_url.as_deref().unwrap_or(""))?);
            draft.asset_id = None;
        }
        "cesiumIon" => {
            if draft.asset_id.unwrap_or(0) == 0 {
                return Err(error("请输入 Cesium Ion Asset ID"));
            }
            draft.tileset_url = None;
        }
        _ => return Err(error("请选择三维连接类型")),
    }
    if draft.required_headers.len() > 32 {
        return Err(error("最多可配置 32 个请求头"));
    }
    draft.required_headers = draft
        .required_headers
        .iter()
        .map(|name| header_name(name))
        .collect::<Result<_, _>>()?;
    draft.required_headers.sort();
    draft.required_headers.dedup();
    if draft.kind == "cesiumIon" && draft.required_headers.iter().any(|h| h == "authorization") {
        return Err(error("Cesium Ion 的认证头由 Access Token 自动生成"));
    }
    Ok(draft)
}
fn get(db: &Db, owner: &str, id: &str) -> Result<(Connection, Option<String>), AppError> {
    let row: Option<(String, Option<String>)> = db
        .query_row(
            "SELECT profile_json,secret_ref FROM tiles3d_connections WHERE owner_id=?1 AND id=?2",
            params![owner, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(storage)?;
    let (profile, secret) = row.ok_or_else(|| {
        workspace_error(
            "DATA_CONNECTION_NOT_FOUND",
            "三维连接不存在或不属于当前账号",
        )
    })?;
    Ok((serde_json::from_str(&profile).map_err(storage)?, secret))
}
pub(crate) fn bind(state: &AppState, owner: &str, id: &str) -> Result<Connection, AppError> {
    Ok(get(&db(&state.db_path)?, owner, id)?.0)
}
pub(crate) fn resolve(
    state: &AppState,
    owner: &str,
    id: &str,
    revision: &str,
) -> Result<ResolvedCredential, AppError> {
    resolve_at(&state.db_path, owner, id, revision)
}
fn resolve_at(
    path: &Path,
    owner: &str,
    id: &str,
    revision: &str,
) -> Result<ResolvedCredential, AppError> {
    let _guard = GATE.lock().map_err(storage)?;
    let (connection, reference) = get(&db(path)?, owner, id)?;
    if connection.revision != revision {
        return Err(workspace_error(
            "DATA_CONNECTION_CHANGED",
            "连接配置已更新，请重新生成下载计划",
        ));
    }
    if !connection.credential_ready {
        return Err(workspace_error(
            "DATA_CREDENTIAL_REQUIRED",
            "请在三维数据连接中填写此连接的凭证",
        ));
    }
    let secrets = match reference {
        None => Secrets::default(),
        Some(reference) => {
            let value = entry(path, owner, &reference)?
                .get_password()
                .map_err(|_| {
                    workspace_error(
                        "DATA_CREDENTIAL_REQUIRED",
                        "本机凭证不可用，请在三维数据连接中重新填写",
                    )
                })?;
            serde_json::from_str(&value).map_err(|_| {
                workspace_error("DATA_CREDENTIAL_REQUIRED", "本机凭证格式无效，请重新填写")
            })?
        }
    };
    Ok(ResolvedCredential {
        connection,
        secrets,
    })
}
#[tauri::command]
pub(crate) fn tiles3d_connections_list(
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
) -> Result<Vec<Connection>, AppError> {
    let owner = user(&services)?;
    let db = db(&state.db_path)?;
    let mut statement = db
        .prepare(
            "SELECT profile_json FROM tiles3d_connections WHERE owner_id=?1 ORDER BY rowid DESC",
        )
        .map_err(storage)?;
    let rows = statement
        .query_map([owner], |r| r.get::<_, String>(0))
        .map_err(storage)?;
    rows.map(|row| serde_json::from_str(&row.map_err(storage)?).map_err(storage))
        .collect()
}
#[tauri::command]
pub(crate) fn tiles3d_connection_prepare(
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    draft: ConnectionDraft,
) -> Result<Connection, AppError> {
    let owner = user(&services)?;
    let draft = normalize(draft)?;
    let _guard = GATE.lock().map_err(storage)?;
    let connection = Connection {
        id: Uuid::new_v4().to_string(),
        revision: Uuid::new_v4().to_string(),
        name: draft.name,
        credential_ready: draft.kind == "direct" && draft.required_headers.is_empty(),
        kind: draft.kind,
        tileset_url: draft.tileset_url,
        asset_id: draft.asset_id,
        required_headers: draft.required_headers,
    };
    db(&state.db_path)?
        .execute(
            "INSERT INTO tiles3d_connections(id,owner_id,profile_json) VALUES(?1,?2,?3)",
            params![
                connection.id,
                owner,
                serde_json::to_string(&connection).map_err(storage)?
            ],
        )
        .map_err(storage)?;
    Ok(connection)
}
#[tauri::command]
pub(crate) fn tiles3d_connection_save(
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    connection_id: String,
    token: Option<String>,
    headers: Option<BTreeMap<String, String>>,
    remove_headers: Option<Vec<String>>,
) -> Result<Connection, AppError> {
    let owner = user(&services)?;
    let _guard = GATE.lock().map_err(storage)?;
    let db = db(&state.db_path)?;
    let (mut connection, old_reference) = get(&db, &owner, &connection_id)?;
    let mut secrets: Secrets = match &old_reference {
        Some(reference) => entry(&state.db_path, &owner, reference)?
            .get_password()
            .ok()
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default(),
        None => Secrets::default(),
    };
    let old_profile = connection.clone();
    let old_secret_json = serde_json::to_string(&secrets).map_err(storage)?;
    if let Some(names) = remove_headers {
        for name in names {
            let name = header_name(&name)?;
            secrets.headers.remove(&name);
            connection.required_headers.retain(|h| h != &name);
        }
    }
    if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
        if connection.kind != "cesiumIon"
            || token.len() > 8192
            || token.chars().any(char::is_control)
        {
            return Err(error("Access Token 格式无效"));
        }
        secrets.token = Some(token.trim().into());
    }
    if let Some(headers) = headers {
        if headers.len() > 32 {
            return Err(error("最多可配置 32 个请求头"));
        }
        for (name, value) in headers {
            let name = header_name(&name)?;
            if connection.kind == "cesiumIon" && name == "authorization" {
                return Err(error("Cesium Ion 的认证头由 Access Token 自动生成"));
            }
            connection.required_headers.push(name.clone());
            if value.trim().is_empty() {
                continue;
            } // Empty UI values preserve saved credentials.
            if value.len() > 8192 {
                return Err(error("请求头内容过长"));
            }
            reqwest::header::HeaderValue::from_str(&value)
                .map_err(|_| error("请求头内容不能包含换行"))?;
            secrets.headers.insert(name, value);
        }
    }
    if serde_json::to_vec(&secrets).map_err(storage)?.len() > 48 * 1024 {
        return Err(error("凭证总长度过大"));
    }
    connection
        .required_headers
        .extend(secrets.headers.keys().cloned());
    connection.required_headers.sort();
    connection.required_headers.dedup();
    connection.credential_ready = (connection.kind != "cesiumIon"
        || secrets.token.as_ref().is_some_and(|t| !t.is_empty()))
        && connection
            .required_headers
            .iter()
            .all(|name| secrets.headers.contains_key(name));
    if !connection.credential_ready {
        return Err(workspace_error(
            "DATA_CREDENTIAL_REQUIRED",
            "请填写 Access Token 和连接要求的请求头",
        ));
    }
    if old_secret_json == serde_json::to_string(&secrets).map_err(storage)?
        && old_profile.required_headers == connection.required_headers
        && old_profile.credential_ready == connection.credential_ready
    {
        return Ok(connection);
    }
    let reference = Uuid::new_v4().to_string();
    connection.revision = Uuid::new_v4().to_string();
    entry(&state.db_path, &owner, &reference)?
        .set_password(&serde_json::to_string(&secrets).map_err(storage)?)
        .map_err(|_| workspace_error("DATA_CREDENTIAL_STORE", "凭证未能保存到 Windows 凭据库"))?;
    if let Err(error) = db.execute(
        "UPDATE tiles3d_connections SET profile_json=?3,secret_ref=?4 WHERE owner_id=?1 AND id=?2",
        params![
            owner,
            connection_id,
            serde_json::to_string(&connection).map_err(storage)?,
            reference
        ],
    ) {
        let _ = entry(&state.db_path, &owner, &reference)?.delete_credential();
        return Err(storage(error));
    }
    if let Some(old) = old_reference {
        if let Ok(entry) = entry(&state.db_path, &owner, &old) {
            let _ = entry.delete_credential();
        }
    }
    Ok(connection)
}
#[tauri::command]
pub(crate) fn tiles3d_connection_remove(
    state: State<'_, AppState>,
    services: State<'_, services::ServiceState>,
    connection_id: String,
) -> Result<(), AppError> {
    let owner = user(&services)?;
    let _guard = GATE.lock().map_err(storage)?;
    let db = db(&state.db_path)?;
    let (_, reference) = get(&db, &owner, &connection_id)?;
    db.execute(
        "DELETE FROM tiles3d_connections WHERE owner_id=?1 AND id=?2",
        params![owner, connection_id],
    )
    .map_err(storage)?;
    if let Some(reference) = reference {
        let _ = entry(&state.db_path, &owner, &reference)?.delete_credential();
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn tiles3d_connection_test(
    app: AppHandle,
    connection_id: String,
) -> Result<serde_json::Value, AppError> {
    // Account refresh/keyring access must not run on Tokio worker threads.
    let (credential, proxy) = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let owner = user(&app.state::<services::ServiceState>())?;
        let connection = bind(&state, &owner, &connection_id)?;
        let proxy =
            network::proxy_for(&connection.source_url()).map_err(|_| error("网络设置不可用"))?;
        Ok::<_, AppError>((
            resolve(&state, &owner, &connection_id, &connection.revision)?,
            proxy,
        ))
    })
    .await
    .map_err(|_| error("连接检查线程中断"))??;
    let endpoint = credential
        .resolve(proxy.as_deref())
        .await
        .map_err(|e| workspace_error("DATA_CONNECTION_FAILED", e))?;
    test_endpoint(endpoint, proxy, 16 * 1024 * 1024).await
}

async fn test_endpoint(
    endpoint: geod_tiles3d::ion::ResolvedEndpoint,
    proxy: Option<String>,
    max_decoded_bytes: usize,
) -> Result<serde_json::Value, AppError> {
    let mut builder = reqwest::Client::builder()
        .gzip(true)
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none());
    if let Some(proxy) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| error("代理设置无效"))?);
    }
    let client = builder.build().map_err(|_| error("无法初始化连接检查"))?;
    let mut request = client.get(&endpoint.tileset_url);
    for (name, value) in endpoint.headers {
        request = request.header(name, value);
    }
    let mut response = request.send().await.map_err(|_| {
        workspace_error(
            "DATA_CONNECTION_FAILED",
            "无法连接三维服务，请检查地址、凭证与网络",
        )
    })?;
    if !response.status().is_success() {
        return Err(workspace_error(
            "DATA_CONNECTION_FAILED",
            format!("三维服务返回 HTTP {}", response.status().as_u16()),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| error("三维服务响应读取失败"))?
    {
        // Chunks are already decompressed. Bound the actual JSON allocation,
        // not its much smaller gzip transfer length.
        if body.len() + chunk.len() > max_decoded_bytes {
            return Err(error("根 tileset 解压后超过允许的大小，请通过下载任务检查"));
        }
        body.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| error("服务未返回有效的 tileset JSON"))?;
    if value["asset"]["version"].as_str().is_none() || !value["root"].is_object() {
        return Err(error("该地址不是 3D Tiles 根节点"));
    }
    Ok(serde_json::json!({"connected":true,"version":value["asset"]["version"]}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn connection_probe_decodes_real_http_gzip_and_bounds_decoded_json() {
        use flate2::{write::GzEncoder, Compression};
        use std::io::{Read, Write};
        for oversized in [false, true] {
            let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/tileset.json", server.local_addr().unwrap());
            let worker = std::thread::spawn(move || {
                let (mut socket, _) = server.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                let mut input = [0u8; 4096];
                let read = socket.read(&mut input).unwrap();
                assert!(String::from_utf8_lossy(&input[..read])
                    .to_lowercase()
                    .contains("accept-encoding: gzip"));
                let body = format!(
                    r#"{{"asset":{{"version":"1.0"}},"root":{{}},"extras":{{"label":"{}"}}}}"#,
                    if oversized {
                        "x".repeat(4096)
                    } else {
                        "gzip probe".into()
                    }
                );
                let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
                encoder.write_all(body.as_bytes()).unwrap();
                let bytes = encoder.finish().unwrap();
                assert!(bytes.len() < 256);
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).unwrap();
                socket.write_all(&bytes).unwrap();
            });
            let endpoint = geod_tiles3d::ion::ResolvedEndpoint {
                tileset_url: url,
                headers: BTreeMap::new(),
                inherit_query: false,
            };
            let result = test_endpoint(endpoint, None, 256).await;
            if oversized {
                assert!(result.err().unwrap().message.contains("解压后"));
            } else {
                assert_eq!(result.unwrap()["version"], "1.0");
            }
            worker.join().unwrap();
        }
    }
    #[test]
    fn metadata_rejects_plaintext_credentials_and_owner_isolation_is_enforced() {
        let direct = |url: &str| ConnectionDraft {
            name: "test".into(),
            kind: "direct".into(),
            tileset_url: Some(url.into()),
            asset_id: None,
            required_headers: vec![],
        };
        for url in [
            "https://user:pass@example.org/t.json",
            "https://example.org/t.json?token=secret",
            "https://example.org/t.json?key=secret",
        ] {
            assert!(normalize(direct(url)).is_err());
        }
        assert!(normalize(direct("https://example.org/t.json?v=2")).is_ok());
        assert!(header_name("Host").is_err());
        assert!(header_name("X-Key\r\n").is_err());
        let temp = tempfile::tempdir().unwrap();
        let database = db(&temp.path().join("state.db")).unwrap();
        let connection = Connection {
            id: "connection".into(),
            revision: "revision".into(),
            name: "test".into(),
            kind: "cesiumIon".into(),
            tileset_url: None,
            asset_id: Some(7),
            required_headers: vec![],
            credential_ready: false,
        };
        database
            .execute(
                "INSERT INTO tiles3d_connections VALUES('connection','alice',?1,NULL)",
                [serde_json::to_string(&connection).unwrap()],
            )
            .unwrap();
        assert!(get(&database, "bob", "connection").is_err());
        assert_eq!(
            get(&database, "alice", "connection").unwrap().0.asset_id,
            Some(7)
        );
        let serialized = serde_json::to_string(&connection).unwrap();
        assert!(!serialized.contains("accessToken"));
    }
    #[cfg(windows)]
    #[test]
    fn windows_vault_roundtrip_is_reference_revision_and_owner_bound() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.db");
        let reference = Uuid::new_v4().to_string();
        let vault = entry(&path, "fixture-owner", &reference).unwrap();
        struct Cleanup(Entry);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let cleanup = Cleanup(vault);
        let secrets = Secrets {
            token: Some("synthetic-ion-token".into()),
            headers: BTreeMap::from([
                ("referer".into(), "https://fixture.invalid/".into()),
                ("x-api-key".into(), "synthetic-header-value".into()),
            ]),
        };
        cleanup
            .0
            .set_password(&serde_json::to_string(&secrets).unwrap())
            .unwrap();
        let connection = Connection {
            id: "fixture-connection".into(),
            revision: "fixture-revision".into(),
            name: "credential fixture".into(),
            kind: "cesiumIon".into(),
            tileset_url: None,
            asset_id: Some(7),
            required_headers: vec!["referer".into(), "x-api-key".into()],
            credential_ready: true,
        };
        db(&path)
            .unwrap()
            .execute(
                "INSERT INTO tiles3d_connections VALUES(?1,'fixture-owner',?2,?3)",
                params![
                    connection.id,
                    serde_json::to_string(&connection).unwrap(),
                    reference
                ],
            )
            .unwrap();
        let runtime =
            resolve_at(&path, "fixture-owner", &connection.id, &connection.revision).unwrap();
        assert_eq!(
            runtime.secrets.token.as_deref(),
            Some("synthetic-ion-token")
        );
        assert!(resolve_at(&path, "other-owner", &connection.id, &connection.revision).is_err());
        assert!(resolve_at(&path, "fixture-owner", &connection.id, "wrong-revision").is_err());
        let persisted = String::from_utf8_lossy(&std::fs::read(path).unwrap()).to_string();
        assert!(!persisted.contains("synthetic-ion-token"));
        assert!(!persisted.contains("synthetic-header-value"));
    }
}

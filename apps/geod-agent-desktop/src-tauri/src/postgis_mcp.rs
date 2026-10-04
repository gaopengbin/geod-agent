//! GeoD's native credential/geometry adapter to the unmodified pgEdge MCP.
//! Each operation owns its stdio process and database context. No shared
//! `select_database_connection` state, shell commands, or credentials in replies.
use crate::{workspace_error, AppError};
use base64::Engine;
use rmcp::{model::CallToolRequestParams, transport::async_rw::AsyncRwTransport, ServiceExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::{Path, PathBuf}, process::Stdio, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::{io::AsyncReadExt, process::{Child, Command}, task::JoinHandle};

const VERSION: &str = "1.1.0";
const BINARY_SHA256: &str = "8640a0d089284dc0a2005c550dc1c08f88a4c4b1e333f6f11b9bd8bd35766dae";
const CONFIG: &str = include_str!("../pgedge-config.yaml");
const DISCOVERY: &str = "SELECT g.f_table_schema AS schema, g.f_table_name AS table_name, g.geometry_column, g.type, g.srid,g.storage_type FROM (SELECT f_table_schema,f_table_name,f_geometry_column AS geometry_column,type,srid,'geometry' AS storage_type FROM geometry_columns UNION ALL SELECT f_table_schema,f_table_name,f_geography_column AS geometry_column,type,srid,'geography' AS storage_type FROM geography_columns) g JOIN pg_namespace n ON n.nspname=g.f_table_schema JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=g.f_table_name WHERE has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT') ORDER BY 1,2,3 LIMIT 201";
const TABLES: &str = "SELECT n.nspname AS schema,c.relname AS table_name,CASE WHEN c.relkind IN ('v','m') THEN 'VIEW' ELSE 'TABLE' END AS type FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%' AND has_schema_privilege(n.oid,'USAGE') AND has_table_privilege(c.oid,'SELECT') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_extension'::regclass AND d.deptype='e') ORDER BY 1,2 LIMIT 201";

fn runtime_root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let mut roots = Vec::new();
    if cfg!(debug_assertions) { roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pgedge")); }
    if let Ok(root) = app.path().resource_dir() { roots.push(root.join("pgedge-runtime")); }
    roots.into_iter().find(|root| root.join("pgedge-postgres-mcp.exe").is_file())
        .ok_or_else(|| workspace_error("INPUT_RUNTIME_MISSING", "内置数据库运行环境缺失，请重新准备开发运行环境或修复应用"))
}

fn verify_runtime(root: &Path) -> Result<(), AppError> {
    let bytes = fs::read(root.join("pgedge-postgres-mcp.exe"))
        .map_err(|_| workspace_error("INPUT_RUNTIME_MISSING", "内置数据库运行环境不可读"))?;
    if format!("{:x}", Sha256::digest(bytes)) != BINARY_SHA256
        || fs::read_to_string(root.join("postgres-mcp.yaml")).ok().as_deref() != Some(CONFIG) {
        return Err(workspace_error("INPUT_RUNTIME_INVALID", "内置数据库运行环境校验失败，请重新准备运行环境"));
    }
    Ok(())
}

fn read_error(text: &str) -> AppError {
    let lower = text.to_ascii_lowercase();
    if lower.contains("certificate") || lower.contains("tls") || lower.contains("sslrootcert") || lower.contains("sslkey") {
        return workspace_error("INPUT_TLS_FAILED", "数据库证书验证失败，请检查 CA、客户端证书与私钥、主机名称和 TLS 模式");
    }
    if lower.contains("28p01") || lower.contains("28000") || lower.contains("password authentication failed")
        || lower.contains("no password supplied") || lower.contains("failed sasl auth") {
        workspace_error("INPUT_AUTH_REQUIRED", "数据库需要有效的认证信息，请在本机输入密码。")
    } else {
        // Driver/server text may include connection details and password values.
        workspace_error("INPUT_READ_FAILED", "数据库读取失败，请检查地址、网络、坐标系和账号权限。")
    }
}

struct Session {
    client: rmcp::service::RunningService<rmcp::RoleClient, ()>,
    child: Child,
    stderr: JoinHandle<String>,
    tools: Vec<String>,
    calls: u32,
    _tls: Option<crate::database_tls::Material>,
}
impl Drop for Session {
    fn drop(&mut self) {
        // Covers success, errors, timeouts and a cancelled native future.
        let _ = self.child.start_kill();
        self.stderr.abort();
    }
}

impl Session {
    async fn start(root: &Path, database: &Value) -> Result<Self, AppError> {
        let tls = crate::database_tls::prepare(database)?;
        let mut command = Command::new(root.join("pgedge-postgres-mcp.exe"));
        command.arg("-config").arg(root.join("postgres-mcp.yaml")).current_dir(root)
            .env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        // Do not inherit unrelated database profiles, trace paths or LLM keys.
        for key in ["SystemRoot", "WINDIR", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"] {
            if let Some(value) = std::env::var_os(key) { command.env(key, value); }
        }
        for (key, field) in [("PGEDGE_DB_HOST", "host"), ("PGEDGE_DB_NAME", "database"), ("PGEDGE_DB_USER", "user"), ("PGEDGE_DB_PASSWORD", "password"), ("PGEDGE_DB_SSLMODE", "sslMode")] {
            command.env(key, database[field].as_str().unwrap_or_default());
        }
        if let Some(path)=database["sslRootCertPath"].as_str(){command.env("PGEDGE_DB_SSLROOTCERT",path);}
        if let Some(tls) = &tls {
            command.env("PGEDGE_DB_SSLCERT", &tls.certificate).env("PGEDGE_DB_SSLKEY", &tls.key);
        }
        command.env("PGEDGE_DB_PORT", database["port"].as_u64().unwrap_or(5432).to_string())
            .env("PGEDGE_DB_ALLOW_WRITES", "false")
            .env("PGPASSFILE", root.join("no-implicit-credentials"));
        #[cfg(windows)] command.creation_flags(0x0800_0000);
        let mut child = command.spawn().map_err(|_| workspace_error("INPUT_RUNTIME_MISSING", "无法启动内置 PostgreSQL MCP"))?;
        let stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut err = child.stderr.take().unwrap();
        let mut stderr = tokio::spawn(async move {
            let mut saved = Vec::new();
            let mut chunk = [0u8; 4096];
            // Drain all output to avoid pipe deadlocks; retain only bounded text
            // for authentication classification, never publish or persist it.
            while let Ok(size) = err.read(&mut chunk).await {
                if size == 0 { break; }
                let retain = size.min((64 * 1024usize).saturating_sub(saved.len()));
                saved.extend_from_slice(&chunk[..retain]);
            }
            String::from_utf8_lossy(&saved).into_owned()
        });
        let started = tokio::time::timeout(Duration::from_secs(20), ().serve(AsyncRwTransport::new(stdout, stdin))).await;
        let client = match started {
            Ok(Ok(client)) => client,
            failed => {
                let _ = child.kill().await;
                let text = tokio::time::timeout(Duration::from_secs(1), &mut stderr).await.ok().and_then(Result::ok).unwrap_or_default();
                stderr.abort();
                return Err(if failed.is_err() { workspace_error("INPUT_TIMEOUT", "数据库连接超时，请检查地址与网络") } else { read_error(&text) });
            }
        };
        let mut session = Self { client, child, stderr, tools: vec![], calls: 0, _tls: tls };
        let peer = session.client.peer_info().ok_or_else(|| workspace_error("INPUT_RUNTIME_INVALID", "数据库 MCP 未返回服务信息"))?;
        let info = peer.server_info.as_ref().ok_or_else(|| workspace_error("INPUT_RUNTIME_INVALID", "数据库 MCP 缺少服务版本信息"))?;
        if info.name != "pgedge-postgres-mcp" || info.version != VERSION {
            return Err(workspace_error("INPUT_RUNTIME_INVALID", "数据库 MCP 版本与内置版本不一致"));
        }
        let tools = tokio::time::timeout(Duration::from_secs(10), session.client.list_tools(Default::default())).await
            .map_err(|_| workspace_error("INPUT_TIMEOUT", "数据库 MCP 工具发现超时"))?
            .map_err(|_| workspace_error("INPUT_READ_FAILED", "数据库 MCP 无法列出工具"))?;
        session.tools = tools.tools.iter().map(|tool| tool.name.to_string()).collect();
        if !session.tools.iter().any(|tool| tool == "query_database") {
            return Err(workspace_error("INPUT_RUNTIME_INVALID", "数据库 MCP 缺少查询工具"));
        }
        Ok(session)
    }

    async fn query(&mut self, expression: &str) -> Result<Value, AppError> {
        // One bounded JSON cell encoded as base64 avoids upstream TSV escaping,
        // embedded tabs/newlines and its 1,000 *result row* limit. Every source
        // query still has its own explicit row/byte bound; no dataset truncation.
        let sql = format!("SELECT replace(encode(convert_to(({expression})::text,'UTF8'),'base64'),chr(10),'') AS geod_result");
        let args = json!({"query": sql, "limit": 1}).as_object().cloned().unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(25), self.client.call_tool(CallToolRequestParams::new("query_database").with_arguments(args))).await
            .map_err(|_| workspace_error("INPUT_TIMEOUT", "数据库读取超时，请缩小范围或检查网络"))?
            .map_err(|_| workspace_error("INPUT_READ_FAILED", "数据库 MCP 连接已中断"))?;
        self.calls += 1;
        let reply = serde_json::to_value(reply).map_err(|_| workspace_error("INPUT_READ_FAILED", "数据库 MCP 返回无效结果"))?;
        let text = reply["content"].as_array().map(|items| items.iter().filter_map(|item| item["text"].as_str()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
        if reply["isError"] == true { return Err(read_error(&text)); }
        decode_cell(&text)
    }

    fn metadata(&self) -> Value {
        let peer = self.client.peer_info().unwrap();
        let info = peer.server_info.as_ref().unwrap();
        json!({"server": info.name, "version": info.version,
            "protocolVersion": peer.protocol_version, "transport": "stdio", "tools": self.tools, "toolCalls": self.calls})
    }
}

fn decode_cell(text: &str) -> Result<Value, AppError> {
    let invalid = || workspace_error("INPUT_READ_FAILED", "数据库 MCP 返回的格式不符合内置版本约定");
    let (_, table) = text.rsplit_once("\nResults (").ok_or_else(invalid)?;
    let (_, rows) = table.split_once('\n').ok_or_else(invalid)?;
    let (header, cell) = rows.split_once('\n').ok_or_else(invalid)?;
    if header.trim() != "geod_result" || cell.len() > geod_core::boundary::MAX_GEOJSON_BYTES + 65536 { return Err(invalid()); }
    let bytes = base64::engine::general_purpose::STANDARD.decode(cell.trim()).map_err(|_| invalid())?;
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}

use crate::database_query::{identifier,literal,Selection};
fn layer_name(row: &Value) -> String { format!("{}.{}.{}", row["schema"].as_str().unwrap_or_default(), row["table_name"].as_str().unwrap_or_default(), row["geometry_column"].as_str().unwrap_or_default()) }
fn table_name(row: &Value) -> String { format!("{}.{}", row["schema"].as_str().unwrap_or_default(), row["table_name"].as_str().unwrap_or_default()) }

async fn database_request(session: &mut Session, layer: Option<&str>, inspect: Option<u32>,selection:&Selection) -> Result<Value, AppError> {
    let catalog = session.query(&format!("SELECT jsonb_build_object('postgis',EXISTS(SELECT 1 FROM pg_extension WHERE extname='postgis'),'tables',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) FROM ({TABLES}) t))")).await?;
    let tables = catalog["tables"].as_array().ok_or_else(|| workspace_error("INPUT_READ_FAILED", "无法读取数据库表目录"))?;
    if tables.len() > 200 { return Err(workspace_error("INPUT_TOO_LARGE", "数据库可见表超过 200 个，请使用较小数据库或限制账号可见表。")); }
    let table_list: Vec<Value> = tables.iter().map(|row| json!({"name": table_name(row), "type": row["type"]})).collect();
    let database_type = if catalog["postgis"] == true { "PostGIS" } else { "PostgreSQL" };
    let discovered = if catalog["postgis"] == true { session.query(&format!("SELECT coalesce(jsonb_agg(to_jsonb(g)),'[]'::jsonb) FROM ({DISCOVERY}) g")).await? } else { json!([]) };
    let rows = discovered.as_array().ok_or_else(|| workspace_error("INPUT_READ_FAILED", "无法读取数据库空间图层列表"))?;
    if rows.len() > 200 { return Err(workspace_error("INPUT_TOO_LARGE", "数据库空间图层超过 200 个，请使用更小的数据库或限制该账号可见表。")); }
    let layers: Vec<Value> = rows.iter().map(|row| json!({"name": layer_name(row), "geometryType": row["type"], "crs": row["srid"].as_u64().filter(|n| *n > 0).map(|n| format!("EPSG:{n}")), "featureCount": null})).collect();
    let Some(selected) = layer else { return Ok(json!({"layers": layers, "tables": table_list, "databaseType": database_type, "selectionRequired": true, "readOnly": true})); };
    // Resolve only IDs actually discovered for this credential. Never split a
    // dotted user argument: PostgreSQL names may themselves contain dots/quotes.
    let matched: Vec<_> = rows.iter().filter(|row| layer_name(row) == selected).chain(tables.iter().filter(|row| table_name(row) == selected)).collect();
    if matched.len() > 1 { return Err(workspace_error("INPUT_LAYER_AMBIGUOUS", "数据库存在同名路径，请为表创建不含歧义名称的视图。")); }
    let row = matched.first().copied().ok_or_else(|| workspace_error("INPUT_LAYER_NOT_FOUND", "请选择本连接返回的表或空间图层。"))?;
    let schema = row["schema"].as_str().unwrap();
    let table = row["table_name"].as_str().unwrap();
    let native_geom = row["geometry_column"].as_str().map(identifier);
    let geography=row["storage_type"]=="geography";
    let geom=native_geom.as_ref().map(|name|if geography{format!("{name}::geometry")}else{name.clone()});
    let relation = format!("{}.{}", identifier(schema), identifier(table));
    let srid = row["srid"].as_u64().unwrap_or(0);
    let crs = (srid > 0).then(|| format!("EPSG:{srid}"));

    let fields = session.query(&format!("SELECT coalesce(jsonb_agg(to_jsonb(f)),'[]'::jsonb) FROM (SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,t.typname IN ('geometry','geography') AS spatial FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid WHERE n.nspname={} AND c.relname={} AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 101) f", literal(schema), literal(table))).await?;
        let columns = fields.as_array().ok_or_else(|| workspace_error("INPUT_READ_FAILED", "无法读取图层字段"))?;
        if columns.len() > 100 { return Err(workspace_error("INPUT_TOO_LARGE", "图层字段超过 100 个，请提供较小的数据库视图。")); }
    let condition=selection.condition(columns,native_geom.as_deref(),srid,geography)?;
    let max=selection.limit()?;let fetch_limit=max+1;
    if let Some(limit) = inspect {
        let limit = limit.clamp(1, 10);
        let spatial = columns.iter().filter(|col| col["spatial"] == true).map(|col| literal(col["name"].as_str().unwrap())).collect::<Vec<_>>().join(",");
        let count = session.query(&format!("SELECT to_jsonb(count(*)) FROM (SELECT 1 FROM {relation} WHERE {condition} LIMIT {fetch_limit}) sampled")).await?.as_u64().unwrap_or(0);
        // Bound encoded samples before the MCP response crosses the process pipe.
        let records = session.query(&format!("WITH sampled AS (SELECT to_jsonb(t)-ARRAY[{spatial}]::text[] AS record FROM {relation} t WHERE {condition} LIMIT {limit}), encoded AS (SELECT coalesce(jsonb_agg(record),'[]'::jsonb) AS records FROM sampled) SELECT CASE WHEN octet_length(records::text)>65536 THEN jsonb_build_object('tooLarge',true) ELSE records END FROM encoded")).await?;
        if records["tooLarge"] == true { return Err(workspace_error("INPUT_TOO_LARGE", "样例记录过大，请减少预览数量或使用字段较少的视图。")); }
        let mut records = records;
        if let Some(records) = records.as_array_mut() {
            for record in records { if let Some(fields) = record.as_object_mut() { for value in fields.values_mut() {
                if let Some(text) = value.as_str().filter(|text| text.chars().count() > 1024) { *value = json!(format!("{}…", text.chars().take(1024).collect::<String>())); }
            } } }
        }
        return Ok(json!({"selectedLayer": selected, "sourceCrs": crs, "geometryType": row["type"], "columns": columns,
            "featureCount": (count <= max).then_some(count), "featureCountLowerBound": (count > max).then_some(count), "sampleRecords": records, "sampleLimit": limit, "readOnly": true,"storageType":row["storage_type"],"filtered":!selection.filters.is_empty()||selection.bounds.is_some()}));
    }
    let geom = geom.ok_or_else(|| workspace_error("INPUT_NOT_POLYGON", "该表没有选定的面几何列，请先选择本连接返回的空间图层。"))?;
    if srid == 0 { return Err(workspace_error("INPUT_CRS_REQUIRED", "数据库几何 SRID 为 0，请先为数据设置正确的坐标系。")); }
    let checks = session.query(&format!("SELECT jsonb_build_object('count',count(*),'empty',coalesce(bool_or(ST_IsEmpty(g)),false),'polygon',coalesce(bool_and(GeometryType(g) IN ('POLYGON','MULTIPOLYGON')),true),'valid',coalesce(bool_and(ST_IsValid(g)),true)) FROM (SELECT {geom} AS g FROM {relation} WHERE {geom} IS NOT NULL AND {condition} LIMIT {fetch_limit}) sampled")).await?;
    if checks["count"].as_u64().unwrap_or(0) == 0 { return Err(workspace_error("INPUT_EMPTY", "选中的图层没有几何数据。")); }
    if checks["count"].as_u64().unwrap_or(0) > max { return Err(workspace_error("INPUT_TOO_LARGE",format!("要素超过当前 {} 个上限，请筛选较小范围",max))); }
    if checks["polygon"] != true || checks["empty"] == true { return Err(workspace_error("INPUT_NOT_POLYGON", "裁剪范围需要 Polygon / MultiPolygon；点和线不能直接作为裁剪边界。")); }
    if checks["valid"] != true { return Err(workspace_error("INPUT_INVALID_GEOMETRY", "存在无效面几何，请修复后导入，原数据未被修改。")); }
    let value = session.query(&format!("WITH sampled AS (SELECT ST_Transform({geom},4326) AS g FROM {relation} WHERE {geom} IS NOT NULL AND {condition} LIMIT {fetch_limit}), encoded AS (SELECT jsonb_build_object('type','FeatureCollection','features',jsonb_agg(jsonb_build_object('type','Feature','properties',jsonb_build_object(),'geometry',ST_AsGeoJSON(g,15)::jsonb))) AS geojson, bool_and(ST_IsValid(g)) AS valid, count(*) AS rows FROM sampled) SELECT CASE WHEN rows>{max} THEN jsonb_build_object('tooLarge',true) WHEN NOT valid THEN jsonb_build_object('invalid',true) WHEN octet_length(geojson::text)>8388608 THEN jsonb_build_object('tooLarge',true) ELSE geojson END FROM encoded")).await?;
    if value["tooLarge"] == true { return Err(workspace_error("INPUT_TOO_LARGE", "图层超过 10,000 个要素或转换后边界超过 8 MiB，请使用较小的图层或视图。")); }
    if value["invalid"] == true { return Err(workspace_error("INPUT_INVALID_GEOMETRY", "坐标转换后存在无效面几何，请检查源坐标系。")); }
    if value["features"].as_array().map(|f|f.len() as u64)!=checks["count"].as_u64(){return Err(workspace_error("INPUT_PAGED_RESULT","读取期间要素数量变化，请重新读取"));}
    Ok(json!({"layers": layers, "selectedLayer": selected, "sourceCrs": crs, "geojson": value, "readOnly": true,"storageType":row["storage_type"],"filtered":!selection.filters.is_empty()||selection.bounds.is_some()}))
}

pub async fn request(app: &AppHandle, database: &Value, layer: Option<&str>, inspect: Option<u32>) -> Value {
    request_filtered(app,database,layer,inspect,Selection::default()).await
}
pub async fn request_filtered(app: &AppHandle, database: &Value, layer: Option<&str>, inspect: Option<u32>,selection:Selection) -> Value {
    let result = async {
        let root = runtime_root(app)?;
        let verified_root = root.clone();
        tauri::async_runtime::spawn_blocking(move || verify_runtime(&verified_root)).await
            .map_err(|_| workspace_error("INPUT_RUNTIME_INVALID", "数据库运行环境校验中断"))??;
        let mut session = Session::start(&root, database).await?;
        let result = database_request(&mut session, layer, inspect,&selection).await;
        let metadata = session.metadata();
        // Close protocol first and reap the owned process even on query failure.
        let _ = tokio::time::timeout(Duration::from_secs(2), session.client.close()).await;
        let _ = session.child.kill().await;
        result.map(|mut value| { value["mcp"] = metadata; value })
    }.await;
    match result { Ok(value) => value, Err(error) => json!({"error": error}) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    #[ignore = "Requires the isolated client-certificate Docker fixture"]
    fn live_mtls_cancellation_cleans_owned_process_and_material() {
        let fixture = PathBuf::from(std::env::var_os("GEOD_MTLS_TEST_CREDENTIAL_FILE").expect("Set isolated fixture credential path"));
        let mut database: Value = serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
        let temp = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let certificate = database["sslClientCert"].take().as_str().unwrap().to_owned();
        let key = database["sslClientKey"].take().as_str().unwrap().to_owned();
        let ca = temp.path().join("ca.pem"); fs::write(&ca, database["sslRootCert"].take().as_str().unwrap()).unwrap();
        crate::database_tls::save(temp.path(), &id, certificate, key).unwrap();
        database["id"] = json!(id); database["clientCertificate"] = json!(true);
        database["tlsRoot"] = json!(temp.path().to_string_lossy()); database["sslRootCertPath"] = json!(ca);
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pgedge");
        verify_runtime(&root).unwrap();
        tauri::async_runtime::block_on(async {
            let mut session = Session::start(&root, &database).await.unwrap();
            assert_eq!(session.query("SELECT jsonb_build_object('connected',true)").await.unwrap()["connected"], true);
            let pid = session.child.id().unwrap();
            let stopped = tokio::time::timeout(Duration::from_millis(500), async move {
                session.query("SELECT pg_sleep(60)").await
            }).await;
            assert!(stopped.is_err());
            let folders: Vec<_> = fs::read_dir(temp.path().join("certificates")).unwrap().flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(".tls-session-")).collect();
            assert!(folders.is_empty(), "Cancelled owned future left temporary private key files");
            use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::*};
            let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x00100000, 0, pid) };
            if !process.is_null() {
                let result = unsafe { WaitForSingleObject(process, 3000) };
                unsafe { CloseHandle(process); }
                assert_eq!(result, 0, "Cancelled MCP child is still running");
            }
            if let Some(report) = std::env::var_os("GEOD_MTLS_TEST_REPORT") {
                fs::write(report, serde_json::to_vec_pretty(&json!({"pass":true,"clientKeyBits":4096,"actualMcpConnected":true,"cancelledOwnedFuture":true,"temporaryPrivateKeysRemoved":true,"ownedProcessStopped":true})).unwrap()).unwrap();
            }
        });
    }
    #[test]
    fn structured_cell_preserves_tabs_newlines_unicode_and_sql_text() {
        let original = json!({"name": "北京\t范围\n'双\"引号'", "value": null});
        let encoded = base64::engine::general_purpose::STANDARD.encode(original.to_string());
        let reply = format!("Database: default\n\nSQL Query:\nSELECT 'Results (fake)'\n\nResults (1 rows):\ngeod_result\n{encoded}\n");
        assert_eq!(decode_cell(&reply).unwrap(), original);
        assert!(decode_cell("Results (1 rows):\nwrong\nnot-json").is_err());
    }
    #[test]
    fn identifiers_and_values_are_composed_separately() {
        assert_eq!(identifier("区划 odd\" table.with.dot"), "\"区划 odd\"\" table.with.dot\"");
        assert_eq!(literal("user's table"), "E'user''s table'");
    }

    #[test]
    #[ignore = "Requires the local synthetic Docker PostGIS fixture"]
    fn live_mcp_read_only_and_parallel_contexts() {
        let path = PathBuf::from(std::env::var_os("GEOD_MCP_TEST_CREDENTIAL_FILE").expect("Set local fixture credential path"));
        let reader: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut admin = reader.clone();
        admin["user"] = json!("geod_admin");
        admin["password"] = json!(fs::read_to_string(path.parent().unwrap().join("admin-password.txt")).unwrap().trim());
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pgedge");
        verify_runtime(&root).unwrap();
        tauri::async_runtime::block_on(async {
            let (reader_session, admin_session) = tokio::join!(Session::start(&root, &reader), Session::start(&root, &admin));
            let mut reader_session = reader_session.unwrap();
            let mut admin_session = admin_session.unwrap();
            let expression = "SELECT jsonb_build_object('role',current_user,'readOnly',current_setting('transaction_read_only'),'visibleRows',(SELECT count(*) FROM demo.scoped_regions))";
            let (reader_result, admin_result) = tokio::join!(reader_session.query(expression), admin_session.query(expression));
            let reader_result = reader_result.unwrap();
            let admin_result = admin_result.unwrap();
            assert_eq!(reader_result, json!({"role": "geod_reader", "readOnly": "on", "visibleRows": 1}));
            assert_eq!(admin_result, json!({"role": "geod_admin", "readOnly": "on", "visibleRows": 2}));
            // Even a role with write permissions is blocked by the actual MCP.
            // The zero-row statement is harmless if this gate regresses.
            let args = json!({"query": "DELETE FROM demo.points WHERE false"}).as_object().cloned().unwrap();
            let rejected = admin_session.client.call_tool(CallToolRequestParams::new("query_database").with_arguments(args)).await.unwrap();
            let rejected = serde_json::to_value(rejected).unwrap();
            assert_eq!(rejected["isError"], true);
            if let Some(report) = std::env::var_os("GEOD_MCP_TEST_REPORT") {
                fs::write(report, serde_json::to_vec_pretty(&json!({"reader": reader_result, "admin": admin_result,
                    "mcp": reader_session.metadata(), "writeRejectedByMcp": true, "separateConcurrentContexts": true})).unwrap()).unwrap();
            }
            let _ = reader_session.client.close().await;
            let _ = admin_session.client.close().await;
            let _ = reader_session.child.kill().await;
            let _ = admin_session.child.kill().await;
        });
    }
}

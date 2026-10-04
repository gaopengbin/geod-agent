use super::*;
use std::path::Path;

const MAX_EXPORT_BYTES: u64 = 64 * 1024 * 1024;
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreditHistoryQuery {
    pub kind: String,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub cursor: Option<String>,
    pub limit: Option<u32>,
}
fn history_path(query: &CreditHistoryQuery, export: bool) -> Result<String, ServiceError> {
    let valid_time = |value: Option<i64>| value.is_none_or(|at| (0..=8_640_000_000_000_000).contains(&at));
    if !["usage", "reservations"].contains(&query.kind.as_str()) || !valid_time(query.from) || !valid_time(query.to)
        || query.from.zip(query.to).is_some_and(|(from, to)| from >= to)
        || query.limit.is_some_and(|limit| !(1..=200).contains(&limit))
        || query.cursor.as_ref().is_some_and(|cursor| cursor.is_empty() || cursor.len() > 2048)
        || export && (query.cursor.is_some() || query.limit.is_some()) {
        return Err(error("PAYMENT_HISTORY_INVALID", "用量筛选无效，请重新查询"));
    }
    let mut url = Url::parse(&format!("http://127.0.0.1/v1/payments/history/{}{}", query.kind, if export { "/export.csv" } else { "" })).unwrap();
    {
        let mut pairs = url.query_pairs_mut();
        if let Some(from) = query.from { pairs.append_pair("from", &from.to_string()); }
        if let Some(to) = query.to { pairs.append_pair("to", &to.to_string()); }
        if let Some(cursor) = &query.cursor { pairs.append_pair("cursor", cursor); }
        if let Some(limit) = query.limit { pairs.append_pair("limit", &limit.to_string()); }
    }
    Ok(format!("{}{}", url.path(), url.query().filter(|query| !query.is_empty()).map(|query| format!("?{query}")).unwrap_or_default()))
}
fn validate_target(target: &Path) -> Result<(), ServiceError> {
    if !target.is_absolute() || !target.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("csv"))
        || !target.parent().is_some_and(Path::is_dir) {
        return Err(error("PAYMENT_STATEMENT_PATH", "请选择 CSV 文件保存位置"));
    }
    Ok(())
}
fn save_statement(mut response: reqwest::blocking::Response, target: &Path) -> Result<Value, ServiceError> {
    validate_target(target)?;
    if !response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(';').next() == Some("text/csv")) {
        return Err(error("PAYMENT_STATEMENT_INVALID", "用量导出内容无效，原文件未修改"));
    }
    let read_header = |name| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let digest = read_header("x-geod-statement-sha256").filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| error("PAYMENT_STATEMENT_INVALID", "用量导出内容无效，原文件未修改"))?;
    let count = read_header("x-geod-record-count").and_then(|v| v.parse::<u64>().ok()).filter(|count| *count <= 100_000)
        .ok_or_else(|| error("PAYMENT_STATEMENT_INVALID", "用量导出内容无效，原文件未修改"))?;
    let as_of = read_header("x-geod-statement-as-of").and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| error("PAYMENT_STATEMENT_INVALID", "用量导出内容无效，原文件未修改"))?;
    let length = response.content_length().filter(|bytes| *bytes <= MAX_EXPORT_BYTES)
        .ok_or_else(|| error("PAYMENT_STATEMENT_TOO_LARGE", "导出过大，请缩小时间范围后重试"))?;
    let mut file = tempfile::NamedTempFile::new_in(target.parent().unwrap()).map_err(|_| error("PAYMENT_STATEMENT_SAVE", "无法保存用量记录，请检查目录和磁盘空间"))?;
    let mut buffer = [0_u8; 32 * 1024];
    let mut hash = Sha256::new();
    let mut bytes = 0_u64;
    loop {
        let n = response.read(&mut buffer).map_err(|_| error("PAYMENT_STATEMENT_INTERRUPTED", "用量导出中断，原文件未修改，请重试"))?;
        if n == 0 { break; }
        bytes += n as u64;
        if bytes > MAX_EXPORT_BYTES { return Err(error("PAYMENT_STATEMENT_TOO_LARGE", "导出过大，请缩小时间范围后重试")); }
        hash.update(&buffer[..n]);
        file.write_all(&buffer[..n]).map_err(|_| error("PAYMENT_STATEMENT_SAVE", "无法保存用量记录，请检查目录和磁盘空间"))?;
    }
    if bytes != length || format!("{:x}", hash.finalize()) != digest.to_lowercase() {
        return Err(error("PAYMENT_STATEMENT_INVALID", "用量导出核验失败，原文件未修改，请重试"));
    }
    file.as_file().sync_all().map_err(|_| error("PAYMENT_STATEMENT_SAVE", "无法保存用量记录，请检查目录和磁盘空间"))?;
    file.persist(target).map_err(|_| error("PAYMENT_STATEMENT_SAVE", "无法保存用量记录，请检查目录和磁盘空间"))?;
    Ok(json!({"records":count,"bytes":bytes,"asOf":as_of,"sha256":digest}))
}
#[tauri::command]
pub async fn agent_credit_history(state: State<'_, ServiceState>, query: CreditHistoryQuery) -> Result<Value, ServiceError> {
    let state = state.inner().clone();
    let path = history_path(&query, false)?;
    tauri::async_runtime::spawn_blocking(move || gateway_call(&state, &path, None)).await
        .map_err(|_| error("PAYMENT_HISTORY_ERROR", "用量查询中断，请重试"))?
}
#[tauri::command]
pub async fn agent_credit_history_export(state: State<'_, ServiceState>, query: CreditHistoryQuery, path: String) -> Result<Value, ServiceError> {
    let state = state.inner().clone();
    let route = history_path(&query, true)?;
    let target = PathBuf::from(path); validate_target(&target)?;
    tauri::async_runtime::spawn_blocking(move || {
        let config = load_config(&state.config_path)?;
        let token = get_access_token(&state, &config)?;
        let response = client(&config.gateway_origin)?.get(format!("{}{route}", config.gateway_origin)).header(reqwest::header::ACCEPT_ENCODING, "identity").bearer_auth(token).send()
            .map_err(|_| error("GATEWAY_UNAVAILABLE", "GeoD Agent 模型服务暂时不可达"))?;
        if !response.status().is_success() {
            gateway_json_response(response, &route)?;
            return Err(error("PAYMENT_STATEMENT_INVALID", "用量导出内容无效，原文件未修改"));
        }
        save_statement(response, &target)
    }).await.map_err(|_| error("PAYMENT_STATEMENT_INTERRUPTED", "用量导出中断，原文件未修改，请重试"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn query() -> CreditHistoryQuery { CreditHistoryQuery { kind: "usage".into(), from: None, to: None, cursor: None, limit: None } }
    #[test]
    fn history_query_uses_fixed_routes_and_encodes_cursor_without_accepting_an_owner() {
        let mut q = query(); q.cursor = Some("signed&account=other".into()); q.limit = Some(20);
        assert_eq!(history_path(&q, false).unwrap(), "/v1/payments/history/usage?cursor=signed%26account%3Dother&limit=20");
        assert!(history_path(&q, true).is_err()); q.cursor = None; q.limit = None; q.from = Some(5); q.to = Some(5);
        assert!(history_path(&q, false).is_err()); q.to = Some(6); assert!(history_path(&q, false).is_ok());
        q.kind = "../orders".into(); assert!(history_path(&q, false).is_err());
        assert!(serde_json::from_value::<CreditHistoryQuery>(json!({"kind":"usage","account":"other"})).is_err());
    }
    #[test]
    fn csv_save_verifies_stream_before_replacing_existing_file() {
        let dir = tempfile::tempdir().unwrap(); let target = dir.path().join("credits.csv");
        let data = "\u{feff}\"generation_id\",\"charge_credits\"\r\n\"isolated\",\"3.2\"\r\n";
        for (digest, content_type, expected) in [(format!("{:x}", Sha256::digest(data.as_bytes())), "text/csv;charset=utf-8", true), ("0".repeat(64), "text/csv", false), ("0".repeat(64), "text/html", false)] {
            fs::write(&target, "original").unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let origin = format!("http://{}", listener.local_addr().unwrap());
            let server = thread::spawn(move || { let (mut stream, _) = listener.accept().unwrap(); let mut request = [0_u8; 2048]; stream.read(&mut request).unwrap();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nx-geod-record-count: 1\r\nx-geod-statement-sha256: {digest}\r\nx-geod-statement-as-of: 123\r\nConnection: close\r\n\r\n{data}", data.len()).unwrap(); });
            let response = reqwest::blocking::Client::builder().no_proxy().build().unwrap().get(origin).send().unwrap();
            assert_eq!(save_statement(response, &target).is_ok(), expected);
            assert_eq!(fs::read_to_string(&target).unwrap(), if expected { data } else { "original" });
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1); server.join().unwrap();
        }
        assert!(validate_target(Path::new("relative.csv")).is_err());
        assert!(validate_target(&dir.path().join("credits.html")).is_err());
    }
}

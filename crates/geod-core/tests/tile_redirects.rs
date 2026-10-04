use geod_core::imagery::{
    fetch_preview_tile, AuthenticationMode, HttpSource, NetworkPolicy, ProxyRoute, RuntimeToken,
    SourceAuthentication, TileScheme,
};
use std::{
    io::{Cursor, Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
struct Server {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn start(mode: &'static str) -> Self {
        Self::start_redirect(mode, None)
    }
    fn start_redirect(mode: &'static str, redirect_target: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let quitting = stop.clone();
        let recorded = requests.clone();
        let origin = url.clone();
        let worker = thread::spawn(move || {
            while !quitting.load(Ordering::Relaxed) {
                let Ok((mut socket, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).unwrap_or(0);
                let text = String::from_utf8_lossy(&buffer[..count]);
                let Some(path) = text
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                else {
                    continue;
                };
                recorded.lock().unwrap().push(path.to_string());
                let redirect = match mode {
                    "cross" | "unauthorized" => redirect_target.clone(),
                    "loop" => Some("/next".to_string()),
                    _ if !path.starts_with("/payload") => {
                        Some(format!("{origin}/payload?token=echoed&keep=yes"))
                    }
                    _ => None,
                };
                let (header, bytes) = if let Some(location) = redirect {
                    let status = match mode {
                        "cross" => "302 Found",
                        "unauthorized" => "401 Unauthorized",
                        _ => "301 Moved Permanently",
                    };
                    (format!("HTTP/1.1 {status}\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),Vec::new())
                } else {
                    let image =
                        image::RgbaImage::from_pixel(256, 256, image::Rgba([7, 20, 40, 255]));
                    let mut bytes = Cursor::new(Vec::new());
                    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
                    let bytes = bytes.into_inner();
                    (format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()),bytes)
                };
                let _ = socket.write_all(header.as_bytes());
                let _ = socket.write_all(&bytes);
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn source(&self) -> HttpSource {
        HttpSource {
            id: "redirect".into(),
            name: "Redirect fixture".into(),
            attribution: "".into(),
            license: "".into(),
            url_template: format!("{}/tile/{{z}}/{{x}}/{{y}}", self.url),
            scheme: TileScheme::XYZ,
            tile_size: 256,
            network_policy: NetworkPolicy::UserTrustedHttp,
            min_interval_ms: 0,
            subdomains: vec![],
            coordinate_system: None,
            elevation_encoding: None,
            authentication: None,
            runtime_token: None,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
    }
}
#[tokio::test]
async fn same_origin_historical_tile_redirect_is_decoded_with_one_current_token() {
    let server = Server::start("success");
    let mut source = server.source();
    source.authentication = Some(SourceAuthentication {
        mode: AuthenticationMode::QueryToken,
        parameter: "token".into(),
        credential_ref: "test-fixture".into(),
        version: "v1".into(),
        origin: server.url.clone(),
    });
    source.runtime_token = Some(RuntimeToken("current-fixture-value".into()));
    let bytes = fetch_preview_tile(&source, 1, 0, 0, ProxyRoute::Direct)
        .await
        .unwrap();
    let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
    assert_eq!(image.get_pixel(0, 0).0, [7, 20, 40, 255]);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let target = reqwest::Url::parse(&format!("{}{}", server.url, requests[1])).unwrap();
    let tokens = target
        .query_pairs()
        .filter(|(key, _)| key == "token")
        .map(|(_, v)| v.to_string())
        .collect::<Vec<_>>();
    assert_eq!(tokens, ["current-fixture-value"]);
    assert!(target
        .query_pairs()
        .any(|(key, value)| key == "keep" && value == "yes"));
}
#[tokio::test]
async fn cross_origin_302_does_not_forward_query_or_bearer_credentials() {
    let receiver = Server::start("success");
    for mode in [
        AuthenticationMode::QueryToken,
        AuthenticationMode::BearerToken,
    ] {
        let server = Server::start_redirect("cross", Some(format!("{}/payload", receiver.url)));
        let mut source = server.source();
        source.authentication = Some(SourceAuthentication {
            mode,
            parameter: "token".into(),
            credential_ref: "test-fixture".into(),
            version: "v1".into(),
            origin: server.url.clone(),
        });
        source.runtime_token = Some(RuntimeToken("current-fixture-value".into()));
        let error = fetch_preview_tile(&source, 1, 0, 0, ProxyRoute::Direct)
            .await
            .unwrap_err();
        assert_eq!(error.code, "SOURCE_REDIRECT_DENIED");
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert_eq!(
            receiver.requests.lock().unwrap().len(),
            0,
            "Untrusted origin received a request"
        );
    }
}
#[tokio::test]
async fn unauthorized_location_is_not_followed_with_credentials() {
    let receiver = Server::start("success");
    let server = Server::start_redirect("unauthorized", Some(format!("{}/payload", receiver.url)));
    let mut source = server.source();
    source.authentication = Some(SourceAuthentication {
        mode: AuthenticationMode::QueryToken,
        parameter: "token".into(),
        credential_ref: "test-fixture".into(),
        version: "v1".into(),
        origin: server.url.clone(),
    });
    source.runtime_token = Some(RuntimeToken("current-fixture-value".into()));
    let error = fetch_preview_tile(&source, 1, 0, 0, ProxyRoute::Direct)
        .await
        .unwrap_err();
    assert_eq!(error.code, "SOURCE_CREDENTIAL_REJECTED");
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert!(receiver.requests.lock().unwrap().is_empty());
}
#[tokio::test]
async fn redirect_loop_has_finite_network_requests() {
    let server = Server::start("loop");
    let error = fetch_preview_tile(&server.source(), 1, 0, 0, ProxyRoute::Direct)
        .await
        .unwrap_err();
    assert_eq!(error.code, "SOURCE_REDIRECT_LIMIT");
    assert_eq!(server.requests.lock().unwrap().len(), 6);
}

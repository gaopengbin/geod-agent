use geod_core::imagery::{fetch_preview_tile, AuthenticationMode, HttpSource, NetworkPolicy, ProxyRoute, RuntimeToken, SourceAuthentication, TileScheme};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use std::{io::{Cursor, Read, Write}, net::TcpListener, thread};

fn source(address: &str, mode: AuthenticationMode, parameter: &str) -> HttpSource {
    HttpSource { subdomains: Vec::new(), coordinate_system: None, elevation_encoding: None, id: "auth-fixture".into(), name: "Declared authentication fixture".into(), attribution: "Synthetic pixels".into(), license: "".into(),
        url_template: format!("http://{address}/{{z}}/{{x}}/{{y}}?LAYER=img&FORMAT=tiles"), scheme: TileScheme::XYZ, tile_size: 256,
        network_policy: NetworkPolicy::UserTrustedHttp, min_interval_ms: 0,
        authentication: Some(SourceAuthentication { mode, parameter: parameter.into(), credential_ref: "fixture-ref".into(), version: "v1".into(), origin: format!("http://{address}") }),
        runtime_token: Some(RuntimeToken("declared-test-token".into())) }
}

fn serve(expected: &'static str, status: &'static str) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let worker = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap(); stream.set_nonblocking(false).unwrap();
        let mut buffer = [0; 8192]; let n = stream.read(&mut buffer).unwrap();
        let request = String::from_utf8_lossy(&buffer[..n]);
        assert!(request.to_ascii_lowercase().contains(expected));
        assert!(request.contains("LAYER=img&FORMAT=tiles"));
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(RgbImage::from_pixel(256, 256, Rgb([32, 80, 140]))).write_to(&mut bytes, ImageFormat::Png).unwrap();
        let bytes = bytes.into_inner();
        write!(stream, "HTTP/1.1 {status}\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).unwrap();
        stream.write_all(&bytes).unwrap();
    });
    (address, worker)
}

#[tokio::test]
async fn three_authentication_modes_fetch_real_images_without_serializing_secrets() {
    for (mode, parameter, expected) in [
        (AuthenticationMode::QueryToken, "tk", "tk=declared-test-token"),
        (AuthenticationMode::BearerToken, "Authorization", "authorization: bearer declared-test-token"),
        (AuthenticationMode::HeaderToken, "X-API-Key", "x-api-key: declared-test-token"),
    ] {
        let (address, worker) = serve(expected, "200 OK"); let endpoint = source(&address, mode, parameter);
        let bytes = fetch_preview_tile(&endpoint, 2, 2, 1, ProxyRoute::Direct).await.unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 256); worker.join().unwrap();
        assert!(!serde_json::to_string(&endpoint).unwrap().contains("declared-test-token"));
        assert!(!format!("{endpoint:?}").contains("declared-test-token"));
        let mut rotated = endpoint.clone(); rotated.runtime_token = Some(RuntimeToken("another-secret".into()));
        assert_eq!(endpoint.configuration_revision(), rotated.configuration_revision());
        rotated.authentication.as_mut().unwrap().version = "v2".into();
        assert_ne!(endpoint.configuration_revision(), rotated.configuration_revision());
    }
}

#[tokio::test]
async fn authentication_failures_do_not_echo_secrets_or_request_without_a_key() {
    let (address, worker) = serve("tk=declared-test-token", "401 Unauthorized");
    let mut endpoint = source(&address, AuthenticationMode::QueryToken, "tk");
    let failure = fetch_preview_tile(&endpoint, 2, 2, 1, ProxyRoute::Direct).await.unwrap_err(); worker.join().unwrap();
    assert_eq!(failure.code, "SOURCE_CREDENTIAL_REJECTED"); assert!(!failure.message.contains("declared-test-token"));
    endpoint.runtime_token = None;
    assert_eq!(fetch_preview_tile(&endpoint, 2, 2, 1, ProxyRoute::Direct).await.unwrap_err().code, "SOURCE_CREDENTIAL_REQUIRED");
    endpoint.url_template = "http://127.0.0.1:1/{z}/{x}/{y}".into();
    assert_eq!(endpoint.validate_configuration().unwrap_err().code, "INVALID_SOURCE_AUTH");
}

#[test]
fn wmts_query_parameters_and_arcgis_render_parameters_are_supported_but_inline_keys_are_rejected() {
    let mut endpoint = source("127.0.0.1:1", AuthenticationMode::QueryToken, "tk");
    endpoint.validate_configuration().unwrap(); endpoint.url_template.push_str("&tk=do-not-persist");
    assert_eq!(endpoint.validate_configuration().unwrap_err().code, "SOURCE_TOKEN_IN_URL");
    endpoint.url_template = "http://127.0.0.1:1/arcgis/rest/service/ImageServer/exportImage?format=png32".into();
    endpoint.validate_configuration().unwrap();
    endpoint.authentication = None;
    endpoint.url_template = "https://t0.tianditu.gov.cn/img_c/wmts?TILEMATRIX={z}&TILEROW={y}&TILECOL={x}".into();
    assert_eq!(endpoint.validate_configuration().unwrap_err().code, "SOURCE_GRID_UNSUPPORTED");
}

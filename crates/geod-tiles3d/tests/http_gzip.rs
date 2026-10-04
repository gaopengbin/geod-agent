use flate2::{write::GzEncoder, Compression};
use geod_tiles3d::{download, CancellationToken, DownloadRequest};
use std::{io::Write, time::Duration};
use tiny_http::{Header, Response, Server};

fn encoded(body: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(body).unwrap();
    encoder.finish().unwrap()
}

async fn run(oversized: bool) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", server.server_addr());
    let worker = std::thread::spawn(move || {
        for index in 0..2 {
            let request = server
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap();
            assert!(request
                .headers()
                .iter()
                .any(|h| h.field.equiv("Accept-Encoding") && h.value.as_str().contains("gzip")));
            let body = if index == 0 {
                r#"{"asset":{"version":"1.0"},"geometricError":0,"root":{"boundingVolume":{"region":[0,0,0.01,0.01,0,10]},"geometricError":0,"content":{"uri":"content.gltf"}}}"#.to_string()
            } else {
                format!(
                    r#"{{"asset":{{"version":"2.0"}},"scenes":[{{"nodes":[]}}],"scene":0,"extras":{{"label":"{}"}}}}"#,
                    if oversized {
                        "x".repeat(4096)
                    } else {
                        "actual gzip fixture".into()
                    }
                )
            };
            let gzip = encoded(body.as_bytes());
            if oversized {
                assert!(gzip.len() < 256);
            }
            request
                .respond(
                    Response::from_data(gzip)
                        .with_header(Header::from_bytes("Content-Encoding", "gzip").unwrap()),
                )
                .unwrap();
        }
    });
    let temp = tempfile::tempdir().unwrap();
    let output = temp.path().join("bundle");
    let mut request = DownloadRequest::new(format!("{origin}/tileset.json"), &output);
    request.retries = 0;
    request.max_asset_bytes = if oversized { 256 } else { 65536 };
    let result = download(request, CancellationToken::new(), |_| {}).await;
    if oversized {
        assert!(result.err().unwrap().contains("file size"));
        assert!(
            !output.exists(),
            "failed oversized response must not publish a bundle"
        );
    } else {
        let bundle = result.unwrap();
        assert_eq!(bundle.resources.len(), 2);
        assert!(bundle.resources.iter().any(|r| r.kind == "gltf"));
        let root = std::fs::read(output.join("tileset.json")).unwrap();
        assert_eq!(root[0], b'{');
        geod_tiles3d::inspect(&output).unwrap();
    }
    worker.join().unwrap();
}

#[tokio::test]
async fn gzip_root_and_content_are_decoded_before_offline_rewrite() {
    run(false).await;
}
#[tokio::test]
async fn gzip_expansion_still_obeys_decoded_resource_limit() {
    run(true).await;
}

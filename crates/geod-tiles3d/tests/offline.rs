use geod_tiles3d::{download, inspect, CancellationToken, DownloadRequest};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
struct Server {
    url: String,
    hits: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(routes: HashMap<String, Vec<u8>>) -> Self {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr());
        let hits = Arc::new(Mutex::new(vec![]));
        let out = hits.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let handle = thread::spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                if let Some(req) = server.recv_timeout(Duration::from_millis(50)).unwrap() {
                    out.lock().unwrap().push(req.url().into());
                    let path = req.url().split('?').next().unwrap();
                    let response = match routes.get(path) {
                        Some(b) => tiny_http::Response::from_data(b.clone()),
                        None => tiny_http::Response::from_data(b"missing".to_vec())
                            .with_status_code(404),
                    };
                    let _ = req.respond(response);
                }
            }
        });
        Self {
            url,
            hits,
            stop,
            handle: Some(handle),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            h.join().unwrap();
        }
    }
}
fn glb(mut doc: Value) -> Vec<u8> {
    doc["asset"] = json!({"version":"2.0"});
    let mut json = serde_json::to_vec(&doc).unwrap();
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    let mut out = b"glTF".to_vec();
    out.extend(2u32.to_le_bytes());
    out.extend(((20 + json.len()) as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(json);
    out
}
fn b3dm(glb: Vec<u8>) -> Vec<u8> {
    let ft = b"{\"BATCH_LENGTH\":0}  ";
    let mut out = b"b3dm".to_vec();
    for n in [1, 28 + ft.len() + glb.len(), ft.len(), 0, 0, 0] {
        out.extend((n as u32).to_le_bytes());
    }
    out.extend(ft);
    out.extend(glb);
    out
}
fn pnts() -> Vec<u8> {
    let mut ft = b"{\"POINTS_LENGTH\":1,\"POSITION\":{\"byteOffset\":0}}".to_vec();
    while (28 + ft.len()) % 8 != 0 {
        ft.push(b' ');
    }
    let mut out = b"pnts".to_vec();
    for n in [1, 28 + ft.len() + 12, ft.len(), 12, 0, 0] {
        out.extend((n as u32).to_le_bytes());
    }
    out.extend(ft);
    out.extend([0u8; 12]);
    out
}
fn tileset(root: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"asset":{"version":"1.1"},"geometricError":100,"root":root}))
        .unwrap()
}
fn node(uri: &str, region: [f64; 6]) -> Value {
    json!({"boundingVolume":{"region":region},"geometricError":0,"content":{"uri":uri}})
}

fn geographic_region(b: [f64; 4]) -> [f64; 6] {
    [
        b[0].to_radians(),
        b[1].to_radians(),
        b[2].to_radians(),
        b[3].to_radians(),
        0.,
        100.,
    ]
}
fn aoi(polygons: Vec<Vec<Vec<[f64; 2]>>>) -> geod_core::boundary::BoundaryGeometry {
    geod_core::boundary::BoundaryGeometry { polygons }
}
fn ring(b: [f64; 4]) -> Vec<[f64; 2]> {
    vec![
        [b[0], b[1]],
        [b[2], b[1]],
        [b[2], b[3]],
        [b[0], b[3]],
        [b[0], b[1]],
    ]
}

#[tokio::test]
async fn polygon_aoi_prunes_concavity_holes_and_between_islands_before_content_requests() {
    let cases = [
        (
            "concave",
            aoi(vec![vec![vec![
                [0., 0.],
                [6., 0.],
                [6., 2.],
                [2., 2.],
                [2., 6.],
                [0., 6.],
                [0., 0.],
            ]]]),
            [4., 4., 5., 5.],
        ),
        (
            "hole",
            aoi(vec![vec![ring([0., 0., 6., 6.]), ring([2., 2., 4., 4.])]]),
            [2.5, 2.5, 3.5, 3.5],
        ),
        (
            "islands",
            aoi(vec![
                vec![ring([0., 0., 2., 2.])],
                vec![ring([4., 4., 6., 6.])],
            ]),
            [2.5, 2.5, 3.5, 3.5],
        ),
    ];
    for (label, boundary, excluded) in cases {
        let root = json!({"boundingVolume":{"region":geographic_region([0.,0.,6.,6.])},"geometricError":100,"children":[
            node("inside.glb", geographic_region([0.2,0.2,0.8,0.8])),
            node("excluded.glb", geographic_region(excluded)),
            node("empty-external.json", geographic_region([0.,0.,6.,6.])),
            {"boundingVolume":{"extensions":{"unknown":{}}},"geometricError":0,"content":{"uri":"unknown.glb"}},
            {"boundingVolume":{"region":geographic_region([0.,0.,6.,6.])},"geometricError":0,"contents":[
                {"uri":"content-inside.glb","boundingVolume":{"region":geographic_region([0.2,0.2,0.8,0.8])}},
                {"uri":"content-excluded.glb","boundingVolume":{"region":geographic_region(excluded)}}
            ]}
        ]});
        let mut routes = HashMap::from([("/tileset.json".into(), tileset(root))]);
        routes.insert(
            "/empty-external.json".into(),
            tileset(node("external-excluded.glb", geographic_region(excluded))),
        );
        for name in [
            "inside",
            "excluded",
            "unknown",
            "content-inside",
            "content-excluded",
        ] {
            routes.insert(format!("/{name}.glb"), glb(json!({})));
        }
        let server = Server::new(routes);
        let tmp = tempfile::tempdir().unwrap();
        let output = tmp.path().join(label);
        let mut req = DownloadRequest::new(format!("{}/tileset.json", server.url), &output);
        req.bounds = Some([0., 0., 6., 6.]);
        req.boundary = Some(boundary.clone());
        let bundle = download(req, CancellationToken::new(), |_| {})
            .await
            .unwrap();
        assert_eq!(bundle.boundary, Some(boundary));
        assert_eq!(bundle.resources.len(), 5, "{label}");
        let hits = server.hits.lock().unwrap();
        assert!(
            !hits.iter().any(|path| path.contains("excluded")),
            "{label}: {hits:?}"
        );
        assert!(
            hits.iter().any(|path| path.contains("unknown")),
            "Unknown geolocation must be retained"
        );
        inspect(&output).unwrap();
    }
}

#[tokio::test]
async fn implicit_polygon_prunes_subtrees_and_keeps_separate_islands() {
    let root = json!({"boundingVolume":{"region":geographic_region([0.,0.,4.,4.])},"geometricError":100.,"refine":"ADD","content":{"uri":"c/{level}-{x}-{y}.glb"},"implicitTiling":{"subdivisionScheme":"QUADTREE","availableLevels":3,"subtreeLevels":1,"subtrees":{"uri":"s/{level}-{x}-{y}.json"}}});
    let tree = serde_json::to_vec(&json!({"tileAvailability":{"constant":1},"contentAvailability":[{"constant":1}],"childSubtreeAvailability":{"constant":1}})).unwrap();
    let mut routes = HashMap::from([("/tileset.json".into(), tileset(root))]);
    for level in 0..3 {
        for x in 0..(1 << level) {
            for y in 0..(1 << level) {
                routes.insert(format!("/s/{level}-{x}-{y}.json"), tree.clone());
                routes.insert(format!("/c/{level}-{x}-{y}.glb"), glb(json!({})));
            }
        }
    }
    let server = Server::new(routes);
    let tmp = tempfile::tempdir().unwrap();
    let output = tmp.path().join("implicit-islands");
    let mut req = DownloadRequest::new(format!("{}/tileset.json", server.url), &output);
    req.boundary = Some(aoi(vec![
        vec![ring([0.1, 0.1, 0.9, 0.9])],
        vec![ring([3.1, 3.1, 3.9, 3.9])],
    ]));
    let bundle = download(req, CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!(bundle.resources.len(), 6);
    let hits = server.hits.lock().unwrap();
    assert_eq!(hits.iter().filter(|p| p.starts_with("/s/")).count(), 5);
    for suffix in ["1-0-1", "1-1-0", "2-1-1", "2-2-2"] {
        assert!(
            !hits.iter().any(|path| path.contains(suffix)),
            "Excluded subtree was fetched: {hits:?}"
        );
    }
    assert!(hits.iter().any(|path| path == "/c/2-0-0.glb"));
    assert!(hits.iter().any(|path| path == "/c/2-3-3.glb"));
    inspect(&output).unwrap();
}

#[tokio::test]
async fn polygon_with_only_empty_external_tilesets_cannot_publish_false_complete() {
    let root = node("nested.json", geographic_region([0., 0., 6., 6.]));
    let server = Server::new(HashMap::from([
        ("/tileset.json".into(), tileset(root)),
        (
            "/nested.json".into(),
            tileset(node("outside.glb", geographic_region([3., 3., 4., 4.]))),
        ),
    ]));
    let tmp = tempfile::tempdir().unwrap();
    let output = tmp.path().join("empty");
    let mut req = DownloadRequest::new(format!("{}/tileset.json", server.url), &output);
    req.boundary = Some(aoi(vec![vec![ring([0., 0., 1., 1.])]]));
    let error = download(req, CancellationToken::new(), |_| {})
        .await
        .unwrap_err();
    assert!(error.contains("no downloadable 3D content"));
    assert!(!output.exists());
    assert!(!server
        .hits
        .lock()
        .unwrap()
        .iter()
        .any(|path| path.ends_with("outside.glb")));
}

#[tokio::test]
async fn recursive_external_tilesets_models_textures_and_pointcloud_are_offline() {
    let region = [0., 0., 0.1, 0.1, 0., 100.];
    let root = json!({"boundingVolume":{"region":region},"geometricError":100,"children":[node("nested/tileset.json",region),node("outside.b3dm",[1.,1.,1.1,1.1,0.,10.])]});
    let nested = json!({"boundingVolume":{"region":region},"geometricError":0,"contents":[{"uri":"../models/model.b3dm"},{"uri":"points.pnts"},{"uri":"../models/standalone.glb"}]});
    let model = glb(
        json!({"images":[{"uri":"textures/albedo.png"}],"buffers":[{"uri":"mesh.bin","byteLength":4}]}),
    );
    let server = Server::new(HashMap::from([
        ("/tileset.json".into(), tileset(root)),
        ("/nested/tileset.json".into(), tileset(nested)),
        ("/models/model.b3dm".into(), b3dm(model.clone())),
        ("/models/standalone.glb".into(), model),
        ("/nested/points.pnts".into(), pnts()),
        ("/models/textures/albedo.png".into(), b"PNGfixture".to_vec()),
        ("/models/mesh.bin".into(), vec![1, 2, 3, 4]),
    ]));
    let tmp = tempfile::tempdir().unwrap();
    let output = tmp.path().join("bundle");
    let mut request =
        DownloadRequest::new(format!("{}/tileset.json?token=secret", server.url), &output);
    request.bounds = Some([0., 0., 1., 1.]);
    request.inherit_query = true;
    let bundle = download(request, CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!(bundle.resources.len(), 7);
    assert!(bundle.resources.iter().any(|a| a.kind == "pnts"));
    assert!(bundle.resources.iter().any(|a| a.kind == "b3dm"));
    assert!(bundle.resources.iter().any(|a| a.kind == "glb"));
    assert!(!server
        .hits
        .lock()
        .unwrap()
        .iter()
        .any(|s| s.contains("outside")));
    assert!(server
        .hits
        .lock()
        .unwrap()
        .iter()
        .all(|s| s.contains("token=secret")));
    drop(server);
    inspect(&output).unwrap();
    let manifest = std::fs::read_to_string(output.join("manifest.json")).unwrap();
    assert!(!manifest.contains("secret"));
    let resource = &bundle
        .resources
        .iter()
        .find(|a| a.kind == "resource")
        .unwrap()
        .path;
    std::fs::write(output.join(resource), b"tampered").unwrap();
    assert!(inspect(&output).unwrap_err().contains("checksum"));
}
#[tokio::test]
async fn invalid_binary_cannot_publish_a_complete_bundle() {
    let r = [0., 0., 0.1, 0.1, 0., 10.];
    let server = Server::new(HashMap::from([
        ("/tileset.json".into(), tileset(node("model.glb", r))),
        ("/model.glb".into(), b"glTFbad".to_vec()),
    ]));
    let tmp = tempfile::tempdir().unwrap();
    let output = tmp.path().join("bad");
    let error = download(
        DownloadRequest::new(format!("{}/tileset.json", server.url), &output),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(error.contains("Truncated"));
    assert!(!output.exists());
}
#[tokio::test]
async fn cancel_removes_staging_and_never_overwrites() {
    let tmp = tempfile::tempdir().unwrap();
    let output = tmp.path().join("cancel");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = download(
        DownloadRequest::new("http://127.0.0.1:9/tileset.json", &output),
        cancel,
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(error.contains("cancelled"));
    assert!(!output.exists());
    assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
}
#[tokio::test]
async fn cyclical_external_tileset_is_rejected() {
    let r = [0., 0., 0.1, 0.1, 0., 10.];
    let server = Server::new(HashMap::from([(
        "/tileset.json".into(),
        tileset(node("tileset.json", r)),
    )]));
    let tmp = tempfile::tempdir().unwrap();
    let err = download(
        DownloadRequest::new(
            format!("{}/tileset.json", server.url),
            tmp.path().join("cycle"),
        ),
        CancellationToken::new(),
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(err.contains("Cyclic"));
}

#[tokio::test]
async fn implicit_availability_external_buffers_metadata_and_spatial_filter() {
    let root = json!({"boundingVolume":{"region":[0.,0.,0.2,0.2,0.,100.]},"geometricError":100.,"refine":"ADD","content":{"uri":"c/{level}-{x}-{y}.glb"},"implicitTiling":{"subdivisionScheme":"QUADTREE","availableLevels":2,"subtreeLevels":2,"subtrees":{"uri":"s/{level}-{x}-{y}.json"}}});
    let mut doc: Value = serde_json::from_slice(&tileset(root)).unwrap();
    doc["schema"] = json!({"classes":{"tile":{"properties":{"height":{"type":"SCALAR","componentType":"UINT16"},"category":{"type":"ENUM","enumType":"category"}}}},"enums":{"category":{"valueType":"UINT8","values":[{"name":"ground","value":1},{"name":"roof","value":2}]}}});
    let subtree = json!({"buffers":[{"uri":"availability.bin","byteLength":16}],"bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":1},{"buffer":0,"byteOffset":1,"byteLength":10},{"buffer":0,"byteOffset":11,"byteLength":5}],"tileAvailability":{"constant":1},"contentAvailability":[{"bitstream":0}],"childSubtreeAvailability":{"constant":0},"tileMetadata":0,"propertyTables":[{"class":"tile","count":5,"properties":{"height":{"values":1,"scale":2},"category":{"values":2}}}]});
    let mut buffer = vec![0b0001_1110];
    for height in [10u16, 20, 30, 40, 50] {
        buffer.extend(height.to_le_bytes());
    }
    buffer.extend([1, 2, 1, 2, 1]);
    let mut routes = HashMap::from([
        ("/tileset.json".into(), serde_json::to_vec(&doc).unwrap()),
        (
            "/s/0-0-0.json".into(),
            serde_json::to_vec(&subtree).unwrap(),
        ),
        ("/s/availability.bin".into(), buffer),
    ]);
    for x in 0..2 {
        for y in 0..2 {
            routes.insert(format!("/c/1-{x}-{y}.glb"), glb(json!({})));
        }
    }
    let server = Server::new(routes);
    let tmp = tempfile::tempdir().unwrap();
    let output = tmp.path().join("filtered");
    let mut req = DownloadRequest::new(format!("{}/tileset.json", server.url), &output);
    req.bounds = Some([0.1, 0.1, 1., 1.]);
    let bundle = download(req, CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!(bundle.resources.len(), 2);
    let saved: Value =
        serde_json::from_slice(&std::fs::read(output.join("tileset.json")).unwrap()).unwrap();
    assert!(saved["root"].get("implicitTiling").is_none());
    assert_eq!(saved["root"]["children"].as_array().unwrap().len(), 1);
    assert_eq!(
        saved["root"]["children"][0]["metadata"]["properties"]["height"],
        20
    );
    assert_eq!(
        saved["root"]["children"][0]["metadata"]["properties"]["category"],
        "roof"
    );
    let class = saved["root"]["children"][0]["metadata"]["class"]
        .as_str()
        .unwrap();
    assert_eq!(
        saved["schema"]["classes"][class]["properties"]["height"]["scale"],
        2
    );
    let hits = server.hits.lock().unwrap();
    assert!(hits.iter().any(|p| p == "/c/1-0-0.glb"));
    assert!(!hits.iter().any(|p| p == "/c/1-1-1.glb"));
    inspect(&output).unwrap();
}

#[tokio::test]
async fn retries_transient_http_and_cancel_interrupts_an_inflight_response() {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://{}", server.server_addr());
    let hits = Arc::new(Mutex::new(0usize));
    let count = hits.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let done = stop.clone();
    let handle = thread::spawn(move || {
        while !done.load(Ordering::Relaxed) {
            if let Some(req) = server.recv_timeout(Duration::from_millis(50)).unwrap() {
                let path = req.url().to_owned();
                let (bytes, status) = if path == "/tileset.json" {
                    (
                        tileset(node("flaky.glb", [0., 0., 0.1, 0.1, 0., 100.])),
                        200,
                    )
                } else {
                    let mut n = count.lock().unwrap();
                    *n += 1;
                    if *n == 1 {
                        (b"retry".to_vec(), 503)
                    } else if path == "/slow.json" {
                        thread::sleep(Duration::from_millis(900));
                        (b"{}".to_vec(), 200)
                    } else {
                        (glb(json!({})), 200)
                    }
                };
                let _ = req.respond(tiny_http::Response::from_data(bytes).with_status_code(status));
            }
        }
    });
    let tmp = tempfile::tempdir().unwrap();
    let mut request =
        DownloadRequest::new(format!("{url}/tileset.json"), tmp.path().join("retried"));
    request.retries = 1;
    download(request, CancellationToken::new(), |_| {})
        .await
        .unwrap();
    assert_eq!(*hits.lock().unwrap(), 2);
    let cancel = CancellationToken::new();
    let other = cancel.clone();
    let request = DownloadRequest::new(format!("{url}/slow.json"), tmp.path().join("cancelled"));
    let task = tokio::spawn(async move { download(request, other, |_| {}).await });
    tokio::time::sleep(Duration::from_millis(80)).await;
    cancel.cancel();
    let result = tokio::time::timeout(Duration::from_millis(300), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(result.contains("cancelled"));
    assert!(!tmp.path().join("cancelled").exists());
    stop.store(true, Ordering::Relaxed);
    handle.join().unwrap();
}

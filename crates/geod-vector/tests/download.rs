use geod_vector::{
    mvt::{Feature, Layer, Tile, TileValue},
    Error, NetworkOptions, OutputFormat, Request, RunOptions, Source, TileScheme,
};
use prost::Message;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

fn tile() -> Vec<u8> {
    Tile {
        layers: vec![Layer {
            name: "places".into(),
            version: 2,
            extent: Some(4096),
            keys: vec!["name".into()],
            values: vec![TileValue {
                string_value: Some("Test place".into()),
                ..Default::default()
            }],
            features: vec![Feature {
                id: Some(9007199254740993),
                tags: vec![0, 0],
                kind: Some(1),
                geometry: vec![9, 4096, 4096],
            }],
        }],
    }
    .encode_to_vec()
}
async fn server(
    bytes: Vec<u8>,
    fail_first: bool,
    slow: bool,
) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));
    let count = hits.clone();
    let handle = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let data = bytes.clone();
            let n = count.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut request = [0; 8192];
                let _ = socket.read(&mut request).await;
                if slow {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
                let (status, body) = if fail_first && n == 0 {
                    ("500 Server Error", b"retry".to_vec())
                } else {
                    ("200 OK", data)
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.write_all(&body).await;
            });
        }
    });
    (
        format!("http://{address}/{{z}}/{{x}}/{{y}}.pbf"),
        hits,
        handle,
    )
}
fn request(url: String) -> Request {
    Request {
        source: Source::Mvt {
            id: "test".into(),
            name: "Test source".into(),
            url_template: url,
            scheme: TileScheme::Xyz,
            layers: vec![],
            attribution: "fixture".into(),
        },
        bounds: [85.0, 65.0, 95.0, 68.0],
        boundary: None,
        zoom_levels: vec![1],
        outputs: vec![
            OutputFormat::Pbf,
            OutputFormat::Mbtiles,
            OutputFormat::Geojson,
            OutputFormat::Gpkg,
        ],
        allow_partial: false,
    }
}
#[tokio::test]
async fn native_packages_retry_resume_and_integrity() {
    let (url, hits, server) = server(tile(), true, false).await;
    let root = tempfile::tempdir().unwrap();
    let plan = geod_vector::plan(request(url)).unwrap();
    let mut options = RunOptions::new(root.path().join("out"), root.path().join("cache"));
    options.network = NetworkOptions {
        allow_local_http: true,
        ..Default::default()
    };
    let manifest = geod_vector::run(&plan, options, |_| {}).await.unwrap();
    assert_eq!(hits.load(Ordering::SeqCst), 2);
    assert_eq!(manifest.tile_count, 1);
    assert_eq!(manifest.feature_count, 1);
    assert_eq!(
        std::fs::read(root.path().join("out/tiles/1/1/0.pbf")).unwrap(),
        tile()
    );
    assert_eq!(manifest.assets.len(), 6);
    assert_eq!(
        geod_vector::inspect(&root.path().join("out"))
            .unwrap()
            .feature_count,
        1
    );
    let preview: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.path().join("out/preview.geojson")).unwrap())
            .unwrap();
    assert_eq!(
        preview["features"][0]["properties"]["_sourceId"],
        "9007199254740993"
    );
    let mut options = RunOptions::new(root.path().join("out-again"), root.path().join("cache"));
    options.network.allow_local_http = true;
    let mut cache_hits = 0;
    geod_vector::run(&plan, options, |p| cache_hits = p.cache_hits)
        .await
        .unwrap();
    assert_eq!(cache_hits, 1);
    assert_eq!(hits.load(Ordering::SeqCst), 2);
    let manifest_path = root.path().join("out/manifest.json");
    let original = std::fs::read(&manifest_path).unwrap();
    let mut removed = manifest.clone();
    removed.assets.clear();
    std::fs::write(&manifest_path, serde_json::to_vec(&removed).unwrap()).unwrap();
    assert!(
        geod_vector::inspect(&root.path().join("out")).is_err(),
        "an empty manifest must not bypass file verification"
    );
    let mut wrong_count = manifest.clone();
    wrong_count.feature_count = 7;
    std::fs::write(&manifest_path, serde_json::to_vec(&wrong_count).unwrap()).unwrap();
    assert!(
        geod_vector::inspect(&root.path().join("out")).is_err(),
        "stored counts must match parsed data"
    );
    std::fs::write(&manifest_path, original).unwrap();
    std::fs::write(root.path().join("out/tiles/1/1/0.pbf"), b"corrupt").unwrap();
    assert!(geod_vector::inspect(&root.path().join("out")).is_err());
    server.abort();
}
#[tokio::test]
async fn cancelling_inflight_network_returns_promptly_without_bundle() {
    let (url, _, server) = server(tile(), false, true).await;
    let root = tempfile::tempdir().unwrap();
    let plan = geod_vector::plan(request(url)).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let mut options = RunOptions::new(root.path().join("out"), root.path().join("cache"));
    options.network.allow_local_http = true;
    options.cancel = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        cancel.store(true, Ordering::SeqCst);
    });
    let start = std::time::Instant::now();
    assert!(matches!(
        geod_vector::run(&plan, options, |_| {}).await,
        Err(Error::Cancelled)
    ));
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(!root.path().join("out").exists());
    server.abort();
}
#[test]
fn refuse_persisted_credentials_and_invalid_formats() {
    let mut r = request("https://example.test/{z}/{x}/{y}.pbf?key=secret".into());
    assert!(geod_vector::plan(r.clone()).is_err());
    r.source = Source::Osm {
        id: "osm".into(),
        name: "OSM".into(),
        endpoint: "https://overpass-api.de/api/interpreter".into(),
        tags: vec![],
    };
    r.zoom_levels.clear();
    assert!(geod_vector::plan(r).is_err());
}

#[tokio::test]
async fn polygon_filters_actual_osm_geojson_and_geopackage_outputs() {
    use serde_json::json;
    let body=serde_json::to_vec(&json!({"elements":[
        {"type":"node","id":1,"lon":1,"lat":1,"tags":{"name":"inside"}},
        {"type":"node","id":2,"lon":5,"lat":5,"tags":{"name":"hole"}},
        {"type":"node","id":3,"lon":15,"lat":1,"tags":{"name":"outside"}},
        {"type":"node","id":4,"lon":21,"lat":1,"tags":{"name":"island"}},
        {"type":"way","id":5,"geometry":[{"lon":-1,"lat":2},{"lon":11,"lat":2}],"tags":{"highway":"road"}}
    ]})).unwrap();
    let (url, _, server) = server(body, false, false).await;
    let mut r = request(url.clone());
    r.source = Source::Osm {
        id: "osm".into(),
        name: "OSM polygon fixture".into(),
        endpoint: url.replace("/{z}/{x}/{y}.pbf", "/osm"),
        tags: vec![],
    };
    r.zoom_levels.clear();
    r.outputs = vec![OutputFormat::Geojson, OutputFormat::Gpkg];
    r.boundary = Some(
        geod_core::boundary::BoundaryGeometry::from_geojson(
            &serde_json::to_vec(&json!({"type":"MultiPolygon","coordinates":[
                [[[0,0],[10,0],[10,10],[0,10],[0,0]],[[4,4],[4,6],[6,6],[6,4],[4,4]]],
                [[[20,0],[22,0],[22,2],[20,2],[20,0]]]
            ]}))
            .unwrap(),
        )
        .unwrap(),
    );
    let plan = geod_vector::plan(r).unwrap();
    assert_eq!(plan.request.bounds, [0., 0., 22., 10.]);
    let root = tempfile::tempdir().unwrap();
    let mut options = RunOptions::new(root.path().join("out"), root.path().join("cache"));
    options.network.allow_local_http = true;
    let manifest = geod_vector::run(&plan, options, |_| {}).await.unwrap();
    assert_eq!(manifest.feature_count, 3);
    let geojson: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.path().join("out/features.geojson")).unwrap())
            .unwrap();
    let ids = geojson["features"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(ids, vec!["node/1", "node/4", "way/5"]);
    assert_eq!(
        geojson["features"][2]["geometry"]["coordinates"],
        json!([[-1.0, 2.0], [11.0, 2.0]]),
        "Crossing features retain complete geometry"
    );
    let db = rusqlite::Connection::open(root.path().join("out/features.gpkg")).unwrap();
    let n: i64 = db
        .query_row("SELECT COUNT(*) FROM features", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 3);
    assert_eq!(
        geod_vector::inspect(&root.path().join("out"))
            .unwrap()
            .feature_count,
        3
    );
    server.abort();
}

#[tokio::test]
async fn mvt_exports_filter_bbox_and_holes_without_modifying_original_tiles() {
    use serde_json::json;
    let mut decoded = Tile::decode(tile().as_slice()).unwrap();
    decoded.layers[0].features.push(Feature {
        id: Some(2),
        tags: vec![0, 0],
        kind: Some(1),
        geometry: vec![9, 200, 4096],
    });
    let bytes = decoded.encode_to_vec();
    let (url, _, server) = server(bytes.clone(), false, false).await;
    let root = tempfile::tempdir().unwrap();
    let mut request = request(url);
    let original = geod_vector::plan(request.clone()).unwrap();
    let mut options = RunOptions::new(root.path().join("bbox"), root.path().join("cache"));
    options.network.allow_local_http = true;
    let manifest = geod_vector::run(&original, options, |_| {}).await.unwrap();
    assert_eq!(
        manifest.feature_count, 1,
        "the other point in the same downloaded tile is outside the requested rectangle"
    );
    assert_eq!(
        std::fs::read(root.path().join("bbox/tiles/1/1/0.pbf")).unwrap(),
        bytes
    );
    request.boundary = Some(
        geod_core::boundary::BoundaryGeometry::from_geojson(
            &serde_json::to_vec(&json!({"type":"Polygon","coordinates":[
                [[85,65],[95,65],[95,68],[85,68],[85,65]],
                [[89,66],[89,67],[91,67],[91,66],[89,66]]
            ]}))
            .unwrap(),
        )
        .unwrap(),
    );
    let plan = geod_vector::plan(request).unwrap();
    assert_ne!(plan.plan_hash, original.plan_hash);
    let mut options = RunOptions::new(root.path().join("hole"), root.path().join("cache"));
    options.network.allow_local_http = true;
    let manifest = geod_vector::run(&plan, options, |_| {}).await.unwrap();
    assert_eq!(manifest.tile_count, 1);
    assert_eq!(manifest.feature_count, 0);
    let data: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.path().join("hole/features.geojson")).unwrap())
            .unwrap();
    assert_eq!(data["features"], json!([]));
    let db = rusqlite::Connection::open(root.path().join("hole/features.gpkg")).unwrap();
    let count: i64 = db
        .query_row("SELECT COUNT(*) FROM features", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        geod_vector::inspect(&root.path().join("hole"))
            .unwrap()
            .feature_count,
        0
    );
    server.abort();
}

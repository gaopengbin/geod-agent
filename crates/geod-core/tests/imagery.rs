use geod_core::{
    boundary::BoundaryGeometry,
    imagery::{
        fetch_bundle, fetch_bundle_with_cache_control_proxy,
        fetch_bundle_with_cache_control_proxy_options, fetch_bundle_with_cancel, inspect_bundle,
        fetch_bundle_with_cache_control_proxy_progress, BundleProgress, BundleStage,
        DownloadOptions, HttpSource, ImageryRequest, NetworkPolicy, ProxyRoute, TileCacheConfig,
        TileScheme,
    },
    tile,
};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use rusqlite::Connection;
use std::{
    io::{Cursor, Read, Write},
    net::{SocketAddr, TcpListener},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tiff::{
    decoder::{Decoder, DecodingResult},
    tags::Tag,
};

#[tokio::test]
async fn pause_during_processing_keeps_tiles_and_resumes_without_network() {
    let fixture = Fixture::start(false);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("paused-export");
    let cache = TileCacheConfig {
        root: directory.path().join("checkpoint"), plan_hash: "a".repeat(64),
        job_id: uuid::Uuid::new_v4().to_string(),
    };
    let cancelled = AtomicBool::new(false);
    let paused = AtomicBool::new(false);
    let mut downloaded = 0;
    let result = fetch_bundle_with_cache_control_proxy_progress(
        &request(output.clone(), 256), &fixture.source(), &cancelled, &paused,
        &cache, ProxyRoute::Direct, |progress| {
            match progress {
                BundleProgress::Tiles { completed, .. } => downloaded = completed,
                BundleProgress::Stage(BundleStage::Processing) => {
                    assert_eq!(downloaded, 2);
                    assert!(!output.exists());
                    paused.store(true, Ordering::Relaxed);
                }
                _ => {},
            }
            Ok(())
        },
    ).await.unwrap_err();
    assert_eq!(result.code, "PAUSED");
    assert!(!output.exists());
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 2);
    paused.store(false, Ordering::Relaxed);
    let mut stages = Vec::new();
    fetch_bundle_with_cache_control_proxy_progress(
        &request(output.clone(), 256), &fixture.source(), &cancelled, &paused,
        &cache, ProxyRoute::Direct, |progress| {
            if let BundleProgress::Stage(stage) = progress { stages.push(stage); }
            Ok(())
        },
    ).await.unwrap();
    assert_eq!(stages.first(), Some(&BundleStage::Downloading));
    assert!(stages.contains(&BundleStage::Processing));
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 2);
    assert_eq!(inspect_bundle(&output).unwrap().quality.status, "complete");
}

struct Fixture {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    request_times: Arc<Mutex<Vec<Instant>>>,
    worker: Option<JoinHandle<()>>,
    tile_size: u16,
    tms: bool,
}

impl Fixture {
    fn start(missing_right: bool) -> Self {
        Self::start_mode(missing_right, 256, false, false)
    }

    fn start_mode(missing_right: bool, tile_size: u16, tms: bool, rate_limit_first: bool) -> Self {
        Self::start_mode_with_retry_after(missing_right, tile_size, tms, rate_limit_first, None)
    }

    fn start_mode_with_retry_after(
        missing_right: bool,
        tile_size: u16,
        tms: bool,
        rate_limit_first: bool,
        retry_after_seconds: Option<u64>,
    ) -> Self {
        Self::start_mode_with_transient_errors(
            missing_right,
            tile_size,
            tms,
            rate_limit_first,
            retry_after_seconds,
            0,
        )
    }

    fn start_mode_with_transient_errors(
        missing_right: bool,
        tile_size: u16,
        tms: bool,
        rate_limit_first: bool,
        retry_after_seconds: Option<u64>,
        temporary_failures: usize,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let request_times = Arc::new(Mutex::new(Vec::new()));
        let stop_worker = stop.clone();
        let count_worker = requests.clone();
        let times_worker = request_times.clone();
        let left = png([40, 90, 130, 255], tile_size);
        let right = png([150, 60, 20, 255], tile_size);
        let annotation = png([255,0,0,128], tile_size);
        let source_y = if tms { 1 } else { 0 };
        let left_path = format!("/1/0/{source_y}.png");
        let right_path = format!("/1/1/{source_y}.png");
        let worker = thread::spawn(move || {
            while !stop_worker.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_millis(500)))
                    .unwrap();
                let mut request = [0u8; 4096];
                let count = stream.read(&mut request).unwrap_or(0);
                let line = String::from_utf8_lossy(&request[..count]);
                let path = line
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1));
                if path.is_none() {
                    continue;
                }
                times_worker.lock().unwrap().push(Instant::now());
                let attempt = count_worker.fetch_add(1, Ordering::Relaxed);
                let (status, body): (&str, &[u8]) = if attempt < temporary_failures {
                    ("503 Service Unavailable", b"")
                } else if rate_limit_first && attempt == 0 {
                    ("429 Too Many Requests", b"")
                } else {
                    match path {
                        Some(value) if value.starts_with("/annotation/") => ("200 OK", &annotation),
                        Some(value) if value.ends_with(&left_path) || value.ends_with("/2/1/1.png") => ("200 OK", &left),
                        Some(value) if (value.ends_with(&right_path) || value.ends_with("/2/2/1.png")) && !missing_right => {
                            ("200 OK", &right)
                        }
                        _ => ("404 Not Found", b""),
                    }
                };
                let retry_after = if status.starts_with("429") {
                    retry_after_seconds
                        .map(|seconds| format!("Retry-After: {seconds}\r\n"))
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let header = format!("HTTP/1.1 {status}\r\nContent-Type: image/png\r\n{retry_after}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                stream.write_all(header.as_bytes()).unwrap();
                stream.write_all(body).unwrap();
            }
        });
        Self {
            address,
            stop,
            requests,
            request_times,
            worker: Some(worker),
            tile_size,
            tms,
        }
    }

    fn source(&self) -> HttpSource {
        HttpSource { subdomains: Vec::new(), coordinate_system: None, elevation_encoding: None, id: "synthetic-xyz".into(),
            name: "Synthetic XYZ fixture".into(),
            attribution: "Generated test pixels".into(),
            license: "Synthetic test data".into(),
            url_template: format!("http://{}/{{z}}/{{x}}/{{y}}.png", self.address),
            scheme: if self.tms {
                TileScheme::TMS
            } else {
                TileScheme::XYZ
            },
            tile_size: self.tile_size,
            network_policy: NetworkPolicy::UserTrustedHttp,
            min_interval_ms: 0, authentication: None, runtime_token: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
    }
}

fn png(color: [u8; 4], tile_size: u16) -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(
        u32::from(tile_size),
        u32::from(tile_size),
        Rgba(color),
    ))
    .write_to(&mut output, ImageFormat::Png)
    .unwrap();
    output.into_inner()
}

fn request(destination: std::path::PathBuf, tile_size: u16) -> ImageryRequest {
    ImageryRequest {
        name: "Synthetic fixture".into(),
        bounds: [-1.0, 1.0, 1.0, 2.0],
        boundary: None,
        grids: vec![tile::grid([-1.0, 1.0, 1.0, 2.0], 1, tile_size).unwrap()],
        output_geotiff: true,
        output_mbtiles: true,
        extra_outputs: Vec::new(),
        export_options: geod_core::imagery::ExportOptions::default(), overlays: Vec::new(),
        max_tiles: 2,
        max_decoded_rgba_bytes: 2 * u64::from(tile_size).pow(2) * 4,
        destination,
        deadline: Duration::from_secs(10),
    }
}

// These retry tests intentionally use one lane so request ordering and counts
// describe retries rather than requests already in flight when control changes.
async fn fetch_serial_bundle(
    request: &ImageryRequest,
    source: &HttpSource,
) -> Result<geod_core::imagery::Manifest, geod_core::imagery::CoreError> {
    let directory = tempfile::tempdir().unwrap();
    let cache = TileCacheConfig {
        root: directory.path().join("cache"),
        plan_hash: "c".repeat(64),
        job_id: uuid::Uuid::new_v4().to_string(),
    };
    fetch_bundle_with_cache_control_proxy_options(
        request,
        source,
        &AtomicBool::new(false),
        &AtomicBool::new(false),
        &cache,
        ProxyRoute::Direct,
        DownloadOptions { concurrency: 1 },
        |_, _| Ok(()),
    )
    .await
}

#[tokio::test]
async fn publishes_inspectable_geotiff_mbtiles_and_manifest() {
    let fixture = Fixture::start(false);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("complete");
    let manifest = fetch_bundle(&request(output.clone(), 256), &fixture.source())
        .await
        .unwrap();
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 2);
    assert_eq!(manifest.quality.status, "complete");
    assert_eq!(manifest.quality.missing_tiles, 0);
    assert_eq!(manifest.assets.len(), 3);
    assert_eq!(
        (manifest.assets[1].width, manifest.assets[1].height),
        (Some(4), Some(2))
    );
    assert_eq!(inspect_bundle(&output).unwrap().assets.len(), 3);

    let mut tiff =
        Decoder::new(std::fs::File::open(output.join("imagery-z1.tif")).unwrap()).unwrap();
    assert_eq!(tiff.dimensions().unwrap(), (4, 2));
    assert_eq!(tiff.get_tag_u32(Tag::Compression).unwrap(), 1, "Default GeoTIFF must be uncompressed");
    assert!(manifest.assets[0].bounds[0] <= -1.0);
    assert!(manifest.assets[0].bounds[2] >= 1.0);
    let keys = tiff.get_tag_u16_vec(Tag::GeoKeyDirectoryTag).unwrap();
    assert!(keys[4..]
        .chunks_exact(4)
        .any(|key| key == [3072, 0, 1, 3857]));
    let DecodingResult::U8(pixels) = tiff.read_image().unwrap() else {
        panic!("expected RGBA bytes")
    };
    assert_eq!(&pixels[..4], &[40, 90, 130, 255]);
    assert_eq!(&pixels[2 * 4..2 * 4 + 4], &[150, 60, 20, 255]);

    let mbtiles = Connection::open(output.join("imagery.mbtiles")).unwrap();
    let count: i64 = mbtiles
        .query_row("SELECT count(*) FROM tiles", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
    let y: i64 = mbtiles
        .query_row("SELECT tile_row FROM tiles LIMIT 1", [], |row| row.get(0))
        .unwrap();
    assert_eq!(y, 1);

    let manifest_path = output.join("manifest.json");
    let mut tampered: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    tampered["assets"][0]["bounds"][0] = serde_json::json!(-10.0);
    std::fs::write(&manifest_path, serde_json::to_vec(&tampered).unwrap()).unwrap();
    assert_eq!(
        inspect_bundle(&output).unwrap_err().code,
        "ARTIFACT_INCOMPLETE"
    );
}

#[tokio::test]
async fn a_missing_tile_publishes_an_explicit_partial_bundle() {
    let fixture = Fixture::start(true);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("incomplete");
    let manifest = fetch_bundle(&request(output.clone(), 256), &fixture.source())
        .await
        .unwrap();
    assert_eq!(manifest.quality.status, "partial");
    assert_eq!(manifest.quality.missing_tiles, 1);
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 2);
    assert_eq!(manifest.quality.missing.len(), 1);
    assert_eq!(
        (
            manifest.quality.missing[0].zoom,
            manifest.quality.missing[0].x,
            manifest.quality.missing[0].y
        ),
        (1, 1, 0)
    );
    assert_eq!(inspect_bundle(&output).unwrap().quality.status, "partial");
    let pixels = image::open(output.join("preview.png")).unwrap().to_rgba8();
    assert_eq!(pixels.get_pixel(0, 0)[3], 255);
    assert_eq!(pixels.get_pixel(3, 0)[3], 0);
    let mbtiles = Connection::open(output.join("imagery.mbtiles")).unwrap();
    let count: i64 = mbtiles
        .query_row("SELECT count(*) FROM tiles", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);

    let path = output.join("manifest.json");
    let mut tampered: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    tampered["quality"]["missingTiles"] = serde_json::json!(0);
    std::fs::write(&path, serde_json::to_vec(&tampered).unwrap()).unwrap();
    assert_eq!(
        inspect_bundle(&output).unwrap_err().code,
        "ARTIFACT_INCOMPLETE"
    );
}

#[tokio::test]
async fn all_missing_tiles_do_not_publish_an_empty_bundle() {
    let fixture = Fixture::start(true);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("empty");
    let mut only_missing = request(output.clone(), 256);
    only_missing.bounds = [0.1, 1.0, 1.0, 2.0];
    only_missing.grids = vec![tile::grid(only_missing.bounds, 1, 256).unwrap()];
    only_missing.max_tiles = 1;
    let error = fetch_bundle(&only_missing, &fixture.source())
        .await
        .unwrap_err();
    assert_eq!(error.code, "SOURCE_UNAVAILABLE");
    assert!(!output.exists());
}

#[tokio::test]
async fn cancellation_never_publishes_or_requests_tiles() {
    let fixture = Fixture::start(false);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("cancelled");
    let cancelled = AtomicBool::new(true);
    let error =
        fetch_bundle_with_cancel(&request(output.clone(), 256), &fixture.source(), &cancelled)
            .await
            .unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 0);
    assert!(!output.exists());
}

#[tokio::test]
async fn resumes_from_verified_tile_checkpoint_without_repeating_http() {
    let fixture = Fixture::start(false);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("resumed");
    let cache = TileCacheConfig {
        root: directory.path().join("tile-cache"),
        plan_hash: "a".repeat(64),
        job_id: "a7dafeb5-eef5-47be-b1f3-9ed1bd2279f2".into(),
    };
    let cancelled = AtomicBool::new(false);
    let error = fetch_bundle_with_cache_control_proxy_options(
        &request(output.clone(), 256),
        &fixture.source(),
        &cancelled,
        &AtomicBool::new(false),
        &cache,
        ProxyRoute::Direct,
        DownloadOptions { concurrency: 1 },
        |completed, _| {
            if completed == 1 {
                cancelled.store(true, Ordering::Relaxed);
            }
            Ok(())
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "CANCELLED");
    assert!(!output.exists());
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 1);
    cancelled.store(false, Ordering::Relaxed);
    let manifest = fetch_bundle_with_cache_control_proxy_options(
        &request(output.clone(), 256),
        &fixture.source(),
        &cancelled,
        &AtomicBool::new(false),
        &cache,
        ProxyRoute::Direct,
        DownloadOptions { concurrency: 1 },
        |_, _| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 2);
    assert_eq!(manifest.quality.status, "complete");
    assert_eq!(manifest.id, format!("geod-agent-job-{}", cache.job_id));
    assert_eq!(inspect_bundle(&output).unwrap().assets.len(), 3);
}

#[tokio::test]
async fn retries_one_rate_limited_tile_and_publishes_complete_bundle() {
    let fixture = Fixture::start_mode(false, 256, false, true);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("retry-complete");
    fetch_serial_bundle(&request(output.clone(), 256), &fixture.source())
        .await
        .unwrap();
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 3);
    assert_eq!(inspect_bundle(&output).unwrap().quality.status, "complete");
}

#[tokio::test]
async fn recovers_after_four_temporary_service_errors() {
    let fixture = Fixture::start_mode_with_transient_errors(false, 256, false, false, None, 4);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("temporary-service-recovery");
    let mut planned = request(output.clone(), 256);
    planned.deadline = Duration::from_secs(30);
    fetch_serial_bundle(&planned, &fixture.source())
        .await
        .unwrap();
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 6);
    assert_eq!(inspect_bundle(&output).unwrap().quality.status, "complete");
}

#[tokio::test]
async fn respects_retry_after_before_requesting_the_rate_limited_tile_again() {
    let fixture = Fixture::start_mode_with_retry_after(false, 256, false, true, Some(2));
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("retry-after-complete");
    fetch_serial_bundle(&request(output.clone(), 256), &fixture.source())
        .await
        .unwrap();
    let times = fixture.request_times.lock().unwrap();
    assert_eq!(times.len(), 3);
    assert!(times[1].duration_since(times[0]) >= Duration::from_millis(1900));
    assert_eq!(inspect_bundle(&output).unwrap().quality.status, "complete");
}

#[tokio::test]
async fn retry_after_beyond_job_deadline_does_not_retry_early() {
    let fixture = Fixture::start_mode_with_retry_after(false, 256, false, true, Some(30));
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("rate-limit-beyond-deadline");
    let error = fetch_serial_bundle(&request(output.clone(), 256), &fixture.source())
        .await
        .unwrap_err();
    assert_eq!(error.code, "SOURCE_RATE_LIMITED");
    assert!(fixture.request_times.lock().unwrap()[0].elapsed() < Duration::from_secs(3));
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 1);
    assert!(!output.exists());
}

#[tokio::test]
async fn cancel_interrupts_retry_after_without_another_tile_request() {
    let fixture = Fixture::start_mode_with_retry_after(false, 256, false, true, Some(30));
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("cancelled-during-rate-limit");
    let cancelled = Arc::new(AtomicBool::new(false));
    let watcher_cancelled = cancelled.clone();
    let requests = fixture.requests.clone();
    let watcher = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        while requests.load(Ordering::Relaxed) == 0 {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
        thread::sleep(Duration::from_millis(250));
        watcher_cancelled.store(true, Ordering::Relaxed);
        true
    });
    let mut job = request(output.clone(), 256);
    job.deadline = Duration::from_secs(60);
    let cache = TileCacheConfig {
        root: directory.path().join("checkpoints"),
        plan_hash: "a".repeat(64),
        job_id: uuid::Uuid::new_v4().to_string(),
    };
    let error = fetch_bundle_with_cache_control_proxy_options(
        &job,
        &fixture.source(),
        &cancelled,
        &AtomicBool::new(false),
        &cache,
        ProxyRoute::Direct,
        DownloadOptions { concurrency: 1 },
        |_, _| Ok(()),
    )
    .await
    .unwrap_err();
    assert!(watcher.join().unwrap());
    assert_eq!(error.code, "CANCELLED");
    assert!(fixture.request_times.lock().unwrap()[0].elapsed() < Duration::from_secs(3));
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 1);
    assert!(!output.exists());
}

#[tokio::test]
async fn explicit_proxy_routes_imagery_tiles_through_selected_server() {
    let fixture = Fixture::start(false);
    let mut source = fixture.source();
    source.url_template = "http://imagery.invalid/{z}/{x}/{y}.png".into();
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("proxied");
    let cache = TileCacheConfig {
        root: directory.path().join("checkpoints"),
        plan_hash: "b".repeat(64),
        job_id: "b76cfda5-2879-4293-9c0b-ec60d595210f".into(),
    };
    let proxy = format!("http://{}", fixture.address);
    let manifest = fetch_bundle_with_cache_control_proxy(
        &request(output.clone(), 256),
        &source,
        &AtomicBool::new(false),
        &AtomicBool::new(false),
        &cache,
        ProxyRoute::Http(&proxy),
        |_, _| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(manifest.quality.missing_tiles, 0);
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 2);
    assert!(output.join("imagery.mbtiles").exists());
}

#[tokio::test]
async fn pause_interrupts_retry_after_and_keeps_the_job_unpublished() {
    let fixture = Fixture::start_mode_with_retry_after(false, 256, false, true, Some(30));
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("paused-during-rate-limit");
    let cancelled = AtomicBool::new(false);
    let paused = Arc::new(AtomicBool::new(false));
    let watcher_paused = paused.clone();
    let requests = fixture.requests.clone();
    let watcher = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(30);
        while requests.load(Ordering::Relaxed) == 0 {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(5));
        }
        thread::sleep(Duration::from_millis(250));
        watcher_paused.store(true, Ordering::Relaxed);
        true
    });
    let cache = TileCacheConfig {
        root: directory.path().join("checkpoints"),
        plan_hash: "a".repeat(64),
        job_id: "f76cfda5-2879-4293-9c0b-ec60d595210f".into(),
    };
    let mut job = request(output.clone(), 256);
    job.deadline = Duration::from_secs(60);
    let error = fetch_bundle_with_cache_control_proxy_options(
        &job,
        &fixture.source(),
        &cancelled,
        &paused,
        &cache,
        ProxyRoute::Direct,
        DownloadOptions { concurrency: 1 },
        |_, _| Ok(()),
    )
    .await
    .unwrap_err();
    assert!(watcher.join().unwrap());
    assert_eq!(error.code, "PAUSED");
    assert!(fixture.request_times.lock().unwrap()[0].elapsed() < Duration::from_secs(3));
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 1);
    assert!(!output.exists());
}

#[tokio::test]
async fn existing_output_is_preserved_before_http() {
    let fixture = Fixture::start(false);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("existing");
    std::fs::create_dir(&output).unwrap();
    std::fs::write(output.join("user.txt"), b"keep me").unwrap();
    let error = fetch_bundle(&request(output.clone(), 256), &fixture.source())
        .await
        .unwrap_err();
    assert_eq!(error.code, "OUTPUT_CONFLICT");
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 0);
    assert_eq!(std::fs::read(output.join("user.txt")).unwrap(), b"keep me");
}

#[tokio::test]
async fn inspect_detects_corrupted_asset() {
    let fixture = Fixture::start(false);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("complete");
    fetch_bundle(&request(output.clone(), 256), &fixture.source())
        .await
        .unwrap();
    let path = output.join("preview.png");
    let mut bytes = std::fs::read(&path).unwrap();
    let middle = bytes.len() / 2;
    bytes[middle] ^= 1;
    std::fs::write(&path, bytes).unwrap();
    assert_eq!(
        inspect_bundle(&output).unwrap_err().code,
        "ARTIFACT_INCOMPLETE"
    );
}

#[tokio::test]
async fn supports_512_pixel_tms_source_through_export_and_inspection() {
    let fixture = Fixture::start_mode(false, 512, true, false);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("large-tms");
    let manifest = fetch_bundle(&request(output.clone(), 512), &fixture.source())
        .await
        .unwrap();
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 2);
    assert_eq!(manifest.assets[0].width, Some(6));
    assert_eq!(inspect_bundle(&output).unwrap().quality.status, "complete");
    let mut tiff =
        Decoder::new(std::fs::File::open(output.join("imagery-z1.tif")).unwrap()).unwrap();
    assert_eq!(tiff.dimensions().unwrap().0, 6);
    assert_eq!(
        tiff.dimensions().unwrap().1,
        manifest.assets[0].height.unwrap()
    );
}

#[tokio::test]
async fn geojson_boundary_masks_geotiff_and_preview_but_preserves_mbtiles() {
    let fixture = Fixture::start(false);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("polygon-clipped");
    let boundary = BoundaryGeometry::from_geojson(
        br#"{"type":"Polygon","coordinates":[[[-1,1],[1,1],[-1,2],[-1,1]]]}"#,
    )
    .unwrap();
    let mut job = request(output.clone(), 256);
    job.boundary = Some(boundary);
    let manifest = fetch_bundle(&job, &fixture.source()).await.unwrap();
    assert_eq!(manifest.assets.len(), 4);
    assert!(manifest
        .assets
        .iter()
        .any(|asset| asset.path == "boundary.geojson" && asset.kind == "vector"));
    assert!(manifest
        .quality
        .warnings
        .iter()
        .any(|warning| warning.contains("Tile containers preserve complete source tiles")));
    assert_eq!(inspect_bundle(&output).unwrap().assets.len(), 4);

    let mut tiff =
        Decoder::new(std::fs::File::open(output.join("imagery-z1.tif")).unwrap()).unwrap();
    let DecodingResult::U8(pixels) = tiff.read_image().unwrap() else {
        panic!("expected RGBA bytes")
    };
    let alpha: Vec<_> = pixels.chunks_exact(4).map(|pixel| pixel[3]).collect();
    assert!(alpha.contains(&0) && alpha.contains(&255));
    let preview = image::open(output.join("preview.png")).unwrap().to_rgba8();
    assert_eq!(
        preview
            .as_raw()
            .chunks_exact(4)
            .map(|pixel| pixel[3])
            .collect::<Vec<_>>(),
        alpha
    );
    let db = Connection::open(output.join("imagery.mbtiles")).unwrap();
    let tile: Vec<u8> = db
        .query_row("SELECT tile_data FROM tiles LIMIT 1", [], |row| row.get(0))
        .unwrap();
    assert!(image::load_from_memory(&tile)
        .unwrap()
        .to_rgba8()
        .pixels()
        .all(|pixel| pixel[3] == 255));
}

#[test]
fn geojson_boundary_rejects_non_polygon_and_ambiguous_coordinates() {
    assert!(BoundaryGeometry::from_geojson(
        br#"{"type":"LineString","coordinates":[[0,0],[1,1]]}"#
    )
    .is_err());
    assert!(BoundaryGeometry::from_geojson(
        br#"{"type":"Polygon","crs":{"type":"name"},"coordinates":[[[0,0],[1,0],[0,1],[0,0]]]}"#
    )
    .is_err());
    assert!(BoundaryGeometry::from_geojson(
        br#"{"type":"Polygon","coordinates":[[[179,0],[-179,0],[179,1],[179,0]]]}"#
    )
    .is_err());
}

#[tokio::test]
async fn six_formats_two_zooms_preserve_pixels_matrices_and_raw_bytes() {
    use geod_core::imagery::ExtraOutput;
    let fixture = Fixture::start(false);
    let dir = tempfile::tempdir().unwrap();
    let output = dir.path().join("six-formats");
    let mut job = request(output.clone(), 256);
    job.grids.push(tile::grid(job.bounds, 2, 256).unwrap());
    job.max_tiles = 4;
    job.max_decoded_rgba_bytes *= 2;
    job.extra_outputs = vec![ExtraOutput::Png, ExtraOutput::Jpeg, ExtraOutput::GeoPackage, ExtraOutput::Tiles];
    job.export_options.generate_sidecars = true;
    let manifest = fetch_bundle(&job, &fixture.source()).await.unwrap();
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 4);
    assert_eq!(inspect_bundle(&output).unwrap().quality.status, "complete");
    for z in [1,2] {
        let png = image::open(output.join(format!("imagery-z{z}.png"))).unwrap().to_rgba8();
        let mut tif = Decoder::new(std::fs::File::open(output.join(format!("imagery-z{z}.tif"))).unwrap()).unwrap();
        let DecodingResult::U8(bytes) = tif.read_image().unwrap() else { panic!("RGBA expected"); };
        assert_eq!(png.as_raw(), &bytes);
        let jpeg = image::open(output.join(format!("imagery-z{z}.jpg"))).unwrap();
        assert_eq!((jpeg.width(), jpeg.height()), png.dimensions());
        let world: Vec<f64> = std::fs::read_to_string(output.join(format!("imagery-z{z}.pgw"))).unwrap().lines().map(|v| v.parse().unwrap()).collect();
        let scale = tif.get_tag_f64_vec(Tag::ModelPixelScaleTag).unwrap();
        let tie = tif.get_tag_f64_vec(Tag::ModelTiepointTag).unwrap();
        assert_eq!(world[0], scale[0]); assert_eq!(world[3], -scale[1]);
        assert!((world[4] - tie[3] - scale[0]/2.0).abs() < 1e-8);
        assert!((world[5] - tie[4] + scale[1]/2.0).abs() < 1e-8);
    }
    let gpkg = Connection::open(output.join("imagery.gpkg")).unwrap();
    let count: u64 = gpkg.query_row("SELECT count(*) FROM tiles", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 4);
    for z in [1,2] {
        let matrix: u64 = gpkg.query_row("SELECT matrix_width FROM gpkg_tile_matrix WHERE zoom_level=?1", [z], |r| r.get(0)).unwrap();
        assert_eq!(matrix, 1 << z);
    }
    let raw = std::fs::read(output.join("tiles/1/0/0.png")).unwrap();
    assert_eq!(raw, png([40,90,130,255], 256));
    let blob: Vec<u8> = gpkg.query_row("SELECT tile_data FROM tiles WHERE zoom_level=1 AND tile_column=0 AND tile_row=0", [], |r| r.get(0)).unwrap();
    assert_eq!(blob, raw);
    assert!(manifest.assets.iter().any(|a| a.path == "imagery.gpkg" && a.crs == "EPSG:3857"));
    std::fs::write(output.join("tiles/1/0/0.png"), b"tampered").unwrap();
    assert_eq!(inspect_bundle(&output).unwrap_err().code, "ARTIFACT_INCOMPLETE");
}

#[tokio::test]
async fn compression_and_internal_overviews_decode_correctly() {
    use geod_core::imagery::TiffCompression;
    let fixture = Fixture::start(false);
    let dir = tempfile::tempdir().unwrap();
    for (i,compression) in [TiffCompression::None, TiffCompression::Lzw, TiffCompression::Deflate].into_iter().enumerate() {
        let output = dir.path().join(format!("compression-{i}"));
        let mut job = request(output.clone(),256);
        job.bounds = [-170.0,1.0,170.0,80.0];
        job.grids = vec![tile::grid(job.bounds,1,256).unwrap()];
        job.export_options.compression = compression;
        job.export_options.build_pyramid = true;
        fetch_bundle(&job, &fixture.source()).await.unwrap();
        let mut tif = Decoder::new(std::fs::File::open(output.join("imagery-z1.tif")).unwrap()).unwrap();
        let (w,h) = tif.dimensions().unwrap();
        let DecodingResult::U8(pixels) = tif.read_image().unwrap() else { panic!("RGBA expected"); };
        assert_eq!(&pixels[..4], &[40,90,130,255]);
        tif.next_image().unwrap();
        assert_eq!(tif.get_tag_u32(Tag::NewSubfileType).unwrap(), 1);
        assert_eq!(tif.dimensions().unwrap(), (w.div_ceil(2),h.div_ceil(2)));
        let DecodingResult::U8(overview) = tif.read_image().unwrap() else { panic!("RGBA expected"); };
        assert_eq!(&overview[..4], &[40,90,130,255]);
        inspect_bundle(&output).unwrap();
    }
}

#[tokio::test]
async fn annotation_is_composited_and_dem_is_float32_metres_with_nodata() {
    use geod_core::imagery::{OverlaySourceRef, ElevationEncoding};
    let fixture=Fixture::start(false);
    let dir=tempfile::tempdir().unwrap();
    let mut job=request(dir.path().join("annotation"),256);
    let mut overlay=fixture.source();overlay.id="annotation".into();overlay.name="半透明注记".into();
    overlay.url_template=overlay.url_template.replace(&fixture.address.to_string(), &format!("{}/annotation",fixture.address));
    job.export_options.overlay_sources=vec![OverlaySourceRef {source_id:overlay.id.clone(),config_revision:overlay.configuration_revision()}];
    job.overlays=vec![overlay];
    let manifest=fetch_bundle(&job,&fixture.source()).await.unwrap();
    assert_eq!(manifest.provenance.len(),2);
    let pixels=image::open(job.destination.join("preview.png")).unwrap().to_rgba8();
    let p=pixels.get_pixel(0,0).0;
    assert!((146..=149).contains(&p[0]) && (43..=46).contains(&p[1]) && p[3]==255, "composite pixel={p:?}");
    assert_eq!(fixture.requests.load(Ordering::Relaxed),4);
    let mut dem=request(dir.path().join("elevation"),256);
    dem.output_mbtiles=false;
    dem.export_options.elevation_encoding=Some(ElevationEncoding::Terrarium);
    dem.boundary=Some(BoundaryGeometry::from_geojson(br#"{"type":"Polygon","coordinates":[[[-1,1],[1,1],[-1,2],[-1,1]]]}"#).unwrap());
    fetch_bundle(&dem,&fixture.source()).await.unwrap();
    inspect_bundle(&dem.destination).unwrap();
    let mut tif=Decoder::new(std::fs::File::open(dem.destination.join("imagery-z1.tif")).unwrap()).unwrap();
    let DecodingResult::F32(values)=tif.read_image().unwrap() else {panic!("Height must be Float32, not RGB");};
    assert!(values.contains(&-9999.0));
    assert!(values.contains(&(40.0*256.0+90.0+130.0/256.0-32768.0)));
}

#[tokio::test]
async fn different_plans_reuse_shared_tiles_and_source_revisions_are_isolated() {
    let fixture=Fixture::start(false);let dir=tempfile::tempdir().unwrap();
    for i in 0..2 {
        let cache=TileCacheConfig {root:dir.path().join(format!("job-{i}")),plan_hash:format!("{i:064x}"),job_id:uuid::Uuid::new_v4().to_string()};
        let mut request=request(dir.path().join(format!("output-{i}")),256);
        if i==1 {request.output_mbtiles=false;request.extra_outputs=vec![geod_core::imagery::ExtraOutput::Png];}
        fetch_bundle_with_cache_control_proxy(&request,&fixture.source(),&AtomicBool::new(false),&AtomicBool::new(false),&cache,ProxyRoute::Direct,|_,_|Ok(())).await.unwrap();
    }
    assert_eq!(fixture.requests.load(Ordering::Relaxed),2,"second plan must reuse the original validated bytes");
    let mut changed=fixture.source();changed.url_template.push_str("?version=2");
    let cache=TileCacheConfig {root:dir.path().join("changed"),plan_hash:"c".repeat(64),job_id:uuid::Uuid::new_v4().to_string()};
    // The fixture returns 404 for the changed request. A stale shared tile must
    // never turn that into success.
    let result=fetch_bundle_with_cache_control_proxy(&request(dir.path().join("changed-out"),256),&changed,&AtomicBool::new(false),&AtomicBool::new(false),&cache,ProxyRoute::Direct,|_,_|Ok(())).await;
    assert_eq!(result.unwrap_err().code,"SOURCE_UNAVAILABLE");
    assert_eq!(fixture.requests.load(Ordering::Relaxed),4);
}

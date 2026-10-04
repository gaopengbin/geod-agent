use geod_core::{
    imagery::{
        fetch_bundle_with_cache_control_proxy_options, inspect_bundle, CoreError, DownloadOptions,
        HttpSource, ImageryRequest, Manifest, NetworkPolicy, ProxyRoute, TileCacheConfig,
        TileScheme,
    },
    tile,
};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use std::{
    io::{Cursor, Read, Write},
    net::TcpListener,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

struct Server {
    address: String,
    requests: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
    times: Arc<Mutex<Vec<Instant>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn start(delay: Duration, rate_limit: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap().to_string();
        let requests = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let times = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (count, working, maximum, timestamps, stopping) = (
            requests.clone(),
            active.clone(),
            peak.clone(),
            times.clone(),
            stop.clone(),
        );
        let worker = thread::spawn(move || {
            let mut handlers = Vec::new();
            let epoch = Instant::now();
            while !stopping.load(Ordering::Relaxed) {
                let (mut socket, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("{error}"),
                };
                // Windows accepted sockets can inherit nonblocking mode.
                socket.set_nonblocking(false).unwrap();
                let (count, working, maximum, timestamps) = (
                    count.clone(),
                    working.clone(),
                    maximum.clone(),
                    timestamps.clone(),
                );
                handlers.push(thread::spawn(move || {
                    socket.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
                    let mut buffer = [0; 2048];
                    let n = socket.read(&mut buffer).unwrap_or_default();
                    let request = String::from_utf8_lossy(&buffer[..n]);
                    let Some(path) = request.lines().next().and_then(|line| line.split_whitespace().nth(1)) else { return; };
                    let parts: Vec<u32> = path.trim_matches('/').split('/').filter_map(|part| part.parse().ok()).collect();
                    let (x, y) = (parts[1], parts[2]);
                    count.fetch_add(1, Ordering::Relaxed);
                    timestamps.lock().unwrap().push(Instant::now());
                    let current = working.fetch_add(1, Ordering::Relaxed) + 1;
                    maximum.fetch_max(current, Ordering::Relaxed);
                    // Deliberately reorder completions across coordinates.
                    thread::sleep(delay + Duration::from_millis(u64::from(x % 3) * 10));
                    let limited = rate_limit && epoch.elapsed() < Duration::from_secs(1);
                    let bytes = if limited { Vec::new() } else { tile_bytes(x, y) };
                    let status = if limited { "429 Too Many Requests\r\nRetry-After: 1" } else { "200 OK" };
                    let header = format!("HTTP/1.1 {status}\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len());
                    let _ = socket.write_all(header.as_bytes());
                    let _ = socket.write_all(&bytes);
                    working.fetch_sub(1, Ordering::Relaxed);
                }));
            }
            for handler in handlers {
                handler.join().unwrap();
            }
        });
        Self {
            address,
            requests,
            peak,
            times,
            stop,
            worker: Some(worker),
        }
    }
    fn source(&self, interval: u64) -> HttpSource {
        HttpSource { subdomains: Vec::new(), coordinate_system: None, elevation_encoding: None, id: "parallel-fixture".into(),
            name: "Parallel fixture".into(),
            attribution: "Synthetic pixels".into(),
            license: "".into(),
            url_template: format!("http://{}/{{z}}/{{x}}/{{y}}", self.address),
            scheme: TileScheme::XYZ,
            tile_size: 256,
            network_policy: NetworkPolicy::UserTrustedHttp,
            min_interval_ms: interval, authentication: None, runtime_token: None,
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.worker.take().unwrap().join().unwrap();
    }
}
fn tile_bytes(x: u32, y: u32) -> Vec<u8> {
    let image = RgbImage::from_pixel(256, 256, Rgb([(x * 5) as u8, (y * 6) as u8, 120]));
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image)
        .write_to(&mut bytes, ImageFormat::Jpeg)
        .unwrap();
    bytes.into_inner()
}
fn request(root: &Path, name: &str) -> ImageryRequest {
    let bounds = [-22.49, 0.01, 22.49, 21.8];
    let grid = tile::grid(bounds, 6, 256).unwrap();
    assert_eq!(grid.tile_count, 32);
    ImageryRequest {
        name: name.into(),
        bounds,
        boundary: None,
        grids: vec![grid],
        output_geotiff: true,
        output_mbtiles: true,
        extra_outputs: Vec::new(),
        export_options: geod_core::imagery::ExportOptions::default(), overlays: Vec::new(),
        max_tiles: 32,
        max_decoded_rgba_bytes: 32 * 256 * 256 * 4,
        destination: root.join(name),
        deadline: Duration::from_secs(30),
    }
}
fn cache(root: &Path, name: &str) -> TileCacheConfig {
    TileCacheConfig {
        root: root.join(name),
        plan_hash: "d".repeat(64),
        job_id: uuid::Uuid::new_v4().to_string(),
    }
}

#[tokio::test]
async fn export_available_uses_no_network_and_recovery_fetches_only_missing_even_after_cache_expiry() {
    let server=Server::start(Duration::from_millis(1),false);
    let root=tempfile::tempdir().unwrap();let source=server.source(0);
    let paused=AtomicBool::new(false);let cancelled=AtomicBool::new(false);
    let initial=request(root.path(),"original");
    let error=fetch(&initial,&source,&cache(root.path(),"original-cache"),1,&cancelled,&paused,|count,_|{if count==5 {paused.store(true,Ordering::Relaxed);}Ok(())}).await.unwrap_err();
    assert_eq!(error.code,"PAUSED");assert!(!initial.destination.exists());
    let before=server.requests.load(Ordering::Relaxed);
    let shared=rusqlite::Connection::open(root.path().join("shared").join(source.configuration_revision()).join("index.sqlite")).unwrap();
    shared.execute("UPDATE tiles SET saved_at='2020-01-01T00:00:00Z'",[]).unwrap();
    let saved:String=shared.query_row("SELECT saved_at FROM tiles ORDER BY zoom,x,y LIMIT 1",[],|r|r.get(0)).unwrap();
    let mut available=request(root.path(),"available");available.export_options.cache_only=true;
    let partial=fetch(&available,&source,&cache(root.path(),"available-cache"),8,&cancelled,&AtomicBool::new(false),|_,_|Ok(())).await.unwrap();
    assert_eq!(server.requests.load(Ordering::Relaxed),before);
    assert_eq!(partial.quality.status,"partial");assert_eq!(partial.quality.missing_tiles,27);
    assert!(partial.quality.warnings.iter().any(|warning|warning.contains("No source tiles were requested")));
    let saved_after:String=shared.query_row("SELECT saved_at FROM tiles ORDER BY zoom,x,y LIMIT 1",[],|r|r.get(0)).unwrap();assert_eq!(saved,saved_after);
    let mut recovery=request(root.path(),"recovered");recovery.export_options.reuse_verified_cache=true;
    let complete=fetch(&recovery,&source,&cache(root.path(),"recovered-cache"),8,&cancelled,&AtomicBool::new(false),|_,_|Ok(())).await.unwrap();
    assert_eq!(server.requests.load(Ordering::Relaxed)-before,27);assert_eq!(complete.quality.status,"complete");
    let unchanged:u64=shared.query_row("SELECT count(*) FROM tiles WHERE saved_at='2020-01-01T00:00:00Z'",[],|r|r.get(0)).unwrap();assert_eq!(unchanged,5,"A cache hit must not renew freshness");
    assert_eq!(inspect_bundle(&available.destination).unwrap().quality.missing_tiles,27);
    // A corrupt blob must be downloaded again, atomically repaired, then reused
    // by a subsequent independent job without more network traffic.
    let corrupt_hash:String=shared.query_row("SELECT hash FROM tiles ORDER BY zoom,x,y LIMIT 1",[],|r|r.get(0)).unwrap();
    let blob=root.path().join("shared").join(source.configuration_revision()).join("blobs").join(&corrupt_hash);
    std::fs::write(&blob,b"corrupted cached bytes").unwrap();
    let corrupt_before=server.requests.load(Ordering::Relaxed);
    let mut repair=request(root.path(),"corrupt-recovered");repair.export_options.reuse_verified_cache=true;
    fetch(&repair,&source,&cache(root.path(),"corrupt-cache"),8,&cancelled,&AtomicBool::new(false),|_,_|Ok(())).await.unwrap();
    assert_eq!(server.requests.load(Ordering::Relaxed)-corrupt_before,1);
    let restored=std::fs::read(&blob).unwrap();use sha2::Digest;assert_eq!(format!("{:x}",sha2::Sha256::digest(&restored)),corrupt_hash);
    let after_repair=server.requests.load(Ordering::Relaxed);
    let mut replay=request(root.path(),"repaired-reused");replay.export_options.reuse_verified_cache=true;
    fetch(&replay,&source,&cache(root.path(),"repaired-cache"),8,&cancelled,&AtomicBool::new(false),|_,_|Ok(())).await.unwrap();
    assert_eq!(server.requests.load(Ordering::Relaxed),after_repair);
}
async fn fetch(
    request: &ImageryRequest,
    source: &HttpSource,
    cache: &TileCacheConfig,
    concurrency: usize,
    cancelled: &AtomicBool,
    paused: &AtomicBool,
    on_tile: impl FnMut(u64, u64) -> Result<(), CoreError>,
) -> Result<Manifest, CoreError> {
    fetch_bundle_with_cache_control_proxy_options(
        request,
        source,
        cancelled,
        paused,
        cache,
        ProxyRoute::Direct,
        DownloadOptions { concurrency },
        on_tile,
    )
    .await
}

#[tokio::test]
async fn concurrent_cold_download_is_bounded_faster_and_places_tiles_correctly() {
    let server = Server::start(Duration::from_millis(300), false);
    let directory = tempfile::tempdir().unwrap();
    let source = server.source(50);
    let cancelled = AtomicBool::new(false);
    let paused = AtomicBool::new(false);
    let mut serial = request(directory.path(), "serial");
    serial.output_mbtiles = false;
    let start = Instant::now();
    fetch(
        &serial,
        &source,
        &cache(directory.path(), "serial-cache"),
        1,
        &cancelled,
        &paused,
        |_, _| Ok(()),
    )
    .await
    .unwrap();
    let serial_time = start.elapsed();
    let mut parallel = request(directory.path(), "parallel");
    parallel.output_mbtiles = false;
    // Cold-vs-cold benchmark: independent parent isolates the shared source cache.
    let parallel_cache = cache(&directory.path().join("parallel-store"), "parallel-cache");
    let mut progress = Vec::new();
    let start = Instant::now();
    fetch(
        &parallel,
        &source,
        &parallel_cache,
        8,
        &cancelled,
        &paused,
        |done, total| {
            progress.push((done, total));
            Ok(())
        },
    )
    .await
    .unwrap();
    let parallel_time = start.elapsed();
    assert!((2..=8).contains(&server.peak.load(Ordering::Relaxed)));
    assert!(
        parallel_time * 2 < serial_time,
        "serial={serial_time:?}, parallel={parallel_time:?}"
    );
    assert_eq!(
        progress,
        (1..=32).map(|done| (done, 32)).collect::<Vec<_>>()
    );
    let grid = &parallel.grids[0];
    for x in grid.x_min..=grid.x_max {
        for y in grid.y_min..=grid.y_max {
            let cached =
                std::fs::read(parallel_cache.root.join(format!("z6-x{x}-y{y}.png"))).unwrap();
            assert_eq!(
                cached,
                tile_bytes(x, y),
                "cache must keep original JPEG bytes"
            );
        }
    }
    let serial_tiff = std::fs::read(serial.destination.join("imagery-z6.tif")).unwrap();
    let parallel_tiff = std::fs::read(parallel.destination.join("imagery-z6.tif")).unwrap();
    assert_eq!(
        serial_tiff, parallel_tiff,
        "unordered download must produce the same mosaic"
    );
    assert_eq!(
        inspect_bundle(&parallel.destination)
            .unwrap()
            .quality
            .status,
        "complete"
    );
    let mut mb_request = parallel.clone();
    mb_request.destination = directory.path().join("mbtiles-cached");
    mb_request.output_geotiff = false;
    mb_request.output_mbtiles = true;
    fetch(
        &mb_request,
        &source,
        &parallel_cache,
        8,
        &cancelled,
        &paused,
        |_, _| Ok(()),
    )
    .await
    .unwrap();
    let db = rusqlite::Connection::open(mb_request.destination.join("imagery.mbtiles")).unwrap();
    for x in grid.x_min..=grid.x_max {
        for y in grid.y_min..=grid.y_max {
            let bytes: Vec<u8> = db.query_row("SELECT tile_data FROM tiles WHERE zoom_level=6 AND tile_column=?1 AND tile_row=?2", rusqlite::params![x, 63-y], |row| row.get(0)).unwrap();
            assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
            assert_eq!(
                image::load_from_memory(&bytes).unwrap().to_rgba8(),
                image::load_from_memory(&tile_bytes(x, y))
                    .unwrap()
                    .to_rgba8()
            );
        }
    }
    println!(
        "32-tile cold fixture: serial={serial_time:?}, parallel8={parallel_time:?}, peak={}",
        server.peak.load(Ordering::Relaxed)
    );
}

#[tokio::test]
async fn pause_keeps_verified_original_tiles_and_resume_avoids_cached_http() {
    let server = Server::start(Duration::from_millis(30), false);
    let directory = tempfile::tempdir().unwrap();
    let source = server.source(500);
    let request = request(directory.path(), "resume");
    let cache = cache(directory.path(), "cache");
    let cancelled = AtomicBool::new(false);
    let paused = AtomicBool::new(false);
    let error = fetch(
        &request,
        &source,
        &cache,
        8,
        &cancelled,
        &paused,
        |done, _| {
            if done == 5 {
                paused.store(true, Ordering::Relaxed);
            }
            Ok(())
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "PAUSED");
    assert!(!request.destination.exists());
    let db = rusqlite::Connection::open(cache.root.join("tiles.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM tiles", [], |row| row.get::<_, u64>(0))
            .unwrap(),
        5
    );
    // Let the already admitted HTTP requests finish; they are allowed in flight.
    thread::sleep(Duration::from_millis(150));
    let before = server.requests.load(Ordering::Relaxed);
    paused.store(false, Ordering::Relaxed);
    fetch(&request, &source, &cache, 8, &cancelled, &paused, |_, _| {
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(server.requests.load(Ordering::Relaxed) - before, 27);
    let before = server.requests.load(Ordering::Relaxed);
    let mut cached_request = request.clone();
    cached_request.destination = directory.path().join("all-cached");
    let start = Instant::now();
    fetch(
        &cached_request,
        &source,
        &cache,
        8,
        &cancelled,
        &paused,
        |_, _| Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(server.requests.load(Ordering::Relaxed), before);
    assert!(
        start.elapsed() < Duration::from_secs(3),
        "cache hits must not sleep 500ms each"
    );
    assert_eq!(
        inspect_bundle(&cached_request.destination)
            .unwrap()
            .quality
            .status,
        "complete"
    );
}

#[tokio::test]
async fn retry_after_pauses_all_lanes_without_storming_new_requests() {
    let server = Server::start(Duration::from_millis(10), true);
    let directory = tempfile::tempdir().unwrap();
    fetch(
        &request(directory.path(), "limited"),
        &server.source(0),
        &cache(directory.path(), "cache"),
        4,
        &AtomicBool::new(false),
        &AtomicBool::new(false),
        |_, _| Ok(()),
    )
    .await
    .unwrap();
    let times = server.times.lock().unwrap();
    // The first four were already admitted when the provider returned 429.
    assert_eq!(
        times
            .iter()
            .filter(|time| time.duration_since(times[0]) < Duration::from_millis(900))
            .count(),
        4
    );
    assert_eq!(times.len(), 36);
}

#[tokio::test]
async fn cancellation_and_deadline_drop_hung_inflight_requests_promptly() {
    for timeout in [false, true] {
        let server = Server::start(Duration::from_secs(2), false);
        let directory = tempfile::tempdir().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut request = request(directory.path(), "interrupted");
        if timeout {
            request.deadline = Duration::from_millis(250);
        }
        let flag = cancelled.clone();
        let watcher = if timeout {
            None
        } else {
            Some(thread::spawn(move || {
                thread::sleep(Duration::from_millis(250));
                flag.store(true, Ordering::Relaxed);
            }))
        };
        let start = Instant::now();
        let error = fetch(
            &request,
            &server.source(0),
            &cache(directory.path(), "cache"),
            8,
            &cancelled,
            &AtomicBool::new(false),
            |_, _| Ok(()),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.code,
            if timeout { "TIMEOUT" } else { "CANCELLED" },
            "elapsed={:?}, error={}, requests={}",
            start.elapsed(),
            error.message,
            server.requests.load(Ordering::Relaxed)
        );
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(!request.destination.exists());
        if let Some(watcher) = watcher {
            watcher.join().unwrap();
        }
    }
}

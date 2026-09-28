use geod_core::{
    imagery::{
        fetch_bundle, inspect_bundle, HttpSource, ImageryRequest, NetworkPolicy, TileScheme,
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
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tiff::{
    decoder::{Decoder, DecodingResult},
    tags::Tag,
};

struct Fixture {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    requests: Arc<AtomicUsize>,
    worker: Option<JoinHandle<()>>,
    tile_size: u16,
    tms: bool,
}

impl Fixture {
    fn start(missing_right: bool) -> Self {
        Self::start_mode(missing_right, 256, false)
    }

    fn start_mode(missing_right: bool, tile_size: u16, tms: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(AtomicUsize::new(0));
        let stop_worker = stop.clone();
        let count_worker = requests.clone();
        let left = png([40, 90, 130, 255], tile_size);
        let right = png([150, 60, 20, 255], tile_size);
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
                let (status, body): (&str, &[u8]) = match path {
                    Some(value) if value == left_path => ("200 OK", &left),
                    Some(value) if value == right_path && !missing_right => ("200 OK", &right),
                    _ => ("404 Not Found", b""),
                };
                count_worker.fetch_add(1, Ordering::Relaxed);
                let header = format!("HTTP/1.1 {status}\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                stream.write_all(header.as_bytes()).unwrap();
                stream.write_all(body).unwrap();
            }
        });
        Self {
            address,
            stop,
            requests,
            worker: Some(worker),
            tile_size,
            tms,
        }
    }

    fn source(&self) -> HttpSource {
        HttpSource {
            id: "synthetic-xyz".into(),
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
            min_interval_ms: 0,
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
        grids: vec![tile::grid([-1.0, 1.0, 1.0, 2.0], 1, tile_size).unwrap()],
        output_geotiff: true,
        output_mbtiles: true,
        max_tiles: 2,
        max_decoded_rgba_bytes: 2 * u64::from(tile_size).pow(2) * 4,
        destination,
        deadline: Duration::from_secs(10),
    }
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
    assert_eq!(inspect_bundle(&output).unwrap().assets.len(), 3);

    let mut tiff =
        Decoder::new(std::fs::File::open(output.join("imagery-z1.tif")).unwrap()).unwrap();
    assert_eq!(tiff.dimensions().unwrap(), (512, 256));
    let keys = tiff.get_tag_u16_vec(Tag::GeoKeyDirectoryTag).unwrap();
    assert!(keys[4..]
        .chunks_exact(4)
        .any(|key| key == [3072, 0, 1, 3857]));
    let DecodingResult::U8(pixels) = tiff.read_image().unwrap() else {
        panic!("expected RGBA bytes")
    };
    assert_eq!(&pixels[..4], &[40, 90, 130, 255]);
    assert_eq!(&pixels[256 * 4..256 * 4 + 4], &[150, 60, 20, 255]);

    let mbtiles = Connection::open(output.join("imagery.mbtiles")).unwrap();
    let count: i64 = mbtiles
        .query_row("SELECT count(*) FROM tiles", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
    let y: i64 = mbtiles
        .query_row("SELECT tile_row FROM tiles LIMIT 1", [], |row| row.get(0))
        .unwrap();
    assert_eq!(y, 1);
}

#[tokio::test]
async fn failed_tile_never_publishes_output() {
    let fixture = Fixture::start(true);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("incomplete");
    let error = fetch_bundle(&request(output.clone(), 256), &fixture.source())
        .await
        .unwrap_err();
    assert_eq!(error.code, "SOURCE_UNAVAILABLE");
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
    let fixture = Fixture::start_mode(false, 512, true);
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("large-tms");
    let manifest = fetch_bundle(&request(output.clone(), 512), &fixture.source())
        .await
        .unwrap();
    assert_eq!(fixture.requests.load(Ordering::Relaxed), 2);
    assert_eq!(manifest.assets[0].width, Some(1024));
    assert_eq!(manifest.assets[0].height, Some(512));
    assert_eq!(inspect_bundle(&output).unwrap().quality.status, "complete");
    let mut tiff =
        Decoder::new(std::fs::File::open(output.join("imagery-z1.tif")).unwrap()).unwrap();
    assert_eq!(tiff.dimensions().unwrap(), (1024, 512));
}

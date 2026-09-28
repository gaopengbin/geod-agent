use chrono::{TimeZone, Utc};
use geod_core::imagery::{HttpSource, NetworkPolicy, TileScheme as HttpTileScheme};
use geod_task_engine::{
    ledger::{JobState, TaskStore},
    OutputFormat, ResourceLimits, SchemaVersion, SourceDescriptor, TaskKind, TaskSpec, TileScheme,
};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use std::{
    io::{Cursor, Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 28, 10, 0, 0).unwrap()
}

fn png(color: [u8; 4]) -> Vec<u8> {
    let mut cursor = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(256, 256, Rgba(color)))
        .write_to(&mut cursor, ImageFormat::Png)
        .unwrap();
    cursor.into_inner()
}

#[tokio::test]
async fn approved_job_downloads_and_only_then_completes() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let requests = Arc::new(AtomicUsize::new(0));
    let stop_worker = stop.clone();
    let requests_worker = requests.clone();
    let left = png([40, 90, 130, 255]);
    let right = png([150, 60, 20, 255]);
    let worker = thread::spawn(move || {
        while !stop_worker.load(Ordering::Relaxed) {
            let (mut stream, _) = match listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("fixture accept failed: {error}"),
            };
            let mut request = [0u8; 4096];
            let count = stream.read(&mut request).unwrap();
            let line = String::from_utf8_lossy(&request[..count]);
            let path = line
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1));
            let body: &[u8] = match path {
                Some("/1/0/0.png") => &left,
                Some("/1/1/0.png") => &right,
                _ => panic!("unexpected tile path: {path:?}"),
            };
            requests_worker.fetch_add(1, Ordering::Relaxed);
            let header = format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(header.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
        }
    });

    let endpoint = HttpSource {
        id: "synthetic".into(),
        name: "Synthetic".into(),
        attribution: "Generated test pixels".into(),
        license: "Synthetic test data".into(),
        url_template: format!("http://{address}/{{z}}/{{x}}/{{y}}.png"),
        scheme: HttpTileScheme::XYZ,
        tile_size: 256,
        network_policy: NetworkPolicy::UserTrustedHttp,
        min_interval_ms: 0,
    };
    let descriptor = SourceDescriptor {
        schema_version: SchemaVersion::V0_1,
        id: endpoint.id.clone(),
        display_name: endpoint.name.clone(),
        attribution: endpoint.attribution.clone(),
        license: endpoint.license.clone(),
        bulk_download_allowed: true,
        scheme: TileScheme::XYZ,
        tile_size: 256,
        min_zoom: 0,
        max_zoom: 22,
        config_revision: endpoint.configuration_revision(),
        credential_ref_version: None,
    };
    let directory = tempfile::tempdir().unwrap();
    let output = directory.path().join("result");
    let spec = TaskSpec {
        schema_version: SchemaVersion::V0_1,
        kind: TaskKind::Imagery,
        source_id: descriptor.id.clone(),
        bounds: [-1.0, 1.0, 1.0, 2.0],
        zoom_levels: vec![1],
        output_formats: vec![OutputFormat::GeoTiff, OutputFormat::Mbtiles],
        output_directory: output.to_string_lossy().into_owned(),
        limits: ResourceLimits {
            max_tiles: 2,
            max_decoded_rgba_bytes: 2 * 256 * 256 * 4,
        },
    };
    let mut store = TaskStore::open(&directory.path().join("jobs.sqlite")).unwrap();
    let planned = store.create_plan(spec, &descriptor, now()).unwrap();
    let approval = store
        .grant_approval(
            &planned.plan_id,
            &planned.plan.plan_hash,
            "local-user",
            "test-ui",
            now(),
        )
        .unwrap();
    let queued = store
        .start_job(
            &planned.plan_id,
            &planned.plan.plan_hash,
            &approval.approval_id,
            "run-1",
            &descriptor,
            now(),
        )
        .unwrap();
    assert_eq!(queued.state, JobState::Queued);
    assert!(!output.exists());

    let manifest = store
        .run_job(&queued.job_id, &descriptor, &endpoint, now())
        .await
        .unwrap();
    assert_eq!(manifest.quality.status, "complete");
    assert_eq!(requests.load(Ordering::Relaxed), 2);
    assert_eq!(
        store.get_job(&queued.job_id).unwrap().unwrap().state,
        JobState::Completed
    );
    let events = store.events_after(&queued.job_id, 0, 10).unwrap();
    assert_eq!(
        events.iter().map(|event| event.state).collect::<Vec<_>>(),
        [
            JobState::Queued,
            JobState::Downloading,
            JobState::Verifying,
            JobState::Completed
        ]
    );
    assert!(output.join("manifest.json").exists());
    stop.store(true, Ordering::Relaxed);
    worker.join().unwrap();
}

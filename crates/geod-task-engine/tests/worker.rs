use chrono::{TimeZone, Utc};
use geod_core::boundary::BoundaryGeometry;
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
    let missing_right = Arc::new(AtomicBool::new(false));
    let requests = Arc::new(AtomicUsize::new(0));
    let stop_worker = stop.clone();
    let missing_right_worker = missing_right.clone();
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
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut request = [0u8; 4096];
            let count = stream.read(&mut request).unwrap_or(0);
            if count == 0 {
                continue;
            }
            let line = String::from_utf8_lossy(&request[..count]);
            let path = line
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1));
            let (status, body): (&str, &[u8]) = match path {
                Some("/1/0/0.png") => ("200 OK", &left),
                Some("/1/1/0.png") if missing_right_worker.load(Ordering::Relaxed) => {
                    ("404 Not Found", &[])
                }
                Some("/1/1/0.png") => ("200 OK", &right),
                _ => panic!("unexpected tile path: {path:?}"),
            };
            requests_worker.fetch_add(1, Ordering::Relaxed);
            let header = format!("HTTP/1.1 {status}\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
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
        boundary: None,
        zoom_levels: vec![1],
        output_formats: vec![OutputFormat::GeoTiff, OutputFormat::Mbtiles],
        output_directory: output.to_string_lossy().into_owned(),
        limits: ResourceLimits {
            max_tiles: 2,
            max_decoded_rgba_bytes: 2 * 256 * 256 * 4,
        },
    };
    let mut store = TaskStore::open(&directory.path().join("jobs.sqlite")).unwrap();
    let planned = store.create_plan(spec.clone(), &descriptor, now()).unwrap();
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
            JobState::Downloading,
            JobState::Downloading,
            JobState::Verifying,
            JobState::Completed
        ]
    );
    assert_eq!(events[2].completed_tiles, Some(1));
    assert_eq!(events[3].completed_tiles, Some(2));
    assert_eq!(events[3].total_tiles, Some(2));
    assert!(output.join("manifest.json").exists());
    assert_eq!(
        store.inspect_job_artifact(&queued.job_id).unwrap().id,
        format!("geod-agent-job-{}", queued.job_id)
    );
    let second_plan = store.create_plan(spec.clone(), &descriptor, now()).unwrap();
    let second_approval = store
        .grant_approval(
            &second_plan.plan_id,
            &second_plan.plan.plan_hash,
            "local-user",
            "test-ui",
            now(),
        )
        .unwrap();
    let second = store
        .start_job(
            &second_plan.plan_id,
            &second_plan.plan.plan_hash,
            &second_approval.approval_id,
            "run-2",
            &descriptor,
            now(),
        )
        .unwrap();
    assert_eq!(
        store
            .run_job(&second.job_id, &descriptor, &endpoint, now())
            .await
            .unwrap_err()
            .code,
        "OUTPUT_CONFLICT"
    );
    assert_eq!(requests.load(Ordering::Relaxed), 2);
    assert_eq!(
        store.get_job(&second.job_id).unwrap().unwrap().state,
        JobState::Failed
    );
    assert_eq!(
        store.inspect_job_artifact(&second.job_id).unwrap_err().code,
        "ARTIFACT_NOT_READY"
    );
    assert!(geod_core::imagery::inspect_bundle(&output).is_ok());

    let paused_output = directory.path().join("paused-result");
    let mut paused_spec = spec;
    paused_spec.output_directory = paused_output.to_string_lossy().into_owned();
    paused_spec.boundary = Some(
        BoundaryGeometry::from_geojson(
            br#"{"type":"Polygon","coordinates":[[[-1,1],[1,1],[-1,2],[-1,1]]]}"#,
        )
        .unwrap(),
    );
    let paused_plan = store.create_plan(paused_spec, &descriptor, now()).unwrap();
    let paused_approval = store
        .grant_approval(
            &paused_plan.plan_id,
            &paused_plan.plan.plan_hash,
            "local-user",
            "test-ui",
            now(),
        )
        .unwrap();
    let paused_job = store
        .start_job(
            &paused_plan.plan_id,
            &paused_plan.plan.plan_hash,
            &paused_approval.approval_id,
            "run-3",
            &descriptor,
            now(),
        )
        .unwrap();
    let cancelled = AtomicBool::new(false);
    let paused = AtomicBool::new(true);
    assert_eq!(
        store
            .run_job_with_control(
                &paused_job.job_id,
                &descriptor,
                &endpoint,
                now(),
                &cancelled,
                &paused
            )
            .await
            .unwrap_err()
            .code,
        "PAUSED"
    );
    assert_eq!(
        store.get_job(&paused_job.job_id).unwrap().unwrap().state,
        JobState::Paused
    );
    assert!(!paused_output.exists());
    assert_eq!(requests.load(Ordering::Relaxed), 2);
    drop(store);
    let mut store = TaskStore::open(&directory.path().join("jobs.sqlite")).unwrap();
    let resumed = store.resume_paused_job(&paused_job.job_id).unwrap();
    assert_eq!(resumed.job_id, paused_job.job_id);
    assert_eq!(resumed.approval_id, paused_approval.approval_id);
    paused.store(false, Ordering::Relaxed);
    store
        .run_job_with_control(
            &paused_job.job_id,
            &descriptor,
            &endpoint,
            now(),
            &cancelled,
            &paused,
        )
        .await
        .unwrap();
    assert_eq!(requests.load(Ordering::Relaxed), 4);
    assert_eq!(
        store.get_job(&paused_job.job_id).unwrap().unwrap().state,
        JobState::Completed
    );
    assert_eq!(
        store.inspect_job_artifact(&paused_job.job_id).unwrap().id,
        format!("geod-agent-job-{}", paused_job.job_id)
    );
    assert!(geod_core::imagery::inspect_bundle(&paused_output).is_ok());
    let clipped = image::open(paused_output.join("preview.png"))
        .unwrap()
        .to_rgba8();
    let alpha: Vec<_> = clipped.pixels().map(|pixel| pixel[3]).collect();
    assert!(alpha.contains(&0) && alpha.contains(&255));
    assert!(paused_output.join("boundary.geojson").exists());

    let partial_output = directory.path().join("partial-result");
    let mut partial_spec = planned.plan.spec.clone();
    partial_spec.output_directory = partial_output.to_string_lossy().into_owned();
    let partial_plan = store.create_plan(partial_spec, &descriptor, now()).unwrap();
    let partial_approval = store
        .grant_approval(
            &partial_plan.plan_id,
            &partial_plan.plan.plan_hash,
            "local-user",
            "test-ui",
            now(),
        )
        .unwrap();
    let partial_job = store
        .start_job(
            &partial_plan.plan_id,
            &partial_plan.plan.plan_hash,
            &partial_approval.approval_id,
            "run-partial",
            &descriptor,
            now(),
        )
        .unwrap();
    missing_right.store(true, Ordering::Relaxed);
    let partial_manifest = store
        .run_job(&partial_job.job_id, &descriptor, &endpoint, now())
        .await
        .unwrap();
    missing_right.store(false, Ordering::Relaxed);
    assert_eq!(partial_manifest.quality.status, "partial");
    assert_eq!(partial_manifest.quality.missing_tiles, 1);
    assert_eq!(
        store.get_job(&partial_job.job_id).unwrap().unwrap().state,
        JobState::Partial
    );
    assert!(store.inspect_job_artifact(&partial_job.job_id).is_ok());
    assert_eq!(requests.load(Ordering::Relaxed), 6);

    // Emulate a process crash after publication but before the final ledger
    // transition. Startup recovery must verify all bundles without HTTP.
    drop(store);
    let connection = rusqlite::Connection::open(directory.path().join("jobs.sqlite")).unwrap();
    for id in [&queued.job_id, &paused_job.job_id, &partial_job.job_id] {
        connection
            .execute("UPDATE jobs SET state='verifying' WHERE job_id=?1", [id])
            .unwrap();
    }
    drop(connection);
    std::fs::write(paused_output.join("preview.png"), b"damaged preview").unwrap();
    let mut restarted = TaskStore::open(&directory.path().join("jobs.sqlite")).unwrap();
    assert_eq!(restarted.recover_verifying_jobs().unwrap(), 2);
    assert_eq!(restarted.recover_verifying_jobs().unwrap(), 0);
    assert_eq!(requests.load(Ordering::Relaxed), 6);
    assert_eq!(
        restarted.get_job(&queued.job_id).unwrap().unwrap().state,
        JobState::Completed
    );
    assert_eq!(
        restarted
            .get_job(&paused_job.job_id)
            .unwrap()
            .unwrap()
            .state,
        JobState::Failed
    );
    assert_eq!(
        restarted
            .get_job(&partial_job.job_id)
            .unwrap()
            .unwrap()
            .state,
        JobState::Partial
    );
    assert!(restarted.inspect_job_artifact(&queued.job_id).is_ok());
    assert!(restarted.inspect_job_artifact(&partial_job.job_id).is_ok());
    assert_eq!(
        restarted
            .inspect_job_artifact(&paused_job.job_id)
            .unwrap_err()
            .code,
        "ARTIFACT_NOT_READY"
    );
    stop.store(true, Ordering::Relaxed);
    worker.join().unwrap();
}

use chrono::Utc;
use geod_core::imagery::{CoreError, ExportOptions, HttpSource, NetworkPolicy, ProjectedRaster, RasterProjector, ProxyRoute};
use geod_task_engine::{ledger::{JobState, TaskStore}, OutputFormat, ResourceLimits, SchemaVersion, SourceDescriptor, TaskKind, TaskSpec, TileScheme};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use std::{io::{Cursor, Read, Write}, net::TcpListener, path::{Path, PathBuf}, process::{Command, Stdio}, sync::{atomic::{AtomicBool, Ordering}, Arc}, time::Duration};

struct PythonProjector { destination: PathBuf, pause: bool }
impl RasterProjector for PythonProjector {
    fn reproject<'a>(&'a self, path: &'a Path, bounds: [f64; 4], options: &'a ExportOptions, _cancelled: &'a AtomicBool, _paused: Option<&'a AtomicBool>)
        -> std::pin::Pin<Box<dyn std::future::Future<Output=Result<ProjectedRaster, CoreError>> + Send + 'a>> {
        Box::pin(async move {
            // No public output is allowed before conversion and final verification.
            assert!(!self.destination.exists());
            if self.pause { return Err(CoreError::new("PAUSED", "Synthetic pause during reprojection")); }
            let packages = std::env::var("GEOD_CRS_TEST_PACKAGES").unwrap();
            let worker = std::fs::read_to_string(std::env::var("GEOD_CRS_TEST_WORKER").unwrap()).unwrap();
            let script = format!("import sys;sys.dont_write_bytecode=True;sys.path[:0]={packages}\n{worker}");
            let mut child = Command::new(std::env::var("GEOD_CRS_TEST_PYTHON").unwrap())
                .args(["-I", "-X", "utf8", "-c", &script]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
            child.stdin.take().unwrap().write_all(serde_json::json!({"path":path,"bounds":bounds,"targetCrs":options.target_crs,"options":options}).to_string().as_bytes()).unwrap();
            let result = child.wait_with_output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
            serde_json::from_slice(&result.stdout).map_err(|_| CoreError::new("CRS_RUNTIME_FAILED", String::from_utf8_lossy(&result.stdout).into_owned()))
        })
    }
}

#[tokio::test]
#[ignore = "requires isolated split GIS packages; executed by scripts/test-export-crs.py"]
async fn projected_job_publishes_verified_crs_and_resumes_from_conversion_pause() {
    for target in ["EPSG:4326", "EPSG:32650", "EPSG:4490"] { projected_case(target).await; }
}

async fn projected_case(target: &str) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let mut cursor = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(256,256,Rgba([35,70,140,255]))).write_to(&mut cursor,ImageFormat::Png).unwrap();
    let bytes = cursor.into_inner();
    let server = std::thread::spawn(move || {
        while !stopped.load(Ordering::Relaxed) {
            let (mut stream,_) = match listener.accept() { Ok(v)=>v, Err(e) if e.kind()==std::io::ErrorKind::WouldBlock=>{std::thread::sleep(Duration::from_millis(5));continue;}, Err(e)=>panic!("{e}") };
            stream.set_nonblocking(false).unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut buffer = [0;4096]; let _ = stream.read(&mut buffer);
            write!(stream,"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",bytes.len()).unwrap();
            stream.write_all(&bytes).unwrap();
        }
    });
    let endpoint = HttpSource {
        id:"crs-test".into(),name:"Synthetic CRS fixture".into(),attribution:"Generated pixels".into(),license:"Test fixture".into(),
        url_template:format!("http://{address}/{{z}}/{{x}}/{{y}}.png"),scheme:geod_core::imagery::TileScheme::XYZ,tile_size:256,network_policy:NetworkPolicy::UserTrustedHttp,
        min_interval_ms:0,subdomains:vec![],coordinate_system:None,elevation_encoding:None,authentication:None,runtime_token:None,
    };
    let source = SourceDescriptor {
        schema_version:SchemaVersion::V0_1,id:endpoint.id.clone(),display_name:endpoint.name.clone(),attribution:endpoint.attribution.clone(),license:endpoint.license.clone(),
        bulk_download_allowed:true,scheme:TileScheme::XYZ,tile_size:256,min_zoom:0,max_zoom:22,config_revision:endpoint.configuration_revision(),credential_ref_version:None,elevation_encoding:None,
    };
    let root = tempfile::tempdir().unwrap(); let destination = root.path().join("projected");
    let spec = TaskSpec {
        schema_version:SchemaVersion::V0_1,kind:TaskKind::Imagery,source_id:source.id.clone(),bounds:[116.38,39.89,116.48,39.98],boundary:None,zoom_levels:vec![12],
        output_formats:vec![OutputFormat::GeoTiff,OutputFormat::Png],output_directory:destination.to_string_lossy().into_owned(),
        limits:ResourceLimits { max_tiles:16,max_decoded_rgba_bytes:16*256*256*4 },
        export_options:Some(ExportOptions {target_crs:Some(target.into()),..Default::default()}),
    };
    let database = root.path().join("tasks.sqlite"); let mut store = TaskStore::open(&database).unwrap();
    let plan = store.create_plan(spec,&source,Utc::now()).unwrap();
    let approval = store.grant_approval(&plan.plan_id,&plan.plan.plan_hash,"test-user","test-ui",Utc::now()).unwrap();
    let job = store.start_job(&plan.plan_id,&plan.plan.plan_hash,&approval.approval_id,"crs-run",&source,Utc::now()).unwrap();
    let cancelled = AtomicBool::new(false); let paused = AtomicBool::new(false);
    let projector = PythonProjector {destination:destination.clone(),pause:true};
    assert_eq!(store.run_job_with_projector(&job.job_id,&source,&endpoint,&[],Utc::now(),&cancelled,&paused,ProxyRoute::Direct,Some(&projector)).await.unwrap_err().code,"PAUSED");
    assert_eq!(store.get_job(&job.job_id).unwrap().unwrap().state,JobState::Paused);
    assert!(!destination.exists());
    store.resume_paused_job(&job.job_id).unwrap();
    let projector = PythonProjector {destination:destination.clone(),pause:false};
    let manifest = store.run_job_with_projector(&job.job_id,&source,&endpoint,&[],Utc::now(),&cancelled,&paused,ProxyRoute::Direct,Some(&projector)).await.unwrap();
    assert_eq!(store.get_job(&job.job_id).unwrap().unwrap().state,JobState::Completed);
    let analysis: Vec<_> = manifest.assets.iter().filter(|a|a.role=="analysis").collect();
    assert_eq!(analysis.len(),2);
    assert!(analysis.iter().all(|a|a.crs==target && a.geo_transform.is_some() && a.crs_definition.is_some()));
    assert!(manifest.assets.iter().any(|a|a.path.ends_with(".pgw") && a.crs==target));
    assert!(store.events_after(&job.job_id,0,100).unwrap().iter().any(|e|e.processing_stage.as_deref()==Some("reprojecting")));
    assert!(store.inspect_job_artifact(&job.job_id).is_ok());
    // Startup recovery verifies the real converted grid, without running Python again.
    rusqlite::Connection::open(&database).unwrap().execute("UPDATE jobs SET state='verifying' WHERE job_id=?1",[&job.job_id]).unwrap();
    store.recover_verifying_job(&job.job_id).unwrap();
    // A different, otherwise valid CRS declaration cannot reuse this approval.
    let mut changed = manifest.clone();
    changed.assets.iter_mut().find(|a|a.role=="analysis" && a.mime_type=="image/png").unwrap().crs="EPSG:3857".into();
    std::fs::write(destination.join("manifest.json"),serde_json::to_vec(&changed).unwrap()).unwrap();
    assert_eq!(store.inspect_job_artifact(&job.job_id).unwrap_err().code,"ARTIFACT_CRS_MISMATCH");
    stop.store(true,Ordering::Relaxed); server.join().unwrap();
}

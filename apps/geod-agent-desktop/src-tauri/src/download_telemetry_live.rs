//! Explicit, ignored real-network acceptance. Never uses the owner's vault entry.
use super::*;
use geod_core::imagery::{HttpSource,NetworkPolicy,TileScheme,ExportOptions,OverlaySourceRef,ProxyRoute};
use geod_task_engine::{ledger::TaskStore,TaskSpec,TaskKind,SchemaVersion,OutputFormat,ResourceLimits};
use std::{sync::atomic::AtomicBool,io::{Read,Write}};

#[test]
#[ignore="Requires an explicitly provisioned internal account, real Amap and production telemetry"]
fn live_amap_delivery_and_persisted_outbox(){
 let dir=std::path::PathBuf::from(std::env::var("GEOD_DIAGNOSTIC_QA_OUTPUT").unwrap());std::fs::create_dir_all(&dir).unwrap();
 let(service,owner)=services::diagnostic_qa_service(&dir);
 let cache_volume=tempfile::tempdir().unwrap();let path=cache_volume.path().join("tasks.sqlite");let mut store=TaskStore::open(&path).unwrap();
 let mut db=Connection::open(&path).unwrap();
 db.execute_batch("CREATE TABLE imagery_plan_owners(plan_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL)").unwrap();schema(&db).unwrap();
 default_policy(&db,&owner).unwrap();assert_eq!(diagnostic_snapshot(&db,&owner).unwrap()["enabled"],true);assert_eq!(diagnostic_snapshot(&db,&owner).unwrap()["noticePending"],true);
 let runtime=tokio::runtime::Runtime::new().unwrap();let mut evidence=vec![];
 for(case,enabled,refused)in [("default-no-click",true,false),("explicit-off",false,false),("explicit-reenable",true,false),("controlled-overlay-403",true,true)]{
  if case=="explicit-off"{db.execute("UPDATE download_telemetry_consent SET enabled=0,diagnostic_consent=0,notice_version=3 WHERE owner=?1",[&owner]).unwrap();}
  if case=="explicit-reenable"{let at=Utc::now().to_rfc3339();db.execute("UPDATE download_telemetry_consent SET enabled=1,since=?2,diagnostic_consent=1,diagnostic_since=?2 WHERE owner=?1",params![owner,at]).unwrap();}
  let make=|id:&str,style:u8|HttpSource{id:id.into(),name:id.into(),attribution:"Amap".into(),license:"User-authorized acceptance only".into(),url_template:format!("https://webst01.is.autonavi.com/appmaptile?style={style}&size=1&scale=1&x={{x}}&y={{y}}&z={{z}}"),scheme:TileScheme::XYZ,tile_size:256,network_policy:NetworkPolicy::PublicHttps,min_interval_ms:100,subdomains:vec![],coordinate_system:None,elevation_encoding:None,authentication:None,runtime_token:None};
  let base=make(&format!("qa-base-{case}"),6);let mut overlay=make(&format!("qa-overlay-{case}"),8);
  let fixture=if refused{let socket=std::net::TcpListener::bind("127.0.0.1:0").unwrap();overlay.url_template=format!("http://{}/{{z}}/{{x}}/{{y}}",socket.local_addr().unwrap());overlay.network_policy=NetworkPolicy::UserTrustedHttp;Some(std::thread::spawn(move||{let(mut s,_)=socket.accept().unwrap();let mut bytes=[0;4096];let _=s.read(&mut bytes);s.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();}))}else{None};
  let source=store.save_source(base.clone(),0,22,false,Utc::now()).unwrap();let extra=store.save_source(overlay.clone(),0,22,false,Utc::now()).unwrap();
  let mut options=ExportOptions::default();options.overlay_sources=vec![OverlaySourceRef{source_id:extra.id,config_revision:extra.config_revision}];
  let spec=TaskSpec{schema_version:SchemaVersion::V0_1,kind:TaskKind::Imagery,source_id:source.id.clone(),bounds:[116.3900,39.9050,116.3901,39.9051],boundary:None,zoom_levels:vec![14],output_formats:vec![OutputFormat::GeoTiff],export_options:Some(options),output_directory:dir.join(case).display().to_string(),limits:ResourceLimits{max_tiles:4,max_decoded_rgba_bytes:4*256*256*4}};
  let p=store.create_plan(spec,&source,Utc::now()).unwrap();db.execute("INSERT INTO imagery_plan_owners VALUES(?1,?2)",params![p.plan_id,owner]).unwrap();
  let a=store.grant_approval(&p.plan_id,&p.plan.plan_hash,&owner,"explicit-internal-qa",Utc::now()).unwrap();let j=store.start_job(&p.plan_id,&p.plan.plan_hash,&a.approval_id,case,&source,Utc::now()).unwrap();
  let result=runtime.block_on(store.run_job_with_control_proxy_and_overlays(&j.job_id,&source,&base,&[overlay],Utc::now(),&AtomicBool::new(false),&AtomicBool::new(false),ProxyRoute::Direct));
  if let Some(fixture)=fixture{fixture.join().unwrap();}
  if refused{assert_eq!(result.unwrap_err().code,"SOURCE_UNAUTHORIZED");}else{assert_eq!(result.unwrap().quality.status,"complete");assert!(dir.join(case).join("manifest.json").exists());}
  let events=store.events_after(&j.job_id,0,100).unwrap();let d=events.last().unwrap().diagnostic.clone().unwrap();assert_eq!(d["sources"].as_array().unwrap().len(),2);assert!(d["storage"].as_array().unwrap().iter().all(|v|v["available_bytes"].is_u64()));
  if refused{assert_eq!(d["error_http_status"],403);assert_eq!(d["sources"][1]["http_status"],403);}
  // Reopen before collecting: terminal result does not depend on UI polling.
  drop(db);db=Connection::open(&path).unwrap();schema(&db).unwrap();reconcile_imagery(&db).unwrap();collect(&mut db).unwrap();
  if !enabled{assert_eq!(db.query_row("SELECT count(*) FROM download_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),0);}
  else{flush(&service,&mut db,&owner).unwrap();assert_eq!(db.query_row("SELECT count(*) FROM download_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),0);}
  evidence.push(json!({"case":case,"diagnostic":d,"taskState":events.last().unwrap().state}));
 }
 drop(runtime);
 flush(&service,&mut db,&owner).unwrap();assert_eq!(diagnostic_snapshot(&db,&owner).unwrap()["reason"],"reported");assert_eq!(db.query_row("SELECT count(*) FROM download_outbox",[],|r|r.get::<_,i64>(0)).unwrap(),0);
 let activity=Connection::open(cache_volume.path().join("activity.sqlite")).unwrap();let reporting=crate::activity_telemetry::live_default_acceptance(&activity,&service,&owner,&diagnostic_snapshot(&db,&owner).unwrap());
 assert!(evidence.iter().any(|v|v["diagnostic"]["storage"].as_array().unwrap().len()>=2));
 std::fs::write(dir.join("acceptance.json"),serde_json::to_vec_pretty(&json!({"passed":true,"testOnly":true,"owner":owner,"cases":evidence,"outboxAcknowledged":true,"activity":reporting,"freshDefaultRequiredNoClick":true,"actualSeparateVolumes":true})).unwrap()).unwrap();
}

use super::*;
use std::sync::OnceLock;
fn fixture(name:&str,date:&str)->Snapshot {
    static ROOT:OnceLock<std::path::PathBuf>=OnceLock::new();
    crate::initialize(ROOT.get_or_init(||tempfile::tempdir().unwrap().keep()).clone());
    let root=Root{id:sha(name.as_bytes()),epoch:7,key:vec![17;32],providers:BTreeMap::from([(4,"Fixture imagery provider".into())])};
    io::write(&io::directory().unwrap().join(format!("root-{}.json",root.id)),&serde_json::to_vec(&root).unwrap()).unwrap();
    select_snapshot(&root.id,date).unwrap()
}
fn record(date:&str)->DateRecord{DateRecord{date:date.into(),packed:pack_date(date).unwrap(),epoch:7,provider:4}}
#[test]fn historical_dates_use_real_calendar_and_never_choose_a_later_record(){
    for date in ["0001-01-01","2026-02-29","2010-1-01","2010-01-01?key=secret"]{assert!(pack_date(date).is_err());}
    let records=[record("2020-01-01"),record("2009-02-03"),record("2010-11-08")];
    assert_eq!(on_or_before(&records,pack_date("2010-12-31").unwrap()).unwrap().date,"2010-11-08");
    assert!(on_or_before(&records,pack_date("1900-01-01").unwrap()).is_none());
}
#[test]fn pinned_contexts_are_durable_content_bound_and_not_http_or_credential_templates(){
    let s=fixture("durability","2010-12-31");let reloaded=validate_template(&s.template()).unwrap();assert_eq!(reloaded.id,s.id);assert!(s.source_id().len()<=80);
    assert_eq!(select_snapshot(&s.root.id,"2010-12-31").unwrap().id,s.id);
    assert_ne!(select_snapshot(&s.root.id,"2011-12-31").unwrap().id,s.id);
    for bad in [s.template()+"?url=https://private",s.template().replace("{z}","0"),s.template().replace("geod-earth-history","file"),s.template().replace(&s.id,"../root")]{assert!(validate_template(&bad).is_err());}
    let info=snapshot_info(&s.template()).unwrap();assert_eq!(info["effectiveAcquisitionDate"],Value::Null);assert!(info.get("root").is_none());assert!(info.get("key").is_none());
    assert!(!io::allowed("http://khmdb.google.com/flatfile?db=tm&qp-0-q.1"));assert!(!io::allowed("https://khmdb.google.com.evil.test/dbRoot.v5?db=tm&hl=en&gl=us&output=proto"));assert!(!io::allowed("https://user@khmdb.google.com/dbRoot.v5?db=tm&hl=en&gl=us&output=proto"));
}
#[tokio::test]async fn a_frozen_missing_tile_is_not_a_successful_blank_and_does_not_repeat_discovery(){
    let s=fixture("missing-tile","1900-01-01");let grid=[16,53957,24830];let cells=Vec::new();let saved=FrozenSelection{snapshot_id:s.id.clone(),grid,sha256:selection_hash(&s.id,grid,&cells),cells};
    io::write(&selector_path(&s,16,53957,24830).unwrap(),&serde_json::to_vec(&saved).unwrap()).unwrap();
    let error=read_tile(&s.template(),16,53957,24830,reqwest::Client::new()).await.unwrap_err();assert!(error.starts_with("EARTH_NO_DATA:"));
    let facts=tile_evidence(&s.template(),&[(16,53957,24830),(16,53957,24831)]).unwrap();assert_eq!(facts["tiles"][0]["cells"],json!([]));assert_eq!(facts["tiles"][1]["selectionStatus"],"unknown");
}
#[tokio::test]async fn changed_frozen_selections_are_rejected_before_network_or_raster_work(){
    let s=fixture("changed-tile","2010-12-31");let grid=[16,53957,24830];let saved=FrozenSelection{snapshot_id:s.id.clone(),grid,cells:Vec::new(),sha256:"wrong".into()};
    io::write(&selector_path(&s,16,53957,24830).unwrap(),&serde_json::to_vec(&saved).unwrap()).unwrap();
    assert!(read_tile(&s.template(),16,53957,24830,reqwest::Client::new()).await.unwrap_err().starts_with("EARTH_PLAN:"));
}
#[test]fn native_quadtree_and_inverse_mercator_sampling_preserve_geographic_positions(){
    for level in 0..=20{let r=((1u32<<level)-1)/3;let c=((1u32<<level)-1)/2;assert_eq!(row_col(&path_for(r,c,level)),(r,c,level));}
    let(z,x,y)=(2,1,1);let mut selected=Vec::new();
    for r in 0..8{for c in 0..8{selected.push(Selection{cell_path:path_for(r,c,3),path:"0".into(),record:record("2010-11-08")});}}
    let image=RgbImage::from_fn(256,256,|x,y|image::Rgb([x as u8,y as u8,100]));let images=BTreeMap::from([("0".into(),Arc::new(image))]);let result=render(&selected,&images,z,x,y).unwrap();assert!(result.pixels().all(|p|p[3]==255));
    let lon=(x as f64+128.5/256.)/4.*360.-180.;let lat=(std::f64::consts::PI*(1.-2.*(y as f64+128.5/256.)/4.)).sinh().atan().to_degrees();let p=result.get_pixel(128,128);
    assert!((f64::from(p[0])-((lon+180.)/360.*256.-0.5)).abs()<=1.);assert!((f64::from(p[1])-(256.-(lat+180.)/360.*256.-0.5)).abs()<=1.);assert_eq!(p[2],100);
}
#[test]fn malformed_compression_and_protobuf_frames_are_bounded(){
    assert!(io::unpack(&[0;8]).is_err());let mut bytes=0x7468deadu32.to_le_bytes().to_vec();bytes.extend_from_slice(&(32*1024*1024u32+1).to_le_bytes());assert!(io::unpack(&bytes).unwrap_err().starts_with("EARTH_BUDGET:"));
    assert!(wire::parse(&[0xff;11]).is_err());assert!(io::decrypt(&[0;32],&[0;8]).is_err());
}

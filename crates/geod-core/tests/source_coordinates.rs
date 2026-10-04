use geod_core::imagery::{authenticated_request,preview_tile_url,HttpSource,CoordinateSystem,SourceAuthentication,AuthenticationMode,RuntimeToken};
use reqwest::{Client,Url};
use serde_json::json;
use sha2::{Digest,Sha256};

fn source() -> HttpSource { serde_json::from_value(json!({"id":"coordinates","name":"Coordinate fixture","attribution":"","license":"","urlTemplate":"https://tiles.example.org/{z}/{x}/{y}.png","scheme":"XYZ","tileSize":256,"networkPolicy":"PublicHttps","minIntervalMs":0})).unwrap() }

#[test] fn omitted_coordinate_metadata_preserves_original_fingerprint() {
    let mut value=source();value.validate_configuration().unwrap();
    let original=format!("{:x}",Sha256::digest(serde_json::to_vec(&(&value.id,&value.url_template,value.scheme,value.tile_size,value.network_policy,value.min_interval_ms)).unwrap()));
    assert_eq!(value.configuration_revision(),original);let serialized=serde_json::to_value(&value).unwrap();assert!(serialized.get("subdomains").is_none());assert!(serialized.get("coordinateSystem").is_none());
    value.coordinate_system=Some(CoordinateSystem::Wgs84);assert_eq!(value.configuration_revision(),original);
    value.coordinate_system=Some(CoordinateSystem::Gcj02);assert_ne!(value.configuration_revision(),original);
}

#[test] fn subdomains_rotate_deterministically_and_reject_non_host_templates() {
    let mut value=source();value.url_template="https://tiles{s}.example.org/{z}/{x}/{y}.png".into();value.subdomains=vec!["0".into(),"1".into(),"2".into()];
    value.validate_configuration().unwrap();let origins=value.request_origins().unwrap();assert_eq!(origins.len(),3);
    let seen=(0..3).map(|x|preview_tile_url(&value,3,x,2).unwrap().host_str().unwrap().to_string()).collect::<std::collections::HashSet<_>>();assert_eq!(seen.len(),3);
    assert_eq!(preview_tile_url(&value,3,2,2).unwrap(),preview_tile_url(&value,3,2,2).unwrap());
    let original=value.configuration_revision();value.subdomains.reverse();assert_ne!(value.configuration_revision(),original);
    for bad in [vec!["a.b"],vec!["/evil"],vec!["a","A"],vec!["-a"],vec!["x@host"],vec![]] {value.subdomains=bad.into_iter().map(str::to_owned).collect();assert!(value.validate_configuration().is_err());}
    value.subdomains=vec!["a".into()];value.url_template="https://tiles.example.org/{s}/{z}/{x}/{y}.png".into();assert!(value.validate_configuration().is_err());
}

#[test] fn credentials_are_sent_only_to_explicitly_expanded_origins() {
    let mut value=source();value.url_template="https://tiles{s}.example.org/{z}/{x}/{y}.png".into();value.subdomains=vec!["0".into(),"1".into()];
    value.authentication=Some(SourceAuthentication{mode:AuthenticationMode::QueryToken,parameter:"token".into(),credential_ref:"keyring:fixture".into(),version:"v1".into(),origin:"https://tiles0.example.org".into()});value.runtime_token=Some(RuntimeToken("synthetic-test-token".into()));
    value.validate_configuration().unwrap();let client=Client::new();
    for host in ["tiles0.example.org","tiles1.example.org"] {let request=authenticated_request(&client,Url::parse(&format!("https://{host}/1/0/0.png")).unwrap(),&value).unwrap().build().unwrap();assert!(request.url().query_pairs().any(|(key,val)|key=="token"&&val=="synthetic-test-token"));}
    for host in ["tiles2.example.org","tiles1.example.org.evil.test","example.org"] {assert!(authenticated_request(&client,Url::parse(&format!("https://{host}/1/0/0.png")).unwrap(),&value).is_err());}
    assert!(authenticated_request(&client,Url::parse("http://tiles1.example.org/1/0/0.png").unwrap(),&value).is_err());
    assert!(!serde_json::to_string(&value).unwrap().contains("synthetic-test-token"));
}

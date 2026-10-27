use geod_earth_history as history;
#[tokio::main]
async fn main()->Result<(),Box<dyn std::error::Error>>{
    let args:Vec<String>=std::env::args().collect();
    if args.len()<5{return Err("probe CACHE_DIRECTORY LONGITUDE LATITUDE ZOOM [DATE] [PROXY]".into());}
    history::initialize(std::path::PathBuf::from(&args[1]));let lon:f64=args[2].parse()?;let lat:f64=args[3].parse()?;let z:u8=args[4].parse()?;
    let mut builder=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(std::time::Duration::from_secs(10)).timeout(std::time::Duration::from_secs(30)).user_agent("GeoD-Agent/Google-Earth-History-v1");
    if let Some(proxy)=args.get(6){builder=builder.no_proxy().proxy(reqwest::Proxy::all(proxy)?);}
    let client=builder.build()?;let catalog=history::discover(lon,lat,z,client.clone()).await?;println!("{}",serde_json::to_string(&catalog)?);
    if let Some(date)=args.get(5){let s=history::select_snapshot(catalog["catalogId"].as_str().ok_or("No real catalogue")?,date)?;let n=2f64.powi(z as i32);let x=((lon+180.)/360.*n).floor()as u32;let y=((1.-lat.to_radians().tan().asinh()/std::f64::consts::PI)/2.*n).floor()as u32;
        let bytes=history::read_tile(&s.template(),z,x,y,client).await?;let target=std::path::Path::new(&args[1]).join("real-google-history.png");std::fs::write(&target,&bytes)?;
        let facts=history::tile_evidence(&s.template(),&[(z,x,y)])?;std::fs::write(std::path::Path::new(&args[1]).join("real-google-history.json"),serde_json::to_vec_pretty(&facts)?)?;
        println!("{}",serde_json::json!({"snapshot":s.id,"sourceTemplate":s.template(),"bytes":bytes.len(),"path":target,"facts":facts}));
    }Ok(())
}

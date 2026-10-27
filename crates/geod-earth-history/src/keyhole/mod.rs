mod io;
mod protocol;
mod wire;
use crate::{dates::pack_date, storage::sha, Result, SCHEME};
use image::{RgbImage,Rgba,RgbaImage};
use protocol::{DateRecord,Engine,Root};
use serde::{Serialize,Deserialize};
use serde_json::{json,Value};
use std::{collections::{BTreeMap,BTreeSet},sync::Arc};
const VERSION: &str = "geod-earth-history.v1";
pub fn valid_path(path:&str)->bool { !path.is_empty()&&path.len()<=21&&path.starts_with('0')&&path.bytes().all(|b|(b'0'..=b'3').contains(&b)) }
pub fn path_for(row:u32,col:u32,level:u8)->String {
    let mut path=String::from("0");
    for bit in (0..level).rev(){let r=(row>>bit)&1;let c=(col>>bit)&1;path.push(char::from(b'0'+((r<<1)|(r^c))as u8));}path
}
fn row_col(path:&str)->(u32,u32,u8){let(mut r,mut c)=(0,0);for digit in path.bytes().skip(1){let y=(digit-b'0')>>1;let x=y^((digit-b'0')&1);r=(r<<1)|u32::from(y);c=(c<<1)|u32::from(x);}(r,c,(path.len()-1)as u8)}
pub fn subindex(path:&str)->u32 {
    fn index(s:&str)->u32{s.bytes().skip(1).fold(0,|n,c|n*4+u32::from(c-b'0')+1)}
    if path.len()<=4{return index(path);}let tail=&path[((path.len()-1)/4)*4..];index(tail)+u32::from(tail.as_bytes()[0]-b'0')*85+1
}
fn native_level(z:u8)->u8 { z.saturating_add(1).clamp(1,20) }
fn cell(lon:f64,lat:f64,level:u8)->(u32,u32){let n=1u32<<level;let to=|v:f64|(((v+180.)/360.*f64::from(n)).floor().max(0.)as u32).min(n-1);(to(lat),to(lon))}
fn coordinates(z:u8,x:u32,y:u32)->Result<()> { if z>22||u64::from(x)>=1u64<<z||u64::from(y)>=1u64<<z{Err("EARTH_PLAN: tile outside XYZ grid".into())}else{Ok(())} }
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Selection { pub cell_path:String,pub path:String,pub record:DateRecord }
impl Selection { pub fn url(&self)->String{format!("https://khmdb.google.com/flatfile?db=tm&f1-{}-i.{}-{:x}",self.path,self.record.epoch,self.record.packed)} }
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Snapshot {pub id:String,root:Root,pub requested_date:String,version:String}
impl Snapshot {
    fn identity(&self)->String{sha(&serde_json::to_vec(&(&self.root,&self.requested_date,&self.version)).unwrap())}
    pub fn template(&self)->String{format!("{SCHEME}://{}/{{z}}/{{x}}/{{y}}",self.id)}
    pub fn source_id(&self)->String{format!("earth-history-{}",self.id)}
    fn load(id:&str)->Result<Self>{
        crate::validate_id(id)?;
        let path=io::directory()?.join(format!("snapshot-{id}.json"));
        let bytes=std::fs::read(&path).map_err(|_|"EARTH_PLAN: saved history snapshot is unavailable; query dates again")?;
        if bytes.len()>2*1024*1024{return Err("EARTH_PLAN: invalid history snapshot size".into());}
        let snapshot:Self=serde_json::from_slice(&bytes).map_err(|_|"EARTH_PLAN: saved history snapshot is invalid")?;
        if snapshot.id!=id||snapshot.identity()!=id||snapshot.version!=VERSION{return Err("EARTH_PLAN: history snapshot identity changed".into());}
        pack_date(&snapshot.requested_date)?;Ok(snapshot)
    }
}
pub fn validate_template(template:&str)->Result<Snapshot>{
    let id=template.strip_prefix("geod-earth-history://").and_then(|s|s.split('/').next()).ok_or("EARTH_PLAN: invalid history source")?;
    crate::validate_id(id)?;
    if template!=format!("{SCHEME}://{id}/{{z}}/{{x}}/{{y}}"){return Err("EARTH_PLAN: history source must use its canonical snapshot template".into());}
    Snapshot::load(id)
}
pub async fn discover(lon:f64,lat:f64,z:u8,client:reqwest::Client)->Result<Value>{
    if !lon.is_finite()||!lat.is_finite()||!(-180. ..=180.).contains(&lon)||!(-85.05112878..=85.05112878).contains(&lat)||z>22{return Err("EARTH_AOI: invalid catalogue position or level".into());}
    let engine=Engine::open(client).await?;
    let level=native_level(z);let(r,c)=cell(lon,lat,level);let path=path_for(r,c,level);let mut current=path.clone();let mut records=Vec::new();
    loop{if let Some(node)=engine.node(&current).await?{if !node.dates.is_empty(){records=node.dates;break;}}if current.len()<=1{break;}current.pop();}
    let dates:BTreeSet<_>=records.into_iter().map(|r|r.date).collect();
    Ok(json!({"catalogId":engine.root.id,"dates":dates.into_iter().rev().collect::<Vec<_>>(),"point":[lon,lat],"zoom":z,"catalogLevel":current.len()-1,"scope":"point","coverageFraction":null,
        "dateMeaning":"历史目录日期；不能据此保证整个范围的覆盖或逐像素拍摄日期。区域覆盖在下载与核验时检查。","effectiveAcquisitionDate":null}))
}
pub fn select_snapshot(catalog_id:&str,date:&str)->Result<Snapshot>{
    pack_date(date)?;let mut snapshot=Snapshot{id:String::new(),root:Root::load(catalog_id)?,requested_date:date.into(),version:VERSION.into()};snapshot.id=snapshot.identity();
    let file=io::directory()?.join(format!("snapshot-{}.json",snapshot.id));
    if file.exists(){return Snapshot::load(&snapshot.id);}io::write(&file,&serde_json::to_vec(&snapshot).unwrap())?;Ok(snapshot)
}
pub fn snapshot_info(template:&str)->Result<Value>{let s=validate_template(template)?;Ok(json!({"provider":"google_earth_history","protocol":"keyhole","snapshotId":s.id,"catalogId":s.root.id,"rootEpoch":s.root.epoch,"requestedDate":s.requested_date,
    "selectionPolicy":"on_or_before","effectiveAcquisitionDate":null,"dateMeaning":"历史目录日期不等于全部像素的实际拍摄日期","attribution":"© Google Earth; imagery providers recorded per native cell","assetType":"processed_map_imagery","resampling":"inverse Web Mercator and bilinear sampling"}))}
async fn select(engine:&Engine,cell_path:&str,date:u32)->Result<Option<Selection>>{
    let mut path=cell_path.to_owned();loop{if let Some(node)=engine.node(&path).await?{if let Some(record)=on_or_before(&node.dates,date){return Ok(Some(Selection{cell_path:cell_path.into(),path,record:record.clone()}));}}if path.len()<=1{return Ok(None);}path.pop();}
}
fn on_or_before(records:&[DateRecord],date:u32)->Option<&DateRecord>{records.iter().filter(|d|d.packed<=date).max_by_key(|d|d.packed)}
fn selector_path(s:&Snapshot,z:u8,x:u32,y:u32)->Result<std::path::PathBuf>{Ok(io::directory()?.join(format!("selection-{}-{z}-{x}-{y}.json",s.id)))}
#[derive(Serialize,Deserialize)]
struct FrozenSelection { snapshot_id:String, grid:[u32;3], cells:Vec<Selection>, sha256:String }
fn selection_hash(snapshot:&str,grid:[u32;3],cells:&[Selection])->String{sha(&serde_json::to_vec(&(snapshot,grid,cells)).unwrap())}
async fn selections(s:&Snapshot,client:reqwest::Client,z:u8,x:u32,y:u32)->Result<Vec<Selection>>{
    let file=selector_path(s,z,x,y)?;let grid=[u32::from(z),x,y];let packed=pack_date(&s.requested_date)?;
    if let Ok(bytes)=std::fs::read(&file){
        if bytes.len()>256*1024{return Err("EARTH_PLAN: oversized frozen tile selection".into());}
        let saved:FrozenSelection=serde_json::from_slice(&bytes).map_err(|_|"EARTH_PLAN: invalid frozen tile selection")?;
        if saved.snapshot_id!=s.id||saved.grid!=grid||saved.sha256!=selection_hash(&s.id,grid,&saved.cells)||saved.cells.iter().any(|c|!valid_path(&c.path)||!valid_path(&c.cell_path)||!c.cell_path.starts_with(&c.path)||c.record.packed>packed){return Err("EARTH_PLAN: frozen tile selection changed".into());}return Ok(saved.cells);
    }
    let scale=2f64.powi(z as i32);let lon=|v:f64|v/scale*360.-180.;let lat=|v:f64|(std::f64::consts::PI*(1.-2.*v/scale)).sinh().atan().to_degrees();let level=native_level(z);
    let(r0,c0)=cell(lon(x as f64)+1e-10,lat(y as f64+1.)+1e-10,level);let(r1,c1)=cell(lon(x as f64+1.)-1e-10,lat(y as f64)-1e-10,level);
    if u64::from(r1-r0+1)*u64::from(c1-c0+1)>32{return Err("EARTH_UNSUPPORTED: native cells per tile exceed the raster working set".into());}
    let engine=Engine{root:s.root.clone(),client};let mut cells=Vec::new();
    for row in r0..=r1{for col in c0..=c1{if let Some(selected)=select(&engine,&path_for(row,col,level),packed).await?{cells.push(selected);}}}
    let saved=FrozenSelection{snapshot_id:s.id.clone(),grid,sha256:selection_hash(&s.id,grid,&cells),cells};io::write(&file,&serde_json::to_vec(&saved).unwrap())?;Ok(saved.cells)
}
pub async fn read_tile(template:&str,z:u8,x:u32,y:u32,client:reqwest::Client)->Result<Vec<u8>>{
    coordinates(z,x,y)?;let snapshot=validate_template(template)?;
    let gate=io::gate(&format!("selection:{}/{z}/{x}/{y}",snapshot.id));let _guard=gate.lock().await;
    let chosen=selections(&snapshot,client.clone(),z,x,y).await?;
    if chosen.is_empty(){return Err("EARTH_NO_DATA: no indexed imagery on or before the selected date".into());}
    let engine=Engine{root:snapshot.root.clone(),client};let mut images=BTreeMap::new();
    for selection in &chosen{if !images.contains_key(&selection.path){images.insert(selection.path.clone(),engine.image(selection).await?);}}
    let output=render(&chosen,&images,z,x,y)?;
    // Missing native cells are a missing output tile, never a successful blank.
    if output.pixels().any(|p|p[3]!=255){return Err("EARTH_NO_DATA: incomplete native cell coverage for this output tile".into());}
    let mut png=std::io::Cursor::new(Vec::new());output.write_to(&mut png,image::ImageFormat::Png).map_err(|_|"EARTH_RASTER: unable to encode native imagery")?;Ok(png.into_inner())
}
pub fn tile_evidence(template:&str,tiles:&[(u8,u32,u32)])->Result<Value>{
    let snapshot=validate_template(template)?;let mut entries=Vec::new();let mut providers=BTreeSet::new();
    for &(z,x,y) in tiles{let grid=[u32::from(z),x,y];let file=selector_path(&snapshot,z,x,y)?;
        let value=std::fs::read(file).ok().and_then(|b|serde_json::from_slice::<FrozenSelection>(&b).ok());
        if let Some(saved)=value.filter(|s|s.snapshot_id==snapshot.id&&s.grid==grid&&s.sha256==selection_hash(&snapshot.id,grid,&s.cells)){
            let mut cells=Vec::new();for selected in saved.cells{
                let credit=snapshot.root.providers.get(&selected.record.provider).cloned();if let Some(c)=&credit{providers.insert(c.clone());}
                let url=selected.url();let evidence=std::fs::read(io::directory()?.join(format!("{}.ref",sha(url.as_bytes())))).ok().and_then(|b|serde_json::from_slice::<io::Evidence>(&b).ok());
                cells.push(json!({"cellPath":selected.cell_path,"path":selected.path,"historyDate":selected.record.date,"imageryEpoch":selected.record.epoch,"providerId":selected.record.provider,"providerAttribution":credit,"contentEvidence":evidence}));
            }entries.push(json!({"grid":grid,"selectionHash":saved.sha256,"cells":cells,"effectiveAcquisitionDate":null}));
        }else{entries.push(json!({"grid":grid,"selectionStatus":"unknown","effectiveAcquisitionDate":null}));}
    }
    let mut document=snapshot_info(template)?;document["tiles"]=json!(entries);document["providers"]=json!(providers);Ok(document)
}
fn render(selected:&[Selection],images:&BTreeMap<String,Arc<RgbImage>>,z:u8,x:u32,y:u32)->Result<RgbaImage>{
    let mut output=RgbaImage::new(256,256);let level=native_level(z);let scale=2f64.powi(z as i32);let lookup:BTreeMap<_,_>=selected.iter().map(|s|(s.cell_path.as_str(),s)).collect();
    for py in 0..256{let lat=(std::f64::consts::PI*(1.-2.*(y as f64+(py as f64+0.5)/256.)/scale)).sinh().atan().to_degrees();
        for px in 0..256{let lon=(x as f64+(px as f64+0.5)/256.)/scale*360.-180.;let(row,col)=cell(lon,lat,level);let path=path_for(row,col,level);
            let Some(s)=lookup.get(path.as_str())else{continue;};let Some(image)=images.get(&s.path)else{continue;};let(r,c,l)=row_col(&s.path);let size=2f64.powi(l as i32);
            let fx=((lon+180.)/360.*size-c as f64)*256.-0.5;let fy=(r as f64+1.-(lat+180.)/360.*size)*256.-0.5;let ix=fx.floor();let iy=fy.floor();let tx=fx-ix;let ty=fy-iy;
            let get=|dx:f64,dy:f64|image.get_pixel((ix+dx).clamp(0.,255.)as u32,(iy+dy).clamp(0.,255.)as u32);let mut pixel=[0,0,0,255];
            for b in 0..3{pixel[b]=((1.-ty)*((1.-tx)*get(0.,0.)[b]as f64+tx*get(1.,0.)[b]as f64)+ty*((1.-tx)*get(0.,1.)[b]as f64+tx*get(1.,1.)[b]as f64)).round()as u8;}
            output.put_pixel(px,py,Rgba(pixel));
        }
    }Ok(output)
}

#[cfg(test)]
mod tests;

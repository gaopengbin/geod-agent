//! GCJ-02 source pixels -> ordinary WGS84/Web-Mercator output pixels.
//!
//! Forward coordinate formula adapted from wandergis/coordtransform (MIT),
//! Copyright (c) 2015 记忆的残骸. See docs/third-party/coordtransform-MIT.txt.
//! Sampling, inverse iteration and bounded tile planning are GeoD Agent code.

use super::CoreError;
use image::{Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeSet, HashMap}, f64::consts::PI, sync::Arc};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CoordinateSystem { Wgs84, Gcj02 }

const A: f64 = 6_378_245.0;
const EE: f64 = 0.006_693_421_622_965_943;
fn transformed_lat(x: f64, y: f64) -> f64 {
    -100.0 + 2.0*x + 3.0*y + 0.2*y*y + 0.1*x*y + 0.2*x.abs().sqrt()
        + (20.0*(6.0*x*PI).sin()+20.0*(2.0*x*PI).sin())*2.0/3.0
        + (20.0*(y*PI).sin()+40.0*(y/3.0*PI).sin())*2.0/3.0
        + (160.0*(y/12.0*PI).sin()+320.0*(y*PI/30.0).sin())*2.0/3.0
}
fn transformed_lon(x: f64, y: f64) -> f64 {
    300.0 + x + 2.0*y + 0.1*x*x + 0.1*x*y + 0.1*x.abs().sqrt()
        + (20.0*(6.0*x*PI).sin()+20.0*(2.0*x*PI).sin())*2.0/3.0
        + (20.0*(x*PI).sin()+40.0*(x/3.0*PI).sin())*2.0/3.0
        + (150.0*(x/12.0*PI).sin()+300.0*(x/30.0*PI).sin())*2.0/3.0
}
pub fn wgs84_to_gcj02(lon: f64, lat: f64) -> [f64; 2] {
    if !(73.66 < lon && lon < 135.05 && 3.86 < lat && lat < 53.55) { return [lon, lat]; }
    let radians=lat.to_radians(); let magic=1.0-EE*radians.sin().powi(2); let root=magic.sqrt();
    [lon+transformed_lon(lon-105.0,lat-35.0)*180.0/(A/root*radians.cos()*PI),
     lat+transformed_lat(lon-105.0,lat-35.0)*180.0/(A*(1.0-EE)/(magic*root)*PI)]
}
pub fn gcj02_to_wgs84(lon: f64, lat: f64) -> [f64; 2] {
    let mut estimate=[lon,lat];
    for _ in 0..12 { let mapped=wgs84_to_gcj02(estimate[0],estimate[1]); let error=[mapped[0]-lon,mapped[1]-lat]; estimate[0]-=error[0];estimate[1]-=error[1];if error[0].abs().max(error[1].abs())<1e-11{break;} }
    estimate
}

/// Maps a WGS84 pixel centre to a GCJ source pixel index (centres are integers).
pub fn source_pixel(zoom: u8, tile_size: u16, px: f64, py: f64) -> [f64;2] {
    let size=(1u64<<zoom) as f64*f64::from(tile_size);
    let lon=px/size*360.0-180.0; let lat=(PI*(1.0-2.0*py/size)).sinh().atan().to_degrees();
    let target=wgs84_to_gcj02(lon,lat);
    if target==[lon,lat] { return [px-0.5,py-0.5]; }
    [(target[0]+180.0)/360.0*size-0.5, (1.0-(target[1].to_radians().tan()+1.0/target[1].to_radians().cos()).ln()/PI)/2.0*size-0.5]
}

pub struct WarpPlan { pub tiles: BTreeSet<(u32,u32)>, positions: Vec<[f64;2]>, tile_size: u16, world_pixels: i64 }
impl WarpPlan {
    /// Inspect every target pixel so boundary discontinuities cannot omit a neighbour.
    /// 512px output uses <=4 MiB of positions, plus <=16 decoded source tiles.
    pub fn new(zoom: u8, x: u32, y: u32, tile_size: u16) -> Result<Self,CoreError> {
        let side=i64::from(tile_size); let world_pixels=(1i64<<zoom)*side;
        let mut result=Self { tiles:BTreeSet::new(),positions:Vec::with_capacity(usize::from(tile_size).pow(2)),tile_size,world_pixels };
        for row in 0..tile_size { for col in 0..tile_size {
            let p=source_pixel(zoom,tile_size,f64::from(x)*f64::from(tile_size)+f64::from(col)+0.5,f64::from(y)*f64::from(tile_size)+f64::from(row)+0.5);
            result.positions.push(p);
            let ix=p[0].floor() as i64;let iy=p[1].floor() as i64;
            for (dx,dy) in [(0,0),(1,0),(0,1),(1,1)] {
                if (dx==1 && p[0]-p[0].floor()<1e-10) || (dy==1 && p[1]-p[1].floor()<1e-10) {continue;}
                result.tiles.insert((((ix+dx).rem_euclid(world_pixels)/side) as u32,((iy+dy).clamp(0,world_pixels-1)/side) as u32));
            }
            if result.tiles.len()>16 { return Err(CoreError::new("SOURCE_WARP_LIMIT","Coordinate transform requires too many source tiles for one output tile")); }
        }}
        Ok(result)
    }
    pub fn render(&self, tiles: &HashMap<(u32,u32),Arc<RgbaImage>>) -> Result<RgbaImage,CoreError> {
        let side=i64::from(self.tile_size); let size=u32::from(self.tile_size);
        let mut output=RgbaImage::new(size,size);
        for (index,p) in self.positions.iter().enumerate() {
            let x=p[0].floor() as i64;let y=p[1].floor() as i64;let fx=p[0]-p[0].floor();let fy=p[1]-p[1].floor();
            let mut sum=[0.0f64;4];
            for (dx,dy,weight) in [(0,0,(1.0-fx)*(1.0-fy)),(1,0,fx*(1.0-fy)),(0,1,(1.0-fx)*fy),(1,1,fx*fy)] {
                if weight<1e-10 {continue;}
                let sx=(x+dx).rem_euclid(self.world_pixels);let sy=(y+dy).clamp(0,self.world_pixels-1);
                let tile=tiles.get(&((sx/side) as u32,(sy/side) as u32)).ok_or_else(||CoreError::new("SOURCE_TILE_MISSING","A required coordinate-transform neighbour is missing"))?;
                let pixel=tile.get_pixel((sx%side) as u32,(sy%side) as u32);let alpha=f64::from(pixel[3]);
                for c in 0..3 {sum[c]+=f64::from(pixel[c])*alpha*weight;}sum[3]+=alpha*weight;
            }
            let mut value=[0;4];if sum[3]>0.0{for c in 0..3{value[c]=(sum[c]/sum[3]).round().clamp(0.0,255.0) as u8;}value[3]=sum[3].round().clamp(0.0,255.0) as u8;}
            output.put_pixel(index as u32%size,index as u32/size,Rgba(value));
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn known_reference_and_iterated_inverse() {
        let mapped=wgs84_to_gcj02(116.404,39.915);
        assert!((mapped[0]-116.41024449916938).abs()<1e-10);assert!((mapped[1]-39.91640428150164).abs()<1e-10);
        let original=gcj02_to_wgs84(mapped[0],mapped[1]);assert!((original[0]-116.404).abs()<1e-9);assert!((original[1]-39.915).abs()<1e-9);
        assert_eq!(wgs84_to_gcj02(-74.0,40.0),[-74.0,40.0]);
    }
    #[test] fn adjacent_outputs_sample_one_continuous_source_grid() {
        let zoom=16;let size=256;let x=53954;let y=24831;
        let left=WarpPlan::new(zoom,x,y,size).unwrap();let right=WarpPlan::new(zoom,x+1,y,size).unwrap();
        let mut tiles=HashMap::new();
        let origin=(left.tiles.iter().map(|p|p.0).min().unwrap()*256) as f64;
        for &(tx,ty) in left.tiles.union(&right.tiles) {
            tiles.insert((tx,ty),Arc::new(RgbaImage::from_fn(256,256,|col,row|Rgba([(((f64::from(tx)*256.0+f64::from(col)-origin)/8.0).round() as u32%256) as u8,(row/2) as u8,180,255]))));
        }
        let a=left.render(&tiles).unwrap();let b=right.render(&tiles).unwrap();
        for row in 0..256 {assert!((i16::from(a.get_pixel(255,row)[0])-i16::from(b.get_pixel(0,row)[0])).abs()<=1);assert_eq!(a.get_pixel(255,row)[3],255);assert_eq!(b.get_pixel(0,row)[3],255);}
        assert!(left.tiles.len()<=9);assert!(right.tiles.len()<=9);
    }
}

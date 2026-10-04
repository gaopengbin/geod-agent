import {fromUrl} from "geotiff";
import {convertFileSrc} from "@tauri-apps/api/core";
import {api} from "../src/api";
import {artifactRasterSource} from "../src/artifact-raster-source";

/** Invoked through native IPC's test adapter; reads bytes without UI interaction. */
export async function checkRaster(jobId:string) {
 const raster=await api.artifactRaster(jobId);
 const url=convertFileSrc(raster.resourceId,"geod-raster"),file=await fromUrl(url),image=await file.getImage();
 const width=image.getWidth(),height=image.getHeight(),x=Math.floor(width/2),y=Math.floor(height/2);
 const samples=await image.readRasters({window:[x,y,x+4,y+4],interleave:true});
 const source=artifactRasterSource(raster.resourceId,!!raster.elevationEncoding);await source.getView();
 const grid=source.getTileGrid()!,zoom=grid.getMaxZoom(),range=grid.getFullTileRange(zoom)!;
 const tile=source.getTile(zoom,Math.floor((range.minX+range.maxX)/2),Math.floor((range.minY+range.maxY)/2),1);
 await new Promise<void>((resolve,reject)=>{const changed=()=>{if(tile.getState()===2){tile.removeEventListener("change",changed);resolve()}else if(tile.getState()===3){tile.removeEventListener("change",changed);reject(new Error("Native GeoTIFF data tile failed"))}};tile.addEventListener("change",changed);tile.load();changed()});
 const data=tile.getData() as Uint8Array;
 const dataTile={type:data.constructor.name,bandCount:source.bandCount,length:data.length,nonzeroValues:data.reduce((n,v)=>n+(v>0?1:0),0)};
 source.dispose();
 return {jobId:raster.jobId,assetId:raster.assetId,sha256:raster.sha256,width,height,maxStripBytes:Math.max(...image.fileDirectory.StripByteCounts),samples:Array.from(samples),protocol:url.split(":")[0],dataTile};
}

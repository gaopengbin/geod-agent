import GeoTIFF from "ol/source/GeoTIFF";
import { convertFileSrc } from "@tauri-apps/api/core";

export function artifactRasterSource(resourceId: string, elevation = false) {
  // GeoD exports 8-bit RGBA. Fixed 0..255 normalization preserves its colors.
  // The default 6 MB block cache evicts strips still used by concurrent reads;
  // this 128 MB LRU cache keeps those reads available.
  return new GeoTIFF({
    normalize: true, interpolate: false, sourceOptions: { cacheSize:2048 },
    sources: [{ url:convertFileSrc(resourceId,"geod-raster"), ...(elevation ? {bands:[1],min:-1000,max:5000,nodata:-9999} : {bands:[1,2,3,4],min:0,max:255}) }],
  });
}

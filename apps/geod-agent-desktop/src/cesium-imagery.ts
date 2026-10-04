import * as Cesium from 'cesium';
import { api } from './api';

/** Use GeoD's proxy and credential-aware native tile path in the 3D globe too. */
export function nativeImageryProvider(sourceId: string | null, attribution: string, maximumLevel = 19, url: string | null = null) {
  const provider = new Cesium.UrlTemplateImageryProvider({
    // The shared native OSM viewport cache supports levels 0–15.
    url: 'https://native.invalid/{z}/{x}/{y}', maximumLevel: sourceId === null && url === null ? 15 : maximumLevel,
    tilingScheme: new Cesium.WebMercatorTilingScheme(), credit: new Cesium.Credit(attribution),
  });
  const stats = { loaded: 0, failed: 0, pending: 0, lastError: null as string | null };
  provider.requestImage = (x: number, y: number, level: number) => {
    // Returning undefined lets Cesium retry without flooding the native HTTP path.
    if (stats.pending >= 8) return undefined;
    stats.pending++;
    const tileUrl = url?.replaceAll('{z}', String(level)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y)).replaceAll('{reverseY}', String(2 ** level - y - 1)).replaceAll('{s}', 'a') ?? null;
    return (sourceId === null && url === null ? api.osmBasemapTile(level, x, y) : api.mapPreviewTile(sourceId, tileUrl, level, x, y))
      .then(encoded => new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('底图瓦片无法解码'));
        image.src = encoded.startsWith('data:') ? encoded : `data:image/${encoded.startsWith('/9j/') ? 'jpeg' : encoded.startsWith('UklGR') ? 'webp' : 'png'};base64,${encoded}`;
      })).then(image => { stats.loaded++; return image; })
      .catch(cause => { stats.failed++; stats.lastError = cause instanceof Error ? cause.message : String(cause); throw cause; })
      .finally(() => { stats.pending--; });
  };
  return { provider, stats };
}

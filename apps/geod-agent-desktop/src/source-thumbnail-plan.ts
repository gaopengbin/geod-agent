export interface ThumbnailTile { z: number; x: number; y: number; longitude: number; latitude: number; fromExtent: boolean }

/** Tile coordinates are always XYZ here; the native source adapter handles TMS. */
export function thumbnailTile(minZoom: number, maxZoom: number, metadata?: Record<string, unknown>): ThumbnailTile {
  if (![minZoom, maxZoom].every(Number.isInteger) || minZoom < 0 || maxZoom > 22 || minZoom > maxZoom) throw new Error("缩放级别无效，请检查图源参数。");
  let longitude = 108, latitude = 35, wantedZoom = 5, fromExtent = false;
  const e = (metadata?.thumbnailExtent ?? metadata?.extent) as Record<string, unknown> | undefined;
  if (e && [e.xmin, e.ymin, e.xmax, e.ymax].every(value => typeof value === "number" && Number.isFinite(value))) {
    let west = e.xmin as number, south = e.ymin as number, east = e.xmax as number, north = e.ymax as number;
    const sr = (e.spatialReference ?? metadata?.spatialReference) as { latestWkid?: number; wkid?: number } | undefined;
    const wkid = sr?.latestWkid ?? sr?.wkid;
    if ([3857, 102100, 102113].includes(wkid ?? 0)) {
      const degrees = 180 / Math.PI;
      west = west / 6378137 * degrees; east = east / 6378137 * degrees;
      south = Math.atan(Math.sinh(south / 6378137)) * degrees; north = Math.atan(Math.sinh(north / 6378137)) * degrees;
    }
    const geographic = [4326, 4269, 4490].includes(wkid ?? 0) || wkid === undefined || [3857, 102100, 102113].includes(wkid ?? 0);
    if (geographic && west >= -180.001 && east <= 180.001 && south >= -90 && north <= 90 && west < east && south < north) {
      // A world extent's midpoint is in the ocean; keep a land sample for it.
      if (!(east - west > 300 && north - south > 100)) { longitude = (west + east) / 2; latitude = (south + north) / 2; }
      wantedZoom = Math.max(5, Math.ceil(Math.log2(360 / Math.max(east - west, north - south))));
      fromExtent = true;
    }
  }
  longitude = Math.max(-180, Math.min(180, longitude));
  latitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const z = Math.max(minZoom, Math.min(maxZoom, wantedZoom)), n = 2 ** z, radians = latitude * Math.PI / 180;
  const x = Math.max(0, Math.min(n - 1, Math.floor((longitude + 180) / 360 * n)));
  const y = Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * n)));
  return { z, x, y, longitude, latitude, fromExtent };
}

export function arcgisMetadataUrl(template: string): string | null {
  try {
    const url = new URL(template.trim());
    if (url.username || url.password || url.search) return null;
    const service = url.pathname.match(/^(.*\/(?:ImageServer|MapServer))(?:\/|$)/i);
    return service ? `${url.origin}${service[1]}` : null;
  } catch { return null; }
}

export function thumbnailImageUrl(encoded: string) {
  const mime = encoded.startsWith("/9j/") ? "jpeg" : encoded.startsWith("iVBORw0KGgo") ? "png" : null;
  if (!mime) throw new Error("图源未返回可用的预览图片。");
  return `data:image/${mime};base64,${encoded}`;
}

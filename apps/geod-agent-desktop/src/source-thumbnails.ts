import { api, type HttpSource, type SourceDescriptor, type SourceRegistrationDraft, type SourceCredentialInput } from "./api";
import { arcgisMetadataUrl, thumbnailImageUrl, thumbnailTile, type ThumbnailTile } from "./source-thumbnail-plan";
import { readCachedThumbnail, removeCachedThumbnail, writeCachedThumbnail } from "./source-thumbnail-cache";

export type ThumbnailTarget = { registered: SourceDescriptor } | { draft: SourceRegistrationDraft; credential?: SourceCredentialInput; revision?: number };
export interface SourceThumbnailImage { url: string; tile: ThumbnailTile }
const cache = new Map<string, { at: number; failed: boolean; settled: boolean; promise: Promise<SourceThumbnailImage> }>();
let running = 0;
const waiters: (() => void)[] = [];

export function thumbnailKey(target: ThumbnailTarget) {
  if ("registered" in target) { const s = target.registered; return JSON.stringify(["source-thumbnail-1", s.id, s.configRevision, s.credentialRefVersion, s.scheme, s.tileSize, s.minZoom, s.maxZoom]); }
  const { source: s, minZoom, maxZoom } = target.draft;
  return JSON.stringify([s.urlTemplate.trim(), s.scheme, s.tileSize, s.networkPolicy, s.authentication, s.subdomains, s.coordinateSystem, minZoom, maxZoom, target.credential?.mode, target.credential?.parameter, target.revision]);
}

export function getSourceThumbnail(target: ThumbnailTarget, refresh = false): Promise<SourceThumbnailImage> {
  const key = thumbnailKey(target), saved = cache.get(key);
  if (saved && !saved.settled) return saved.promise;
  if (!refresh && saved && Date.now() - saved.at < (saved.failed ? 20_000 : 10 * 60_000)) return saved.promise;
  const entry = { at: Date.now(), failed: false, settled: false, promise: null as unknown as Promise<SourceThumbnailImage> };
  entry.promise = loadCached(target, key, refresh).catch(cause => { entry.failed = true; throw cause; })
    .finally(() => { entry.settled = true; entry.at = Date.now(); });
  cache.delete(key); cache.set(key, entry);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  return entry.promise;
}

async function loadCached(target: ThumbnailTarget, key: string, refresh: boolean): Promise<SourceThumbnailImage> {
  if ("registered" in target && !refresh) {
    try {
      const saved = await readCachedThumbnail(key);
      if (saved) {
        try { if (await hasVisiblePixels(saved.url)) return saved; } catch { /* A damaged image is fetched again. */ }
        await removeCachedThumbnail(key);
      }
    } catch { /* Cache availability must not prevent a real preview. */ }
  }
  const image = await load(target);
  if ("registered" in target) {
    try { await writeCachedThumbnail(key, target.registered.id, image); }
    catch { console.warn("图源预览缓存保存失败，当前预览仍可使用。"); }
  }
  return image;
}

async function load(target: ThumbnailTarget): Promise<SourceThumbnailImage> {
  if (running >= 2) await new Promise<void>(resolve => waiters.push(resolve));
  running++;
  try {
    let endpoint: HttpSource, minZoom: number, maxZoom: number;
    if ("registered" in target) {
      const stored = await api.sourcesGet(target.registered.id);
      if (!stored) throw new Error("图源已不存在，请刷新列表。");
      endpoint = stored.endpoint; minZoom = stored.descriptor.minZoom; maxZoom = stored.descriptor.maxZoom;
    } else {
      endpoint = { ...target.draft.source, id: target.draft.source.id || "thumbnail-preview", name: target.draft.source.name || "图源预览", urlTemplate: target.draft.source.urlTemplate.trim() };
      minZoom = target.draft.minZoom; maxZoom = target.draft.maxZoom;
    }
    let metadata: Record<string, unknown> | undefined;
    const metadataUrl = arcgisMetadataUrl(endpoint.urlTemplate);
    if (metadataUrl) {
      // Coverage metadata chooses a representative sample; failure doesn't
      // prevent a service's tile from being tried at the fallback position.
      try { metadata = await api.sourceThumbnailMetadata(metadataUrl); } catch { /* Use the default sample. */ }
    }
    const footprints = Array.isArray(metadata?.thumbnailExtents) ? metadata.thumbnailExtents.slice(0, 3) : [];
    const samples = footprints.length ? footprints.map(extent => ({ ...metadata, thumbnailExtent: extent })) : [metadata];
    for (const sample of samples) {
      const tile = thumbnailTile(minZoom, maxZoom, sample);
      const encoded = "registered" in target
        ? await api.mapPreviewTile(target.registered.id, null, tile.z, tile.x, tile.y)
        : await api.sourcePreviewTile(endpoint, tile.z, tile.x, tile.y, target.credential);
      const url = thumbnailImageUrl(encoded);
      if (await hasVisiblePixels(url)) return { url, tile };
    }
    throw new Error("示例位置未返回影像，可稍后重试。");
  } finally { running--; waiters.shift()?.(); }
}

async function hasVisiblePixels(url: string): Promise<boolean> {
  const image = new Image(); image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 32;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法读取预览图片。");
  context.drawImage(image, 0, 0, 32, 32);
  const pixels = context.getImageData(0, 0, 32, 32).data;
  return pixels.some((alpha, index) => index % 4 === 3 && alpha > 0);
}

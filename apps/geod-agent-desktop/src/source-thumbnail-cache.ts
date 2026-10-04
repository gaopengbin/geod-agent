import type { ThumbnailTile } from "./source-thumbnail-plan";

/** Separate from conversation storage: previews are disposable, bounded image data. */
const DATABASE = "geod-source-thumbnails-v1", STORE = "images";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 24 * 1024 * 1024, MAX_ENTRIES = 128;
interface ThumbnailRecord {
  key: string;
  sourceId: string;
  image: Blob;
  tile: ThumbnailTile;
  accessedAt: number;
}
export interface CachedThumbnail { url: string; tile: ThumbnailTile }
let opened: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  return opened ??= new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DATABASE, 1);
    const timer = setTimeout(() => fail(), 3_000);
    function fail() {
      if (settled) return;
      settled = true; clearTimeout(timer); opened = undefined;
      reject(new Error("无法打开图源预览缓存。"));
    }
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onerror = fail;
    request.onblocked = fail;
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; clearTimeout(timer);
      const db = request.result;
      db.onversionchange = () => { db.close(); opened = undefined; };
      db.onclose = () => { opened = undefined; };
      resolve(db);
    };
  });
}

function validTile(tile: ThumbnailTile | undefined): tile is ThumbnailTile {
  if (!tile || !Number.isInteger(tile.z) || tile.z < 0 || tile.z > 22) return false;
  return [tile.x, tile.y].every(value => Number.isInteger(value) && value >= 0 && value < 2 ** tile.z)
    && Number.isFinite(tile.longitude) && Math.abs(tile.longitude) <= 180
    && Number.isFinite(tile.latitude) && Math.abs(tile.latitude) <= 85.05112878
    && typeof tile.fromExtent === "boolean";
}

function validRecord(record: ThumbnailRecord | undefined, key: string): record is ThumbnailRecord {
  return !!record && record.key === key && typeof record.sourceId === "string"
    && record.image instanceof Blob && ["image/png", "image/jpeg"].includes(record.image.type)
    && record.image.size > 0 && record.image.size <= MAX_IMAGE_BYTES
    && Number.isFinite(record.accessedAt) && validTile(record.tile);
}

export async function removeCachedThumbnail(key: string): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function readCachedThumbnail(key: string): Promise<CachedThumbnail | null> {
  const db = await database();
  const record = await new Promise<ThumbnailRecord | undefined>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly"), request = transaction.objectStore(STORE).get(key);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
  if (!record) return null;
  if (!validRecord(record, key)) { await removeCachedThumbnail(key); return null; }
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(record.image);
  });
  // Update only the timestamp of the current record; another window may have refreshed it.
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite"), store = transaction.objectStore(STORE);
    const request = store.get(key);
    request.onsuccess = () => {
      if (validRecord(request.result, key)) store.put({ ...request.result, accessedAt: Date.now() });
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  }).catch(() => { /* A failed LRU update must not discard an otherwise usable image. */ });
  return { url, tile: record.tile };
}

export async function writeCachedThumbnail(key: string, sourceId: string, thumbnail: CachedThumbnail): Promise<void> {
  // No endpoint, headers, draft credentials or Token enter this database.
  const match = thumbnail.url.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !validTile(thumbnail.tile) || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return;
  const decoded = atob(match[2]), bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  const image = new Blob([bytes], { type: match[1] });
  if (image.size > MAX_IMAGE_BYTES) return;
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    // Wait for the disk commit before the preview promise resolves.
    const transaction = db.transaction(STORE, "readwrite", { durability: "strict" });
    const store = transaction.objectStore(STORE), now = Date.now();
    store.put({ key, sourceId, image, tile: thumbnail.tile, accessedAt: now } satisfies ThumbnailRecord);
    const request = store.getAll();
    request.onsuccess = () => {
      const records = (request.result as ThumbnailRecord[]).sort((a, b) => b.accessedAt - a.accessedAt);
      let count = 0, size = 0;
      for (const record of records) {
        if (!validRecord(record, record.key) || ++count > MAX_ENTRIES || (size += record.image.size) > MAX_CACHE_BYTES) store.delete(record.key);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

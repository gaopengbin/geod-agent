/** Large conversation/map records use IndexedDB; small preferences remain in localStorage. */
export interface StatePersistence {
  read(): Promise<Map<string, string>>;
  write(entries: [string, string | null][]): Promise<void>;
}
const prefixes = [
  "geod-agent-conversations-0.1", "geod-agent-chat-0.1", "geod-agent-legacy-chat-imported-0.1",
  "geod-agent-pending-generations-0.1", "geod-agent-workspace-list-0.1", "geod-map-session-1:",
  "geod-agent-plan-presentation-1:", "geod-agent-task-queue-1:", "geod.boundary-bookmarks.v1:",
  "geod-agent-deleted-conversations-1",
];
export const isLargeStateKey = (key: string) => prefixes.some(prefix => key.startsWith(prefix));

export function createLocalState(persistence: StatePersistence, fallback: Storage, failed: (error: unknown) => void) {
  const values = new Map<string, string>(), pending = new Map<string, string | null>();
  let ready = false, initializing: Promise<void> | undefined, writing: Promise<void> | undefined;
  const check = () => { if (!ready) throw new Error("本机记录尚未打开，请稍后重试。"); };
  const flush = async (): Promise<void> => {
    if (writing) { await writing; if (pending.size) await flush(); return; }
    if (!pending.size) return;
    writing = (async () => {
      while (pending.size) {
        const batch = [...pending];
        await persistence.write(batch);
        for (const [key, value] of batch) if (pending.get(key) === value) pending.delete(key);
      }
    })();
    try { await writing; } finally { writing = undefined; }
  };
  const enqueue = (key: string, value: string | null) => {
    pending.set(key, value);
    queueMicrotask(() => { void flush().catch(failed); });
  };
  const entries = () => {
    check(); const combined = new Map<string, string>();
    for (let i = 0; i < fallback.length; i++) { const key = fallback.key(i); if (key && !isLargeStateKey(key)) combined.set(key, fallback.getItem(key)!); }
    for (const pair of values) combined.set(...pair);
    return [...combined];
  };
  const store: Storage = {
    get length() { return entries().length; },
    key(index) { return entries()[index]?.[0] ?? null; },
    getItem(key) { if (!isLargeStateKey(key)) return fallback.getItem(key); check(); return values.get(key) ?? null; },
    setItem(key, value) {
      if (!isLargeStateKey(key)) { fallback.setItem(key, value); return; }
      check(); const next = String(value); if (values.get(key) === next) return;
      values.set(key, next); enqueue(key, next);
    },
    removeItem(key) {
      if (!isLargeStateKey(key)) { fallback.removeItem(key); return; }
      check(); values.delete(key); enqueue(key, null);
    },
    clear() { check(); for (const key of values.keys()) store.removeItem(key); fallback.clear(); },
  };
  const initialize = () => initializing ??= (async () => {
    const existing = await persistence.read();
    const legacy: [string, string][] = [];
    for (let i = 0; i < fallback.length; i++) {
      const key = fallback.key(i), value = key ? fallback.getItem(key) : null;
      if (key && isLargeStateKey(key) && value !== null) legacy.push([key, value]);
    }
    // Commit the complete migration before removing any legacy record. Existing DB data wins.
    const imported = legacy.filter(([key]) => !existing.has(key));
    if (imported.length) await persistence.write(imported);
    for (const [key, value] of imported) existing.set(key, value);
    for (const pair of existing) if (isLargeStateKey(pair[0])) values.set(...pair);
    ready = true;
    for (const [key, value] of legacy) if (fallback.getItem(key) === value) fallback.removeItem(key);
  })().catch(error => { initializing = undefined; throw error; });
  return { store, initialize, flush, entries };
}

function indexedPersistence(): StatePersistence {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () => opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("geod-ui-state-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records");
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => { opened = undefined; reject(new Error("无法打开本机记录存储，请检查磁盘可用空间后重试。")); };
    request.onblocked = () => reject(new Error("另一个窗口正在更新本机记录，请关闭旧窗口后重试。"));
  });
  return {
    async read() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction("records", "readonly"), records = new Map<string, string>();
        const request = transaction.objectStore("records").openCursor();
        request.onsuccess = () => { const cursor = request.result; if (cursor) { records.set(String(cursor.key), cursor.value); cursor.continue(); } };
        transaction.oncomplete = () => resolve(records);
        transaction.onabort = () => reject(new Error("无法读取本机对话记录，请重试。"));
      });
    },
    async write(entries) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction("records", "readwrite", { durability: "strict" }), records = transaction.objectStore("records");
        for (const [key, value] of entries) if (value === null) records.delete(key); else records.put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error("本机记录保存失败，请检查磁盘空间；当前恢复记录已保留。"));
      });
    },
  };
}
// Keep the cache/serialization queue across frontend hot updates.
type StateInstance = ReturnType<typeof createLocalState>;
const shared = globalThis as typeof globalThis & { __GEOD_LOCAL_STATE__?: StateInstance };
function state() {
  return shared.__GEOD_LOCAL_STATE__ ??= createLocalState(indexedPersistence(), localStorage, error => {
    window.dispatchEvent(new CustomEvent("geod-state-storage-error", { detail: error }));
  });
}
export const localStateStore: Storage = new Proxy({} as Storage, {
  get(_target, key) { const value = Reflect.get(state().store, key); return typeof value === "function" ? value.bind(state().store) : value; },
});
export const initializeLocalState = () => state().initialize();
export const flushLocalState = () => state().flush();
export const localStateEntries = () => state().entries();
export async function snapshotLocalRecords() {
  await flushLocalState();
  return {schemaVersion:1 as const,entries:localStateEntries().filter(([key])=>key.startsWith("geod"))};
}

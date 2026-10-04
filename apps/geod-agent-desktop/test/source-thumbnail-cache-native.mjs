// Read actual registered sources through native IPC; all synthetic cache cases use a separate browser profile.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL(process.argv[2] ?? "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const output = resolve("../../artifacts/source-thumbnail-cache-20261004");
mkdirSync(output, { recursive: true });
const desktop = await chromium.connectOverCDP("http://127.0.0.1:9233");
const nativePage = desktop.contexts().flatMap(context => context.pages()).find(page => page.url() === "http://127.0.0.1:1420/");
assert(nativePage, "Development desktop is required");
const rpc = (command, args = {}) => nativePage.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const sourcesBefore = await rpc("sources_list");
const source = sourcesBefore.find(source => source.id === "esri-world-imagery");
assert(source, "Registered Esri World Imagery is required");
const report = { passed: false, checkedAt: new Date().toISOString(), cases: [], rendererErrors: [], sourceCount: sourcesBefore.length };
const allowed = new Set(["sources_get", "source_thumbnail_metadata", "map_preview_tile"]);
let calls = [], context;
async function openProfile() {
  const profile = await chromium.launchPersistentContext(join(output, "isolated-browser-profile"), { channel: "msedge", headless: true, viewport: { width: 1100, height: 780 } });
  await profile.exposeBinding("thumbnailNativeInvoke", async (_binding, command, args) => {
    assert(allowed.has(command), `Unexpected native mutation: ${command}`);
    calls.push(command);
    return rpc(command, args);
  });
  await profile.addInitScript(() => {
    window.__TAURI_INTERNALS__ = { invoke: (command, args) => window.thumbnailNativeInvoke(command, args) };
  });
  const page = profile.pages()[0] ?? await profile.newPage();
  page.on("pageerror", error => report.rendererErrors.push(error.message));
  await page.goto("http://127.0.0.1:1420/test/source-thumbnail-cache-harness.html");
  return { profile, page };
}
async function load(page, descriptor, phase, refresh = false) {
  const before = calls.length;
  const result = await page.evaluate(async ({ descriptor, phase, refresh }) => {
    const { getSourceThumbnail } = await import(`/src/source-thumbnails.ts?acceptance=${phase}`);
    const image = await getSourceThumbnail({ registered: descriptor }, refresh);
    return { image, elapsedMs: performance.now() };
  }, { descriptor, phase, refresh });
  const encoded = result.image.url.split(",")[1], bytes = Buffer.from(encoded, "base64");
  return { ...result.image, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), calls: calls.slice(before) };
}
async function recordCount(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("geod-source-thumbnails-v1", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction("images", "readonly"), all = tx.objectStore("images").getAll();
      tx.oncomplete = () => { db.close(); resolve(all.result.map(record => ({ key: record.key, fields: Object.keys(record), bytes: record.image.size, imageType: record.image.type }))); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}
try {
  context = await openProfile();
  await context.page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("geod-source-thumbnails-v1");
    request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error("Isolated cache is still open"));
  }));
  const cold = await load(context.page, source, "cold", true);
  assert(cold.bytes > 0); assert(cold.calls.includes("map_preview_tile"));
  writeFileSync(join(output, "real-esri-thumbnail." + (cold.url.startsWith("data:image/png") ? "png" : "jpg")), Buffer.from(cold.url.split(",")[1], "base64"));
  report.cases.push({ name: "first real preview is committed to persistent storage", bytes: cold.bytes, sha256: cold.sha256, calls: cold.calls });
  const stored = await recordCount(context.page);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].fields.sort(), ["accessedAt", "image", "key", "sourceId", "tile"].sort());
  assert(!/https?:|token|authorization|urlTemplate/i.test(stored[0].key));
  report.cases.push({ name: "cache stores image and source revision without endpoint or credentials", records: stored.length });
  await context.page.reload();
  const reload = await load(context.page, source, "reload");
  assert.equal(reload.sha256, cold.sha256); assert.equal(reload.calls.length, 0);
  report.cases.push({ name: "full page reload reuses the image with no native/network preview calls", calls: reload.calls });
  await context.profile.close(); context = await openProfile();
  const restart = await load(context.page, source, "restart");
  assert.equal(restart.sha256, cold.sha256); assert.equal(restart.calls.length, 0);
  report.cases.push({ name: "complete browser process restart reuses the image", calls: restart.calls });
  const refreshed = await load(context.page, source, "manual-refresh", true);
  assert(refreshed.calls.includes("map_preview_tile"));
  report.cases.push({ name: "explicit refresh bypasses persistent cache", calls: refreshed.calls });
  for (const [label, descriptor] of [["configuration revision", { ...source, configRevision: "thumbnail-cache-revision-test" }], ["credential version", { ...source, credentialRefVersion: "thumbnail-cache-credential-test" }]]) {
    const changed = await load(context.page, descriptor, label);
    assert(changed.calls.includes("map_preview_tile"));
    report.cases.push({ name: `${label} change uses a new cache key`, calls: changed.calls });
  }
  await context.page.evaluate(async descriptor => {
    const { thumbnailKey } = await import("/src/source-thumbnails.ts?acceptance=damage");
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("geod-source-thumbnails-v1", 1);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("images", "readwrite"), store = tx.objectStore("images"), key = thumbnailKey({ registered: descriptor }), get = store.get(key);
        get.onsuccess = () => store.put({ ...get.result, image: new Blob(["corrupted image"], { type: "image/png" }) });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      }; request.onerror = () => reject(request.error);
    });
  }, source);
  const repaired = await load(context.page, source, "repair");
  assert(repaired.calls.includes("map_preview_tile")); assert(repaired.bytes > 0);
  const repairedHit = await load(context.page, source, "repair-hit"); assert.equal(repairedHit.calls.length, 0);
  report.cases.push({ name: "damaged image is replaced with a real tile and reusable again", calls: repaired.calls });
  const failed = await context.page.evaluate(async descriptor => {
    const { getSourceThumbnail, thumbnailKey } = await import("/src/source-thumbnails.ts?acceptance=missing");
    const target = { registered: { ...descriptor, id: "thumbnail-cache-source-does-not-exist" } };
    try { await getSourceThumbnail(target); return { unexpectedlySucceeded: true }; }
    catch { return { failed: true, key: thumbnailKey(target) }; }
  }, source);
  assert(failed.failed); assert(!(await recordCount(context.page)).some(record => record.key === failed.key));
  report.cases.push({ name: "preview failures are not written to disk" });
  const capped = await context.page.evaluate(async image => {
    const { writeCachedThumbnail, readCachedThumbnail } = await import("/src/source-thumbnail-cache.ts");
    for (let i = 0; i < 130; i++) await writeCachedThumbnail(`capacity-${i}`, `source-${i}`, image);
    return { oldestGone: await readCachedThumbnail("capacity-0") === null, newestRetained: !!await readCachedThumbnail("capacity-129") };
  }, { url: repaired.url, tile: repaired.tile });
  assert(capped.oldestGone && capped.newestRetained); assert((await recordCount(context.page)).length <= 128);
  report.cases.push({ name: "LRU eviction bounds persistent storage to 128 images", ...capped });
  await context.page.evaluate(async image => {
    const { writeCachedThumbnail } = await import("/src/source-thumbnail-cache.ts");
    // Real JPEG bytes with harmless trailing padding exercise the byte limit without network requests.
    const data = atob(image.url.split(",")[1]).padEnd(1536 * 1024, "\0");
    const large = { ...image, url: image.url.split(",")[0] + "," + btoa(data) };
    for (let i = 0; i < 20; i++) await writeCachedThumbnail(`byte-limit-${i}`, `large-source-${i}`, large);
  }, { url: repaired.url, tile: repaired.tile });
  const bounded = await recordCount(context.page), totalBytes = bounded.reduce((sum, record) => sum + record.bytes, 0);
  assert(totalBytes <= 24 * 1024 * 1024);
  assert(!bounded.some(record => record.key === "byte-limit-0"));
  assert(bounded.some(record => record.key === "byte-limit-19"));
  report.cases.push({ name: "large previews remain within the 24 MiB cache limit", totalBytes });
  assert.deepEqual(await rpc("sources_list"), sourcesBefore, "No registered source was altered");
  assert.equal(report.rendererErrors.length, 0); report.passed = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (context) await context.profile.close();
  await desktop.close();
  writeFileSync(join(output, "acceptance.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

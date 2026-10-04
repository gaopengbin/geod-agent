// Verify persistence in the user's running WebView profile without editing any source or conversation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const output = resolve("../../artifacts/source-thumbnail-cache-20261004"); mkdirSync(output, { recursive: true });
const afterRestart = process.argv.includes("--after-restart");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9233");
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === "http://127.0.0.1:1420/");
assert(page); const errors = []; page.on("pageerror", error => errors.push(error.message));
try {
  const result = await page.evaluate(async phase => {
    const { api } = await import("/src/api.ts");
    const { getSourceThumbnail, thumbnailKey } = await import(`/src/source-thumbnails.ts?desktop-acceptance=${phase}`);
    const sources = await api.sourcesList();
    const records = await new Promise((resolve, reject) => {
      const request = indexedDB.open("geod-source-thumbnails-v1", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction("images", "readonly"), all = tx.objectStore("images").getAll();
        tx.oncomplete = () => { db.close(); resolve(all.result.map(record => ({ key: record.key, sourceId: record.sourceId, bytes: record.image.size }))); };
        tx.onabort = () => reject(tx.error);
      };
    });
    const keys = new Set(records.map(record => record.key));
    const targets = sources.filter(source => keys.has(thumbnailKey({ registered: source })));
    if (!targets.some(source => source.id === "esri-world-imagery")) throw new Error("The real Esri preview has not been cached yet");
    const calls = [], originals = {};
    for (const name of ["sourcesGet", "sourceThumbnailMetadata", "mapPreviewTile"]) {
      originals[name] = api[name];
      api[name] = (...args) => { calls.push(name); return originals[name](...args); };
    }
    const images = [], start = performance.now();
    try {
      for (const descriptor of targets) images.push({ id: descriptor.id, image: await getSourceThumbnail({ registered: descriptor }) });
    } finally { for (const [name, original] of Object.entries(originals)) api[name] = original; }
    return { sourceCount: sources.length, cachedCount: records.length, totalBytes: records.reduce((sum, record) => sum + record.bytes, 0), images, calls, elapsedMs: Math.round(performance.now() - start), background: await api.backgroundStatus() };
  }, afterRestart ? "after-restart" : "before-restart");
  result.images = result.images.map(({ id, image }) => ({ id, sha256: createHash("sha256").update(Buffer.from(image.url.split(",")[1], "base64")).digest("hex") }));
  assert.equal(result.calls.length, 0, "Disk cache must avoid all source preview API calls");
  assert.equal(result.sourceCount, 16); assert(result.cachedCount > 0);
  if (afterRestart) {
    const before = JSON.parse(readFileSync(join(output, "desktop-before-restart.json"), "utf8"));
    for (const image of before.images) assert(result.images.some(current => current.id === image.id && current.sha256 === image.sha256), `Image changed after restart: ${image.id}`);
  }
  await page.getByRole("button", { name: "图源管理", exact: true }).click();
  await page.locator('.source-page:not([hidden]) .source-row').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(expected => [...document.querySelectorAll('.source-page:not([hidden]) .source-thumbnail-image img')].filter(image => image.complete && image.naturalWidth > 0).length >= expected, result.images.length, { timeout: 5_000 });
  await page.waitForTimeout(250); // Capture after the existing page entrance transition.
  result.visible = await page.locator('.source-page:not([hidden]) .source-thumbnail-image img').evaluateAll(images => images.filter(image => image.complete && image.naturalWidth > 0).length);
  assert(result.visible > 0); assert.equal(errors.length, 0);
  result.passed = true; result.rendererErrors = errors;
  await page.screenshot({ path: join(output, afterRestart ? "desktop-after-restart.png" : "desktop-before-restart.png") });
  writeFileSync(join(output, afterRestart ? "desktop-after-restart.json" : "desktop-before-restart.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }

// Render verified offline bundles with the production React/Cesium component.
// Starts an isolated headless Edge process and blocks every non-loopback request.
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const root = resolve('artifacts/desktop-parity');
const output = resolve('docs/implementation/evidence');
mkdirSync(output, { recursive: true });
const samples = ['tiles3d-request-volume-20261002', 'tiles3d-multiple-contents-20261002', 'tiles3d-implicit-quad-20261002', 'tiles3d-implicit-oct-20261002'];
const allowed = new Map();
for (const sample of samples) {
  const dir = realpathSync(resolve(root, sample));
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
  for (const asset of manifest.resources) allowed.set(`/${sample}/${asset.path}`, { dir, file: realpathSync(resolve(dir, asset.path)) });
}
const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const resource = allowed.get(req.url?.split('?')[0]);
  if (!resource || !resource.file.startsWith(resource.dir + sep)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', resource.file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
  res.setHeader('Content-Length', statSync(resource.file).size);
  createReadStream(resource.file).pipe(res);
});
await new Promise(resolve => server.listen(15447, '127.0.0.1', resolve));
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!existsSync(edge)) throw new Error('Microsoft Edge is required for the isolated browser check');
const browser = spawn(edge, ['--headless=new', '--remote-debugging-port=9249', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl', '--window-size=1100,800', `--user-data-dir=${resolve(tmpdir(), `geod-tiles3d-preview-${randomUUID()}`)}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let socket;
try {
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    try { const pages = await (await fetch('http://127.0.0.1:9249/json/list')).json(); target = pages.find(p => p.type === 'page'); } catch {}
    if (!target) await new Promise(r => setTimeout(r, 250));
  }
  if (!target) throw new Error('Headless browser did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map(); const remoteRequests = []; const errors = [];
  const call = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timed out: ${method}`)); }, 60000); pending.set(key, { resolve, reject, timer }); socket.send(JSON.stringify({ id: key, method, params })); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data); const request = pending.get(data.id);
    if (request) { clearTimeout(request.timer); pending.delete(data.id); data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result); }
    if (data.method === 'Fetch.requestPaused') {
      const url = data.params.request.url; const parsed = new URL(url); const local = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
      if (!local) remoteRequests.push(url);
      void call(local ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: data.params.requestId, ...(local ? {} : { errorReason: 'BlockedByClient' }) }).catch(() => {});
    }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text);
  });
  await call('Page.enable'); await call('Runtime.enable');
  await call('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] });
  await call('Page.navigate', { url: 'http://127.0.0.1:1420/' });
  await new Promise(r => setTimeout(r, 1500));
  const evidence = [];
  for (const sample of samples) {
    const result = await call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const ReactModule = await import('/node_modules/.vite/deps/react.js'); const React = ReactModule.default ?? ReactModule;
      const DOMModule = await import('/node_modules/.vite/deps/react-dom_client.js'); const { createRoot } = DOMModule.default ?? DOMModule;
      const { Tiles3dPreview } = await import('/src/tiles3d-preview.tsx');
      window.__tilesPreviewRoot?.unmount(); document.getElementById('tiles-preview-test')?.remove();
      const host = document.createElement('div'); host.id = 'tiles-preview-test'; host.style = 'position:fixed;inset:0;z-index:999999;background:#15171a'; document.body.append(host);
      const root = createRoot(host); window.__tilesPreviewRoot = root;
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No rendered tiles within 45 seconds')),45000);
        root.render(React.createElement(Tiles3dPreview, { tilesetUrl: ${JSON.stringify(`http://127.0.0.1:15447/${sample}/tileset.json`)}, title: ${JSON.stringify(sample)}, onReady: r => {clearTimeout(timeout); setTimeout(() => resolve(r),1000);}, onError: e => {clearTimeout(timeout); reject(new Error(e));} }));
      });
    })()` });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(resolve(output, `${sample}-preview.png`), Buffer.from(screenshot.data, 'base64'));
    evidence.push({ sample, result: result.result.value, screenshot: `${sample}-preview.png` });
  }
  const report = { pass: true, viewer: 'production Tiles3dPreview', network: 'all non-loopback requests blocked', evidence, remoteRequestsBlocked: remoteRequests, runtimeErrors: errors };
  writeFileSync(resolve(output, 'tiles3d-preview-acceptance-2026-10-02.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await call('Browser.close');
} finally {
  socket?.close(); browser.kill(); server.close();
}

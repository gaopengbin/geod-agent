/** Reference fixtures, actual Rust downloader and actual native production viewer. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Cartographic, Matrix4, Cartesian3 } from '../apps/geod-agent-desktop/node_modules/@cesium/core/index.js';
import Transforms from '../apps/geod-agent-desktop/node_modules/@cesium/engine/Source/Core/Transforms.js';
import S2Cell from '../apps/geod-agent-desktop/node_modules/@cesium/engine/Source/Core/S2Cell.js';
const exec = promisify(execFile), [playwrightModule, evidencePath] = process.argv.slice(2), { chromium } = await import(playwrightModule);
await fs.mkdir(evidencePath, { recursive: true });
const report = { pass: false, cases: [], references: { cesium: 'b8d3a36fe98a3e432eb89253c95d5f20e605e0f1', gltfSamples: 'd7a3cc8e51d7c573771ae77a57f16b0662a905c6' } }, routes = new Map(), hits = [];
const save = () => fs.writeFile(path.join(evidencePath, 'acceptance.json'), JSON.stringify(report, null, 2));
const passed = async (name, result) => { report.cases.push({ name, pass: true, result }); await save(); console.log(name, 'PASS'); };
const box = await fs.readFile('artifacts/cesium-scene-tools-20261003/khronos-box-glb1.glb');
assert.equal(box.readUInt32LE(4), 1);
const s2 = token => ({ extensions: { '3DTILES_bounding_volume_S2': { token, minimumHeight: -100, maximumHeight: 200 } } });
const center = token => Cartographic.fromCartesian(S2Cell.fromToken(token).getCenter());
const rootCell = S2Cell.fromToken('89c6c7');
const tokens = [0, 1, 2, 3].map(i => S2Cell.getTokenFromId(rootCell.getChild(i)._cellId));
const target = center(tokens[0]), degrees = c => [c.longitude * 180 / Math.PI, c.latitude * 180 / Math.PI];
const [lon, lat] = degrees(target), aoi = [lon - .00001, lat - .00001, lon + .00001, lat + .00001];
const transform = c => Matrix4.toArray(Matrix4.multiplyByUniformScale(Transforms.eastNorthUpToFixedFrame(Cartesian3.fromRadians(c.longitude, c.latitude, 30)), 10, new Matrix4()));
const implicitTransform = Matrix4.fromArray(transform(target));
const implicitInverse = Matrix4.inverse(implicitTransform, new Matrix4());
// Keep every implicit content inside its own horizontal and vertical volume.
// On face 4 increasing u is southward; increasing v is eastward.
const cells = tokens.map(token => ({ token, position: center(token) }));
const middleLat = cells.reduce((n, cell) => n + cell.position.latitude, 0) / 4;
const middleLon = cells.reduce((n, cell) => n + cell.position.longitude, 0) / 4;
function positionedBox(x, y, z) {
  const cell = cells.find(cell => (cell.position.latitude < middleLat ? 1 : 0) === x && (cell.position.longitude > middleLon ? 1 : 0) === y);
  const point = Matrix4.multiplyByPoint(implicitInverse, Cartesian3.fromRadians(cell.position.longitude, cell.position.latitude, z ? 130 : 30), new Cartesian3());
  const originalLength = box.readUInt32LE(12), doc = JSON.parse(box.subarray(20, 20 + originalLength));
  const node = doc.nodes[doc.scenes[doc.scene].nodes[0]];
  // Cesium changes glTF Y-up to local Z-up: (x,y,z) -> (x,-z,y).
  node.matrix[12] = point.x; node.matrix[13] = point.z; node.matrix[14] = -point.y;
  const encoded = Buffer.from(JSON.stringify(doc)), padded = Buffer.concat([encoded, Buffer.alloc((4 - encoded.length % 4) % 4, 32)]);
  const header = Buffer.from(box.subarray(0, 20)), body = box.subarray(20 + originalLength);
  header.writeUInt32LE(20 + padded.length + body.length, 8); header.writeUInt32LE(padded.length, 12);
  return Buffer.concat([header, padded, body]);
}
const add = (uri, value) => routes.set(uri, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)));
add('/explicit/tileset.json', { asset: { version: '1.1' }, extensionsUsed: ['3DTILES_bounding_volume_S2'], extensionsRequired: ['3DTILES_bounding_volume_S2'], geometricError: 1000,
  root: { boundingVolume: s2('89c6c7'), geometricError: 100, refine: 'ADD', children: tokens.map((token, index) => ({ boundingVolume: s2(token), transform: transform(center(token)), geometricError: 0, content: { uri: `${index}.glb` } })) } });
for (let i = 0; i < 4; i++) add(`/explicit/${i}.glb`, box);
for (const scheme of ['QUADTREE', 'OCTREE']) {
  const name = scheme === 'QUADTREE' ? 'implicit-quad' : 'implicit-oct';
  const n = scheme === 'QUADTREE' ? 4 : 8;
  add(`/${name}/tileset.json`, { asset: { version: '1.1' }, extensionsUsed: ['3DTILES_bounding_volume_S2'], extensionsRequired: ['3DTILES_bounding_volume_S2'], geometricError: 100,
    root: { boundingVolume: s2('89c6c7'), transform: transform(target), geometricError: 100, refine: 'ADD', content: { uri: 'content/{level}/{x}/{y}/{z}.glb' }, implicitTiling: { subdivisionScheme: scheme, subtreeLevels: 2, availableLevels: 2, subtrees: { uri: 'subtree.json' } } } });
  // Leaf content only. Availability is indexed by Morton order, independent
  // of the Hilbert token order; a bitstream distinguishes root from leaves.
  add(`/${name}/subtree.json`, { buffers: [{ uri: 'availability.bin', byteLength: 2 }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 2 }], tileAvailability: { constant: 1 }, contentAvailability: [{ bitstream: 0 }], childSubtreeAvailability: { constant: 0 } });
  add(`/${name}/availability.bin`, Buffer.from(n === 4 ? [30, 0] : [254, 1]));
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < (n === 4 ? 1 : 2); z++) add(`/${name}/content/1/${x}/${y}/${z}.glb`, positionedBox(x, y, z));
}
for (const number of [1, 2]) {
  const dir = `artifacts/cesium-reference-1.146/Specs/Data/Cesium3DTiles/Batched/BatchedDeprecated${number}`;
  add(`/deprecated-${number}/tileset.json`, JSON.parse(await fs.readFile(`${dir}/tileset.json`, 'utf8')));
  add(`/deprecated-${number}/batchedDeprecated${number}.b3dm`, await fs.readFile(`${dir}/batchedDeprecated${number}.b3dm`));
}
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost').pathname, bytes = routes.get(url); res.setHeader('Access-Control-Allow-Origin', '*');
  if (!bytes) { res.writeHead(404); return res.end('missing'); }
  hits.push(url); res.setHeader('Content-Type', url.endsWith('.json') ? 'application/json' : 'application/octet-stream'); res.end(bytes);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const samples = [];
let browser, page;
const consoleErrors = [];
try {
  for (const name of ['explicit', 'deprecated-1', 'deprecated-2', 'implicit-quad', 'implicit-oct']) {
    const directory = path.join(evidencePath, `bundle-${name}`); const before = hits.length;
    const fixtureHash = crypto.createHash('sha256').update(Buffer.concat([...routes].filter(([uri]) => uri.startsWith(`/${name}/`)).flatMap(([uri, bytes]) => [Buffer.from(uri), bytes]))).digest('hex');
    const args = ['cargo', 'run', '--offline', '--quiet', '--example', 'download', '--', `${base}/${name}/tileset.json`, directory, ...(!name.startsWith('deprecated') ? [aoi.join(',')] : [])];
    const exists = await fs.access(path.join(directory, 'manifest.json')).then(() => true).catch(() => false);
    if (exists) assert.equal(await fs.readFile(path.join(directory, 'fixture.sha256'), 'utf8'), fixtureHash, 'Fixture changed; use a fresh evidence directory');
    const result = exists ? { stderr: 'Reusing this script\'s already verified evidence bundle' } : await exec('rtk', ['proxy', ...args], { cwd: 'crates/geod-tiles3d', windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    if (!exists) await fs.writeFile(path.join(directory, 'fixture.sha256'), fixtureHash);
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const tree = JSON.parse(await fs.readFile(path.join(directory, 'tileset.json'), 'utf8'));
    const requested = hits.slice(before); const assets = manifest.resources.filter(v => v.kind !== 'tileset');
    if (name === 'explicit') { assert.equal(assets.length, 1); assert.equal(tree.root.children.length, 1); assert.equal(tree.root.children[0].boundingVolume.extensions['3DTILES_bounding_volume_S2'].token, tokens[0]); if (!exists) assert.deepEqual(requested.filter(v => v.endsWith('.glb')), ['/explicit/0.glb']); }
    else if (name.startsWith('implicit')) { assert.equal(assets.length, name === 'implicit-quad' ? 1 : 2); assert(!JSON.stringify(tree).includes('implicitTiling')); assert(tree.root.children.every(child => child.boundingVolume.extensions['3DTILES_bounding_volume_S2'].token === tokens[0])); }
    else { const tile = await fs.readFile(path.join(directory, assets[0].path)); assert.equal(tile.readUInt32LE(8), tile.length); const featureLength = tile.readUInt32LE(12); assert.equal(JSON.parse(tile.subarray(28, 28 + featureLength)).BATCH_LENGTH, 10); assert.equal(28 + [12, 16, 20, 24].reduce((sum, off) => sum + tile.readUInt32LE(off), 0) & 7, 0); }
    for (const asset of manifest.resources) {
      const bytes = await fs.readFile(path.join(directory, asset.path)); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256);
      add(`/offline-${name}/${asset.path}`, bytes);
    }
    samples.push({ name, directory, manifest, bounds: !name.startsWith('deprecated') ? aoi : null });
    await passed(`Actual Rust download and strict saved-bundle inspection: ${name}`, { resources: manifest.resources.length, requested, stderr: result.stderr });
  }
  browser = await chromium.connectOverCDP('http://127.0.0.1:9233'); page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':1420'));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.stack ?? error.message));
  assert.equal(await page.getByRole('button', { name: '停止回复', exact: true }).count(), 0);
  await page.goto('http://127.0.0.1:1420/test/tiles3d-compatibility-harness.html');
  for (const sample of samples) {
    const loaded = await page.evaluate(({ name, url, bounds }) => window.loadActualTiles(name, url, bounds), { name: sample.name, url: `${base}/offline-${sample.name}/tileset.json`, bounds: sample.bounds });
    assert.equal(loaded.loaded, true, JSON.stringify(loaded));
    const ready = tile => (tile.ready && !tile.children.length ? 1 : 0) + tile.children.reduce((sum, child) => sum + ready(child), 0);
    assert.equal(ready(loaded.traversal), sample.name === 'implicit-oct' ? 2 : 1, 'Every selected offline content was really loaded');
    await page.locator('.tiles3d-preview__canvas').screenshot({ path: path.join(evidencePath, `actual-${sample.name}.png`) });
    await passed(`Production Cesium renderer actually loads the verified offline ${sample.name} bundle`, loaded);
  }
  report.pass = true;
} catch (error) { report.failure = error?.stack ?? error; console.error(JSON.stringify(report.failure)); process.exitCode = 1; await page?.screenshot({ path: path.join(evidencePath, 'failure.png') }).catch(() => {}); }
finally { report.finishedAt = new Date().toISOString(); report.requests = hits; report.consoleErrors = consoleErrors; await save(); if (page) await page.goto('http://127.0.0.1:1420').catch(() => {}); await browser?.close(); server.close(); }
console.log(JSON.stringify({ pass: report.pass, cases: report.cases.length }));

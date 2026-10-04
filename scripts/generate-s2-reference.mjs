/** Frozen reference facts from the installed, published Cesium 1.146.0. */
import fs from 'node:fs/promises';
import S2Cell from '../apps/geod-agent-desktop/node_modules/@cesium/engine/Source/Core/S2Cell.js';
import { Cartographic } from '../apps/geod-agent-desktop/node_modules/@cesium/core/index.js';
const facts = [];
const coordinate = p => { const c = Cartographic.fromCartesian(p); return [c.longitude * 180 / Math.PI, c.latitude * 180 / Math.PI]; };
for (let face = 0; face < 6; face++) for (const level of [0, 1, 5, 15, 30]) {
  const max = 1n << BigInt(level * 2), position = level ? max / 3n : 0n;
  // Construct the normative ID directly: Cesium's helper adds a position bit
  // for level zero, so its level-zero face helper is unsuitable as a reference.
  const id = (BigInt(face) << 61n) | (position << BigInt(61 - 2 * level)) | (1n << BigInt(60 - 2 * level));
  const cell = new S2Cell(id);
  facts.push({ token: S2Cell.getTokenFromId(cell._cellId), level, points: [coordinate(cell.getCenter()), ...[0, 1, 2, 3].map(i => coordinate(cell.getVertex(i)))], children: level < 30 ? [0, 1, 2, 3].map(i => S2Cell.getTokenFromId(cell.getChild(i)._cellId)) : [] });
}
for (const token of ['89c6c7', '04', '7', '5', 'b']) {
  const cell = S2Cell.fromToken(token);
  facts.push({ token, level: cell._level, points: [coordinate(cell.getCenter()), ...[0, 1, 2, 3].map(i => coordinate(cell.getVertex(i)))], children: [0, 1, 2, 3].map(i => S2Cell.getTokenFromId(cell.getChild(i)._cellId)) });
}
await fs.writeFile(process.argv[2], JSON.stringify({ reference: 'CesiumJS 1.146.0, b8d3a36fe98a3e432eb89253c95d5f20e605e0f1, S2Cell public package source', facts }, null, 2));
console.log(JSON.stringify({ count: facts.length }));

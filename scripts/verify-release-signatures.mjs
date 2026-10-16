import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { verifySignedFile } from './update-candidate.mjs';

const [candidateArg, configArg, receiptArg] = process.argv.slice(2);
if (!candidateArg || !configArg || !receiptArg) throw new Error('Use candidate public-config receipt');
const candidate = path.resolve(candidateArg);
const config = JSON.parse(await fs.readFile(configArg, 'utf8'));
const latest = JSON.parse(await fs.readFile(path.join(candidate, 'latest.json'), 'utf8'));
const index = JSON.parse(await fs.readFile(path.join(candidate, 'component-update.json'), 'utf8'));
assert.equal(latest.version, index.version);
const entries = [latest.platforms['windows-x86_64'], latest.componentUpdate,
  index.application, ...index.runtimes.map(r => r.artifact)];
const checks = [];
for (const entry of entries) {
  const url = new URL(entry.url);
  assert.equal(url.origin, 'https://download.laogao.xyz');
  assert.equal(path.posix.dirname(url.pathname), `/agent-updates/windows-x86_64/${latest.version}`);
  assert.equal(url.search, ''); assert.equal(url.hash, '');
  const name = decodeURIComponent(path.posix.basename(url.pathname));
  assert.equal(path.basename(name), name);
  assert(!name.includes('\\'));
  const verified = await verifySignedFile(path.join(candidate, name), config.GEOD_UPDATE_PUBLIC_KEY,
    entry.signature, latest.version);
  if (entry.bytes !== undefined) assert.equal(verified.bytes, entry.bytes);
  if (entry.sha256 !== undefined) assert.equal(verified.sha256, entry.sha256);
  checks.push({name, ...verified});
}
await fs.mkdir(path.dirname(path.resolve(receiptArg)), {recursive: true});
await fs.writeFile(receiptArg, JSON.stringify({passed: true, version: latest.version, checks}, null, 2));
console.log(JSON.stringify({passed: true, signedArtifacts: checks.length, largeCdnDownloads: 0}));

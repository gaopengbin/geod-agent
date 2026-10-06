// Verify the migrated owner's retained published document and image records.
// Native reads validate stored bytes/text hashes; return no document text or pixels.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root = 'artifacts/windows-independent-launch-20261006/';
const expected = JSON.parse(readFileSync(root + 'development-restoration.json', 'utf8'));
const inventory = JSON.parse(readFileSync(root + 'profile-json-reference-audit-after-809403d0b35d1d72.json', 'utf8'));
const sha = value => createHash('sha256').update(String(value)).digest('hex');
const documents = inventory.documentRecords.filter(r => r.ownerScopedDirectory === sha(`${expected.owner}:${r.conversationId}`).slice(0, 32));
const images = inventory.imageRecords.filter(r => r.ownerScopedDirectory === sha(expected.owner));
assert.equal(documents.length, 51);
assert.equal(images.length, 7);
const output = root + 'restored-attachment-reads.json';
assert(!existsSync(output));
const report = {passed: false, modelCalls: 0, textOrPixelsReturned: false, attachmentsModified: false,
  checks: [], startedAt: new Date().toISOString()};
const {chromium} = await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
try {
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url() === 'http://127.0.0.1:1420/');
  assert(page);
  const owner = await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('auth_status')).userId);
  assert.equal(owner, expected.owner);
  for (const record of documents) {
    const result = await page.evaluate(async record => {
      try {
        const value = await window.__TAURI_INTERNALS__.invoke('document_attachment_read', {
          conversationId: record.conversationId, id: record.id, offset: 0, limit: 1});
        return {id: value.attachment.id, originalSha256: value.attachment.sha256,
          textSha256: value.attachment.textSha256, characters: value.attachment.characters,
          available: value.available, kind: value.attachment.kind};
      } catch (error) {return {errorCode: error?.code ?? 'NATIVE_ATTACHMENT_READ_FAILED'};}
    }, record);
    assert(!result.errorCode, result.errorCode);
    assert.equal(result.id, record.id);
    assert.equal(result.originalSha256, record.sha256);
    assert.equal(result.textSha256, record.textSha256);
    assert.equal(result.characters, record.characters);
    assert(result.available);
    report.checks.push({type: 'document', ...result});
  }
  for (const record of images) {
    const result = await page.evaluate(async record => {
      try {
        const data = await window.__TAURI_INTERNALS__.invoke('image_attachment_preview', {
          conversationId: record.conversationId, id: record.id});
        return {available: data.startsWith('data:image/png;base64,'), previewCharacters: data.length};
      } catch (error) {return {errorCode: error?.code ?? 'NATIVE_IMAGE_READ_FAILED'};}
    }, record);
    assert(!result.errorCode, result.errorCode);
    assert(result.available && result.previewCharacters > 30);
    report.checks.push({type: 'image', id: record.id, originalSha256: record.sha256, ...result});
  }
  report.documents = documents.length;
  report.images = images.length;
  report.passed = true;
  report.finishedAt = new Date().toISOString();
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({passed: true, documents: report.documents, images: report.images, modelCalls: 0}));
} catch (error) {
  report.error = String(error);
  writeFileSync(output, JSON.stringify(report, null, 2));
  throw error;
} finally {
  await browser.close();
}

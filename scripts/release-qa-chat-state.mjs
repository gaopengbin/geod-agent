/** Compare saved development chats before and after native profile isolation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const output = path.resolve(process.argv[2]);
assert(output.startsWith(path.resolve('artifacts') + path.sep));
const mode = process.argv[3];
assert(['save', 'compare'].includes(mode));
const {chromium} = await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
try {
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes(':1420'));
  assert(page);
  await page.locator('.conversation-account-trigger').waitFor({timeout: 30000});
  const state = await page.evaluate(async () => {
    const {api} = await import('/src/api.ts');
    const {localStateStore, flushLocalState} = await import('/src/local-state.ts');
    const {accountChatStore, CHAT_LIST_KEY} = await import('/src/pending-generations.ts');
    await flushLocalState();
    const auth = await api.authStatus(), store = accountChatStore(localStateStore, auth.userId);
    return {active: store.getItem('geod-agent-active-conversation-0.1'),
      chats: JSON.parse(store.getItem(CHAT_LIST_KEY) || '[]')};
  });
  const receipt = {active: state.active, count: state.chats.length,
    chatIds: state.chats.map(chat => chat.conversationId).sort(),
    contentSha256: createHash('sha256').update(JSON.stringify(state.chats)).digest('hex')};
  const before = path.join(output, 'development-chats-before.json');
  if (mode === 'save') fs.writeFileSync(before, JSON.stringify(receipt, null, 2));
  else {
    const expected = JSON.parse(fs.readFileSync(before, 'utf8'));
    assert.deepEqual(receipt, expected, 'Original chats changed during candidate isolation');
    fs.writeFileSync(path.join(output, 'development-chats-restored.json'), JSON.stringify({...receipt, passed: true}, null, 2));
  }
  console.log(JSON.stringify({mode, chats: receipt.count, preserved: mode === 'compare'}));
} finally { await browser.close(); }

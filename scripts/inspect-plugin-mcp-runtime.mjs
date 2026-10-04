import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const saved=JSON.parse(fs.readFileSync('artifacts/product-gaps-20261004/plugin-mcp-runtime/restart-state.json','utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
if(process.argv.includes('--remove'))console.log(await page.evaluate(async saved=>window.__TAURI_INTERNALS__.invoke('plugin_remove',{id:saved.pluginId}),saved));
else console.log(await page.evaluate(async saved=>window.__TAURI_INTERNALS__.invoke('mcp_call',{id:saved.connectors.stdio.id,conversationId:saved.conversationId,toolName:'read_context',arguments:{},executionId:crypto.randomUUID()}),saved));
await browser.close();

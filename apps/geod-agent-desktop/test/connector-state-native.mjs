import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/connector-state-layout-20261007');mkdirSync(output,{recursive:true});const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
 const report=await page.evaluate(async()=>{
  const invoke=window.__TAURI_INTERNALS__.invoke,{discoverExtensions}=await import('/src/extension-discovery.ts'),installed=await invoke('extensions_list');let probes=0;
  const discovered=await discoverExtensions(installed,'高德',async()=>{probes++;throw new Error('No probing expected for disabled Amap');});
  const stored=installed.connectors.find(c=>c.url==='https://mcp.amap.com/mcp');
  return {stored:{connectorId:stored?.id,name:stored?.name,enabled:stored?.enabled,authenticationConfigured:stored?.queryNames?.includes('key')},discovered,probes};
 });assert.equal(report.stored.enabled,false);assert.equal(report.stored.authenticationConfigured,true);assert.equal(report.probes,0);assert.equal(report.discovered.connectors[0].registered,true);assert.equal(report.discovered.connectors[0].status,'notEnabled');
 await page.getByText('技能与连接器',{exact:true}).first().click();await page.getByRole('button',{name:/^连接器 /}).click();const card=page.locator('.extension-tile').filter({has:page.locator('strong').filter({hasText:'高德地图 MCP'})}).first();await card.waitFor();await card.scrollIntoViewIfNeeded();assert.match(await card.textContent(),/未启用/);
 const contained=await card.evaluate(tile=>{const r=tile.getBoundingClientRect();return [...tile.querySelectorAll('button')].every(b=>{const q=b.getBoundingClientRect();return q.left>=r.left-1&&q.right<=r.right+1;});});assert(contained);
 await page.getByRole('button',{name:'高德地图 MCP的更多操作',exact:true}).click();await page.getByRole('button',{name:'配置 Key',exact:true}).waitFor();await page.waitForTimeout(450);await page.screenshot({path:join(output,'native-connected-disabled.png')});await page.keyboard.press('Escape');
 const after=await page.evaluate(async()=>{const installed=await window.__TAURI_INTERNALS__.invoke('extensions_list');return installed.connectors.find(c=>c.url==='https://mcp.amap.com/mcp').enabled;});assert.equal(after,false);
 const evidence={passed:true,actualNativeInventory:true,actualNativeUI:true,modelCalls:0,noEnableOrCredentialChanges:true,containedActions:contained,...report};writeFileSync(join(output,'native-report.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();}

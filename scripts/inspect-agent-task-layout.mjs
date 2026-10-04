/** Capture the real populated panel in both themes, restoring user selection. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const[modulePath,evidenceDirectory]=process.argv.slice(2),{chromium}=await import(modulePath);
const root=path.resolve(evidenceDirectory),evidence=JSON.parse(await fs.readFile(path.join(root,'acceptance.json'),'utf8'));
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
const original=await page.evaluate(async()=>{const{localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();const auth=await window.__TAURI_INTERNALS__.invoke('auth_status');const values=[...localStateEntries(),...Object.entries(localStorage)],entry=values.find(([k])=>k===`geod-agent-active-conversation-0.1:account:${auth.userId}`);return{key:entry?.[0],value:entry?.[1],theme:document.documentElement.dataset.theme};});assert(original.key);
const measurements=[];
try{
  for(const theme of['light','dark']){
    await page.evaluate(async({key,id,theme})=>{const{localStateStore,flushLocalState}=await import('/src/local-state.ts');localStateStore.setItem(key,id);await flushLocalState();localStorage.setItem('geod-agent-theme',theme);},{key:original.key,id:evidence.conversationId,theme});
    await page.reload();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();
    await page.locator(`.conversation-item.active[data-conversation-id="${evidence.conversationId}"]`).waitFor();
    await page.evaluate(({conversationId})=>window.dispatchEvent(new CustomEvent('geod-agent-task-focus',{detail:{conversationId}})),{conversationId:evidence.conversationId});
    await page.getByRole('tab',{name:'子任务',exact:true}).click();await page.getByRole('button',{name:/Alpha 文件分析.*已完成/}).click();
    await page.locator('.agent-task-panel .command-detail h4').first().filter({hasText:'Alpha 文件分析'}).waitFor();
    const dimensions=await page.locator('.agent-task-list-scroll').evaluate(e=>({height:e.clientHeight,contentHeight:e.scrollHeight,scrollable:e.scrollHeight>e.clientHeight,theme:document.documentElement.dataset.theme}));assert(dimensions.height<=241);assert.equal(dimensions.theme,theme);measurements.push(dimensions);
    await page.screenshot({path:path.join(root,`task-panel-${theme}.png`)});
  }
  await fs.writeFile(path.join(root,'layout.json'),JSON.stringify({pass:true,measurements},null,2));console.log(JSON.stringify({pass:true,measurements}));
}finally{
  await page.evaluate(async original=>{const{localStateStore,flushLocalState}=await import('/src/local-state.ts');localStateStore.setItem(original.key,original.value);await flushLocalState();localStorage.setItem('geod-agent-theme',original.theme);},original).catch(()=>{});
  await page.reload().catch(()=>{});await browser.close();
}

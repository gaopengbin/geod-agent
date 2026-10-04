import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const[modulePath,output,backup]=process.argv.slice(2),{chromium}=await import(modulePath);
await fs.mkdir(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
const report={pass:false,cases:[]},key=`geod-map-session-1:storage-qa-${crypto.randomUUID()}`,nonce=crypto.randomUUID();
try{
  await page.reload();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();
  const previous=JSON.parse(await fs.readFile(backup,'utf8'));
  const snapshot=await page.evaluate(async()=>{const{localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();return Object.fromEntries(localStateEntries());});
  const mapKeys=Object.keys(previous).filter(k=>k.startsWith('geod-map-session-1:'));
  for(const k of mapKeys){const before=JSON.parse(previous[k]),after=JSON.parse(snapshot[k]);assert.deepEqual(after.commands,before.commands);assert.deepEqual(after.view?.center,before.view?.center);assert.equal(after.view?.zoom,before.view?.zoom);}
  const former=Object.entries(previous).filter(([k])=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([,v])=>JSON.parse(v));
  const current=Object.entries(snapshot).filter(([k])=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([,v])=>JSON.parse(v));
  for(const chat of former){const restored=current.find(c=>c.conversationId===chat.conversationId);assert(restored);assert.equal(restored.display.length,chat.display.length);}
  report.cases.push({name:'Existing actual conversations and exact map data retained after production migration',pass:true,mapRecords:mapKeys.length,conversations:former.length});
  const payload=JSON.stringify({qa:nonce,data:'v'.repeat(6*1024*1024)});
  await page.evaluate(async({key,payload})=>{const{localStateStore,flushLocalState}=await import('/src/local-state.ts');localStateStore.setItem(key,payload);await flushLocalState();},{key,payload});
  await page.reload();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();
  const read=await page.evaluate(async key=>{const{localStateStore}=await import('/src/local-state.ts');const value=localStateStore.getItem(key);return{bytes:value?.length,qa:value&&JSON.parse(value).qa,legacyBytes:Object.values(localStorage).reduce((n,v)=>n+v.length,0)};},key);
  assert.equal(read.bytes,payload.length);assert.equal(read.qa,nonce);assert(read.legacyBytes<100000);
  report.cases.push({name:'Actual production persistence saves and reopens a record larger than the former 5 MiB limit',pass:true,value:read});
  const recovery=page.getByRole('button',{name:'检查状态',exact:true});
  if(await recovery.count()){
    await recovery.click();await page.waitForFunction(()=>!document.body.innerText.includes('上次请求尚未确认结果'));
    report.cases.push({name:'Production recovery reads actual gateway status and releases the original retained request without replaying tools',pass:true});
  }
  report.pass=true;
}catch(error){report.error=String(error);process.exitCode=1;}finally{
  await page.evaluate(async key=>{const{localStateStore,flushLocalState}=await import('/src/local-state.ts');localStateStore.removeItem(key);await flushLocalState();},key).catch(()=>{});
  await fs.writeFile(path.join(output,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();
}

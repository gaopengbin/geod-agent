/** Run after an actual desktop stop/relaunch, using its saved native vault reference. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const output=path.resolve('artifacts/product-gaps-20261004/sql-inputs');
const state=JSON.parse(fs.readFileSync(path.join(output,'mysql-restart-state.json'),'utf8')),fixture=JSON.parse(fs.readFileSync(path.join(output,'mysql-fixture.json'),'utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;
for(let n=0;n<100&&!page;n++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(!page)await new Promise(r=>setTimeout(r,100));}assert(page);await page.locator('.conversation-account-trigger').waitFor();
const rpc=async(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const report=JSON.parse(fs.readFileSync(path.join(output,'mysql-result.json'),'utf8'));assert(report.passed);
try{
  const all=(await rpc('sql_connections_list')).connections;assert(all.some(item=>item.id===state.connectionId));assert(state.baselineIds.every(id=>all.some(item=>item.id===id)));
  const result=await rpc('sql_query',{connectionId:state.connectionId,sql:'SELECT marker FROM regions WHERE id = 1'});assert.equal(result.result.statements[0].rows[0].marker,fixture.marker);
  report.cases.push({name:'Actual desktop restart preserves native MySQL credentials and reads the real database',passed:true,result});
  const uiState=await page.evaluate(async()=>{const {snapshotLocalRecords}=await import('/src/local-state.ts');return snapshotLocalRecords();});
  const backup=await rpc('desktop_backup_create',{uiState}),manifest=JSON.parse(fs.readFileSync(path.join(backup.path,'manifest.json'),'utf8'));
  const owned=manifest.records.filter(record=>record.path.startsWith('sql-inputs/')&&record.path.endsWith('connections.json'));assert(owned.length>0);
  let found=false;for(const record of owned){const content=fs.readFileSync(path.join(backup.path,record.file));assert.equal(createHash('sha256').update(content).digest('hex'),record.sha256);const values=JSON.parse(content);if(values.some(value=>value.id===state.connectionId))found=true;assert(values.every(value=>!Object.hasOwn(value,'password')));}
  assert(found);report.cases.push({name:'Actual complete backup includes SQL connection metadata without passwords',passed:true,backup,connectionRecords:owned.length});
  await rpc('sql_connection_remove',{connectionId:state.connectionId});const after=(await rpc('sql_connections_list')).connections;assert(!after.some(c=>c.id===state.connectionId));assert(state.baselineIds.every(id=>after.some(c=>c.id===id)));
  fs.writeFileSync(path.join(output,'mysql-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,cases:report.cases.length}));
}finally{await browser.close();}

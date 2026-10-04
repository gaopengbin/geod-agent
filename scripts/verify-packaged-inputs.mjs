/** Actual portable executable and installer files, no SDK/Node/Python in PATH. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const output=path.resolve(process.argv[2]),fixtureRoot=path.resolve('artifacts/product-gaps-20261004');
const manifest=JSON.parse(fs.readFileSync(path.join(output,'candidate.json'),'utf8'));
const expected=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'sql-inputs/fixture-state.json'),'utf8'));
const docMarkers=JSON.parse(fs.readFileSync(path.join(fixtureRoot,'documents/fixture-markers.json'),'utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
let browser;const startupDeadline=Date.now()+60000;while(!browser&&Date.now()<startupDeadline){try{browser=await chromium.connectOverCDP('http://127.0.0.1:9234');}catch{await new Promise(r=>setTimeout(r,500));}}assert(browser,'Candidate WebView did not start');let page;for(let n=0;n<100&&!page;n++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('tauri.localhost'));if(!page)await new Promise(r=>setTimeout(r,100));}assert(page);await page.locator('.conversation-account-trigger').waitFor({timeout:30000});
const rpc=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const report={passed:false,cases:[],installed:false,published:false,cleanWindowsVerified:false};let connectionId,scheduleId;
const record=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(path.join(output,'packaged-inputs.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const conversationId=randomUUID();
try{
  assert.equal((await rpc('desktop_settings_get')).development,false);assert.equal(await rpc('plugin:app|version'),manifest.version);assert.equal((await rpc('auth_status')).state,'connected');
  assert.equal((await rpc('sql_connections_list')).connections.length,0);
  record('Actual isolated release starts with a fresh profile and stock Windows PATH',{version:manifest.version});
  const payload=path.join(output,'installer-payload');
  for(const [name,metadata]of Object.entries(manifest.runtimeVerification)){
    const runtime=path.join(payload,name),data=fs.readFileSync(path.join(runtime,'manifest.json'));assert.equal(createHash('sha256').update(data).digest('hex'),metadata.manifestSha256);
    for(const[file,spec]of Object.entries(JSON.parse(data).files)){const content=fs.readFileSync(path.join(runtime,file));assert.equal(createHash('sha256').update(content).digest('hex'),typeof spec==='string'?spec:spec.sha256);}
  }
  record('Actual NSIS installer payload contains every pinned runtime file',{runtimes:Object.keys(manifest.runtimeVerification),files:Object.values(manifest.runtimeVerification).reduce((sum,item)=>sum+item.filesVerified,0)});
  await rpc('workspace_set',{conversationId,directory:path.join(fixtureRoot,'sql-inputs/workspace'),permission:'fullAccess'});
  const connected=await rpc('sql_connection_connect',{conversationId,request:{kind:'sqlite',name:'Packaged actual SQLite QA',relativePath:expected.sqlite.relativePath}});assert(!connected.error,JSON.stringify(connected));connectionId=connected.connection.id;assert.equal(connected.mcp.server,'DBHub MCP Server');
  const rows=await rpc('sql_query',{connectionId,sql:'SELECT * FROM "'+expected.sqlite.table.replaceAll('"','""')+'"'});assert(rows.result.statements[0].rows[0].note.includes(expected.sqlite.marker));
  record('Packaged native SQLite MCP loads bundled Node and actual database',{connection:connected.connection,mcp:connected.mcp});
  const pdfName='影像说明.pdf',pdf=await rpc('document_attachment_add',{conversationId,name:pdfName,base64:fs.readFileSync(path.join(fixtureRoot,'documents/workspace',pdfName)).toString('base64')});assert(pdf.characters>0);
  record('Packaged PDF parser loads bundled Python and pypdf',{document:pdf});
  const scheduled=await rpc('ai_schedules_create',{conversationId,name:'发行候选实际 SQL 读取',prompt:'仅调用 sql_query，连接 '+connectionId+'，查询表 "'+expected.sqlite.table.replaceAll('"','""')+'" 的 note 列和 score 总和。最终只回复 SQL_ 开头的随机标记以及总和。不要使用 shell 或文件工具。',nextRunAt:new Date(Date.now()+1000).toISOString(),repeatSeconds:null,executionId:randomUUID()});scheduleId=scheduled.scheduleId;
  let result;const deadline=Date.now()+180000;while(Date.now()<deadline){const overview=await rpc('ai_schedules_list',{conversationId}),run=overview.runs.find(item=>item.scheduleId===scheduleId);if(run&&!['queued','running'].includes(run.state)){result=await rpc('ai_schedules_run_events',{runId:run.runId});break;}await new Promise(r=>setTimeout(r,1000));}
  assert.equal(result?.run.state,'succeeded',JSON.stringify(result?.run));assert(JSON.stringify(result.events).includes(expected.sqlite.marker));fs.writeFileSync(path.join(output,'actual-packaged-sql-model.json'),JSON.stringify(result,null,2));record('Actual packaged companion, Codex and DeepSeek read SQLite through MCP',{run:result.run});
  await page.locator('.sidebar-new-chat').click();await page.locator('textarea:not([disabled])').waitFor();
  await page.locator('input[type=file][accept*=docx]').setInputFiles(path.join(fixtureRoot,'documents/workspace/范围说明.docx'));await page.locator('.composer-documents .chat-document-chip').waitFor({timeout:60000});
  await page.locator('textarea').fill('实际发行候选 Word 附件验收。请使用 attachment_read 读取本轮 Word 附件；最终只回复正文里 DOC_ 开头的实际随机标记。不要用 shell 或其他工具。');await page.locator('textarea').press('Enter');
  await page.waitForFunction(marker=>Array.from(document.querySelectorAll('.geod-message-body')).some(node=>node.textContent.includes(marker)),docMarkers.word,{timeout:180000});await page.waitForFunction(()=>!document.querySelector('.conversation-running-dot'),null,{timeout:30000});
  await page.evaluate(()=>document.fonts.ready);await new Promise(resolve=>setTimeout(resolve,800));
  await page.screenshot({path:path.join(output,'actual-packaged-document-chat.png')});record('Actual packaged composer uploads Word and real AI reads its text',{answerMarker:docMarkers.word});
  report.passed=true;
}catch(error){report.error={code:error.code,message:error.message??String(error)};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  if(scheduleId)await rpc('ai_schedules_set_enabled',{scheduleId,enabled:false}).catch(()=>{});
  if(connectionId)await rpc('sql_connection_remove',{connectionId}).catch(()=>{});
  await rpc('background_stop').catch(()=>{});await rpc('plugin:window|close').catch(()=>{});
  fs.writeFileSync(path.join(output,'packaged-inputs.json'),JSON.stringify(report,null,2));await browser.close();
}

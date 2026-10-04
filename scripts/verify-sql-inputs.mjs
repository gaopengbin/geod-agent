import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const output=path.resolve('artifacts/product-gaps-20261004/sql-inputs');
const workspace=path.join(output,'workspace'),fixture=JSON.parse(fs.readFileSync(path.join(output,'fixture-state.json'),'utf8'));
const playwright='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(playwright).href),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;for(let attempt=0;attempt<100&&!page;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,100));}assert(page);
await page.locator('.conversation-account-trigger').waitFor();
if(fs.existsSync(path.join(output,'native-result.json')))fs.copyFileSync(path.join(output,'native-result.json'),path.join(output,'native-result-attempt-'+Date.now()+'.json'));
const conversationId=randomUUID(),report={passed:false,cases:[]},saved=[];
async function rpc(method,args={}){const value=await page.evaluate(async ({method,args})=>{try{return {value:await window.__TAURI_INTERNALS__.invoke(method,args)};}catch(error){return {error:{code:error?.code,message:error?.message||String(error)}};}},{method,args});if(value.error)throw Object.assign(new Error(value.error.message),{code:value.error.code});return value.value;}
const record=(name,extra={})=>{report.cases.push({name,passed:true,...extra});fs.writeFileSync(path.join(output,'native-result.json'),JSON.stringify(report,null,2));console.log(name);};
try{
  assert.equal(await page.locator('.conversation-running-dot').count(),0);
  await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
  const before=createHash('sha256').update(fs.readFileSync(path.join(workspace,fixture.sqlite.relativePath))).digest('hex');
  const connected=await rpc('sql_connection_connect',{conversationId,request:{name:fixture.sqlite.name,kind:'sqlite',relativePath:fixture.sqlite.relativePath}});
  assert(!connected.error,JSON.stringify(connected));assert(connected.connection?.id);saved.push(connected.connection.id);
  assert.equal(connected.mcp.server,'DBHub MCP Server');assert.equal(connected.mcp.version,'1.4.0');
  assert(connected.catalog.results.some(row=>row.name===fixture.sqlite.table));
  record('Actual native DBHub connects to SQLite and discovers a quoted Unicode table',{connection:connected.connection,mcp:connected.mcp,catalog:connected.catalog});
  const columns=await rpc('sql_objects_search',{connectionId:connected.connection.id,request:{objectType:'column',schema:'main',table:fixture.sqlite.table,detailLevel:'full'}});
  assert(columns.result.results.some(row=>row.name==='score'));record('Actual MCP field discovery',{result:columns.result});
  const quoted='"'+fixture.sqlite.table.replaceAll('"','""')+'"';
  const rows=await rpc('sql_query',{connectionId:connected.connection.id,sql:'SELECT * FROM '+quoted+' ORDER BY id'});
  assert.equal(rows.result.statements[0].rows[0].note,fixture.sqlite.marker+'\t换行\n正文');
  assert.equal(rows.result.statements[0].rows[0].big_integer,'9223372036854775806');
  const sum=await rpc('sql_query',{connectionId:connected.connection.id,sql:'SELECT SUM(score) AS total FROM '+quoted});assert.equal(sum.result.statements[0].rows[0].total,50);
  record('Actual SQLite values preserve newlines, Unicode, 64-bit integers and aggregates',{rows,sum});
  let writeError;try{await rpc('sql_query',{connectionId:connected.connection.id,sql:'DELETE FROM many_rows WHERE id < 0'});}catch(error){writeError=error;}assert.equal(writeError?.code,'INPUT_READ_ONLY');
  const capped=await rpc('sql_query',{connectionId:connected.connection.id,sql:'SELECT id FROM many_rows ORDER BY id'});
  assert.equal(capped.result.statements[0].rows.length,500);assert.equal(capped.result.statements[0].truncated,true);
  record('Actual MCP read-only rejection and honest 500-row truncation');
  const invalid=await rpc('sql_connection_connect',{conversationId,request:{kind:'sqlite',name:'outside fixture',relativePath:'../outside.sqlite'}}).catch(error=>({error:error.message}));assert(invalid.error);
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(workspace,fixture.sqlite.relativePath))).digest('hex'),before);
  record('Workspace boundary enforced; source SQLite remains unchanged');
  const actual=await page.evaluate(async p=>{
    const {runCodexTurn}=await import('/src/codex-client.ts'),{executeDataInputTool}=await import('/src/data-input-tools.ts');
    const calls=[],generations=[];
    const input='这是实际 SQLite 输入验收。通过 sql_connection_connect 连接工作区 '+p.relativePath+'，实际发现表及字段，然后用 sql_query 读取实际数据。最后只报告 note 列中 SQL_ 开头的随机标记和 score 总和。不要使用文件或 shell 工具读取数据库；标记只在数据库中。';
    const result=await runCodexTurn(crypto.randomUUID(),p.conversationId,input,[],{onEvent:()=>{},onModel:()=>{},onGeneration:g=>generations.push({state:g.state,inputTokens:g.inputTokens}),onRequest:async()=>({decision:'decline'}),execute:async call=>{
      const args=JSON.parse(call.function.arguments||'{}');
      if(!call.function.name.startsWith('sql_'))return {result:{error:'QA_SQL_INPUT_TOOLS_ONLY'}};
      const result=await executeDataInputTool(p.conversationId,call.function.name,args);calls.push({name:call.function.name,args,result});return {result};
    }});
    return {result,calls,generations};
  },{conversationId,relativePath:fixture.sqlite.relativePath});
  for(const call of actual.calls)if(call.result?.connection?.id)saved.push(call.result.connection.id);
  fs.writeFileSync(path.join(output,'actual-model-sqlite.json'),JSON.stringify(actual,null,2));
  assert.equal(actual.result.status,'completed');assert(actual.generations.every(item=>item.state==='settled'&&item.inputTokens>0));
  assert(actual.result.text.includes(fixture.sqlite.marker));assert(actual.result.text.includes('50'));assert(actual.calls.some(call=>call.name==='sql_query'));
  record('Real Codex/DeepSeek connects, discovers and reads SQLite through MCP',{actualAnswer:actual.result.text,tools:actual.calls.map(call=>call.name)});
  report.passed=true;
}catch(error){report.error={code:error.code,message:error.message};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{for(const id of new Set(saved))await rpc('sql_connection_remove',{connectionId:id}).catch(()=>{});fs.writeFileSync(path.join(output,'native-result.json'),JSON.stringify(report,null,2));await browser.close();}

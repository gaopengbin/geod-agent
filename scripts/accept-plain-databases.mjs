/** Actual native MCP and product Agent reads for PostgreSQL and SQLite vectors. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const[modulePath,output]=process.argv.slice(2),{chromium}=await import(modulePath),exec=promisify(execFile);
const root=path.resolve(output),report={pass:false,cases:[]},errors=[],createdConnections=[];
const descriptor=path.resolve('infra/postgis-test/.secrets',`plain-acceptance-${crypto.randomUUID()}.json`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn,label,ms=180000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await sleep(250);}throw new Error(`Timeout: ${label}`);};
await fs.mkdir(root,{recursive:true});
let browser,page,conversationId,credentialPath,fixtureCreated=false,password;
const rpc=async(command,args={})=>{const r=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(r.error)throw Object.assign(new Error(JSON.stringify(r.error)),r.error);return r.value;};
const chats=()=>page.evaluate(async()=>{const{localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();return localStateEntries().filter(([k])=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([,v])=>JSON.parse(v));});
const pass=async(name,result)=>{assert(!password||!JSON.stringify(result).includes(password),'Credential leaked into evidence');report.cases.push({name,pass:true,result});console.log(name,'PASS');await fs.writeFile(path.join(root,'acceptance.json'),JSON.stringify(report,null,2));};
async function ask(message){const n=(await chats()).find(c=>c.conversationId===conversationId)?.display.filter(d=>d.role==='user').length??0;await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(message);await page.getByRole('button',{name:'发送消息',exact:true}).click();return wait(async()=>{const chat=(await chats()).find(c=>c.conversationId===conversationId);return chat&&!chat.pendingId&&chat.display.filter(d=>d.role==='user').length>n&&chat.messages.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count())?chat:null;},'Actual database Agent',240000);}
try{
  await exec('python',['-X','utf8','scripts/plain-postgres-fixture.py','create',descriptor],{windowsHide:true});fixtureCreated=true;
  const fixture=JSON.parse(await fs.readFile(descriptor,'utf8'));password=fixture.draft.password;
  browser=await chromium.connectOverCDP('http://127.0.0.1:9233');page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);page.on('pageerror',e=>errors.push(e.message));
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();assert.equal((await rpc('background_status')).activeAiTurns,0);
  const before=new Set((await chats()).map(c=>c.conversationId));await page.locator('.sidebar-new-chat').click();conversationId=await wait(async()=>(await chats()).find(c=>!before.has(c.conversationId))?.conversationId,'New database chat');
  const workspace=(await rpc('workspace_get',{conversationId})).directory;await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
  const inputDirectory=`database-qa-${crypto.randomBytes(6).toString('hex')}`;await fs.mkdir(path.join(workspace,inputDirectory),{recursive:true});
  credentialPath=path.join(workspace,inputDirectory,'postgres-credentials.json');await fs.writeFile(credentialPath,JSON.stringify({...fixture.draft,name:'普通 PostgreSQL Agent 验收'}));
  const saved=await rpc('data_connection_save',{draft:fixture.draft});createdConnections.push(saved.connection.id);
  assert.equal(saved.databaseType,'PostgreSQL');assert.deepEqual(saved.layers,[]);assert(saved.tables.some(t=>t.name===fixture.table));assert.equal(saved.mcp.server,'pgedge-postgres-mcp');
  await pass('Actual builtin MCP discovers an ordinary PostgreSQL database without PostGIS',saved);
  const inspected=await rpc('data_layer_inspect',{connectionId:saved.connection.id,layer:fixture.table,limit:2});assert.equal(inspected.featureCount,2);assert(inspected.columns.every(c=>!c.spatial));assert(inspected.sampleRecords.some(r=>r.name===fixture.marker&&r.score===7&&r.details.nested==='实际属性'&&r.notes==='tab\t换行\n引号"'),JSON.stringify(inspected));
  await pass('Actual MCP reads a quoted Chinese table, tabs, newlines and nested JSON',inspected);
  let invalid;try{invalid=(await rpc('data_input_read',{conversationId,request:{connectionId:saved.connection.id,layer:fixture.table}})).error;}catch(e){invalid=e;}assert.equal(invalid?.code,'INPUT_NOT_POLYGON');
  const listed=(await rpc('data_connections_list')).find(c=>c.id===saved.connection.id);assert.equal(listed.databaseType,'PostgreSQL');assert(!('password'in listed));await pass('Ordinary records remain records and persisted connection metadata excludes credentials',{code:invalid.code,connection:listed});
  await page.reload();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();await wait(()=>page.getByRole('textbox',{name:'发送给 GeoD Agent'}).isEnabled(),'Ready database composer');
  const pg=await ask(`请用 data_connection_connect 通过工作区相对凭据文件 ${inputDirectory}/postgres-credentials.json 连接普通 PostgreSQL。不要通过 shell 或其他读文件工具读取凭据。连接后发现真实表，读取 ${fixture.table} 的实际字段和两条记录。只回复第一条 name 随机值及两条 score 的总和。不将普通属性表作为裁剪范围，不下载。`);
  const pgCalls=pg.display.filter(d=>d.role==='tool').map(d=>({tool:d.toolName,status:d.toolStatus,details:d.details}));assert(pgCalls.some(c=>c.tool==='data_connection_connect'));assert(pgCalls.some(c=>c.tool==='data_layer_inspect'));assert(pg.messages.at(-1).content.includes(fixture.marker));assert(pg.messages.at(-1).content.includes('18'));assert(!JSON.stringify(pg).includes(password));
  createdConnections.push(...(await rpc('data_connections_list')).filter(c=>c.database===fixture.draft.database).map(c=>c.id));await pass('Real Codex Agent connects from a private credential file and answers from actual PostgreSQL records',{answer:pg.messages.at(-1).content,calls:pgCalls});
  const vectorPath=path.join(workspace,inputDirectory,'范围.sqlite'),runtime=path.resolve('apps/geod-agent-desktop/src-tauri/resources/gdal');
  const marker=crypto.randomBytes(8).toString('hex'),geo={type:'FeatureCollection',features:[{type:'Feature',properties:{name:'SQLite 实际范围',marker},geometry:{type:'Polygon',coordinates:[[[116.1,39.6],[116.3,39.6],[116.3,39.8],[116.1,39.8],[116.1,39.6]]]}}]};
  const python=`import json,geopandas,pyogrio\nf=geopandas.GeoDataFrame.from_features(json.loads(${JSON.stringify(JSON.stringify(geo))}),crs='EPSG:4326').to_crs('EPSG:3857')\nf.to_file(${JSON.stringify(vectorPath)},driver='SQLite',layer='ranges')\nprint(json.dumps({'driver':'SQLite','crs':str(pyogrio.read_info(${JSON.stringify(vectorPath)})['crs']),'rows':len(f)}))`;
  const made=await exec(path.join(runtime,'python.exe'),['-I','-X','utf8','-c',python],{windowsHide:true});const generated=JSON.parse(made.stdout);assert.equal(generated.crs,'EPSG:3857');
  const read=await rpc('data_input_read',{conversationId,request:{relativePath:`${inputDirectory}/范围.sqlite`,layer:'ranges'}});assert.equal(read.boundary.polygonCount,1);read.boundary.bounds.forEach((v,i)=>assert(Math.abs(v-[116.1,39.6,116.3,39.8][i])<1e-6));await pass('Actual SQLite vector file in EPSG:3857 becomes a complete WGS84 polygon range',{generated,boundary:read.boundary});
  const extensions=await rpc('extensions_list'),gdal=extensions.connectors.find(c=>c.transport==='gdalStdio');assert(gdal);const tools=await rpc('mcp_tools',{id:gdal.id,conversationId});assert(tools.tools.some(t=>t.name==='vector_info'));
  const info=await rpc('mcp_call',{id:gdal.id,conversationId,toolName:'vector_info',arguments:{uri:`${inputDirectory}/范围.sqlite`},executionId:crypto.randomUUID()});assert(!info.isError);await pass('Bundled GDAL MCP independently inspects the actual SQLite dataset',info);
  const sqlite=await ask(`使用 data_input_read 实际读取工作区里的 ${inputDirectory}/范围.sqlite，图层 ranges，保存为当前会话范围。只回复实际面数量和 WGS84 边界框，不下载、不写文件。`);
  assert(sqlite.display.some(d=>d.role==='tool'&&d.toolName==='data_input_read'));assert(sqlite.messages.at(-1).content.includes('116.1'));assert(!JSON.stringify(sqlite).includes(password));const stored=await rpc('boundaries_list',{conversationId});assert(stored.some(b=>b.polygonCount===1&&Math.abs(b.bounds[0]-116.1)<1e-6));await pass('Real Codex Agent reads and attaches the SQLite vector range',{answer:sqlite.messages.at(-1).content,boundaries:stored});
  assert.equal(errors.length,0,JSON.stringify(errors));report.pass=true;report.conversationId=conversationId;
}catch(error){report.error=String(error);console.error(report.error);process.exitCode=1;}
finally{
  if(page&&browser){if(await page.getByRole('button',{name:'停止回复',exact:true}).isVisible().catch(()=>false))await page.getByRole('button',{name:'停止回复',exact:true}).click();for(const connectionId of new Set(createdConnections))await rpc('data_connection_remove',{connectionId}).catch(()=>{});}
  if(credentialPath)await fs.unlink(credentialPath).catch(()=>{});
  if(fixtureCreated)await exec('python',['-X','utf8','scripts/plain-postgres-fixture.py','remove',descriptor],{windowsHide:true}).catch(e=>{report.cleanupError=String(e);report.pass=false;process.exitCode=1;});
  report.pageErrors=errors;report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(root,'acceptance.json'),JSON.stringify(report,null,2));if(browser)await browser.close();console.log(JSON.stringify({pass:report.pass,cases:report.cases.length,error:report.error}));
}

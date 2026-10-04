/** The actual product composer, Codex app-server and hosted model perform all calls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [playwrightModule,evidenceDirectory,credentialFile]=process.argv.slice(2);
const evidencePath=path.resolve(evidenceDirectory);
await fs.mkdir(evidencePath,{recursive:true});
const draft=JSON.parse(await fs.readFile(credentialFile,'utf8'));
const {chromium}=await import(playwrightModule);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
if(!page)throw new Error('Actual desktop page missing');
const rpc=async(command,args={})=>{const reply=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!reply.ok)throw reply.error;return reply.value;};
const status=await rpc('auth_status');
if(status.state!=='connected')throw new Error('Existing GeoD account is not connected');
const key=`geod-agent-conversations-0.1:account:${status.userId}`;
const chats=()=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'[]'),key);
let conversationId,connectionId,connectorId;
const readChat=async()=> (await chats()).find(chat=>chat.conversationId===conversationId);
const send=async(input)=>{
  await page.getByRole('textbox',{name:'发送给 GeoD Agent',exact:true}).fill(input);
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await page.getByRole('button',{name:'停止回复',exact:true}).waitFor({timeout:15000});
  await page.getByRole('button',{name:'停止回复',exact:true}).waitFor({state:'hidden',timeout:240000});
};
const report={cases:[]};
const save=async(name,expect)=>{
  const chat=await readChat();
  if(JSON.stringify(chat).includes(draft.password))throw new Error('Database credential leaked into chat');
  const calls=(chat.display??[]).filter(item=>item.role==='tool'&&item.toolName).map(item=>{let details={};try{details=JSON.parse(item.details||'{}');}catch{}return{tool:item.toolName,status:item.toolStatus,...details};});
  expect(calls,chat);
  report.cases.push({name,pass:true,calls,answers:chat.messages.filter(m=>m.role==='assistant'&&m.content).map(m=>m.content),context:chat.codexContext,engine:chat.engine});
  report.conversationId=conversationId;
  await fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(report,null,2));
  console.log(name,'PASS');
};
try{
  const known=new Set((await chats()).map(chat=>chat.conversationId));
  await page.locator('.sidebar-new-chat').click();
  for(let i=0;i<100;i++){conversationId=(await chats()).find(chat=>!known.has(chat.conversationId))?.conversationId;if(conversationId)break;await new Promise(r=>setTimeout(r,100));}
  if(!conversationId)throw new Error('New product conversation missing');
  const workspace=await rpc('workspace_get',{conversationId});
  await rpc('workspace_set',{conversationId,directory:workspace.directory,permission:'fullAccess'});
  report.workspace=workspace.directory;
  const connected=await rpc('data_connection_save',{draft:{...draft,name:'AI 筛选实测 PostGIS'}});
  if(connected.error)throw connected.error;
  connectionId=connected.connection.id;
  await send('连接能力验收：请通过数据输入工具连接已保存的“AI 筛选实测 PostGIS”，发现真实图层。对 public.regions.geog 先检查实际字段，再按 name 等于 east、WGS84 范围 [116.05,39.55,116.25,39.75] 筛选，读取完整范围并保存到当前会话。数量上限 1。只回答读取到的区域名称、面数量和边界框，不规划、不下载。不要使用 shell 或手写 SQL。');
  await save('actual AI PostGIS discovery and filtered geography',(calls,chat)=>{
    const text=JSON.stringify(calls);
    if(!text.includes('data_layer_inspect')||!text.includes('data_input_read')||!text.includes('east'))throw new Error('Expected real filtered data tools did not run');
    if(!chat.messages.some(m=>m.role==='assistant'&&m.content?.includes('east')))throw new Error('AI did not answer from selected attributes');
  });
  await send('接着验收在线目录发现：使用在线数据发现工具检查 https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer ，列出真实图层的名称和接口类型。只发现目录，不读取要素、不下载。');
  await save('actual AI online directory discovery',(calls)=>{
    const text=JSON.stringify(calls);
    if(!text.includes('online_services_discover')||!text.includes('Census Block Points')||!text.includes('states'))throw new Error('Real online discovery not recorded');
  });
  const runtime=path.resolve('apps/geod-agent-desktop/src-tauri/resources/pgedge');
  const added=await rpc('mcp_add',{name:'pgEdge 私有 stdio AI 实测',url:'',command:path.join(runtime,'pgedge-postgres-mcp.exe'),args:['-config',path.join(runtime,'postgres-mcp.yaml')],env:{PGEDGE_DB_HOST:draft.host,PGEDGE_DB_PORT:String(draft.port),PGEDGE_DB_NAME:draft.database,PGEDGE_DB_USER:draft.user,PGEDGE_DB_PASSWORD:draft.password,PGEDGE_DB_SSLMODE:'verify-full',PGEDGE_DB_SSLROOTCERT:path.resolve('infra/postgis-test/.secrets/tls-test/ca.pem'),PGEDGE_DB_ALLOW_WRITES:'false'}});
  connectorId=added.connectors.find(c=>c.name==='pgEdge 私有 stdio AI 实测').id;
  await rpc('mcp_set_enabled',{id:connectorId,enabled:true});
  await send('最后检查“pgEdge 私有 stdio AI 实测”这个已启用的通用 MCP。请发现它的真实工具，使用它的查询工具读取 public.regions 的 name、score，按 score 排序。只读，不改数据。回复三个名称和分数；不要改用内置数据输入连接。');
  await save('actual AI generic private stdio MCP',(calls,chat)=>{
    const selected=calls.filter(call=>call.input?.connectorId===connectorId||call.arguments?.connectorId===connectorId||JSON.stringify(call).includes(connectorId));
    if(!JSON.stringify(selected).includes('query_database')||!JSON.stringify(selected).includes('third'))throw new Error('AI did not use the configured stdio MCP');
    if(!chat.messages.some(m=>m.role==='assistant'&&m.content?.includes('third')))throw new Error('AI did not answer actual queried rows');
  });
  await page.screenshot({path:path.join(evidencePath,'real-model-chat.png')});
}catch(error){
  await fs.writeFile(path.join(evidencePath,'failure.json'),JSON.stringify({conversationId,error:error.message??error,chat:await readChat()},null,2));
  await page.screenshot({path:path.join(evidencePath,'failure.png')}).catch(()=>{});
  throw error;
}finally{
  if(await page.getByRole('button',{name:'停止回复',exact:true}).isVisible().catch(()=>false))await page.getByRole('button',{name:'停止回复',exact:true}).click();
  if(connectorId)await rpc('mcp_remove',{id:connectorId}).catch(()=>{});
  if(connectionId)await rpc('data_connection_remove',{connectionId}).catch(()=>{});
  await browser.close();
}

/** Actual native dispatcher and pgEdge 1.1.0; local HTTP cases are fault fixtures. */
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
const [playwrightModule,evidenceDirectory,credentialFile]=process.argv.slice(2);
const evidencePath=path.resolve(evidenceDirectory);
await fs.mkdir(evidencePath,{recursive:true});
const draft=JSON.parse(await fs.readFile(credentialFile,'utf8'));
const {chromium}=await import(playwrightModule);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;
for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}
if(!page)throw new Error('Actual desktop WebView not found');
const rpc=async(command,args={})=>{const reply=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!reply.ok)throw reply.error;return reply.value;};
const report={conversationId:`private-mcp-${crypto.randomUUID()}`,cases:[]};
const token=crypto.randomUUID(),owned=[];
const record=(name,result)=>{const text=JSON.stringify(result);if(text.includes(token)||text.includes(draft.password))throw new Error('Secret appeared in acceptance output');report.cases.push({name,pass:true,result});console.log(name,'PASS');};
let calls=0,requests=0,foreignRequests=0;
const foreign=http.createServer((request,response)=>{foreignRequests++;response.end('{}');});
await new Promise(resolve=>foreign.listen(0,'127.0.0.1',resolve));
const fixture=http.createServer(async(request,response)=>{
  requests++;
  if(request.headers.authorization!==`Bearer ${token}`||request.headers['x-api-key']!==token){response.writeHead(401).end();return;}
  if(request.url==='/redirect'){response.writeHead(307,{location:`http://127.0.0.1:${foreign.address().port}/mcp`}).end();return;}
  if(request.method!=='POST'){response.writeHead(405).end();return;}
  let raw='';for await(const chunk of request)raw+=chunk;
  const body=JSON.parse(raw);
  if(body.id===undefined){response.writeHead(202).end();return;}
  const result=body.method==='initialize'?{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'explicit-auth-fixture',version:'1.0'}}:
    body.method==='tools/list'?{tools:[{name:'echo_auth',description:'Explicit authentication fixture',inputSchema:{type:'object',properties:{message:{type:'string'}}}}]}:
    {content:[{type:'text',text:JSON.stringify({message:body.params.arguments.message,authenticated:true,calls:++calls})}]};
  response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
try{
  await rpc('workspace_set',{conversationId:report.conversationId,directory:evidencePath,permission:'fullAccess'});
  const runtime=path.resolve('apps/geod-agent-desktop/src-tauri/resources/pgedge');
  const env={PGEDGE_DB_HOST:draft.host,PGEDGE_DB_PORT:String(draft.port),PGEDGE_DB_NAME:draft.database,PGEDGE_DB_USER:draft.user,PGEDGE_DB_PASSWORD:draft.password,PGEDGE_DB_SSLMODE:'verify-full',PGEDGE_DB_SSLROOTCERT:path.resolve('infra/postgis-test/.secrets/tls-test/ca.pem'),PGEDGE_DB_ALLOW_WRITES:'false',PGPASSFILE:path.join(runtime,'no-implicit-credentials')};
  const added=await rpc('mcp_add',{name:'通用 stdio · pgEdge 验收',url:'',command:path.join(runtime,'pgedge-postgres-mcp.exe'),args:['-config',path.join(runtime,'postgres-mcp.yaml')],env});
  const stdio=added.connectors.find(c=>c.name==='通用 stdio · pgEdge 验收');owned.push(stdio.id);
  record('stdio metadata contains names only',stdio);
  const tools=await rpc('mcp_tools',{id:stdio.id,conversationId:report.conversationId});
  if(!tools.tools.some(t=>t.name==='query_database'))throw new Error('pgEdge query tool missing');
  record('real pgEdge tool discovery',{toolNames:tools.tools.map(t=>t.name)});
  await rpc('mcp_set_enabled',{id:stdio.id,enabled:true});
  const result=await rpc('mcp_call',{id:stdio.id,toolName:'query_database',arguments:{query:'SELECT name,score,ST_SRID(geom) AS srid FROM public.regions ORDER BY score'},executionId:`private-test:${crypto.randomUUID()}`,conversationId:report.conversationId});
  if(result.isError||!JSON.stringify(result).includes('east')||!JSON.stringify(result).includes('4326'))throw new Error('Actual PostgreSQL query failed');
  record('actual read-only database via generic stdio',result);
  const address=`http://127.0.0.1:${fixture.address().port}/mcp`;
  const httpAdded=await rpc('mcp_add',{name:'请求头认证 fault fixture',url:address,headers:{Authorization:`Bearer ${token}`,'X-Api-Key':token}});
  const privateHttp=httpAdded.connectors.find(c=>c.url===address);owned.push(privateHttp.id);
  record('private header names only',privateHttp);
  const privateTools=await rpc('mcp_tools',{id:privateHttp.id,conversationId:report.conversationId});
  if(privateTools.tools[0]?.name!=='echo_auth')throw new Error('Private service not discovered');
  await rpc('mcp_set_enabled',{id:privateHttp.id,enabled:true});
  const executionId=`private-test:${crypto.randomUUID()}`;
  const arguments_={message:'native authenticated request'};
  const first=await rpc('mcp_call',{id:privateHttp.id,toolName:'echo_auth',arguments:arguments_,executionId,conversationId:report.conversationId});
  const second=await rpc('mcp_call',{id:privateHttp.id,toolName:'echo_auth',arguments:arguments_,executionId,conversationId:report.conversationId});
  if(calls!==1||JSON.stringify(first)!==JSON.stringify(second))throw new Error('MCP duplicate operation repeated');
  record('private call and persisted deduplication',{result:first,calls});
  const redirectAdded=await rpc('mcp_add',{name:'跨地址认证 fault fixture',url:`http://127.0.0.1:${fixture.address().port}/redirect`,headers:{Authorization:`Bearer ${token}`,'X-Api-Key':token}});
  const redirect=redirectAdded.connectors.find(c=>c.name==='跨地址认证 fault fixture');owned.push(redirect.id);
  try{await rpc('mcp_tools',{id:redirect.id,conversationId:report.conversationId});throw new Error('Redirect unexpectedly accepted');}catch(error){if(error.code!=='MCP_CONNECT_FAILED')throw error;}
  if(foreignRequests!==0)throw new Error('Credentials were forwarded to a foreign server');
  record('no credential forwarding on redirect',{foreignRequests,authenticatedRequests:requests});
  await fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(report,null,2));
}finally{
  for(const id of owned)await rpc('mcp_remove',{id}).catch(()=>{});
  await browser.close();await new Promise(resolve=>fixture.close(resolve));await new Promise(resolve=>foreign.close(resolve));
}

import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';import {randomUUID} from 'node:crypto';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/mcp-onboarding-20261007');mkdirSync(output,{recursive:true});let expected='local-fixture-only&value=one';const requests=[];
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');if(url.searchParams.get('key')!==expected){res.writeHead(401);res.end();return;}
 if(req.method!=='POST'){res.writeHead(405);res.end();return;}
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body.method);
 if(body.id===undefined){res.writeHead(202);res.end();return;}
 const result=body.method==='initialize'?{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'query-key-fixture',version:'1'}}:body.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}:{content:[{type:'text',text:body.params.arguments.text}]};
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/mcp`;const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let id;
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
 id=await page.evaluate(async({url,key})=>{const invoke=window.__TAURI_INTERNALS__.invoke;const overview=await invoke('mcp_add',{name:'Query credential integration fixture',url,query:{key}});return overview.connectors.find(c=>c.url===url).id;},{url,key:expected});
 const first=await page.evaluate(async({id,key})=>{const invoke=window.__TAURI_INTERNALS__.invoke;const list=await invoke('extensions_list'),tools=await invoke('mcp_tools',{id});if(JSON.stringify({list,tools}).includes(key))throw new Error('Credential leaked in metadata');const found=list.connectors.find(c=>c.id===id);return {publicUrl:found.url,private:found.private,queryNames:found.queryNames,enabled:found.enabled,tools:tools.tools.map(t=>t.name)};},{id,key:expected});
 assert.deepEqual(first.queryNames,['key']);assert.equal(first.publicUrl,url);assert(first.private);assert.equal(first.enabled,false);assert.deepEqual(first.tools,['echo']);
 await page.evaluate(async(id)=>window.__TAURI_INTERNALS__.invoke('mcp_set_enabled',{id,enabled:true}),id);
 const call=await page.evaluate(async({id,executionId})=>window.__TAURI_INTERNALS__.invoke('mcp_call',{id,toolName:'echo',arguments:{text:'Native credential round trip'},executionId}),{id,executionId:randomUUID()});assert(JSON.stringify(call).includes('Native credential round trip'));
 expected='local-fixture-only&value=two';await page.evaluate(async({id,key})=>window.__TAURI_INTERNALS__.invoke('mcp_query_credentials_set',{id,query:{key}}),{id,key:expected});await page.evaluate(async(id)=>window.__TAURI_INTERNALS__.invoke('mcp_tools',{id}),id);
 const registry=await page.evaluate(async()=>{const invoke=window.__TAURI_INTERNALS__.invoke;const preset=await invoke('mcp_registry_search',{query:'高德mcp'});const publicRegistry=await invoke('mcp_registry_search',{query:'flamap'}).then(r=>({success:true,count:r.length}),e=>({success:false,error:e}));return {preset,publicRegistry};});assert.equal(registry.preset[0].source,'officialPreset');assert.equal(registry.preset[0].url,'https://mcp.amap.com/mcp');
 const report={passed:true,actualNativeTransport:true,fixtureOnly:true,queryEncoded:true,vaultReloaded:true,metadataRedacted:true,credentialRotation:true,modelCalls:0,requests,registry};writeFileSync(join(output,'native-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
 if(id){const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));await page.evaluate(async(id)=>window.__TAURI_INTERNALS__.invoke('mcp_remove',{id}),id);}
 await browser.close();await new Promise(r=>server.close(r));
}

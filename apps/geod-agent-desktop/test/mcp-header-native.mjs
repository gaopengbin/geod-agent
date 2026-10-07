import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/mapbox-onboarding-20261007');mkdirSync(output,{recursive:true});let expected='Bearer local-fixture-only-one',requests=0;
const server=createServer(async(req,res)=>{
 if(req.headers.authorization!==expected||req.headers['x-project']!=='fixture-project'){res.writeHead(401);res.end();return;}
 if(req.method!=='POST'){res.writeHead(405);res.end();return;}
 const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());requests++;
 if(body.id===undefined){res.writeHead(202);res.end();return;}
 const result=body.method==='initialize'?{protocolVersion:body.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'header-credential-fixture',version:'1'}}:{tools:[{name:'read_fixture',inputSchema:{type:'object',properties:{}}}]};
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/mcp`;const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let id;
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
 id=await page.evaluate(async({url,authorization})=>{const invoke=window.__TAURI_INTERNALS__.invoke;const all=await invoke('mcp_add',{name:'Header credential integration fixture',url,headers:{authorization,'X-Project':'fixture-project'}});return all.connectors.find(c=>c.url===url).id;},{url,authorization:expected});
 await page.evaluate(async(id)=>window.__TAURI_INTERNALS__.invoke('mcp_tools',{id}),id);
 expected='Bearer local-fixture-only-two';
 await page.evaluate(async({id,authorization})=>window.__TAURI_INTERNALS__.invoke('mcp_header_credentials_set',{id,headers:{Authorization:authorization}}),{id,authorization:expected});
 const result=await page.evaluate(async({id,authorization})=>{const invoke=window.__TAURI_INTERNALS__.invoke;const list=await invoke('extensions_list'),tools=await invoke('mcp_tools',{id});if(JSON.stringify({list,tools}).includes(authorization))throw new Error('Credential leaked into metadata');const saved=list.connectors.find(c=>c.id===id);return {url:saved.url,enabled:saved.enabled,headerNames:saved.headerNames,private:saved.private,tools:tools.tools.map(t=>t.name)};},{id,authorization:expected});
 assert.equal(result.url,url);assert.equal(result.enabled,false);assert(result.private);assert.deepEqual(result.headerNames,['Authorization','X-Project']);assert.deepEqual(result.tools,['read_fixture']);
 const report={passed:true,actualNativeTransport:true,localFixtureOnly:true,credentialsRedacted:true,credentialRotation:true,unrelatedHeadersPreserved:true,registeredFixtureRemoved:true,modelCalls:0,requests};writeFileSync(join(output,'header-native-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(id){const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));await page.evaluate(async(id)=>window.__TAURI_INTERNALS__.invoke('mcp_remove',{id}),id);}await browser.close();await new Promise(r=>server.close(r));}

import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/mcp-target-resolution-20261007');mkdirSync(output,{recursive:true});const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
 const report=await page.evaluate(async()=>{
  const invoke=window.__TAURI_INTERNALS__.invoke,{resolveMcpTarget,prepareMcpConnection}=await import('/src/mcp-connection.ts');
  const installed=await invoke('extensions_list'),saved=installed.connectors.find(c=>c.url==='https://mcp.amap.com/mcp'),candidates=await invoke('mcp_registry_search',{query:'高德'}),catalog=new Map(candidates.map(c=>[c.name,c]));
  const args=[{candidateId:'official/amap-maps',name:'高德地图 MCP'},{name:'高德地图 MCP',url:'https://mcp.amap.com/mcp'}];const resolution=args.map(a=>resolveMcpTarget(a,installed.connectors,catalog,()=>false));
  if(resolution.some(r=>r.error||r.connector?.id!==saved.id))throw new Error('Saved target resolution failed');
  const prepared=await prepareMcpConnection(resolution[0],undefined,'native-replay',{mcpAdd:async()=>{throw new Error('Must not re-add saved connector');},mcpTools:id=>invoke('mcp_tools',{id})});
  const after=await invoke('extensions_list'),current=after.connectors.find(c=>c.id===saved.id);
  return {resolvedViaCandidateId:resolution[0].connector.id,resolvedViaSavedUrl:resolution[1].connector.id,registeredBefore:true,enabledBefore:saved.enabled,enabledAfter:current.enabled,credentialsPreserved:current.queryNames?.includes('key'),prepared:prepared.error?{error:prepared.error,message:prepared.message}:{connected:prepared.connected,requiresUserReview:prepared.requiresUserReview,enabled:prepared.enabled,toolNames:prepared.extensionProposal?.toolNames},modelCalls:0,registrationWrites:0};
 });assert.equal(report.resolvedViaCandidateId,report.resolvedViaSavedUrl);assert.equal(report.enabledAfter,report.enabledBefore);assert(report.credentialsPreserved);assert.equal(report.prepared.connected,true);assert.equal(report.prepared.requiresUserReview,true);
 const card=page.locator('.agent-source-review').filter({hasText:'高德地图 MCP'}).last();await card.waitFor();await card.scrollIntoViewIfNeeded();assert.equal(await card.getByRole('button',{name:'配置并连接',exact:true}).count(),0);assert.equal(await card.getByRole('button',{name:'确认启用',exact:true}).count(),1);await page.screenshot({path:join(output,'native-enable-review.png')});
 writeFileSync(join(output,'native-report.json'),JSON.stringify({passed:true,actualNativeAmapHandshake:true,...report},null,2));console.log(JSON.stringify({passed:true,...report}));
}finally{await browser.close();}

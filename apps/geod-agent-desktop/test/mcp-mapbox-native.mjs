import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/mapbox-onboarding-20261007');mkdirSync(output,{recursive:true});const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
 const report=await page.evaluate(async()=>{
  const invoke=window.__TAURI_INTERNALS__.invoke,{resolveMcpTarget,prepareMcpConnection}=await import('/src/mcp-connection.ts');
  const before=await invoke('extensions_list');const start=performance.now();
  const searches=await Promise.all(['mapbox','Mapbox MCP server','MAPBOX'].map(query=>invoke('mcp_registry_search',{query})));
  const results=searches[0],target=resolveMcpTarget({candidateId:results[0].name},before.connectors,new Map(results.map(c=>[c.name,c])),()=>false);
  if(target.error)throw new Error(target.error);
  const preparation=await prepareMcpConnection(target,undefined,'native-mapbox-stage',{mcpAdd:async()=>{throw new Error('Token must be provided in native form before registration');},mcpTools:async()=>{throw new Error('No credential: do not claim an authenticated handshake');}});
  const after=await invoke('extensions_list');
  return {searches:searches.map(items=>({candidateId:items[0].name,url:items[0].url,source:items[0].source})),searchDurationMs:Math.round(performance.now()-start),needsLocalConfiguration:preparation.requiresLocalConfiguration,proposal:preparation.extensionProposal,registeredCountUnchanged:before.connectors.length===after.connectors.length,modelCalls:0,authenticatedHandshake:false};
 });
 assert(report.searches.every(s=>s.candidateId==='official/mapbox'&&s.url==='https://mcp.mapbox.com/mcp'&&s.source==='officialPreset'));assert(report.needsLocalConfiguration);assert(report.registeredCountUnchanged);assert(report.proposal.requiresKey);
 await page.getByRole('button',{name:'技能与连接器',exact:true}).click();
 await page.getByRole('button',{name:/^连接器\s/}).click();
 const search=page.getByRole('textbox',{name:'搜索 MCP Registry'});await search.fill('mapbox');await search.press('Enter');
 const tile=page.locator('.extension-tile').filter({hasText:'Mapbox MCP（官方服务预设）'});await tile.waitFor();await tile.getByRole('button',{name:'添加',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.getByLabel('Access Token',{exact:true}).getAttribute('type'),'password');assert.equal(await dialog.getByRole('button',{name:'保存并测试'}).isDisabled(),true);
 await page.screenshot({path:join(output,'native-mapbox-config.png')});
 writeFileSync(join(output,'mapbox-native-report.json'),JSON.stringify({passed:true,...report,actualNativePresetSearch:true,actualConfigurationForm:true},null,2));console.log(JSON.stringify({passed:true,...report,actualNativePresetSearch:true,actualConfigurationForm:true}));
}finally{await browser.close();}

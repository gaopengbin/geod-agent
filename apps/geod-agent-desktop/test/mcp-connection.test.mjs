import test from 'node:test';import assert from 'node:assert/strict';
import {resolveMcpTarget,prepareMcpConnection} from '../src/mcp-connection.ts';
const url='https://mcp.amap.com/mcp';
const saved={id:'saved-amap',name:'高德地图 MCP',url,enabled:false,queryNames:['key']};
const preset={name:'official/amap-maps',title:'高德地图 MCP（官方服务预设）',url,description:'official preset',source:'officialPreset'};
const candidates=new Map([[preset.name,preset]]);
test('replay the reported candidateId then URL retry with no new human URL, preserving saved credentials',async()=>{
 for(const args of [{candidateId:'official/amap-maps',name:saved.name},{name:saved.name,url},{connectorId:saved.id},{registryName:preset.name}]){
  const target=resolveMcpTarget(args,[saved],candidates,()=>false);assert.equal(target.connector.id,saved.id);
  let added=0;const output=await prepareMcpConnection(target,'conversation','call',{mcpAdd:async()=>{added++;throw new Error('Must not add again');},mcpTools:async(id)=>{assert.equal(id,saved.id);return {tools:[{name:'maps_geo'}]};}});
  assert.equal(added,0);assert.equal(output.registered,true);assert.equal(output.enabled,false);assert.equal(output.requiresUserReview,true);assert.equal(output.requiresLocalConfiguration,undefined);assert.equal(output.extensionProposal.id,saved.id);assert.equal(output.extensionProposal.requiresKey,undefined);
 }
});
test('URL matching works independently of a lost search cache; unrelated new URLs and ID conflicts stay blocked',()=>{
 assert.equal(resolveMcpTarget({url},[saved],new Map(),()=>false).connector.id,saved.id);
 assert.equal(resolveMcpTarget({url:'https://unselected.example/mcp'},[saved],candidates,()=>false).error,'MCP_URL_NOT_USER_PROVIDED');
 assert.equal(resolveMcpTarget({connectorId:'another-account',url},[saved],candidates,()=>true).error,'MCP_CANDIDATE_NOT_FOUND');
 assert.equal(resolveMcpTarget({connectorId:saved.id,url:'https://other.example/mcp'},[saved],candidates,()=>true).error,'MCP_TARGET_CONFLICT');
 assert.equal(resolveMcpTarget({candidateId:preset.name,registryName:'unknown'},[saved],candidates,()=>true).error,'MCP_TARGET_CONFLICT');
});
test('saved authentication is not treated as absent when the transport fails',async()=>{
 const target=resolveMcpTarget({url},[saved],candidates,()=>false);const result=await prepareMcpConnection(target,'chat','call',{mcpAdd:async()=>{throw new Error('Must not add');},mcpTools:async()=>{throw new Error('Offline');}});
 assert.equal(result.error,'MCP_CONNECT_FAILED');assert.equal(result.registered,true);assert.equal(result.enabled,false);assert.equal(result.requiresLocalConfiguration,undefined);assert.equal(result.extensionProposal.requiresKey,undefined);
});
test('a new official provider still needs local credentials; an enabled saved connector reports its actual tools',async()=>{
 const fresh=resolveMcpTarget({candidateId:preset.name},[],candidates,()=>false);const result=await prepareMcpConnection(fresh,'chat','call',{mcpAdd:async()=>{throw new Error('Cannot register before local key input');},mcpTools:async()=>{throw new Error('Cannot probe without key');}});assert(result.requiresLocalConfiguration);
 const enabled=await prepareMcpConnection(resolveMcpTarget({url},[{...saved,enabled:true}],candidates,()=>false),'chat','call',{mcpTools:async()=>({tools:[{name:'maps_geo'}]})});assert.equal(enabled.enabled,true);assert.deepEqual(enabled.tools,['maps_geo']);assert.equal(enabled.extensionProposal,undefined);
});

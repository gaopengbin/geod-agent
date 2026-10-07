import test from 'node:test';import assert from 'node:assert/strict';
import {MAPBOX_MCP_URL,mcpProvider,providerSetupProposal,providerCredentialConfigured,validateProviderCredential} from '../src/mcp-provider-presets.ts';
import {configureProviderCredential} from '../src/mcp-provider-key-config.ts';
import {resolveMcpTarget,prepareMcpConnection} from '../src/mcp-connection.ts';
import {reconcileMcpProposals} from '../src/mcp-onboarding.ts';
const url=MAPBOX_MCP_URL,token='pk.test_payload.test_signature';
const connector={id:'mapbox-saved',name:'Mapbox MCP',url,enabled:false,headerNames:['Authorization']};
function client(existing=false){const calls=[];return {calls,extensionsList:async()=>({connectors:existing?[connector]:[]}),mcpAdd:async(name,url,options)=>{calls.push({action:'add',name,url,options});return {connectors:[connector]};},mcpQueryCredentialsSet:async()=>{throw new Error('Mapbox must not use query credentials');},mcpHeaderCredentialsSet:async(id,headers)=>{calls.push({action:'headers',id,headers});},mcpTools:async(id,conversationId)=>{calls.push({action:'tools',id,conversationId});return {tools:[{name:'directions_tool',inputSchema:{}}]};}};}
test('Mapbox reuses native authentication metadata and always stages user review',()=>{
 const proposal=providerSetupProposal(url,'stage');assert(proposal.requiresKey);assert.equal(proposal.detail,url);assert.equal(providerCredentialConfigured(url,undefined),false);
 for(const c of [connector,{...connector,headerNames:['authorization']},{...connector,headerNames:[],oauth:true},{...connector,headerNames:[],runtime:{bearerTokenEnvVar:'MAPBOX_TOKEN'}}])assert(providerCredentialConfigured(url,c));
 assert.equal(providerCredentialConfigured(url,{...connector,headerNames:['X-Unrelated']}),false);
});
test('an official Mapbox candidate opens local configuration without requiring another address question',async()=>{
 const candidate={name:'official/mapbox',title:'Mapbox MCP',url,description:'official',source:'officialPreset'};
 const target=resolveMcpTarget({candidateId:candidate.name},[],new Map([[candidate.name,candidate]]),()=>false);
 const result=await prepareMcpConnection(target,'chat','call',{mcpAdd:async()=>{throw new Error('Do not register without token');},mcpTools:async()=>{throw new Error('Do not probe without token');}});
 assert(result.requiresLocalConfiguration);assert(result.extensionProposal.requiresKey);assert.equal(result.extensionProposal.detail,url);
 const old=[{id:'stage',role:'tool',content:'需要配置',extensionProposal:result.extensionProposal}];const configured=reconcileMcpProposals(old,[connector]);assert.equal(configured[0].extensionProposal.requiresKey,false);assert.match(configured[0].content,/尚未启用/);
});
test('validating credentials is bound to the official endpoint and rejects header injection',()=>{
 for(const value of [token,'sk.test_payload.test_signature','tk.test_payload.test_signature'])assert.equal(validateProviderCredential(mcpProvider(url),value),value);
 for(const value of ['invalid',token+'\r\nX-Key: secret','Bearer '+token,'pk.'+'a'.repeat(4096)+'.signature'])assert.throws(()=>validateProviderCredential(mcpProvider(url),value));
});
test('first save and credential update preserve URL and disabled state, with no token in result',async()=>{
 for(const existing of [false,true]){
  const local=client(existing);const result=await configureProviderCredential(url,'Mapbox MCP',token,'conversation',local);
  assert(!JSON.stringify(result).includes(token));assert.equal(result.connector.enabled,false);assert.equal(local.calls.length,2);
  assert.equal(local.calls[0].action,existing?'headers':'add');assert.equal(local.calls[0].headers?.Authorization??local.calls[0].options.headers.Authorization,'Bearer '+token);assert.equal(local.calls[1].conversationId,'conversation');
 }
});
test('unknown provider and invalid credentials have no side effects; failures never claim success',async()=>{
 const local=client();await assert.rejects(configureProviderCredential('https://untrusted.example/mcp','other',token,'chat',local));await assert.rejects(configureProviderCredential(url,'Mapbox','invalid','chat',local));assert.equal(local.calls.length,0);
 local.mcpTools=async()=>{throw new Error('unauthorized')};await assert.rejects(configureProviderCredential(url,'Mapbox',token,'chat',local),/unauthorized/);
});

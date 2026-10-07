import test from 'node:test';import assert from 'node:assert/strict';
import {AMAP_MCP_URL,userApprovedMcpUrl,restoreMcpSetup,reconcileMcpProposals,amapSetupProposal} from '../src/mcp-onboarding.ts';
import {configureMcpKey} from '../src/mcp-key-config.ts';
import {userInputReplyText} from '../src/user-input-records.ts';
import {conversationSessionSeed} from '../src/conversation-sessions.ts';
const questions=[{id:'endpoint',header:'接入地址',question:'请选择服务',options:[{label:'官方高德 MCP 云服务',description:'官方 Streamable HTTP 端点 '+AMAP_MCP_URL+'，需要本机 Key。'},{label:'其他地址',description:'https://other.example/mcp'}]}];
const human={id:'human',role:'user',content:'帮我接入高德mcp'};
const record={requestId:'request',questions,status:'answered',reply:{answers:{endpoint:{answers:['官方高德 MCP 云服务']}}},userMessageId:human.id,userText:human.content,createdAt:'2026-10-07'};
const messages=[human,{id:'question',role:'tool',content:'补充需求',userInput:record}];
test('selected visible endpoint grants only the exact URL and survives saved history',()=>{
 const saved=conversationSessionSeed({display:messages,messages:[],conversationId:'chat'}).display;
 assert(userApprovedMcpUrl(saved,human.id,AMAP_MCP_URL));
 for(const url of ['https://other.example/mcp',AMAP_MCP_URL+'?key=exposed',AMAP_MCP_URL+'/other'])assert(!userApprovedMcpUrl(saved,human.id,url));
});
test('draft, cancelled, unselected options, assistant prose and a later task do not authorize',()=>{
 for(const status of ['pending','cancelled'])assert(!userApprovedMcpUrl([human,{...messages[1],userInput:{...record,status}}],human.id,AMAP_MCP_URL));
 assert(!userApprovedMcpUrl([human,{id:'assistant',role:'assistant',content:AMAP_MCP_URL}],human.id,AMAP_MCP_URL));
 assert(!userApprovedMcpUrl([...messages,{id:'later',role:'user',content:'连接另一个MCP'}],'later',AMAP_MCP_URL));
 assert(!userApprovedMcpUrl(messages,undefined,AMAP_MCP_URL));
});
test('real retry and card submissions keep their original task authorization',()=>{
 assert(userApprovedMcpUrl([...messages,{id:'retry',role:'user',content:'继续'}],'retry',AMAP_MCP_URL));
 assert(userApprovedMcpUrl([...messages,{id:'submitted',role:'user',content:userInputReplyText(record,record.reply)}],'submitted',AMAP_MCP_URL));
 assert(userApprovedMcpUrl([{...human,content:AMAP_MCP_URL}],human.id,AMAP_MCP_URL));
});
test('the rejected legacy selection becomes a local setup card without opening a connection',()=>{
 const failure={id:'failure',role:'tool',toolName:'mcp_connect',content:'MCP_URL_NOT_USER_PROVIDED',details:JSON.stringify({arguments:{url:AMAP_MCP_URL},result:{error:'MCP_URL_NOT_USER_PROVIDED'}})};
 const restored=restoreMcpSetup([...messages,failure]);assert(restored.at(-1).extensionProposal.requiresKey);assert.equal(restored.at(-1).details,failure.details);
 assert.equal(restoreMcpSetup([human,failure]).at(-1).extensionProposal,undefined);
});
const secret='a'.repeat(32),connector={id:'connector',name:'高德',url:AMAP_MCP_URL,enabled:false,queryNames:['key']};
test('a local settings change replaces the obsolete key request but does not claim enabled or reachable',()=>{
 const old=[{id:'setup',role:'tool',content:'等待 Key',extensionProposal:amapSetupProposal('local-setup')}];
 const updated=reconcileMcpProposals(old,[connector]);assert.equal(updated[0].extensionProposal.id,connector.id);assert.equal(updated[0].extensionProposal.requiresKey,false);assert.match(updated[0].content,/已保存.*尚未启用/);assert.strictEqual(reconcileMcpProposals(updated,[connector]),updated);
 const enabled=reconcileMcpProposals(updated,[{...connector,enabled:true}]);assert.equal(enabled[0].extensionProposal,undefined);assert.match(enabled[0].content,/已启用/);
 assert.strictEqual(reconcileMcpProposals(old,[{...connector,queryNames:[]}]),old);assert.strictEqual(reconcileMcpProposals(old,[]),old);
});
test('restoring history does not recreate a credential request already reconciled as enabled',()=>{
 const failure={id:'old-failure',role:'tool',toolName:'mcp_connect',content:'MCP_URL_NOT_USER_PROVIDED',details:JSON.stringify({arguments:{url:AMAP_MCP_URL},result:{error:'MCP_URL_NOT_USER_PROVIDED'}})};
 const restored=restoreMcpSetup([...messages,failure]);
 assert(restored.at(-1).extensionProposal.requiresKey);
 const reconciled=reconcileMcpProposals(restored,[{...connector,enabled:true}]);
 assert.equal(reconciled.at(-1).extensionProposal,undefined);
 assert.equal(restoreMcpSetup(reconciled).at(-1).extensionProposal,undefined);
 assert.equal(restoreMcpSetup(reconciled).at(-1).toolStatus,'success');
});
function client(existing=false){const calls=[];return {calls,extensionsList:async()=>({skills:[],connectors:existing?[connector]:[]}),mcpAdd:async(name,url,options)=>{calls.push({name,url,options});return {skills:[],connectors:[connector]};},mcpQueryCredentialsSet:async(id,query)=>calls.push({id,query}),mcpTools:async(id,conversationId)=>{calls.push({id,conversationId});return {connectorId:id,name:'高德',tools:[{name:'maps_geo',inputSchema:{}}]};}};}
test('new and existing credentials go only to native adapter; result contains no key',async()=>{
 for(const existing of [false,true]){const local=client(existing);const result=await configureMcpKey('高德',secret,'chat',local);assert(!JSON.stringify(result).includes(secret));assert.equal(local.calls.length,2);assert.equal(local.calls[0].query?.key??local.calls[0].options.query.key,secret);assert.equal(local.calls[1].conversationId,'chat');assert.equal(result.connector.enabled,false);}
});
test('invalid key has no side effects and failed handshake does not claim a connection',async()=>{
 const local=client();await assert.rejects(configureMcpKey('高德','invalid','chat',local));assert.equal(local.calls.length,0);
 local.mcpTools=async()=>{throw new Error('connection failed')};await assert.rejects(configureMcpKey('高德',secret,'chat',local),/connection failed/);
});

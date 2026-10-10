import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCodexConversation,conversationBusyFailure,confirmedCreditRejection} from '../src/codex-recovery.ts';
const idle={busy:false,runId:null,stopping:false};
test('idle conversation is read without stopping it',async()=>{
 const seen=[];
 await prepareCodexConversation({runtimeCapabilities:async()=>({conversationExecution:true}),codexConversationStatus:async id=>{seen.push(id);return idle;},codexConversationStop:async()=>{throw Error('must not stop');}},'chat');
 assert.deepEqual(seen,['chat']);
});
test('orphaned native lease must release before a new send can proceed',async()=>{
 let release,ready=false;const order=[];
 const prepared=prepareCodexConversation({runtimeCapabilities:async()=>({conversationExecution:true}),codexConversationStatus:async()=>({...idle,busy:true,runId:'old'}),codexConversationStop:id=>{order.push(id);return new Promise(resolve=>{release=()=>resolve(idle);});}},'same-chat').then(()=>{ready=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(ready,false);assert.deepEqual(order,['same-chat']);release();await prepared;assert.equal(ready,true);
});
test('failed stop blocks sending instead of claiming that billing reconciliation stopped it',async()=>{
 await assert.rejects(prepareCodexConversation({runtimeCapabilities:async()=>({conversationExecution:true}),codexConversationStatus:async()=>({...idle,busy:true}),codexConversationStop:async()=>({...idle,busy:true})},'chat'),{code:'CODEX_BUSY'});
});
test('older native binaries do not receive unsupported commands',async()=>{
 await prepareCodexConversation({runtimeCapabilities:async()=>({}),codexConversationStatus:async()=>{throw Error('unsupported');},codexConversationStop:async()=>{throw Error('unsupported');}},'chat');
});
test('busy failures are distinct from executed turn failures',()=>{
 for(const cause of [{code:'CODEX_BUSY'},new Error('此会话正在处理上一轮请求'),{message:'上一轮仍在停止，请稍后再发送消息。'}])assert.equal(conversationBusyFailure(cause),true);
 for(const cause of [{code:'MODEL_OUTPUT_LIMIT',message:'模型输出达到本次上限'},new Error('真实网络错误')])assert.equal(conversationBusyFailure(cause),false);
});

test('confirmed pre-dispatch credit failures release only an idle account-owned pending request',async()=>{
 const generation={generationId:'g',conversationId:'chat',state:'failed',errorCode:'BILLING_INSUFFICIENT_CREDIT'};
 const client={runtimeCapabilities:async()=>({conversationExecution:true}),agentGenerationGet:async()=>generation,codexConversationStatus:async()=>idle};
 assert.equal(await confirmedCreditRejection(client,'chat','g'),true);
 generation.errorCode='BILLING_CREDIT_IN_USE';assert.equal(await confirmedCreditRejection(client,'chat','g'),true);
 assert.equal(await confirmedCreditRejection({...client,codexConversationStatus:async()=>({...idle,busy:true})},'chat','g'),false);
 assert.equal(await confirmedCreditRejection(client,'other-chat','g'),false);assert.equal(await confirmedCreditRejection(client,'chat','other-generation'),false);
 for(const state of ['reserved','streaming','pending_reconcile','settled']){generation.state=state;assert.equal(await confirmedCreditRejection(client,'chat','g'),false);}
 generation.state='failed';generation.errorCode='UPSTREAM_REJECTED';assert.equal(await confirmedCreditRejection(client,'chat','g'),false);
});

test('missing evidence or an older native binary cannot silently clear an unresolved request',async()=>{
 const client={runtimeCapabilities:async()=>({}),agentGenerationGet:async()=>{throw Error('must not read');},codexConversationStatus:async()=>{throw Error('must not read');}};
 assert.equal(await confirmedCreditRejection(client,'chat','g'),false);
 await assert.rejects(confirmedCreditRejection({...client,runtimeCapabilities:async()=>({conversationExecution:true}),agentGenerationGet:async()=>{throw Error('offline');},codexConversationStatus:async()=>idle},'chat','g'),/offline/);
});

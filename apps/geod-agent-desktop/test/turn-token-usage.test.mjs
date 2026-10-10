import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateTurnTokenUsage,loadTurnTokenUsage,recordGenerationTokenUsage,turnUsageSources,usageSourceKey} from '../src/turn-token-usage.ts';
import {accountChatStore,persistCompletedChat,CHAT_LIST_KEY,restorePendingChats} from '../src/pending-generations.ts';

const receipt=(id,input,output,extra={})=>({generationId:id,state:'settled',inputTokens:input,outputTokens:output,...extra});
test('one round includes tool loops and compaction, deduplicates generation replay and subset tokens',async()=>{
 const source={runIds:['r','r'],receipts:[receipt('a',20558,38,{cachedInputTokens:3328,reasoningTokens:13})]};
 let reads=0;
 const result=await loadTurnTokenUsage(source,'c',{
  async billingRunSnapshot(){reads++;return {conversationId:'c',status:'completed',generations:[source.receipts[0],receipt('b',100,20,{cachedInputTokens:80,reasoningTokens:10}),receipt('compact',50,5,{cachedInputTokens:0,reasoningTokens:0})]};},
  async agentGenerationGet(){throw Error('already has usage');},
 });
 assert.equal(reads,1);assert.equal(result.status,'complete');assert.equal(result.requests,3);
 assert.equal(result.inputTokens,20708);assert.equal(result.outputTokens,63);assert.equal(result.totalTokens,20771);
 assert.equal(result.cachedInputTokens,3408);assert.equal(result.reasoningTokens,23);
});
test('missing, explicit unknown and invalid usage are never fabricated as zero',()=>{
 const source={runIds:['r'],receipts:[]};
 const rows=[receipt('known',100,10),receipt('unknown',0,0,{usageKnown:false}),{generationId:'pending',state:'streaming'},receipt('invalid',NaN,-1)];
 const result=aggregateTurnTokenUsage(source,rows);
 assert.equal(result.status,'partial');assert.equal(result.totalTokens,110);assert.equal(result.knownRequests,1);
 assert.equal(result.pendingRequests,1);assert.equal(result.unknownRequests,2);
 assert.equal(result.cachedInputTokens,null);assert.equal(result.reasoningTokens,null);
 assert.equal(aggregateTurnTokenUsage(source,[rows[1]]).status,'unavailable');
 assert.equal(aggregateTurnTokenUsage(source,[rows[2]]).status,'pending');
});
test('failed requests with actual usage count, incomplete replays cannot erase it',()=>{
 const r=receipt('a',100,10,{state:'failed',cachedInputTokens:101,reasoningTokens:11});
 const result=aggregateTurnTokenUsage({runIds:['r'],receipts:[]},[r,{generationId:'a',state:'requested'}]);
 assert.equal(result.status,'complete');assert.equal(result.requests,1);assert.equal(result.totalTokens,110);
 assert.equal(result.cachedInputTokens,null);assert.equal(result.reasoningTokens,null);
});
test('late settlement rechecks the exact generation and rejects other-conversation proof',async()=>{
 const source={runIds:['r'],receipts:[]};
 let generationReads=0;
 const client={async billingRunSnapshot(){return {conversationId:'c',status:'interrupted',generations:[{generationId:'a',state:'requested'}]};},
  async agentGenerationGet(id){generationReads++;assert.equal(id,'a');return {...receipt(id,200,20),conversationId:'c'};}};
 assert.equal((await loadTurnTokenUsage(source,'c',client)).totalTokens,220);assert.equal(generationReads,1);
 const wrong=await loadTurnTokenUsage(source,'other',client);
 assert.equal(wrong.status,'unavailable');assert.equal(wrong.knownRequests,0);assert.equal(generationReads,1);
});
test('no submitted requests is zero only with a native receipt; missing history stays unavailable',async()=>{
 const client={async billingRunSnapshot(){return {conversationId:'c',status:'failed',generations:[]};},async agentGenerationGet(){throw Error();}};
 assert.equal((await loadTurnTokenUsage({runIds:['r'],receipts:[]},'c',client)).status,'complete');
 assert.equal((await loadTurnTokenUsage({runIds:[],receipts:[]},'c',client)).status,'unavailable');
});
test('round source boundaries merge continuations and steering, not later rounds or background polls',()=>{
 const rows=[{id:'u',role:'user',content:'下载'},
  {id:'a',role:'tool',turnId:'r1',content:'检查'},
  {id:'question',role:'tool',turnId:'r1',content:'参数',userInput:{status:'answered'}},
  {id:'steer',role:'user',content:'改为z14'},
  {id:'b',role:'assistant',phase:'progress',turnId:'r2',content:'继续'},
  {id:'background',role:'tool',turnId:'unrelated',content:'旧任务',backgroundJob:{}},
  {id:'f',role:'assistant',turnId:'r2',phase:'final',content:'完成'},
  {id:'u2',role:'user',content:'你好'},
  {id:'c',role:'tool',turnId:'r3',content:'思考'},
  {id:'outcome',role:'tool',turnId:'r3',content:'停止',turnOutcome:{generationId:'last',status:'interrupted'}},
 ];
 const sources=turnUsageSources([...rows,rows.at(-1)]);
 assert.deepEqual(sources.f.runIds,['r1','r2']);assert.deepEqual(sources.outcome.runIds,['r3']);
 assert.deepEqual(sources.outcome.receipts,[{generationId:'last',state:'unknown',inputTokens:null,outputTokens:null,cachedInputTokens:null,reasoningTokens:null,usageKnown:undefined}]);
});
test('legacy whole-round receipts and final summary survive account-scoped save/reload',()=>{
 const original=[{id:'u',role:'user',content:'下载'}];
 const rows=recordGenerationTokenUsage(recordGenerationTokenUsage(original,receipt('a',100,10)),receipt('b',200,20));
 rows.push({id:'f',role:'assistant',phase:'final',content:'完成'});
 const source=turnUsageSources(rows).f;rows.at(-1).tokenUsage=aggregateTurnTokenUsage(source,source.receipts);
 assert.equal(rows.at(-1).tokenUsage.totalTokens,330);assert.equal(original[0].modelReceipts,undefined);
 const map=new Map(),store={getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value)};
 const scoped=accountChatStore(store,'owner');persistCompletedChat(scoped,{conversationId:'c',messages:[],display:rows});
 const restored=restorePendingChats(scoped,JSON.parse(scoped.getItem(CHAT_LIST_KEY)))[0];
 assert.equal(restored.display.at(-1).tokenUsage.totalTokens,330);
 assert.equal(restored.display.at(-1).tokenUsage.sourceKey,usageSourceKey(turnUsageSources(restored.display).f));
 assert.equal(accountChatStore(store,'another').getItem(CHAT_LIST_KEY),null);
});

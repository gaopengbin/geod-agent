import test from 'node:test';
import assert from 'node:assert/strict';
import {groupWorkRecords,isTurnWork} from '../src/chat-work.ts';
import {turnOutcomeMessage,modelResponseIssue,orphanedReasoningTurn,recoverTurnOutcome} from '../src/turn-outcome.ts';
const reason={id:'reason',turnId:'run',role:'tool',itemType:'reasoning',toolStatus:'attention',streaming:false,content:'思考',details:'Leg 3 ('};
const rows=[{id:'human',role:'user',content:'下载沿线影像'},{id:'question',turnId:'run',role:'tool',content:'补充需求',userInput:{status:'answered'}},reason];
test('only incomplete output is rejected; tool-only, final, unresolved and native responses stay distinct',()=>{
 for(const result of [{content:null,toolCalls:[]},{content:' ',toolCalls:[]},{content:'partial',toolCalls:[{}],finishReason:'length'}])assert(modelResponseIssue({state:'settled',result}));
 for(const generation of [null,{state:'streaming',result:{content:null,toolCalls:[]}},{state:'settled',result:{content:'完成',toolCalls:[]}},{state:'settled',result:{content:null,toolCalls:[{}]}},{state:'settled',result:{response:{output:[]}}}])assert.equal(modelResponseIssue(generation),null);
});
test('an old partial reasoning row needs native proof; valid completed and awaiting input records are not changed',async()=>{
 let reads=0;const client={billingRunSnapshot:async()=>({status:'completed',conversationId:'chat',generations:[{generationId:'gen'}]}),agentGenerationGet:async()=>{reads++;return {state:'settled',result:{content:null,toolCalls:[]}};}};
 assert.equal(orphanedReasoningTurn(rows),'run');
 const notice=await recoverTurnOutcome(rows,'chat',client);assert.equal(notice.turnOutcome.status,'incomplete');assert.equal(notice.turnOutcome.code,'MODEL_EMPTY_RESPONSE');assert.equal(notice.turnOutcome.generationId,'gen');assert.equal(reads,1);
 assert.deepEqual(rows.at(-1),reason,'raw reasoning history remains intact');
 for(const messages of [[...rows,notice],[...rows,{id:'final',turnId:'run',role:'assistant',phase:'final',content:'完成'}],rows.map(m=>m.id==='question'?{...m,userInput:{status:'pending'}}:m),rows.map(m=>m.id==='reason'?{...m,toolStatus:'running'}:m)])assert.equal(orphanedReasoningTurn(messages),null);
 assert.equal(await recoverTurnOutcome(rows,'different-chat',client),null);
 assert.equal(await recoverTurnOutcome(rows,'chat',{...client,billingRunSnapshot:async()=>({status:'running',conversationId:'chat',generations:[]})}),null);
 assert.equal(await recoverTurnOutcome(rows,'chat',{...client,agentGenerationGet:async()=>({state:'settled',result:{content:'实际最终回复',toolCalls:[]}})}),null);
});
test('failure outcome is durable and stays outside folded work records',()=>{
 const notice=turnOutcomeMessage('run',{status:'failed',message:'连接中断'}),restored=JSON.parse(JSON.stringify([...rows,notice]));
 const entries=groupWorkRecords(restored);assert(entries.some(item=>!isTurnWork(item)&&item.turnOutcome?.status==='failed'));assert(!entries.filter(isTurnWork).some(item=>item.items.some(record=>record.turnOutcome)));
});

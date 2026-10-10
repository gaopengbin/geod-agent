import test from 'node:test';
import assert from 'node:assert/strict';
import {completeCodexReply,orphanedReplyTurn,recoverCodexReply} from '../src/codex-final-reply.ts';
import {reduceCodexItems} from '../src/codex-items.ts';
import {groupWorkRecords,isTurnWork} from '../src/chat-work.ts';

function transcript(){
 let rows=[{id:'human',role:'user',content:'加载混合地图'}];
 rows=reduceCodexItems(rows,'run','item/completed',{item:{type:'agentMessage',id:'announce',phase:'commentary',text:'正在核对图源。'}});
 rows=reduceCodexItems(rows,'run','item/started',{item:{type:'reasoning',id:'reason',summary:[]}});
 rows=reduceCodexItems(rows,'run','item/completed',{item:{type:'mcpToolCall',id:'load',server:'maps',tool:'loadSource',status:'completed',result:{ready:true}}});
 rows=reduceCodexItems(rows,'run','item/completed',{item:{type:'agentMessage',id:'summary',phase:'commentary',text:'已加载完成，并已核对实际状态。'}});
 return rows;
}
test('native completion promotes the last commentary summary once, leaves earlier commentary folded and settles reasoning',()=>{
 const original=transcript();assert.equal(groupWorkRecords(original).filter(isTurnWork)[0].items.at(-1).phase,'progress');
 const rows=reduceCodexItems(original,'run','turn/completed',{turn:{status:'completed',items:[]}});
 const entries=groupWorkRecords(rows),work=entries.filter(isTurnWork),answers=entries.filter(item=>!isTurnWork(item)&&item.role==='assistant');
 assert.equal(work.length,1);assert.equal(answers.length,1);assert.equal(answers[0].id,'codex-run-summary');
 assert.equal(answers[0].content,'已加载完成，并已核对实际状态。');assert.equal(answers[0].phase,'final');
 assert(work[0].items.some(item=>item.id==='codex-run-announce'&&item.phase==='progress'));
 assert(!work[0].items.some(item=>item.id==='codex-run-summary'));
 assert.equal(rows.find(item=>item.itemType==='reasoning').toolStatus,'success');
 assert.strictEqual(completeCodexReply(rows,'run',{status:'completed',text:answers[0].content}),rows);
 assert.equal(original.at(-1).phase,'progress','input history is immutable');
});
test('failed/interrupted turns, reasoning-only output and an announcement followed by more work never become summaries',()=>{
 const rows=transcript();
 for(const status of ['failed','interrupted','running'])assert.strictEqual(completeCodexReply(rows,'run',{status,text:rows.at(-1).content}),rows);
 assert.strictEqual(completeCodexReply(rows,'run',{status:'completed',text:''}),rows);
 const beforeTool=rows.slice(0,-1);
 assert.strictEqual(completeCodexReply(beforeTool,'run',{status:'completed',text:'正在核对图源。'}),beforeTool);
 assert.equal(orphanedReplyTurn(beforeTool),null);
});
test('completion uses full native text after a truncated stream and supports a missing display event without duplicate replies',()=>{
 const rows=reduceCodexItems([], 'run','item/agentMessage/delta',{itemId:'summary',delta:'已加载'});
 const done=completeCodexReply(rows,'run',{status:'completed',text:'已加载并核对。'});
 assert.equal(done.length,1);assert.equal(done[0].phase,'final');assert.equal(done[0].streaming,false);assert.equal(done[0].content,'已加载并核对。');
 const missing=completeCodexReply([],'run',{status:'completed',text:'原生回复'});
 assert.equal(missing.length,1);assert.strictEqual(completeCodexReply(missing,'run',{status:'completed',text:'原生回复'}),missing);
});
test('historic commentary requires matching conversation, completed native receipt and a settled non-tool final generation',async()=>{
 const rows=transcript();assert.equal(orphanedReplyTurn(rows),'run');
 const client={billingRunSnapshot:async()=>({status:'completed',conversationId:'chat',generations:[{generationId:'generation'}]}),agentGenerationGet:async()=>({state:'settled',result:{content:rows.at(-1).content,toolCalls:[]}})};
 const repaired=await recoverCodexReply(rows,'chat',client);assert.equal(repaired.at(-1).phase,'final');assert.equal(rows.at(-1).phase,'progress');
 assert.equal(await recoverCodexReply(rows,'another-chat',client),null);
 for(const status of ['running','failed','interrupted'])assert.equal(await recoverCodexReply(rows,'chat',{...client,billingRunSnapshot:async()=>({status,conversationId:'chat',generations:[{generationId:'generation'}]})}),null);
 for(const generation of [{state:'streaming',result:{content:rows.at(-1).content}},{state:'settled',result:{content:'截断',finishReason:'length'}},{state:'settled',result:{content:'工具前说明',toolCalls:[{}]}},{state:'settled',result:{content:null,reasoning:'模型思考'}},{state:'settled',result:{content:'被过滤',finishReason:'content_filter'}},{state:'settled',result:{content:'工具前说明',response:{output:[{type:'function_call'}]}}}])assert.equal(await recoverCodexReply(rows,'chat',{...client,agentGenerationGet:async()=>generation}),null);
});
test('pending questions, failure markers, a new human message and existing final replies prevent historic repair',()=>{
 const rows=transcript();
 for(const record of [{id:'wait',turnId:'run',role:'tool',content:'选择',userInput:{status:'pending'}},{id:'outcome',turnId:'run',role:'tool',content:'失败',turnOutcome:{status:'failed'}},{id:'new-user',role:'user',content:'下一件事'},{id:'final',turnId:'run',role:'assistant',phase:'final',content:'实际回复'}])assert.equal(orphanedReplyTurn([...rows,record]),null);
});
test('native Responses recovery uses assistant output text, never reasoning or tool payloads',async()=>{
 const rows=transcript(),client={billingRunSnapshot:async()=>({status:'completed',conversationId:'chat',generations:[{generationId:'generation'}]}),agentGenerationGet:async()=>({state:'settled',result:{content:null,response:{output:[{type:'reasoning',summary:[{type:'summary_text',text:'不是回复'}]},{type:'message',role:'assistant',content:[{type:'output_text',text:rows.at(-1).content}]},{type:'function_call_output',output:'不是回复'}]}}})};
 const recovered=await recoverCodexReply(rows,'chat',client);assert.equal(recovered.at(-1).content,rows.at(-1).content);assert.equal(recovered.at(-1).phase,'final');
});

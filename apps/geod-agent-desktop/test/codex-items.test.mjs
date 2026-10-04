import test from 'node:test';
import assert from 'node:assert/strict';
import {reduceCodexItems} from '../src/codex-items.ts';
import {elicitationContent} from '../src/codex-elicitation.ts';

test('actual lifecycle completion updates its existing row and preserves failed output',()=>{
 const run={id:'session-start:0:home/hooks.json',eventName:'sessionStart',status:'running',executionMode:'sync',statusMessage:'Reviewed plugin'};
 let rows=reduceCodexItems([],'one','hook/started',{run});
 assert.equal(rows[0].itemType,'hook');assert.equal(rows[0].toolStatus,'running');assert.equal(rows[0].role,'tool');
 rows=reduceCodexItems(rows,'one','hook/completed',{run:{...run,status:'failed',entries:[{kind:'error',text:'actual exit code 1'}]}});
 assert.equal(rows.length,1);assert.equal(rows[0].toolStatus,'attention');assert.match(rows[0].details,/actual exit code 1/);
 rows=reduceCodexItems(rows,'two','hook/completed',{run:{...run,status:'completed'}});
 assert.equal(rows.length,2);assert.equal(rows[1].toolStatus,'success');assert.equal(rows[1].turnId,'two');
});
test('an asynchronous hook reports startup without claiming its execution has finished',()=>{
 const rows=reduceCodexItems([],'one','hook/started',{run:{id:'async-hook',eventName:'stop',status:'running',executionMode:'async'}});
 assert.match(rows[0].content,/已启动/);assert.equal(JSON.parse(rows[0].details).status,'running');
});

test('streaming updates one item and completion replaces the aggregate without duplicating text',()=>{
 let rows=reduceCodexItems([],'turn','item/agentMessage/delta',{itemId:'reply',delta:'实际'});
 rows=reduceCodexItems(rows,'turn','item/agentMessage/delta',{itemId:'reply',delta:'结果'});
 assert.equal(rows[0].content,'实际结果');assert.equal(rows[0].streaming,true);
 rows=reduceCodexItems(rows,'turn','item/completed',{item:{id:'reply',type:'agentMessage',text:'实际结果',phase:'final_answer'}});
 assert.equal(rows.length,1);assert.equal(rows[0].streaming,false);assert.equal(rows[0].phase,'final');
});
test('a known final answer keeps its phase during streaming instead of folding into execution',()=>{
 let rows=reduceCodexItems([],'turn','item/started',{item:{id:'reply',type:'agentMessage',text:'',phase:'final_answer'}});
 rows=reduceCodexItems(rows,'turn','item/agentMessage/delta',{itemId:'reply',delta:'计划已生成'});
 assert.equal(rows[0].phase,'final');assert.equal(rows[0].streaming,true);
 rows=reduceCodexItems(rows,'turn','item/started',{item:{id:'progress',type:'agentMessage',text:'',phase:'commentary'}});
 rows=reduceCodexItems(rows,'turn','item/agentMessage/delta',{itemId:'progress',delta:'正在处理'});
 assert.equal(rows[1].phase,'progress');
});
test('command output and actual failure survive completion; reused item IDs are scoped to turns',()=>{
 let rows=reduceCodexItems([],'a','item/started',{item:{type:'commandExecution',id:'cmd',command:'python convert.py',status:'inProgress'}});
 rows=reduceCodexItems(rows,'a','item/commandExecution/outputDelta',{itemId:'cmd',delta:'conversion failed'});
 rows=reduceCodexItems(rows,'a','item/completed',{item:{type:'commandExecution',id:'cmd',command:'python convert.py',status:'failed',aggregatedOutput:null}});
 rows=reduceCodexItems(rows,'b','item/started',{item:{type:'reasoning',id:'cmd',summary:[]}});
 assert.equal(rows.length,2);assert.equal(rows[0].details,'conversion failed');assert.equal(rows[0].toolStatus,'attention');assert.equal(rows[1].toolStatus,'running');
});
test('native MCP records keep arguments, tool errors and completed results',()=>{
 const rows=reduceCodexItems([],'t','item/completed',{item:{type:'mcpToolCall',id:'m',server:'humaps',tool:'search_map_layers',arguments:{query:'China'},status:'failed',error:{message:'timeout'},result:null}});
 assert.equal(rows[0].toolStatus,'attention');assert.deepEqual(JSON.parse(rows[0].details).arguments,{query:'China'});assert.match(rows[0].details,/timeout/);
});
test('MCP elicitation preserves boolean false, integer numbers and selected arrays',()=>{
 assert.deepEqual(elicitationContent({properties:{allowed:{type:'boolean'},zoom:{type:'integer',minimum:0,maximum:22},format:{type:'array',items:{enum:['tif','gpkg']}}},required:['allowed','zoom']},{allowed:false,zoom:'12',format:['gpkg']}),{allowed:false,zoom:12,format:['gpkg']});
 assert.throws(()=>elicitationContent({properties:{zoom:{type:'integer',maximum:22}}},{zoom:'24'}),/不符合要求/);
 assert.throws(()=>elicitationContent({properties:{name:{type:'string'}},required:['name']},{}),/请填写/);
 assert.throws(()=>elicitationContent({properties:{format:{type:'string',enum:['tif']}}},{format:'exe'}),/不符合要求/);
});

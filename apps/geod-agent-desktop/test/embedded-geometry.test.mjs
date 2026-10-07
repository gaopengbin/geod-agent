import test from 'node:test';import assert from 'node:assert/strict';
import {hasBulkGeometry,persistEmbeddedGeometryRequest,persistEmbeddedGeometryHistory} from '../../../packages/codex-protocol/bulk-data.mjs';
import {continueTaskContext} from '../src/continue-task.ts';
const coordinates=Array.from({length:400},(_,i)=>[116+i/100000,39+i/200000]);const result={featureCount:1,geojson:{type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'LineString',coordinates}}]}};
const req={input:[{type:'reasoning',summary:[{type:'summary_text',text:'signed original reasoning'}],encrypted_content:'opaque signature'},{type:'function_call',name:'mcp_call',call_id:'map-export',arguments:JSON.stringify({connectorId:'builtin-openlayers-mcp',toolName:'exportFeatures',arguments:{layerId:'route'}})},{type:'function_call_output',call_id:'map-export',output:JSON.stringify({connectorId:'builtin-openlayers-mcp',toolName:'exportFeatures',result})}]};
test('embedded map history receives a real local reference while raw data and signed state remain unchanged',async()=>{
 let saved;const original=JSON.stringify(req);const next=await persistEmbeddedGeometryRequest(req,async value=>{saved=value;return {bulkData:true,executionId:'codex:chat:map-export',geometryFields:[{jsonPointer:'/geojson',pointCount:400}]};});
 assert.deepEqual(saved.result,result);assert.equal(saved.callId,'map-export');assert.equal(JSON.stringify(req),original);assert.equal(next.input[0],req.input[0]);assert.equal(next.input[1],req.input[1]);assert(JSON.parse(next.input[2].output).result.bulkData);assert(!next.input[2].output.includes('116.00001'));
 assert.equal(hasBulkGeometry({bounds:[1,2,3,4]}),false);assert.equal(hasBulkGeometry({coordinates:coordinates.slice(0,10)}),false);
 await assert.rejects(persistEmbeddedGeometryRequest(req,async()=>({error:'storage failure'})),/NOT_SAVED/);
 const history=[{role:'assistant',content:null,tool_calls:[{id:'map-export',function:{name:'mcp_call',arguments:req.input[1].arguments}}]},{role:'tool',tool_call_id:'map-export',content:req.input[2].output}];
 const migrated=await persistEmbeddedGeometryHistory(history,async()=>({bulkData:true,executionId:'codex:chat:map-export'}));assert(migrated[1].content.includes('bulkData'));assert(history[1].content.includes('116.00001'));
});
test('external MCP, ordinary output and existing summaries never acquire invented references',async()=>{
 let saves=0;const external=structuredClone(req);external.input[1].arguments=JSON.stringify({connectorId:'external',toolName:'directions',arguments:{}});assert.equal(await persistEmbeddedGeometryRequest(external,async()=>{saves++;}),external);
 const ready=structuredClone(req);ready.input[2].output=JSON.stringify({result:{bulkData:true,executionId:'real'}});assert.equal(await persistEmbeddedGeometryRequest(ready,async()=>{saves++;}),ready);assert.equal(saves,0);
});
test('continuation carries actual accepted choices for the same task and does not infer answers or permission',()=>{
 const rows=[{id:'human',role:'user',content:'把沿途1公里范围内的影像下载'},{id:'question',role:'tool',content:'补充需求',userInput:{requestId:'q',userMessageId:'human',status:'answered',questions:[{id:'crs',header:'坐标系',question:'输出坐标系？'},{id:'secret',question:'秘密',isSecret:true}],reply:{answers:{crs:{answers:['EPSG:4490']},secret:{answers:['must-not-copy']}}}}},{id:'failure',role:'tool',turnOutcome:{status:'incomplete',code:'MODEL_OUTPUT_LIMIT',message:'未完成'},content:'未完成'},{id:'resume',role:'user',content:'继续刚才的任务'}];
 const text=continueTaskContext('继续刚才的任务',rows);assert(text.includes('EPSG:4490'));assert(text.includes('originUserMessageId'));assert(text.includes('mcp_result_export'));assert(!text.includes('must-not-copy'));assert(text.includes('not new defaults or permissions'));
 assert.equal(continueTaskContext('下载另一个城市',rows),'');assert.equal(continueTaskContext('继续处理',[{id:'user',role:'user',content:'继续处理'}]),'');
 const cancelled=structuredClone(rows);cancelled[1].userInput.status='cancelled';assert(!continueTaskContext('继续刚才的任务',cancelled).includes('EPSG:4490'));
 const newer=[...rows,{id:'new-task',role:'user',content:'下载另一个城市'},{id:'continue-new',role:'user',content:'继续处理'}];assert.equal(continueTaskContext('继续处理',newer),'');
});

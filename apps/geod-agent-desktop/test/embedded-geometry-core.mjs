// Pinned Core: legacy inline map data, output-limit failure and explicit retry.
import assert from 'node:assert/strict';import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';import {createHash} from 'node:crypto';import {resolve,join} from 'node:path';import {createHost} from '../src-tauri/codex-host.mjs';
const artifacts=resolve('../../artifacts/repeated-output-limit-20261007');mkdirSync(artifacts,{recursive:true});const root=mkdtempSync(join(artifacts,'core-')),home=join(root,'home');
const coordinates=Array.from({length:400},(_,i)=>[116+i/100000,39+i/200000]);const raw={featureCount:1,geojson:{type:'FeatureCollection',features:[{type:'Feature',properties:{name:'fixture route'},geometry:{type:'LineString',coordinates}}]}};
const executionId='codex:embedded-fixture:map-export',receipt=join(root,'original-result.json'),sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summary={bulkData:true,executionId,sha256:sha(raw),geometryFields:[{jsonPointer:'/geojson/features/0/geometry/coordinates',pointCount:400}],summary:{featureCount:1,geojson:{type:'FeatureCollection'}},exportTool:'mcp_result_export',notice:'Full original data retained locally. Export /geojson and process locally; never transcribe coordinates.'};
let listener,round=0,mode='failure',saves=0;const requests=[],tools=[];
const options={codex:resolve('src-tauri/resources/codex/codex.exe'),home,toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{model:'deepseek-flash',contextWindow:128000,inputModalities:['text']},receive:fn=>{listener=fn;return()=>{};},emit:event=>{
 if(event.type==='embeddedData'){assert.equal(event.connectorId,'builtin-openlayers-mcp');assert.equal(event.toolName,'exportFeatures');assert.deepEqual(event.result,raw);if(saves===0)writeFileSync(receipt,JSON.stringify(event.result));else assert.deepEqual(JSON.parse(readFileSync(receipt,'utf8')),raw);saves++;listener({type:'response',requestId:event.requestId,value:summary});}
 if(event.type==='model'){
  requests.push(event.request);const n=++round;let content=null,finishReason='tool_calls',toolCalls=[];
  if(mode==='failure'&&n===1)toolCalls=[{id:'map-export',type:'function',function:{name:'mcp_call',arguments:JSON.stringify({connectorId:'builtin-openlayers-mcp',toolName:'exportFeatures',arguments:{layerId:'route'}})}}];
  else if(mode==='failure'){listener({type:'delta',requestId:event.requestId,part:'reasoning',text:'The previous legacy output had coordinates; the run reached its reasoning limit.'});finishReason='length';}
  else if(n===1){const outputs=event.request.input.filter(i=>i.type==='function_call_output');assert(outputs.some(i=>i.output.includes('bulkData')));assert(!JSON.stringify(outputs).includes('116.00001'));toolCalls=[{id:'export-local',type:'function',function:{name:'mcp_result_export',arguments:JSON.stringify({executionId,jsonPointer:'/geojson'})}}];}
  else{content='本机文件写入需要用户确认，原始路线和已选参数均保留。';finishReason='stop';}
  listener({type:'response',requestId:event.requestId,value:{state:'settled',generationId:event.generationId,inputTokens:30,outputTokens:finishReason==='length'?8192:30,result:{content,toolCalls,finishReason}}});
 }
 if(event.type==='tool'){tools.push(event.tool);if(event.tool==='mcp_call')listener({type:'response',requestId:event.requestId,value:{result:{connectorId:'builtin-openlayers-mcp',toolName:'exportFeatures',result:raw}}});else if(event.tool==='mcp_result_export'){assert.deepEqual(event.arguments,{executionId,jsonPointer:'/geojson'});listener({type:'response',requestId:event.requestId,value:{result:{error:'MCP_APPROVAL_REQUIRED',message:'当前工作区需要确认写入'}}});}else throw new Error('Unexpected tool '+event.tool);}
}};
let host=await createHost(options);
try{
 const first=await host.turn({conversationId:'embedded-fixture',workspace:root,permission:'confirmEach',input:'查看路线图层的原始数据。',history:[]},'failed-fixture');assert.equal(first.status,'failed');assert.equal(round,2);assert.equal(saves,1);
 await host.close();mode='resume';round=0;host=await createHost(options);
 const resumed=await host.turn({conversationId:'embedded-fixture',workspace:root,permission:'confirmEach',input:'继续刚才的任务。已确认原始路线、1公里缓冲区和EPSG:4490。使用本机数据引用，不抄写坐标。',history:[]},'resume-fixture');assert.equal(resumed.status,'completed');assert.equal(round,2);assert.deepEqual(tools,['mcp_call','mcp_result_export']);
 assert.deepEqual(JSON.parse(readFileSync(receipt,'utf8')),raw);
 const sessions=join(home,'sessions'),rollout=readdirSync(sessions,{recursive:true}).find(n=>String(n).endsWith('.jsonl'));const rows=readFileSync(join(sessions,rollout),'utf8').trim().split('\n').map(line=>JSON.parse(line));const original=rows.find(r=>r.type==='response_item'&&r.payload.type==='function_call_output'&&r.payload.call_id==='map-export');assert(original.payload.output.includes('116.00001'));
 const report={passed:true,realCore:true,fixtureProvider:true,paidModelCalls:0,firstTurnFailed:true,explicitContinuationCompleted:true,localReceiptSaved:true,originalCoordinates:400,rawNativeHistoryPreserved:true,modelToolOutputsContainRawGeometry:false,writePermissionRetained:true,downloadJobsStarted:0,tools,saves};writeFileSync(join(artifacts,'core-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await host.close();}

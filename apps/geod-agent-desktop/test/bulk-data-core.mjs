// Real pinned Codex engine with deterministic provider/tool fixtures, no paid API.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createHost} from '../src-tauri/codex-host.mjs';
const output=resolve('../../artifacts/bulk-data-20261007');mkdirSync(output,{recursive:true});
const fixture=JSON.parse(readFileSync(join(output,'native-fixture.json'),'utf8'));
const home=mkdtempSync(join(output,'core-')),requests=[],tools=[];let listener,models=0;
const resultFile=join(output,fixture.export.relativePath),geometry=JSON.parse(readFileSync(resultFile,'utf8'));
assert.equal(geometry.coordinates.length,fixture.pointCount);assert.equal(createHash('sha256').update(readFileSync(resultFile)).digest('hex'),fixture.export.sha256);
const bounds=geometry.coordinates.reduce((b,[x,y])=>[Math.min(b[0],x),Math.min(b[1],y),Math.max(b[2],x),Math.max(b[3],y)],[Infinity,Infinity,-Infinity,-Infinity]);
assert.deepEqual(bounds,fixture.summary.geometryFields[0].bounds);
const legacy={paged:true,executionId:fixture.summary.executionId,offset:0,totalChars:fixture.originalChars,content:JSON.stringify(geometry.coordinates.slice(0,180)),nextOffset:7000,complete:false};
const host=await createHost({codex:resolve('src-tauri/resources/codex/codex.exe'),home,toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{model:'deepseek-flash',contextWindow:128000,inputModalities:['text']},receive:fn=>{listener=fn;return()=>{};},emit:event=>{
 if(event.type==='model'){
  const round=++models;requests.push(event.request);
  if(round>1){const outputs=event.request.input.filter(i=>['function_call_output','custom_tool_call_output'].includes(i.type));assert(outputs.length);assert(!JSON.stringify(outputs).includes('116.0001'),'coordinates must not enter the next model request');}
  const calls=round===1?[{id:'bulk_route',type:'function',function:{name:'mcp_call',arguments:JSON.stringify({connectorId:'fixture-route',toolName:'directions',arguments:{}})}}]:round===2?[{id:'bulk_export',type:'function',function:{name:'mcp_result_export',arguments:JSON.stringify({executionId:fixture.summary.executionId,jsonPointer:'/structuredContent/route/geometry'})}}]:[];
  listener({type:'response',requestId:event.requestId,value:{state:'settled',generationId:event.generationId,inputTokens:50,outputTokens:20,result:{content:round===3?'完整路线文件已保存，可交给本机 GIS 工具处理。':null,toolCalls:calls,finishReason:calls.length?'tool_calls':'stop'}}});
 }
 if(event.type==='tool'){
  tools.push(event.tool);
  if(event.tool==='mcp_call')listener({type:'response',requestId:event.requestId,value:{result:{connectorId:'fixture-route',toolName:'directions',result:fixture.summary}}});
  else if(event.tool==='mcp_result_export'){
   assert.equal(event.arguments.executionId,fixture.summary.executionId);assert.equal(event.arguments.jsonPointer,'/structuredContent/route/geometry');
   listener({type:'response',requestId:event.requestId,value:{result:fixture.export}});
  }else throw new Error('Unexpected fixture tool '+event.tool);
 }
}});
try{
 const history=[{role:'tool',content:JSON.stringify({result:legacy})}];
 const result=await host.turn({conversationId:'bulk-fixture',workspace:home,permission:'fullAccess',input:'用已经保存的完整路线文件继续处理，保留全部点。',history},'bulk-core-proof');
 assert.equal(result.status,'completed');assert.equal(models,3);assert.deepEqual(tools,['mcp_call','mcp_result_export']);
 assert(!JSON.stringify(requests[0]).includes('116.0001'),'imported legacy history must also be compacted');
 assert(JSON.stringify(history).includes('116.0001'),'the original saved history remains unchanged');
 const report={passed:true,realCodexEngine:true,providerFixture:true,nativeToolFixture:true,paidModelCalls:0,models,tools,geometryPoints:geometry.coordinates.length,localFileVerified:true,originalReceiptPreserved:fixture.originalReceiptPreserved,sourceCrsChanged:false,legacyHistoryCompacted:true,rawCoordinatesInModelRequests:false,originalChars:fixture.originalChars,summaryChars:fixture.summaryChars,characterReductionPercent:Math.round((1-fixture.summaryChars/fixture.originalChars)*1000)/10};
 writeFileSync(join(output,'core-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await host.close();}

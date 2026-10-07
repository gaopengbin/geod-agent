import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compactGeometryToolOutput,compactGeometryRequest,compactGeometryHistory,BULK_DATA_POLICY} from '../../../packages/codex-protocol/bulk-data.mjs';
import {codexRequest} from '../../../packages/codex-protocol/codex-contract.mjs';

const coordinates=Array.from({length:180},(_,i)=>[116+i/10000,39+i/20000]);
const page=JSON.stringify({connectorId:'test-map',toolName:'directions',result:{paged:true,executionId:'codex:conversation:call',offset:7000,totalChars:30000,content:JSON.stringify(coordinates),nextOffset:14000,complete:false}});

test('historical coordinate pages become local references without mutating saved history',()=>{
 const compact=JSON.parse(compactGeometryToolOutput(page));
 assert.equal(compact.result.bulkData,true);assert.equal(compact.result.legacyGeometryPage,true);assert.equal(compact.result.executionId,'codex:conversation:call');assert.equal(compact.connectorId,'test-map');
 assert(!('content' in compact.result));assert(!('nextOffset' in compact.result));assert(!('complete' in compact.result));assert(compact.result.notice.includes('not the complete geometry'));
 assert.equal(JSON.parse(page).result.content,JSON.stringify(coordinates));
 assert(compactGeometryToolOutput(page).length<page.length/4);
 const history=[{role:'tool',content:page},{role:'user',content:'actual request'}],original=JSON.stringify(history);
 assert(JSON.parse(compactGeometryHistory(history)[0].content).result.bulkData);assert.equal(JSON.stringify(history),original);
});
test('non-geometry pages, bounding boxes, errors and results with no saved reference are preserved',()=>{
 for(const value of ['plain text',JSON.stringify({error:'MCP_RESULT_UNKNOWN'}),JSON.stringify({coordinates}),JSON.stringify({paged:true,executionId:'x',content:'[116,39,117,40]',nextOffset:100}),JSON.stringify({paged:true,executionId:'x',content:'行政区说明'.repeat(2000),nextOffset:7000})])assert.equal(compactGeometryToolOutput(value),value);
});
test('wire compaction preserves provider reasoning/signatures, call pairs and tool outputs of supported text modalities',()=>{
 const signed={type:'reasoning',summary:[{type:'summary_text',text:'untouched'}],encrypted_content:'provider-signature'};
 const req={instructions:'actual policy',input:[signed,{type:'function_call',name:'mcp_call',call_id:'call',arguments:'{}'},{type:'function_call_output',call_id:'call',output:page},{type:'custom_tool_call_output',call_id:'custom',output:[{type:'input_text',text:page}]}]};
 const original=JSON.stringify(req),wire=compactGeometryRequest(req);assert.equal(JSON.stringify(req),original);assert.deepEqual(wire.input[0],signed);assert.equal(wire.input[2].call_id,'call');assert(JSON.parse(wire.input[2].output).result.bulkData);assert(JSON.parse(wire.input[3].output[0].text).result.bulkData);
 const contract=codexRequest({instructions:'actual policy',input:req.input.slice(0,3),tools:[{type:'function',name:'mcp_call',parameters:{type:'object'}}]});assert.equal(contract.messages.at(-1).tool_call_id,'call');assert(JSON.parse(contract.messages.at(-1).content).result.bulkData);
});
test('bundled native helper and discovered tool schemas are synchronized',()=>{
 assert.equal(readFileSync('src-tauri/codex-bulk-data.mjs','utf8'),readFileSync('../../packages/codex-protocol/bulk-data.mjs','utf8'));
 const tools=JSON.parse(readFileSync('src-tauri/codex-tools.json','utf8')),definition=tools.find(t=>t.function.name==='mcp_result_export').function;
 assert.deepEqual(definition.parameters.required,['executionId']);assert.match(definition.description,/never inline coordinates/);assert.match(BULK_DATA_POLICY,/Never page through coordinate arrays/);
});

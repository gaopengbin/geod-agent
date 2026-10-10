import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ModelToolCatalog,SEARCH_TOOL,CONTEXT_TOOL,projectModelInput} from '../src-tauri/model-input-context.mjs';
import {USER_INPUT_POLICY} from '../src-tauri/codex-host.mjs';
const declared=[...JSON.parse(readFileSync(new URL('../src-tauri/codex-tools.json',import.meta.url))),SEARCH_TOOL,CONTEXT_TOOL];
const message=(role,value)=>({type:'message',role,content:[{type:role==='assistant'?'output_text':'input_text',text:value}]});
const tools=declared.map(({function:f})=>({type:'function',...f}));
const policy="You are GeoD Agent. Reply in the user's language. Use actual tools. For a 2D map, MAP_RULE_SENTINEL use OpenLayers. For vector ranges, preserve saved boundaryId values. Use data_connection_connect SQL_RULE_SENTINEL for native connections. Current conversation permission: fullAccess; native executors enforce it. Source configuration is a technical task, SOURCE_RULE_SENTINEL. When explicitly asked to schedule imagery, SCHEDULE_RULE_SENTINEL. Hand downloads off to native background monitoring; do not poll. For requests to switch to 2D/3D MAP_VIEW_SENTINEL. For explicitly requested later or recurring AI AI_SCHEDULE_SENTINEL. For explicitly requested long-running workspace commands COMMAND_RULE_SENTINEL. Independent file analysis subtasks TASK_RULE_SENTINEL. GeoD explicit memory is managed only on explicit human request. "+USER_INPUT_POLICY+' A casual observation, is not an action request. Large geometry tool results are retained locally; preserve exact coordinates. Current native conversation export CRS default: null.';
function project(items,input='继续下载故宫影像',{home,history=[]}={}){const catalog=new ModelToolCatalog(declared,{input,history},{home});const source={input:[message('developer',policy+'<permissions instructions>KEEP_NATIVE_PERMISSION</permissions instructions>'),...items,message('user',input),message('developer','[GeoD execution checkpoint]\n{"requirements":{"targetCrs":"EPSG:4326"},"unresolvedOperations":[],"resources":[{"id":"job-real","state":"completed","verified":true}]}')],tools};return{catalog,source,result:projectModelInput(source,{catalog,developerInstructions:policy})};}
const call=(id,name='sources_list',args='{}')=>({type:'function_call',call_id:id,name,arguments:args});
const output=(id,value)=>({type:'function_call_output',call_id:id,output:JSON.stringify(value)});

test('old catalogs are offloaded, exact human choices and accepted question receipts remain live, native status is untouched',()=>{
 const human=message('user','故宫，Wayback 2026-09-24，Z16，EPSG:4326，未压缩，无金字塔');
 const questions=call('ask','ask_user','{"questions":[{"id":"crs","question":"成果坐标系？"}]}'),answer=output('ask',{answers:{crs:{answers:['EPSG:4326'],scope:'same-task'}},answeredBy:'user'});
 const raw=output('catalog',{sources:Array.from({length:100},(_,i)=>({id:'source-'+i,name:'Long source description '+i,technicalHint:'sentinel-source-data-'+i}))});
 const {catalog,source,result}=project([human,questions,answer,call('catalog'),raw]);
 assert(result.input.includes(human));assert(result.input.includes(questions));assert(result.input.includes(answer));assert.deepEqual(result.input.at(-1),source.input.at(-1));
 const projected=result.input.find(item=>item.call_id==='catalog'&&item.type==='function_call_output');assert(!projected.output.includes('sentinel-source-data-99'));
 const id=JSON.parse(projected.output).archivedHistory.recordId,record=catalog.context({section:'history',recordId:id,maxChars:24000}).entries[0];assert.deepEqual(record.item,raw);
 assert(source.input.includes(raw));
});

test('archive survives host recreation and exact multi-page JSON, including old reasoning, can be recovered',()=>{
 const home=mkdtempSync(join(tmpdir(),'geod-context-archive-')),large=output('big',{payload:'RECOVERY_SENTINEL_'+('中文 0123456789 '.repeat(4000))});
 const oldReason={type:'reasoning',summary:[{type:'summary_text',text:'PRIOR_REASONING_SENTINEL'}]};
 const {catalog,result}=project([oldReason,call('big'),large],undefined,{home});
 const id=JSON.parse(result.input.find(item=>item.call_id==='big'&&item.type==='function_call_output').output).archivedHistory.recordId;
 const resumed=new ModelToolCatalog(declared,{input:'继续'},{home});let text='',textOffset=0,count=0;
 do{const part=resumed.context({section:'history',recordId:id,textOffset,maxChars:1000}).entries[0];assert.equal(part.recordId,id);text+=part.text;textOffset=part.nextTextOffset;count++;}while(textOffset!==null);
 assert(count>20);assert.deepEqual(JSON.parse(text).item,large);assert.deepEqual(resumed.context({section:'reasoning',query:'PRIOR_REASONING_SENTINEL'}).entries,[oldReason]);
 assert.equal(catalog.history.size,resumed.history.size);
});

test('a large accepted proposal remains verbatim even when older than recent assistant messages',()=>{
 const proposal=message('assistant','计划使用Z16、EPSG:4326、无压缩；'+('original proposal details '.repeat(70))),accepted=message('user','确认，其他参数不变');
 const {result}=project([proposal,accepted,message('assistant','later one'),message('assistant','later two'),message('assistant','later three')]);assert(result.input.includes(proposal));assert(result.input.includes(accepted));
});

test('current long task keeps recent receipts, every current reasoning record and unresolved call without a step cap',()=>{
 const input='下载故宫影像';const items=[message('user',input)],reasons=[];
 for(let n=0;n<25;n++){const reason={type:'reasoning',summary:[{type:'summary_text',text:'current-reason-'+n}]};reasons.push(reason);items.push(reason,call('current-'+n),output('current-'+n,{id:'resource-'+n,state:'completed',details:'x'.repeat(2000)}));}
 const pending=call('pending','plan_imagery','{"boundaryId":"confirmed-boundary"}');items.push(pending);
 const catalog=new ModelToolCatalog(declared,{input}),source={input:items,tools},result=projectModelInput(source,{catalog,developerInstructions:policy});
 for(const reason of reasons)assert(result.input.includes(reason));assert(result.input.includes(pending));
 for(let n=17;n<25;n++)assert(result.input.includes(items.find(item=>item.call_id==='current-'+n&&item.type==='function_call_output')));
 assert(!result.input.find(item=>item.call_id==='current-0'&&item.type==='function_call_output').output.includes('x'.repeat(2000)));assert.equal(result.input.filter(item=>item.type==='function_call').length,26);
});

test('large closed historical command arguments/results remain exactly recoverable without breaking tool pairing',()=>{
 const args=JSON.stringify({cmd:'echo '+('ARGUMENT_SENTINEL '.repeat(200))}),before=call('cmd','exec_command',args),after=output('cmd',{exitCode:0,stdout:'STDOUT_SENTINEL '.repeat(150)});
 const {catalog,result}=project([before,after]);assert(!result.input.some(item=>item.call_id==='cmd'));assert.equal(catalog.context({section:'history',query:'ARGUMENT_SENTINEL',maxChars:24000}).entries[0].item.arguments,args);
 assert(result.input.some(item=>JSON.stringify(item).includes('argumentsRecordId')));
});

test('inactive detailed rules stay recoverable and tool discovery activates relevant rule modules',()=>{
 const {catalog,result,source}=project([], '下载故宫影像');const body=JSON.stringify(result.input);
 assert(body.includes(USER_INPUT_POLICY));for(const marker of ['MAP_RULE_SENTINEL','SQL_RULE_SENTINEL','SCHEDULE_RULE_SENTINEL','COMMAND_RULE_SENTINEL','TASK_RULE_SENTINEL'])assert(!body.includes(marker));assert(body.includes('KEEP_NATIVE_PERMISSION'));
 assert(catalog.context({section:'rules',query:'COMMAND_RULE_SENTINEL'}).entries[0].text.includes('COMMAND_RULE_SENTINEL'));
 catalog.search({names:['sql_query']});const next=projectModelInput(source,{catalog,developerInstructions:policy});assert(JSON.stringify(next.input).includes('SQL_RULE_SENTINEL'));
});

test('internal Core compaction receives the entire original source rather than compressed history',()=>{
 const {catalog,source}=project([call('big'),output('big',{detail:'x'.repeat(5000)})]);const internal={...source,input:[...source.input,message('user','Core internal compaction summary request')]};assert.equal(projectModelInput(internal,{catalog,developerInstructions:policy}),internal);
});

test('imported histories keep human messages and actual accepted answers while offloading large old results',()=>{
 const human={role:'user',content:'故宫 EPSG:4326 Z16'},asked={role:'assistant',content:null,tool_calls:[{id:'a',function:{name:'ask_user',arguments:'{}'}}]},accepted={role:'tool',tool_call_id:'a',content:JSON.stringify({answers:{q:{answers:['EPSG:4326']}},answeredBy:'user'})};
 const old=[human,asked,accepted,{role:'assistant',content:null,tool_calls:[{id:'s',function:{name:'sources_list',arguments:'{}'}}]},{role:'tool',tool_call_id:'s',content:JSON.stringify({sources:['catalog-sentinel '.repeat(500)]})}];
 const input='继续下载影像',catalog=new ModelToolCatalog(declared,{input}),prefix='【Imported GeoD conversation history; local tool records remain authoritative】\n';
 const source={input:[message('developer',policy),message('user',prefix+JSON.stringify(old)+'\n\n'+input)],tools};const result=projectModelInput(source,{catalog,developerInstructions:policy});
 const projected=JSON.parse(result.input.at(-1).content[0].text.slice(prefix.length,-input.length).trim());assert.deepEqual(projected[0],human);assert.deepEqual(projected[2],accepted);assert(!projected[4].content.includes('catalog-sentinel'));
 assert(catalog.context({section:'history',query:'catalog-sentinel',maxChars:24000}).entries.length>0);
});

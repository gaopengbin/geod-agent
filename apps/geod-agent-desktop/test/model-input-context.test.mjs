import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ModelToolCatalog,SEARCH_TOOL,CONTEXT_TOOL,PRODUCT_IDENTITY,conversationalOnly,projectModelInput,modelInputAudit} from '../src-tauri/model-input-context.mjs';
import {USER_INPUT_POLICY} from '../src-tauri/codex-host.mjs';
import {RuntimePolicy,RUNTIME_TOOLS} from '../src-tauri/runtime-policy.mjs';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';

const declared=[...JSON.parse(readFileSync(new URL('../src-tauri/codex-tools.json',import.meta.url))),SEARCH_TOOL,CONTEXT_TOOL];
const tools=declared.map(({function:f})=>({type:'function',...f}));
const owned=`You are GeoD Agent. Reply in the user's language. Use real tools. For requests to switch to 2D/3D use the actual map. For explicitly requested later or recurring AI use schedules. For explicitly requested long-running workspace commands use background commands. Independent file analysis subtasks have restricted workspaces. GeoD explicit memory is managed only on explicit human request. ${USER_INPUT_POLICY} Keep native permission checks and confirmed defaults.`;
const suffix='<skills_instructions>large catalogue</skills_instructions><permissions instructions>KEEP PERMISSIONS EXACT</permissions instructions>';
const message=(role,body)=>({role,content:[{type:'input_text',text:body}]});
const request={instructions:'real Core base instructions',input:[message('developer',owned+suffix),message('user','<environment_context>workspace</environment_context>'),message('user','old question'),message('assistant','old answer'),message('user','你好，请简短回复，不调用工具。'),message('developer','[GeoD execution checkpoint]\nstate')],tools};

test('closed historic SQL/schedule calls keep their records without activating unrelated tools; unresolved calls retain their contract',()=>{
 const input='下载故宫影像，Z16，EPSG:4326',history=[message('user','old SQL work'),{type:'function_call',name:'sql_query',call_id:'sql-old',arguments:'{"sql":"SELECT 1"}'},{type:'function_call_output',call_id:'sql-old',output:'{"rows":[1]}'},{type:'function_call',name:'schedules_create',call_id:'schedule-old',arguments:'{}'},{type:'function_call_output',call_id:'schedule-old',output:'{"scheduleId":"saved"}'},message('user',input)];
 const catalog=new ModelToolCatalog(declared,{input}),result=projectModelInput({...request,input:[message('developer',owned+suffix),...history]},{catalog,developerInstructions:owned});
 assert.deepEqual(result.input.slice(1),history);assert(!result.tools.some(t=>['sql_query','schedules_create'].includes(t.name)));assert(result.tools.some(t=>t.name==='jobs_start'));
 const pending=projectModelInput({...request,input:[message('user',input),{type:'function_call',name:'sql_query',call_id:'unfinished',arguments:'{}'}]},{catalog,developerInstructions:owned});assert(pending.tools.some(t=>t.name==='sql_query'));
});

test('prior-turn reasoning is archived on demand while current reasoning, tool results and all human requirements remain intact',()=>{
 const input='继续任务',old={type:'reasoning',summary:[{type:'summary_text',text:'old long investigation'}]},current={type:'reasoning',summary:[{type:'summary_text',text:'current decision'}]},history=[old,message('user','影像 Z16 EPSG:4326'),message('assistant','已确认'),message('user',input),current];
 const catalog=new ModelToolCatalog(declared,{input,history:[{role:'user',content:'下载影像 Z16 EPSG:4326'}]}),result=projectModelInput({...request,input:history},{catalog,developerInstructions:owned});
 assert(!result.input.includes(old));assert(result.input.includes(current));assert.deepEqual(catalog.context({section:'reasoning'}).entries,[old]);assert.equal(request.input.length,6);assert(result.tools.some(t=>t.name==='jobs_start'));assert(result.tools.some(t=>t.name==='runtime_context_read'));
 catalog.steer('改成 Z15，其他不变');const steered=projectModelInput({...request,input:[...history,message('user','改成 Z15，其他不变')]},{catalog,developerInstructions:owned});assert(steered.input.includes(current),'steering retains reasoning already produced during this Core turn');assert(!steered.input.includes(old));
 const compacted=projectModelInput({...request,input:[...history,message('user','Core internal summary request')]},{catalog,developerInstructions:owned});assert(compacted.input.includes(old),'Core compaction receives all original reasoning');assert(compacted.input.includes(current));
});

test('large installed skill inventories load by explicit name or paged discovery without dropping skill rules or permissions',()=>{
 const entries=Array.from({length:120},(_,i)=>'- skill-'+i+': '+('detailed description '.repeat(20))+'(file: /skills/skill-'+i+'/SKILL.md)');
 const instructions=owned+'<skills_instructions>Read SKILL.md before use.\n'+entries.join('\n')+'\n</skills_instructions><permissions instructions>NATIVE RULE</permissions instructions>';
 const input='使用 skill-119 分析文件',catalog=new ModelToolCatalog(declared,{input}),full={...request,input:[message('developer',instructions),message('user',input)]};
 const result=projectModelInput(full,{catalog,developerInstructions:owned}),body=JSON.stringify(result.input);
 assert(!body.includes(entries[1]),'explicit names do not enable another skill sharing a prefix');
 assert(body.includes('Read SKILL.md before use.'));assert(body.includes('NATIVE RULE'));assert(body.includes(entries[119]));assert(!body.includes(entries[80]));assert.equal(catalog.context({section:'skills',query:'skill-119'}).entries[0],entries[119]);
 let found=[],offset=0;do{const page=catalog.context({section:'skills',offset,limit:16});found.push(...page.entries);offset=page.nextOffset;}while(offset!==null);assert.deepEqual(found,entries);
 assert(Buffer.byteLength(JSON.stringify(result))<Buffer.byteLength(JSON.stringify(full))*.5);
});

test('resume bookkeeping does not activate unrelated families or skills; human action text and discoverability remain intact',()=>{
 const metadata='<geod_resume_context>{"originalRequest":"下载故宫影像","confirmedAnswers":[{"answer":"Esri Wayback Z16 EPSG:4326"}]} Retrieve saved map/MCP geometry; use local file tools and GeoJSON.\n</geod_resume_context>';
 const input='继续刚才的任务\n'+metadata,history=[{role:'user',content:'下载今年的历史影像'}];
 const catalog=new ModelToolCatalog(declared,{input,history});
 assert.deepEqual([...catalog.groups],['imagery']);
 const full={...request,input:[message('developer',owned+suffix),message('user',input)]};
 const projected=projectModelInput(full,{catalog,developerInstructions:owned});
 assert.equal(projected.input[1].content[0].text,input,'resume facts and confirmed answers are not removed');
 assert(projected.tools.some(t=>t.name==='workspace_gis_files_list'),'imagery can locate the existing saved boundary without enabling the entire files group');
 for(const name of ['mcp_connect','skill_connect','source_configure','tiles3d_connection_prepare','data_download_start'])assert(!projected.tools.some(t=>t.name===name));
 assert(catalog.search({names:['mcp_connect']}).tools.some(t=>t.name==='mcp_connect'),'deferred capabilities remain available');
 const action=new ModelToolCatalog(declared,{input:'继续，加载到三维地图\n'+metadata,history});assert(action.groups.has('map'));
 const steered=new ModelToolCatalog(declared,{input:'下载影像'});steered.steer('继续刚才的任务\n'+metadata);assert(!steered.groups.has('extensions'));
});

test('standalone Core skill updates are projected on resume while complete original records remain recoverable',()=>{
 const entries=Array.from({length:35},(_,i)=>'- skill-'+i+': '+('full installed skill description '.repeat(15))+'(file: /skills/skill-'+i+'/SKILL.md)');
 const framework='Read SKILL.md before applying a skill. Keep skill authorization boundaries.\n';
 const standalone=message('developer','<skills_instructions>'+framework+entries.join('\n')+'\n</skills_instructions><permissions instructions>KEEP NEW PERMISSIONS EXACT</permissions instructions>');
 const input='下载故宫影像',catalog=new ModelToolCatalog(declared,{input});
 const full={...request,input:[message('developer',owned+suffix),standalone,message('user',input)]},original=JSON.stringify(full);
 const projected=projectModelInput(full,{catalog,developerInstructions:owned});
 const update=projected.input[1].content[0].text;
 assert(update.includes(framework));assert(update.includes('KEEP NEW PERMISSIONS EXACT'));assert(!update.includes(entries[0]));
 assert.deepEqual(catalog.context({section:'skills',offset:16,limit:16}).entries,entries.slice(16,32));
 assert.equal(JSON.stringify(full),original,'durable Core context is unchanged');
 assert(Buffer.byteLength(update)<Buffer.byteLength(standalone.content[0].text)*.2);
 const chosen=new ModelToolCatalog(declared,{input:'使用 skill-34 分析影像'});
 const selected=projectModelInput({...full,input:[full.input[0],standalone,message('user',chosen.params.input)]},{catalog:chosen,developerInstructions:owned}).input[1].content[0].text;assert(selected.includes(entries[34]));assert(!selected.includes(entries[3]));
 const greeting={...full,input:[standalone,message('user','你好')]};
 const brief=projectModelInput(greeting,{catalog:new ModelToolCatalog(declared,{input:'你好'}),developerInstructions:owned});assert(!JSON.stringify(brief).includes('full installed skill description'));assert(JSON.stringify(brief).includes('KEEP NEW PERMISSIONS EXACT'));
});

test('local input audit separates schema/instruction bytes and tool names without persisting prompt contents',()=>{
 const input='下载影像',catalog=new ModelToolCatalog(declared,{input});
 const full={...request,input:[message('user','PRIVATE_MARKER_'+input)]};
 const projected=projectModelInput(full,{catalog,developerInstructions:owned});
 const audit=modelInputAudit(full,projected,catalog);
 assert.equal(audit.version,2);assert.equal(audit.toolsBytes,Buffer.byteLength(JSON.stringify(projected.tools)));
 assert.equal(audit.instructionsBytes,Buffer.byteLength(JSON.stringify(projected.instructions)));
 assert.equal(audit.toolDefinitions.length,audit.sentToolCount);assert(audit.toolDefinitions.some(t=>t.name==='plan_imagery'&&t.bytes>0));
 assert(!JSON.stringify(audit).includes('PRIVATE_MARKER'));
});
test('only explicit greetings/thanks without attachments qualify; approvals and task instructions do not',()=>{
 for(const input of ['你好','您好！','谢谢。','Hello!','你好，请简短回复，不调用工具。','Use English for your commentary and final answer. My request:\nhi'])assert(conversationalOnly({input}));
 for(const input of ['好','确认','继续','你好，下载北京影像','谢谢，继续执行','hi, read my file','看起来没有偏移','你好，请查看任务状态'])assert(!conversationalOnly({input}));
 for(const p of [{images:['x']},{selectedSkills:[{}]},{background:true}])assert(!conversationalOnly({input:'你好',...p}));
});
test('greeting drops tool schemas/skill catalogue/task history only in wire projection, retains permission rules and user text',()=>{
 const source=JSON.stringify(request),catalog=new ModelToolCatalog(declared,{input:'你好，请简短回复，不调用工具。'});
 const result=projectModelInput(request,{catalog,developerInstructions:owned});
 assert.equal(result.instructions,request.instructions);assert.equal(result.tools.length,0);
 assert(result.input.some(item=>JSON.stringify(item).includes('KEEP PERMISSIONS EXACT')));
 assert(!JSON.stringify(result).includes('large catalogue'));assert(!JSON.stringify(result).includes('old answer'));
 assert(!JSON.stringify(result).includes('execution checkpoint'));assert(JSON.stringify(result).includes('你好，请简短回复，不调用工具。'));
 assert.equal(JSON.stringify(request),source,'Core durable request is never modified');
 assert(modelInputAudit(request,result,catalog).sentBytes<modelInputAudit(request,result,catalog).originalBytes*.2);
});
test('normal tasks keep exact user history, paired tools, Core builtins, permissions and full CRS/clarification rules',()=>{
 const history=[message('user','下载北京影像，EPSG:4326'),{type:'function_call',name:'source_configure',call_id:'c',arguments:'{}'},{type:'function_call_output',call_id:'c',output:'{"sourceId":"saved"}'},message('assistant','已配置'),message('user','改成z14，其余不变')];
 const native={type:'namespace',name:'functions',tools:[{type:'custom',name:'apply_patch',description:'Core patch',format:{type:'text'}}]};
 const catalog=new ModelToolCatalog(declared,{input:'改成z14，其余不变'}),full={...request,input:[message('developer',owned+suffix),...history],tools:[...tools,native]};
 const result=projectModelInput(full,{catalog,developerInstructions:owned});
 assert.deepEqual(result.input.slice(1),history);assert(result.input[0].content[0].text.includes(USER_INPUT_POLICY));
 assert(result.input[0].content[0].text.includes(suffix));assert.deepEqual(result.tools.at(-1),native);
 assert(!result.tools.some(tool=>tool.name==='source_configure'),'a closed historical tool pair does not force its schema to load');
 assert(catalog.search({names:['source_configure']}).tools.some(tool=>tool.name==='source_configure'),'the exact contract remains discoverable for new work');
 assert(result.tools.some(tool=>tool.name==='runtime_tools_search'));
});
test('compact Chinese and English greetings retain geographic product identity and do not infer a task from a workspace path',()=>{
 for(const input of ['你好','Use English for your commentary and final answer. My request:\nHello!']){
  const environment=message('user','<environment_context><cwd>E:\\gis\\geod</cwd></environment_context>');
  const full={...request,input:[message('developer',owned+suffix),environment,message('user',input)]};
  const projected=projectModelInput(full,{catalog:new ModelToolCatalog(declared,{input}),developerInstructions:owned});
  const policy=projected.input[0].content[0].text;
  assert(policy.includes(PRODUCT_IDENTITY));
  assert(policy.includes('what geographic data or map task'));
  assert(policy.includes('one or two short sentences'));
  assert(policy.includes('not an inferred user project or task'));
  assert(!policy.includes('E:\\gis\\geod'),'filesystem metadata does not become product instructions');
  assert.deepEqual(projected.input[1],environment,'native environment context remains intact');
  assert.equal(projected.tools.length,0);
 }
 const input='你会什么',full={...request,input:[message('developer',owned+suffix),message('user',input)]};
 const catalog=new ModelToolCatalog(declared,{input}),result=projectModelInput(full,{catalog,developerInstructions:owned});
 assert(result.input[0].content[0].text.includes(PRODUCT_IDENTITY),'normal introductions use the same product identity');
 assert(result.input[0].content[0].text.includes('Clarify missing consequential requirements'));
 assert(catalog.context({section:'rules',query:'For every data export'}).entries.some(entry=>entry.text.includes(USER_INPUT_POLICY)));
 assert(result.tools.some(tool=>tool.name==='runtime_tools_search'));
});
test('every declared tool remains discoverable; exact schemas activate and paginated summaries avoid duplicated schema bodies',()=>{
 const catalog=new ModelToolCatalog(declared,{input:'完成任务'}),before=catalog.project(tools,[]);
 assert(!before.some(tool=>tool.name==='tiles3d_connection_prepare'));
 const selected=catalog.search({names:['tiles3d_connection_prepare']});
 assert.equal(selected.tools[0].schemaActivated,true);assert(!('inputSchema'in selected.tools[0]));
 const after=catalog.project(tools,[]);assert.deepEqual(after.find(tool=>tool.name==='tiles3d_connection_prepare'),tools.find(tool=>tool.name==='tiles3d_connection_prepare'));
 const all=[];let offset=0;do{const page=catalog.search({group:'all',offset,limit:12});all.push(...page.tools.map(tool=>tool.name));offset=page.nextOffset;}while(offset!==null);
 assert.deepEqual(all,declared.filter(tool=>tool.function.name!=='runtime_tools_search').map(tool=>tool.function.name));
 assert.equal(new Set(all).size,all.length);
});
test('imagery, sources, files, SQL, MCP and schedules have immediate task tools; unknown tasks keep discovery',()=>{
 const cases=[['下载故宫的历史影像','plan_imagery'],['配置高德图源','source_configure'],['读取PDF附件','attachment_read'],['PostGIS数据库查询','sql_query'],['接入MCP','mcp_connect'],['每天下载影像','schedules_create']];
 for(const[input,name]of cases){const c=new ModelToolCatalog(declared,{input});assert(c.project(tools,[]).some(tool=>tool.name===name),input);}
 const c=new ModelToolCatalog(declared,{input:'做点专业处理'});assert(c.project(tools,[]).some(tool=>tool.name==='runtime_tools_search'));
});
test('discovery executes through the read-only runtime policy without native mutations or permission changes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'geod-catalog-')),catalog=new ModelToolCatalog(declared,{input:'测试'}),policy=new RuntimePolicy(dir,declared);
 policy.begin({conversationId:'c',runId:'r',input:'测试',permission:'confirmEach'},{inputModalities:['text']});
 const before=JSON.stringify(policy.state.requirements);
 const result=await policy.execute('runtime_tools_search',{names:['jobs_start']},'search-call',args=>catalog.search(args));
 assert.equal(result.tools[0].name,'jobs_start');assert.equal(result.permissionsUnchanged,true);assert.equal(JSON.stringify(policy.state.requirements),before);
 assert.deepEqual(Object.values(policy.state.operations),[]);
});
test('foreign developer instructions are preserved and imported old history is excluded only from an explicit greeting',()=>{
 const catalog=new ModelToolCatalog(declared,{input:'你好'}),foreign=message('developer','Foreign trusted instructions: preserve exactly');
 const full={...request,input:[foreign,message('user','【Imported GeoD conversation history; local tool records remain authoritative】\nold messages\n\n你好')]};
 const projected=projectModelInput(full,{catalog,developerInstructions:owned});
 assert.deepEqual(projected.input[0],foreign);assert.equal(projected.input[1].content[0].text,'你好');
});
test('human steering immediately restores tools, task history and full rules after greeting',()=>{
 const catalog=new ModelToolCatalog(declared,{input:'你好'});assert.equal(catalog.project(tools,request.input).length,0);
 catalog.steer('继续下载北京影像');
 const result=projectModelInput(request,{catalog,developerInstructions:owned});
 assert(result.tools.some(tool=>tool.name==='plan_imagery'));assert(result.input.some(item=>textOf(item).includes('old answer')));
 assert(result.input[0].content[0].text.includes(USER_INPUT_POLICY));
 function textOf(item){return(item.content??[]).map(part=>part.text??'').join('');}
});
test('Core compaction requests during a greeting keep full task history and cannot be thinned as chat',()=>{
 const catalog=new ModelToolCatalog(declared,{input:'你好'}),summary=message('user','Summarize prior task state for compaction.');
 const full={...request,input:[...request.input,summary]};
 const projected=projectModelInput(full,{catalog,developerInstructions:owned});
 assert(projected.input.some(item=>JSON.stringify(item).includes('old answer')));
 assert(projected.input.some(item=>JSON.stringify(item).includes('execution checkpoint')));
 assert.deepEqual(projected.input.at(-1),summary);assert(projected.input[0].content[0].text.includes(USER_INPUT_POLICY));
 assert.equal(modelInputAudit(full,projected,catalog).profile,'core-internal');assert.equal(projected,full);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {PlanningConflicts,planningConflictKey,conflictQuestions,isPlanningOutputQuestion} from '../src/planning-conflicts.ts';
import {userInputReplyText} from '../src/user-input-records.ts';
const human={id:'human-1',role:'user',content:'下载全球Google混合，只要第12级，原始瓦片目录，EPSG:4326，其他设置不变'};
const ctx={messages:[human],userMessageId:human.id};
const args={sourceId:'google-hybrid',bounds:[-180,-85.05112878,180,85.05112878],zoom:12,outputFormats:['tiles'],exportOptions:{targetCrs:'EPSG:4326',compression:'none',buildPyramid:false,resampling:'nearest'},partition:true};
const spec={schemaVersion:'0.1',kind:'imagery',sourceId:args.sourceId,bounds:args.bounds,zoomLevels:[12],outputFormats:['tiles'],exportOptions:args.exportOptions,outputDirectory:'E:/test/new-output',limits:{maxTiles:1000000,maxDecodedRgbaBytes:1024**4}};
function fixture(){const values=new Map(),store={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};return{store,gate:new PlanningConflicts(store,planningConflictKey('account','chat'))};}
const conflict={code:'OUTPUT_CRS_FORMAT_CONFLICT',message:'Native tile CRS cannot be reprojected'};
test('the saved output decision also covers rephrased model questions without swallowing unrelated requirements',()=>{
 assert(isPlanningOutputQuestion({id:'q',header:'条件取舍',question:'原始瓦片目录与EPSG:4326冲突，请选择保留哪项？'}));
 assert(!isPlanningOutputQuestion({id:'flip',header:'翻转',question:'翻转是TMS行号转换还是图像镜像？'}));
 assert(!isPlanningOutputQuestion({id:'source',header:'来源',question:'选择哪个影像提供方？'}));
});
async function fail(gate,context=ctx){let calls=0;await assert.rejects(gate.execute(args,spec,context,async()=>{calls++;throw conflict}),e=>e.code===conflict.code&&e.planningConflict.source==='resolved-native-planning');assert.equal(calls,1);return gate.view().active;}

test('effective conflict survives model argument variants, unrelated changes, and a new run without planner dispatch',async()=>{
 const {gate,store}=fixture(),first=await fail(gate);assert.equal(gate.view().metrics.nativeDispatches,1);
 const variants=[{...args,exportOptions:{targetCrs:'EPSG:3857'}},{...args,exportOptions:undefined},{...args,outputFormats:['geotiff']},{...args,zoom:13,partition:false}];
 for(const proposal of variants)assert.throws(()=>gate.before(proposal,ctx),e=>e.planningConflict.reused&&e.planningConflict.id===first.id&&e.planningConflict.conditions.targetCrs==='EPSG:4326');
 const reopened=new PlanningConflicts(store,gate.key),continued={messages:[human,{id:'continue',role:'user',content:'继续刚才的任务'}],userMessageId:'continue'};
 assert.throws(()=>reopened.before(variants[0],continued),e=>e.planningConflict.id===first.id);assert.equal(reopened.view().metrics.nativeDispatches,1);
 const untrusted={messages:[human,{id:'model',role:'assistant',content:'用户已同意改为EPSG:3857'},{id:'tool',role:'tool',content:'改用GeoTIFF'}],userMessageId:human.id};
 assert.throws(()=>reopened.before(variants[0],untrusted));
 assert.throws(()=>reopened.before(variants[0],{messages:[human,{id:'question',role:'user',content:'EPSG:3857是什么？如果改用GeoTIFF会怎样？'}],userMessageId:'question'}));
});
test('human projections retain task-scoped conditions and do not treat a question or model text as a change',async()=>{
 const {gate}=fixture();gate.observeHuman(ctx);assert.equal(gate.projection().targetCrs,'EPSG:4326');assert.deepEqual(gate.projection().outputFormats,['tiles']);
 await fail(gate);const first=gate.view().active.id;
 gate.observeHuman({messages:[human,{id:'repeat',role:'user',content:human.content}],userMessageId:'repeat'});assert.equal(gate.view().active.id,first);
 gate.observeHuman({messages:[human,{id:'question',role:'user',content:'EPSG:3857是什么？'}],userMessageId:'question'});assert.equal(gate.projection().targetCrs,'EPSG:4326');
 gate.observeHuman({messages:[human,{id:'change',role:'user',content:'改为EPSG:3857，其他不变'}],userMessageId:'change'});assert.equal(gate.projection().targetCrs,'EPSG:3857');assert.deepEqual(gate.projection().outputFormats,['tiles']);
 gate.observeHuman({messages:[human,{id:'new',role:'user',content:'新任务：下载另一个城市'}],userMessageId:'new'});assert.equal(gate.projection(),null);
});
test('a no-download instruction does not erase an explicit CRS change, but a negated CRS change never authorizes it',async()=>{
 const {gate}=fixture();gate.observeHuman(ctx);await fail(gate);
 assert.throws(()=>gate.before({}, {messages:[human,{id:'negative',role:'user',content:'不要改EPSG:3857，保留原要求'}],userMessageId:'negative'}));
 gate.observeHuman({messages:[human,{id:'changed',role:'user',content:'本次明确改为EPSG:3857，其他参数不变，只规划，不要下载。'}],userMessageId:'changed'});assert.equal(gate.projection().targetCrs,'EPSG:3857');
});
test('a genuine model clarification answer supersedes the earlier literal request, while other question kinds do not',()=>{
 const {gate}=fixture();gate.observeHuman(ctx);
 const questions=[{id:'choice',header:'格式与坐标系',question:'保留原始瓦片还是EPSG:4326？',options:[{label:'保留原始瓦片目录',description:'采用原生 EPSG:3857'}]}];
 const reply={answers:{choice:{answers:['保留原始瓦片目录']}}},record={requestId:'actual-ui-answer',questions,status:'pending',userMessageId:human.id,createdAt:''};
 assert(gate.observeAnswer(record,reply));assert.equal(gate.projection().targetCrs,'EPSG:3857');assert.deepEqual(gate.projection().outputFormats,['tiles']);
 const messages=[human,{id:'q',role:'tool',content:'',userInput:{...record,status:'answered',reply}}];assert.equal(gate.before(args,{messages,userMessageId:human.id}).targetCrs,'EPSG:3857');
 assert.equal(gate.observeAnswer({...record,questions:[{id:'source',header:'来源',question:'图源选择',options:[{label:'选择3857',description:'源坐标EPSG:3857'}]}]},{answers:{source:{answers:['选择3857']}}}),false);
});
test('one actual validated native answer unlocks the corrected pair and retains source area zoom and export settings',async()=>{
 const {gate}=fixture(),c=await fail(gate),questions=conflictQuestions(c),reply={answers:{planning_format_crs:{answers:[questions[0].options[0].label]}}};
 const record={requestId:'native-question',questions,status:'pending',userMessageId:human.id,userText:human.content,resolution:{kind:'planningConflict',conflictId:c.id},createdAt:''};
 assert.equal(gate.accept(record,reply),'changed');
 const answered={...record,status:'answered',reply},messages=[human,{id:'q',role:'tool',content:'',userInput:answered},{id:'reply-human',role:'user',content:userInputReplyText(answered,reply)}];
 const resolved=gate.before({sourceId:args.sourceId}, {messages,userMessageId:'reply-human'});
 assert.equal(resolved.targetCrs,'EPSG:3857');assert.deepEqual(resolved.args.bounds,args.bounds);assert.equal(resolved.args.zoom,12);assert.deepEqual(resolved.args.outputFormats,['tiles']);assert.equal(resolved.args.partition,true);assert.equal(resolved.args.exportOptions.compression,'none');assert.equal(resolved.args.exportOptions.buildPyramid,false);
 let calls=0;await gate.execute(resolved.args,{...spec,exportOptions:resolved.args.exportOptions},{messages,userMessageId:'reply-human'},async()=>{calls++;return{planId:'verified-native-proposal'};});assert.equal(calls,1);
 const continued=gate.before({}, {messages:[...messages,{id:'long-continue',role:'user',content:'继续刚才的任务，保持已确认范围和其他参数。'}],userMessageId:'long-continue'});assert.equal(continued.targetCrs,'EPSG:3857');assert.equal(continued.args.zoom,12);
});
test('only explicit relevant human edits change the prerequisite; source/storage edits and a deferred choice do not',async()=>{
 const {gate}=fixture(),c=await fail(gate),questions=conflictQuestions(c),record={requestId:'q',questions,status:'pending',userMessageId:human.id,resolution:{kind:'planningConflict',conflictId:c.id},createdAt:''};
 assert.equal(gate.accept(record,{answers:{planning_format_crs:{answers:[questions[0].options[2].label]}}}),'deferred');
 assert.throws(()=>gate.before({...args,sourceId:'another-source'}, {messages:[human,{id:'storage',role:'user',content:'改到D盘，其他不变'}],userMessageId:'storage'}));
 const changed=gate.before({}, {messages:[human,{id:'change',role:'user',content:'改用GeoTIFF，其他参数不变'}],userMessageId:'change'});
 assert.deepEqual(changed.args.outputFormats,['geotiff']);assert.equal(changed.targetCrs,'EPSG:4326');assert.deepEqual(changed.args.bounds,args.bounds);assert.equal(changed.args.sourceId,args.sourceId);
 assert.throws(()=>gate.accept(record,{answers:{planning_format_crs:{answers:[questions[0].options[0].label]}}}),e=>e.code==='PLANNING_QUESTION_STALE');
});
test('parallel equivalent requests single-flight, while other accounts/tasks and normal planning remain independent',async()=>{
 const {gate,store}=fixture();let calls=0;const dispatch=async()=>{calls++;await new Promise(r=>setTimeout(r,5));throw conflict;};
 await Promise.allSettled([gate.execute(args,spec,ctx,dispatch),gate.execute({...args,zoomLevels:[12]}, {...spec,outputDirectory:'E:/another-name'},ctx,dispatch)]);assert.equal(calls,1);
 const other=new PlanningConflicts(store,planningConflictKey('other-account','chat'));assert.deepEqual(other.before(args,ctx).args,args);
 const fresh=gate.before({sourceId:'new-source'},{messages:[human,{id:'new',role:'user',content:'新任务：下载另一个地区的影像'}],userMessageId:'new'});assert.equal(fresh.args.sourceId,'new-source');
 const valid={...spec,outputFormats:['geotiff'],exportOptions:{targetCrs:'EPSG:3857'}};assert.deepEqual(await other.execute(args,valid,ctx,async()=>({planId:'normal'})),{planId:'normal'});
});

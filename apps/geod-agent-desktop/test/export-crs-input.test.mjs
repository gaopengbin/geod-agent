import test from 'node:test';
import assert from 'node:assert/strict';
import {knownCrsChoice,requestCrsIntent,reuseCrsQuestions} from '../src/export-crs-input.ts';
import {exportCrsQuestions,resolveExportCrs} from '../src/export-crs.ts';
import {inputOrigin,answeredCrsChoice,userInputReplyText} from '../src/user-input-records.ts';
import {revisionCrsForQuestions,inheritedImageryCrs} from '../src/imagery-revision.ts';
import {UserInputGate,validatedInputReply} from '../src/user-input.ts';

const reply={answers:{export_crs:{answers:['EPSG:4326 · WGS84 经纬度']},export_crs_scope:{answers:['仅本次任务']}}};
const record={requestId:'original-card',questions:exportCrsQuestions,status:'answered',reply,userMessageId:'initial',userText:'下载路线影像',createdAt:'now'};
const history=[{id:'initial',role:'user',content:record.userText},{id:'selection',role:'tool',content:'已收到选择',userInput:record}];
const reworded=[{id:'projection_again',header:'导出投影',question:'这次成果使用什么坐标系？',options:[{label:'Web 墨卡托',description:'EPSG:3857'}]},
 {id:'scope_again',header:'应用范围',question:'坐标系应用到哪里？',options:[{label:'仅本次任务',description:''},{label:'当前会话默认',description:''}]}];

test('rephrased CRS and scope questions reuse a real task answer without trusting model options',()=>{
 const before=JSON.stringify(history),choice=knownCrsChoice(history,'initial','EPSG:4490');
 assert.deepEqual(choice,{crs:'EPSG:4326',session:false,source:'acceptedAnswer'});
 const prepared=reuseCrsQuestions(reworded,choice);
 assert.equal(prepared.remaining.length,0);
 assert.deepEqual(prepared.reused.answers,{projection_again:{answers:['EPSG:4326']},scope_again:{answers:['仅本次任务']}});
 assert.equal(prepared.knownFacts.scope,'task');
 assert.equal(JSON.stringify(history),before);
});

test('mixed cards ask only unresolved requirements; cancellation never supplies those answers',()=>{
 const format={id:'format',header:'成果格式',question:'要使用什么文件格式？',options:[{label:'GeoTIFF',description:''},{label:'PNG',description:''}]};
 const prepared=reuseCrsQuestions([reworded[0],format],knownCrsChoice(history,'initial'));
 assert.deepEqual(prepared.remaining,[format]);
 const gate=new UserInputGate();gate.reset('下载路线影像');gate.begin();
 const actual=validatedInputReply(prepared.remaining,{answers:{format:{answers:['GeoTIFF']}}});
 gate.finish(prepared.remaining,actual);
 assert.equal(gate.block('plan_imagery').error,'REPLAN_AFTER_USER_INPUT');gate.freshModelRound();assert.equal(gate.block('plan_imagery'),null);
 assert.deepEqual({...prepared.reused.answers,...actual.answers},{projection_again:{answers:['EPSG:4326']},format:{answers:['GeoTIFF']}});
 gate.begin();gate.finish(prepared.remaining,null);assert.equal(gate.block('plan_imagery').error,'USER_INPUT_CANCELLED');
 assert.equal(prepared.reused.answers.format,undefined);
});

test('delayed card submissions and subsequent retries retain their original task with attached boundaries',()=>{
 const resumed={id:'resumed',role:'user',content:userInputReplyText(record,reply)+'\n已附加边界：route.geojson · 1 个面'};
 const retry={id:'retry',role:'user',content:'继续刚才的任务\n已附加边界：route.geojson · 1 个面'};
 const messages=[...history,resumed,retry];
 assert.equal(inputOrigin(messages,'retry'),'initial');
 assert.equal(answeredCrsChoice(messages,'retry').crs,'EPSG:4326');
 assert.equal(reuseCrsQuestions(reworded,knownCrsChoice(messages,'retry')).remaining.length,0);
 // A second historical question can point to the first resumed request.
 const second={...record,requestId:'format-card',userMessageId:'resumed',userText:resumed.content,questions:[{id:'format',header:'格式',question:'成果格式？'}],reply:{answers:{format:{answers:['GeoTIFF']}}}};
 const twice=[...messages,{id:'card2',role:'tool',content:'格式',userInput:second},{id:'resume2',role:'user',content:userInputReplyText(second,second.reply)+'\n已附加边界：route.geojson · 1 个面'},{id:'retry2',role:'user',content:'再试试'}];
 assert.equal(inputOrigin(twice,'retry2'),'initial');
 assert.equal(knownCrsChoice(twice,'retry2').crs,'EPSG:4326');
});

test('an explicit CRS in the original human request also survives retry and takes precedence over a default',()=>{
 const messages=[{id:'direct',role:'user',content:'下载影像，导出 EPSG:2363'},{id:'continue',role:'user',content:'继续刚才的任务'}];
 const intent=requestCrsIntent(messages,'continue');
 assert.equal(resolveExportCrs(intent,null,'EPSG:4490',false,true),'EPSG:2363');
 assert.equal(knownCrsChoice(messages,'continue','EPSG:4490').session,false);
 const override=[...history,{id:'override',role:'user',content:'这次改用 EPSG:3857'}];
 assert.equal(knownCrsChoice(override,'override','EPSG:4490').crs,'EPSG:3857');
});

test('a new independent task asks again; a conversation default resolves it only when no ambiguous change is requested',()=>{
 const next=[...history,{id:'new',role:'user',content:'下载天津影像'}];
 assert.equal(knownCrsChoice(next,'new'),null);
 assert.equal(reuseCrsQuestions(reworded,knownCrsChoice(next,'new')).remaining.length,2);
 assert.deepEqual(knownCrsChoice(next,'new','EPSG:4490'),{crs:'EPSG:4490',session:true,source:'conversationDefault'});
 for(const content of ['改用高斯投影','取消默认坐标系，每次问我']){
  const changed=[...history,{id:'changed',role:'user',content}];
  assert.equal(knownCrsChoice(changed,'changed','EPSG:4490'),null);
 }
});

test('pending/cancelled cards and assistant claims never establish a CRS',()=>{
 for(const status of ['pending','cancelled'])assert.equal(knownCrsChoice([{...history[0]},{...history[1],userInput:{...record,status,reply:undefined}}],'initial'),null);
 assert.equal(knownCrsChoice([history[0],{id:'claim',role:'assistant',content:'已确认 EPSG:4326，其余参数不变'}],'initial'),null);
});

test('source CRS, resampling and plan replacement questions remain open',()=>{
 const questions=[{id:'source_crs',header:'源坐标系',question:'输入数据的坐标系是什么？'},
 {id:'method',header:'重采样',question:'坐标转换采用哪种重采样方法？'},
 {id:'apply_mode',header:'应用方式',question:'坐标系不同的两个计划要替换还是都保留？',options:[{label:'替换',description:''},{label:'两版都保留',description:''}]},
 {id:'key',header:'坐标系',question:'输入密码',isSecret:true}];
 assert.deepEqual(reuseCrsQuestions(questions,knownCrsChoice(history,'initial')).remaining,questions);
});

test('a bundled provider, resolution or format choice is not answered by a known CRS alone',()=>{
 const questions=[{id:'settings',header:'影像源 · 分辨率 · 坐标系',question:'影像下载要使用哪组参数？',options:[{label:'Esri · Z16 · EPSG:4326',description:''}]},
 {id:'output',header:'成果格式',question:'使用 GeoJSON 还是其他格式和坐标系？'}];
 assert.deepEqual(reuseCrsQuestions(questions,knownCrsChoice(history,'initial')).remaining,questions);
});

test('the latest genuine CRS answer on a resumed request wins on the next retry',()=>{
 const resumed={id:'resumed',role:'user',content:userInputReplyText(record,reply)};
 const correction={...record,requestId:'corrected-card',userMessageId:'resumed',userText:resumed.content,reply:{answers:{export_crs:{answers:['EPSG:3857 · Web 墨卡托']},export_crs_scope:{answers:['仅本次任务']}}}};
 const messages=[...history,resumed,{id:'corrected',role:'tool',content:'已收到选择',userInput:correction},{id:'retry',role:'user',content:'继续刚才的任务'}];
 assert.equal(answeredCrsChoice(messages,'retry').crs,'EPSG:3857');
 assert.equal(knownCrsChoice(messages,'retry').crs,'EPSG:3857');
});

test('zoom-only model questions and plan execution share the owned native plan CRS after a failed attempt',async()=>{
 const args={sourceId:'esri',boundaryId:'route',zoom:18,outputFormats:['geotiff'],exportOptions:{targetCrs:'EPSG:4326'}};
 const stored={planId:'owned',plan:{spec:{kind:'imagery',sourceId:'esri',bounds:[1,2,3,4],boundary:{polygons:[]},zoomLevels:[18],outputFormats:['geotiff'],exportOptions:{targetCrs:'EPSG:4326',resampling:'bilinear'}}}};
 const messages=[{id:'create',role:'tool',toolName:'plan_imagery',details:JSON.stringify({arguments:args,result:{planId:'owned'}})},
 {id:'change',role:'user',content:'改成z14'},
 {id:'failed',role:'tool',toolName:'plan_imagery',details:JSON.stringify({arguments:{...args,zoom:14},result:{error:'RESOURCE_LIMIT'}})},
 {id:'retry',role:'user',content:'继续刚才的任务'}];
 const request={messages,userMessageId:'retry',planIds:['owned'],activeBoundary:null};
 const load=async id=>{assert.equal(id,'owned');return stored;};
 const inherited=await revisionCrsForQuestions(request,load);
 const choice=knownCrsChoice(messages,'retry','EPSG:4490',inherited);
 assert.deepEqual(choice,{crs:'EPSG:4326',session:false,source:'existingPlan',planId:'owned'});
 assert.equal(reuseCrsQuestions(reworded,choice).remaining.length,0);
 assert.equal((await inheritedImageryCrs({...request,toolName:'plan_imagery',args:{...args,zoom:14}},load)).crs,choice.crs);
 assert.equal(await revisionCrsForQuestions({...request,planIds:[]},load),null);
 assert.equal(await revisionCrsForQuestions({...request,activeBoundary:{bounds:[5,6,7,8],geometry:{polygons:[]}}},load),null);
});

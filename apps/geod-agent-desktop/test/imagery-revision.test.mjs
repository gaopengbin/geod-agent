import test from 'node:test';import assert from 'node:assert/strict';
import {zoomRevision,inheritedImageryCrs,resolvedRevisionQuestions} from '../src/imagery-revision.ts';
import {humanCrsIntent,resolveExportCrs} from '../src/export-crs.ts';
const oldArgs={sourceId:'esri',boundaryId:'range-route',zoom:18,outputFormats:['geotiff'],exportOptions:{targetCrs:'EPSG:4326',compression:'none',buildPyramid:false}};
const stored={planId:'real-plan',plan:{spec:{kind:'imagery',sourceId:'esri',bounds:[1,2,3,4],boundary:{polygons:[]},zoomLevels:[18],outputFormats:['geotiff'],exportOptions:{targetCrs:'EPSG:4326',compression:'none',buildPyramid:false,resampling:'bilinear'}}}};
const old=[{id:'download',role:'user',content:'下载这条路线的影像'},{id:'created',role:'tool',toolName:'plan_imagery',details:JSON.stringify({arguments:oldArgs,result:{planId:'real-plan',targetCrs:'EPSG:4326'}}),content:'计划已创建'},{id:'change',role:'user',content:'改成z14\n已附加边界：route.geojson · 1 个面'}];
const request=(extra={})=>({messages:old,userMessageId:'change',toolName:'plan_imagery',args:{...oldArgs,zoom:14},planIds:['real-plan'],activeBoundary:null,...extra});

test('only unambiguous single zoom revisions inherit task parameters',()=>{
 for(const text of ['改成z14','请改为 Z14','只把层级改成14，其余参数不变','change zoom to 14'])assert.equal(zoomRevision(text),14,text);
 for(const text of ['改成14','分辨率改成14','下载天津影像 z14','“改成z14” 是举例','改成z14，改用 UTM','改成z14，坐标系再问我','改成z99'])assert.equal(zoomRevision(text),null,text);
});
test('zoom-only plan change uses the native owned plan CRS and resampling without making a session default',async()=>{
 const choice=await inheritedImageryCrs(request(),async id=>{assert.equal(id,'real-plan');return stored;});
 assert.deepEqual(choice,{crs:'EPSG:4326',resampling:'bilinear',planId:'real-plan'});
 assert.equal(resolveExportCrs(humanCrsIntent('改成z14'),choice.crs,'EPSG:4490',false,true),'EPSG:4326');
 const continued=[...old,{id:'retry',role:'user',content:'继续刚才的任务'}];
 assert.deepEqual(await inheritedImageryCrs(request({messages:continued,userMessageId:'retry'}),async()=>stored),choice);
});
test('assistant prose, model targetCrs and unrelated, missing or unowned plans cannot satisfy the requirement',async()=>{
 for(const extra of [{planIds:[]},{toolName:'data_download_plan'},{args:{...oldArgs,zoom:14,sourceId:'other'}},{args:{...oldArgs,zoom:14,boundaryId:'another-range'}},{args:{...oldArgs,zoom:14,outputFormats:['png']}},{args:{...oldArgs,zoom:15}}])assert.equal(await inheritedImageryCrs(request(extra),async()=>stored),null);
 assert.equal(await inheritedImageryCrs(request(),async()=>null),null);
 const claimed=[{id:'claim',role:'assistant',content:'其余参数不变，EPSG:4326'},{id:'change',role:'user',content:'改成z14'}];
 assert.equal(await inheritedImageryCrs(request({messages:claimed}),async()=>stored),null);
 const newTask=[...old.slice(0,2),{id:'change',role:'user',content:'下载另一座城市的影像'}];
 assert.equal(await inheritedImageryCrs(request({messages:newTask}),async()=>stored),null);
 const ambiguous=[...old.slice(0,2),{id:'change',role:'user',content:'改成z14，坐标系用高斯投影'}];
 assert.equal(await inheritedImageryCrs(request({messages:ambiguous}),async()=>stored),null);
});
test('obsolete application-generated questions become provenance records, never forged human answers',async()=>{
 const tool={id:'new-call',role:'tool',toolName:'plan_imagery',content:'规划中',details:JSON.stringify({...oldArgs,zoom:14})};
 const q={id:'q',role:'tool',content:'补充需求',userInput:{requestId:'crs-generated',status:'pending',userMessageId:'change',toolCallId:'new-call',questions:[{id:'export_crs',header:'成果坐标系',question:'坐标系？'},{id:'export_crs_scope',header:'应用范围',question:'范围？'}],createdAt:'now'}};
 const history=[...old,tool,q],original=JSON.stringify(history),result=await resolvedRevisionQuestions(history,['real-plan'],null,async()=>stored);
 assert.equal(JSON.stringify(history),original);assert.equal(result.at(-1).userInput.status,'resolved');assert.equal(result.at(-1).userInput.reply,undefined);
 assert.deepEqual(result.at(-1).userInput.resolution,{kind:'existingPlanCrs',crs:'EPSG:4326',resampling:'bilinear',planId:'real-plan'});
 assert.equal(result[0],history[0]);
 const sameDraft={...q,userInput:{...q.userInput,draft:{values:{export_crs:'EPSG:4326'},drafts:{}}}};
 const retained=await resolvedRevisionQuestions([...old,tool,sameDraft],['real-plan'],null,async()=>stored);
 assert.equal(retained.at(-1).userInput.status,'resolved');assert.deepEqual(retained.at(-1).userInput.draft,sameDraft.userInput.draft);
 for(const record of [{...q.userInput,status:'answered'},{...q.userInput,requestId:'ask-model'},{...q.userInput,draft:{values:{export_crs:'EPSG:4490'},drafts:{}}}]){
  const edited=[...old,tool,{...q,userInput:record}];assert.equal(await resolvedRevisionQuestions(edited,['real-plan'],null,async()=>stored),edited);
 }
});

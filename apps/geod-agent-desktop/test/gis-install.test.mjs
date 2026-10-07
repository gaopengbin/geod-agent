import test from 'node:test';
import assert from 'node:assert/strict';
import {GisDependencyGate,gisRequirement,missingGisDependency} from '../src/gis-dependencies.ts';
import {GisInstallFlow} from '../src/gis-install-flow.ts';
import {UserInputGate} from '../src/user-input.ts';
const offer={id:'gis-raster-convert',name:'栅格转换',description:'',ready:false,enabled:false,downloadBytes:41820004,installedBytes:135072207,components:[]};
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};};
function fixture(install=async()=>{}) {
  let request,listener;const installed=[],cancelled=[];let releases=0;
  const flow=new GisInstallFlow({install,cancel:async id=>cancelled.push(id),subscribe:async fn=>{listener=fn;return()=>releases++;},change:value=>request=value,installed:value=>installed.push(value.id),failure:()=>assert.fail('unexpected cancel failure'),errorMessage:e=>e.message});
  return {flow,installed,cancelled,get request(){return request;},get releases(){return releases;},progress:value=>listener(value)};
}
test('dependency selection installs only the components needed by the operation',()=>{
  assert.equal(gisRequirement('plan_imagery',{exportOptions:{targetCrs:'EPSG:3857'}}),null);
  assert.equal(gisRequirement('plan_imagery_batch',{exportOptions:{targetCrs:'EPSG:4490'}}).id,'gis-raster-convert');
  assert.equal(gisRequirement('data_download_plan',{kind:'online',targetCrs:'EPSG:4326'}).id,'gis-vector-convert');
  assert.equal(gisRequirement('data_download_plan',{kind:'mvt',targetCrs:'EPSG:4326'}),null);
  assert.equal(gisRequirement('data_download_plan',{kind:'tiles3d'},true),null);
  assert.equal(gisRequirement('data_input_read',{},true).id,'gis-import');
  assert(missingGisDependency({error:{code:'GIS_COMPONENT_INVALID'}}));
  assert(missingGisDependency({errors:[{error:JSON.stringify({code:'GIS_SKILL_NOT_INSTALLED'})}]}));
  assert(!missingGisDependency({error:{code:'INPUT_AUTH_REQUIRED'}}));
});
test('the original operation waits for successful installation and preserves its arguments',async()=>{
  const native=deferred(),f=fixture(()=>native.promise),gate=new GisDependencyGate();
  const args={bounds:[116.37,39.97,116.42,40.01],sourceId:'esri',zoom:18,exportOptions:{targetCrs:'EPSG:4490',compression:'none'}},snapshot=structuredClone(args);
  let executions=0;
  const operation=gate.ensure(async()=>offer,value=>f.flow.ask(value,'按已选坐标系导出影像')).then(result=>{if(result==='ready')executions++;return result;});
  await Promise.resolve();assert.equal(executions,0);assert(f.request);
  const running=f.flow.install();await Promise.resolve();assert(f.request.busy);assert.equal(executions,0);
  f.progress({requestId:'other',featureId:offer.id,phase:'downloading',bytes:99,total:100});assert.equal(f.request.progress,undefined);
  f.progress({requestId:f.request.requestId,featureId:offer.id,phase:'downloading',bytes:10,total:100});assert.equal(f.request.progress.bytes,10);
  native.resolve();await running;assert.equal(await operation,'ready');assert.equal(executions,1);assert.deepEqual(args,snapshot);assert.equal(f.releases,1);assert.deepEqual(f.installed,[offer.id]);
});
test('installation failure keeps the prompt open and can retry without a new chat message',async()=>{
  let attempts=0;const f=fixture(async()=>{if(!attempts++)throw new Error('network unavailable');});const answer=f.flow.ask(offer,'reason');
  await f.flow.install();assert.equal(f.request.busy,false);assert.equal(f.request.error,'network unavailable');
  await f.flow.install();assert.equal(await answer,true);assert.equal(attempts,2);assert.equal(f.request,null);
});
test('cancellation stops continuation and ignores late native success',async()=>{
  const native=deferred(),f=fixture(()=>native.promise),answer=f.flow.ask(offer,'reason');
  const id=f.request.requestId,running=f.flow.install();await Promise.resolve();f.flow.cancel();assert.equal(await answer,false);
  native.resolve();await running;assert.deepEqual(f.cancelled,[id]);assert.deepEqual(f.installed,[]);assert.equal(f.request,null);
});
test('stop during listener registration never starts a native download',async()=>{
  const subscription=deferred();let calls=0,released=false;
  const flow=new GisInstallFlow({install:async()=>calls++,cancel:async()=>{},subscribe:()=>subscription.promise,change:()=>{},installed:()=>assert.fail('cancelled'),failure:()=>{},errorMessage:String});
  const answer=flow.ask(offer,'reason'),running=flow.install();flow.cancel();subscription.resolve(()=>released=true);await running;
  assert.equal(await answer,false);assert.equal(calls,0);assert(released);
});
test('parallel calls share one dependency prompt and verified cached components skip installation',async()=>{
  const gate=new GisDependencyGate(),confirmation=deferred();let prompts=0;
  const first=gate.ensure(async()=>offer,()=>{prompts++;return confirmation.promise;});
  assert.equal(await gate.ensure(async()=>offer,()=>assert.fail('duplicate')),'pending');confirmation.resolve(false);assert.equal(await first,'cancelled');assert.equal(prompts,1);
  assert.equal(await gate.ensure(async()=>({...offer,ready:true}),()=>assert.fail('cached')),'ready');
});
test('installation confirmation still blocks stale sibling tool calls',()=>{
  const gate=new UserInputGate();gate.reset('下载鸟巢影像 EPSG:4490');gate.begin();assert.equal(gate.block('plan_imagery').error,'USER_INPUT_PENDING');
  gate.finishDependency(true);assert.equal(gate.block('jobs_start').error,'REPLAN_AFTER_USER_INPUT');gate.freshModelRound();assert.equal(gate.block('jobs_start'),null);
  gate.begin();gate.finishDependency(false);gate.freshModelRound();assert.equal(gate.block('plan_imagery').error,'USER_INPUT_CANCELLED');
});

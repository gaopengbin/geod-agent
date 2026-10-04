import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlanTitle, inferPlanPresentations, planCardAnchors, readPlanPresentations, savePlanPresentations } from '../src/plan-presentation.ts';

const user = id => ({id,role:'user',content:id});
const answer = id => ({id,role:'assistant',phase:'final',content:id});
const tool = (id,name,result,turnId) => ({id,role:'tool',toolName:name,toolStatus:'success',content:id,turnId,details:JSON.stringify({arguments:{},result})});
const plan = (id,bounds) => ({planId:id,plan:{sourceName:'Esri World Imagery',spec:{bounds}}});
const boundary = (id,name,bounds) => tool(id,'mcp_call',{toolName:'lookup_boundary',result:{found:true,name,bounds,attachedToDesktopPlan:true}});
const metadata = (id,u,t) => ({planId:id,title:`${id}影像`,userMessageId:u,toolMessageId:t});
const store = () => {const data=new Map();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)};};

test('administrative and data names become clean default titles; sources remain a fallback',()=>{
  assert.equal(defaultPlanTitle('河南省-AreaCity-20260403.geojson','Esri'),'河南省影像');
  assert.equal(defaultPlanTitle('C:\\data\\驻马店市-AreaCity-20260403.geojson','Esri'),'驻马店市影像');
  assert.equal(defaultPlanTitle('工业园区范围.gpkg','Esri'),'工业园区范围影像');
  assert.equal(defaultPlanTitle('成都影像.tif','Esri'),'成都影像');
  assert.equal(defaultPlanTitle(null,'Sentinel-2'),'Sentinel-2');
});
test('cards stay after their own answer when another user message and new work arrive',()=>{
  const messages=[user('u1'),tool('t1','plan_imagery',{}),answer('a1'),user('u2')];
  const records={p1:metadata('p1','u1','t1')};
  assert.deepEqual(planCardAnchors(messages,records),{a1:['p1']});
  messages.push(tool('t2','plan_imagery',{}),answer('a2'),user('u3'));
  records.p2=metadata('p2','u2','t2');
  assert.deepEqual(planCardAnchors(messages,records),{a1:['p1'],a2:['p2']});
  messages.push({id:'work',role:'assistant',phase:'progress',content:'处理新请求'});
  assert.deepEqual(planCardAnchors(messages,records),{a1:['p1'],a2:['p2']});
});
test('multiple plans belong to one answer; active cards remain within the originating turn',()=>{
  const messages=[user('u'),tool('t1','plan_imagery',{},'run'),tool('t2','plan_imagery',{},'run')];
  const records={p1:metadata('p1','u','t1'),p2:metadata('p2','u','t2')};
  assert.deepEqual(planCardAnchors(messages,records),{run:['p1','p2']});
  messages.push(answer('a'),user('next'));
  assert.deepEqual(planCardAnchors(messages,records),{a:['p1','p2']});
});
test('steering in the same Codex run cannot place a second card before its user message',()=>{
  const messages=[user('u1'),tool('t1','plan_imagery',{},'run'),user('u2'),tool('t2','plan_imagery',{},'run')];
  const records={p2:metadata('p2','u2','t2')};
  assert.deepEqual(planCardAnchors(messages,records),{});
  messages.push(answer('a2'));
  assert.deepEqual(planCardAnchors(messages,records),{a2:['p2']});
});
test('historical titles use matching boundaries and successful plan ids, ignoring later requests and failures',()=>{
  const henan=[110,31,116,36], city=[113,32,115,34];
  const messages=[user('u1'),boundary('b1','河南省',henan),tool('t1','plan_imagery',{planId:'p1'}),answer('a1'),user('u2'),boundary('b2','驻马店市',city),tool('t2','plan_imagery',{planId:'p2'}),answer('a2'),user('u3'),boundary('b3','新地区',[0,0,1,1])];
  messages.push({...tool('fail','plan_imagery',{planId:'p3'}),toolStatus:'attention'});
  const inferred=inferPlanPresentations(messages,[plan('p1',henan),plan('p2',city),plan('p3',city)]);
  assert.deepEqual(inferred.map(item=>[item.planId,item.title,item.userMessageId]),[['p1','河南省影像','u1'],['p2','驻马店市影像','u2']]);
  assert.deepEqual(planCardAnchors(messages,Object.fromEntries(inferred.map(item=>[item.planId,item]))),{a1:['p1'],a2:['p2']});
});
test('legacy result recovery requires intact tool history and excludes plans_get results',()=>{
  const bounds=[110,31,116,36], rows=[user('u'),{id:'t',role:'tool',toolName:'plan_imagery',toolStatus:'success',content:'计算影像计划'},answer('a')];
  const raw=[{role:'assistant',content:null,tool_calls:[{id:'c1',function:{name:'plan_imagery',arguments:'{}'}},{id:'c2',function:{name:'plans_get',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'c1',content:JSON.stringify({planId:'p',totalTiles:10})},
    {role:'tool',tool_call_id:'c2',content:JSON.stringify({planId:'p',totalTiles:10})}];
  assert.equal(inferPlanPresentations(rows,[plan('p',bounds)],raw)[0].userMessageId,'u');
  assert.deepEqual(inferPlanPresentations([...rows,{...rows[1],id:'extra'}],[plan('p',bounds)],raw),[]);
  assert.deepEqual(planCardAnchors(rows,{missing:{planId:'missing',title:'未知'}}),{});
});
test('ownership and names persist, are scoped, and cannot be overwritten by execution replay',()=>{
  const local=store(), original=metadata('p','u1','t1');
  savePlanPresentations(local,'alice','chat',[original]);
  savePlanPresentations(local,'alice','chat',[{...original,title:'错误的新名称',userMessageId:'u2',toolMessageId:'t2',answerMessageId:'wrong-answer'}]);
  assert.deepEqual(readPlanPresentations(local,'alice','chat'),{p:original});
  assert.deepEqual(readPlanPresentations(local,'bob','chat'),{});
  assert.deepEqual(readPlanPresentations(local,'alice','other'),{});
});
test('the first final answer remains the permanent anchor after subsequent recovery messages',()=>{
  const local=store(), original=metadata('p','u','t');
  savePlanPresentations(local,'alice','chat',[original]);
  savePlanPresentations(local,'alice','chat',[{...original,answerMessageId:'a'}]);
  savePlanPresentations(local,'alice','chat',[{...original,answerMessageId:'later'}]);
  const records=readPlanPresentations(local,'alice','chat');
  const messages=[user('u'),tool('t','plan_imagery',{}),answer('a'),answer('later'),user('new')];
  assert.deepEqual(planCardAnchors(messages,records),{a:['p']});
  assert.deepEqual(planCardAnchors(messages.filter(item=>item.id!=='a'),records),{});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationSessions,conversationSessionSeed} from '../src/conversation-sessions.ts';
test('two asynchronous turns retain messages, tool state, request resolvers and stop handles by conversation',async()=>{
  const store=new ConversationSessions(),a=store.get('account','a'),b=store.get('account','b');
  for(const slot of [a,b]){slot.get('display',[]);slot.get('busy',false);slot.set('busy',true);}
  const runA=a.ref('run','run-a'),runB=b.ref('run','run-b'),requestsA=a.ref('requests',new Map()),requestsB=b.ref('requests',new Map());
  const answerA=()=>a.set('display',items=>[...items,{content:'A'}]);
  const answerB=()=>b.set('display',items=>[...items,{content:'B'}]);
  await Promise.all([Promise.resolve().then(answerB),Promise.resolve().then(answerA)]);
  requestsA.current.set('question',()=>{});runA.current=null;a.set('busy',false);
  assert.deepEqual(a.snapshot().display,[{content:'A'}]);assert.deepEqual(b.snapshot().display,[{content:'B'}]);
  assert.equal(requestsB.current.size,0);assert.equal(runB.current,'run-b');assert.deepEqual(store.running('account').map(slot=>slot.conversationId),['b']);
});
test('account identity, dirty persistence and restored history remain separated',()=>{
  const store=new ConversationSessions(),a=store.get('a','same',conversationSessionSeed({conversationId:'same',messages:[],display:[{id:'1',role:'assistant',content:'Recovered'}],planIds:['owned-a']}));
  a.get('display',[]);a.set('pendingId','generation-a');
  const b=store.get('b','same');b.get('display',[]);b.set('pendingId','generation-b');
  assert.equal(store.takeDirty('a')[0].snapshot().pendingId,'generation-a');assert.equal(store.takeDirty('b')[0].snapshot().pendingId,'generation-b');
  assert.equal(a.snapshot().display[0].content,'Recovered');assert.deepEqual(a.snapshot().planIds,['owned-a']);
});

test('a native streaming burst preserves the latest result with one UI notification',async()=>{
  const store=new ConversationSessions(),slot=store.get('account','stream');
  slot.get('display',[]);let rootNotifications=0,sessionNotifications=0;
  const rootOff=store.subscribe(()=>rootNotifications++),sessionOff=slot.subscribe(()=>sessionNotifications++);
  for(let index=0;index<500;index++)slot.set('display',[{content:`token ${index}`}]);
  assert.equal(slot.snapshot().display[0].content,'token 499');
  assert.equal(store.takeDirty('account').length,1);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(rootNotifications,1);assert.equal(sessionNotifications,1);
  rootOff();sessionOff();
});

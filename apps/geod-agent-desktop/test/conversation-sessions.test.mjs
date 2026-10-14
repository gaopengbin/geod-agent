import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationSessions,conversationSessionSeed} from '../src/conversation-sessions.ts';
import {conversationActivity} from '../src/conversation-history.ts';
import {accountChatStore,persistCompletedChat,restorePendingChats,CHAT_LIST_KEY} from '../src/pending-generations.ts';

test('streaming takes priority; only completed unseen replies become unread and reopening marks the exact latest reply read',()=>{
 const registry=new ConversationSessions(),a=registry.get('account','a',conversationSessionSeed({conversationId:'a',messages:[],display:[]}));
 a.set('busy',true);a.set('display',[{id:'stream',role:'assistant',phase:'final',streaming:true,content:'partial'}]);
 assert.equal(conversationActivity(a.snapshot(),true),'running');assert.equal(conversationActivity(a.snapshot()),'idle','streaming text is not a completed reply');
 a.completeReply('reply-1',false);assert.equal(conversationActivity(a.snapshot(),true),'running','finishing persistence must not replace an active spinner early');
 a.set('busy',false);assert.equal(conversationActivity(a.snapshot()),'unread');a.markRead();assert.equal(conversationActivity(a.snapshot()),'idle');
 a.completeReply('reply-2',false);assert.equal(conversationActivity(a.snapshot()),'unread');assert.equal(a.snapshot().readReplyId,'reply-1');
 a.markRead();assert.equal(a.snapshot().readReplyId,'reply-2');a.completeReply('reply-3',true);assert.equal(conversationActivity(a.snapshot()),'idle');
});

test('failure or stop without a completed reply cannot create a blue dot; read state survives restart and stays account scoped',()=>{
 const registry=new ConversationSessions(),a=registry.get('a','same',conversationSessionSeed({conversationId:'same',messages:[],display:[]}));
 a.set('busy',true);a.set('display',[{id:'failure',role:'assistant',content:'failed',turnOutcome:{status:'failed'}}]);a.set('busy',false);assert.equal(conversationActivity(a.snapshot()),'idle');
 a.completeReply('done',false);const memory=new Map(),store={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v)};
 const scoped=accountChatStore(store,'a');persistCompletedChat(scoped,{conversationId:'same',messages:[],display:[],...a.snapshot()});
 const saved=restorePendingChats(scoped,JSON.parse(scoped.getItem(CHAT_LIST_KEY)))[0];const reopened=new ConversationSessions(),next=reopened.get('a','same',conversationSessionSeed(saved));assert.equal(conversationActivity(next.snapshot()),'unread');next.markRead();assert.equal(conversationActivity(next.snapshot()),'idle');
 persistCompletedChat(scoped,{...saved,...next.snapshot()});const reread=restorePendingChats(scoped,JSON.parse(scoped.getItem(CHAT_LIST_KEY)))[0];assert.equal(conversationActivity(reread),'idle','read status survives another restart');
 const other=registry.get('b','same',conversationSessionSeed());assert.equal(conversationActivity(other.snapshot()),'idle');assert.equal(a.snapshot().readReplyId,'');
});
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

import assert from 'node:assert/strict';
import test from 'node:test';
import {exportConversation,importConversation,searchConversations} from '../src/conversation-history.ts';
import {accountChatStore,CHAT_LIST_KEY,deleteStoredConversation,persistCompletedChat,restorePendingChats,savePending} from '../src/pending-generations.ts';
const storage=()=>{const map=new Map();return{getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value)};};
const chat=id=>({conversationId:id,messages:[{role:'user',content:`Search record ${id}`}],display:[{id:`m-${id}`,role:'user',content:`Search record ${id}`}],updatedAt:'2026-10-04T00:00:00Z'});
test('more than 30 conversations survive saving, recovery and account isolation',()=>{
  const base=storage(),a=accountChatStore(base,'account-a'),b=accountChatStore(base,'account-b');
  for(let i=0;i<105;i++)persistCompletedChat(a,chat(`history-${i}`));
  persistCompletedChat(b,chat('other-account'));
  savePending(a,{conversationId:'missing',generationId:'request',userId:'account-a',messages:[]});
  const restored=restorePendingChats(a,JSON.parse(a.getItem(CHAT_LIST_KEY)));
  assert.equal(restored.length,106);assert(restored.some(c=>c.conversationId==='history-0'));assert(!restored.some(c=>c.conversationId==='other-account'));
});
test('late model completion preserves renamed, pinned and archived metadata',()=>{
  const store=storage(),original={...chat('owned'),title:'Named task',pinned:true,archived:true};persistCompletedChat(store,original);
  const next=persistCompletedChat(store,{...chat('owned'),messages:[{role:'assistant',content:'Actual answer'}]});
  assert.equal(next[0].title,'Named task');assert(next[0].pinned&&next[0].archived);
});
test('deleted conversation cannot be revived by late model output or pending recovery',()=>{
  const store=storage(),original=chat('deleted');persistCompletedChat(store,original);savePending(store,{conversationId:'deleted',generationId:'in-flight',userId:'account',messages:[]});
  deleteStoredConversation(store,'deleted');assert.equal(persistCompletedChat(store,original).length,0);
  savePending(store,{conversationId:'deleted',generationId:'late',userId:'account',messages:[]});assert.equal(restorePendingChats(store,[]).length,0);
});
test('history search includes message content, distinguishes archive and orders pins first',()=>{
  const a={...chat('a'),title:'Alpha'},b={...chat('b'),title:'Beta',pinned:true},c={...chat('archived-unique-nonce'),archived:true};
  assert.equal(searchConversations([a,b,c],'SEARCH record')[0].conversationId,'b');assert.equal(searchConversations([a,b,c],'record archived-unique-nonce').length,0);assert.equal(searchConversations([a,b,c],'record archived-unique-nonce',true)[0].conversationId,'archived-unique-nonce');
});
test('portable history creates a new identity and cannot import native task or file authority',()=>{
  const source={...chat('source'),planIds:['private-plan'],workspaceDirectory:'C:/private',pendingId:'active-model'};
  const exported=JSON.parse(exportConversation(source,'json'));Object.assign(exported.conversation,{conversationId:'source',planIds:['private-plan'],workspaceDirectory:'C:/private',pendingId:'active-model',engine:'legacy'});
  exported.conversation.display[0].sourceDraft={url:'private'};exported.conversation.display[0].backgroundJob={jobId:'private-job'};exported.conversation.messages[0].tool_calls=[{id:'private'}];
  const imported=importConversation(JSON.stringify(exported),'new-identity');
  assert.equal(imported.conversationId,'new-identity');assert.deepEqual(imported.planIds,[]);assert.equal(imported.pendingId,undefined);assert.equal(imported.workspaceDirectory,undefined);assert.equal(imported.display[0].sourceDraft,undefined);assert.equal(imported.display[0].backgroundJob,undefined);assert.equal(imported.messages[0].tool_calls,undefined);
  assert(exportConversation(source,'markdown').includes('Search record source'));
  assert.throws(()=>importConversation('{broken','id'));assert.throws(()=>importConversation(JSON.stringify({product:'unknown'}),'id'));
});

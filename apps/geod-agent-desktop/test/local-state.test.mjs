import assert from 'node:assert/strict';
import test from 'node:test';
import {createLocalState} from '../src/local-state.ts';
function storage(entries=[]){const data=new Map(entries);return{get length(){return data.size},key:i=>[...data.keys()][i]??null,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k),clear:()=>data.clear()};}

test('atomic migration preserves existing records on failure, then stores and reopens data above the localStorage limit',async()=>{
  const key='geod-agent-conversations-0.1:account:qa',large='x'.repeat(6*1024*1024);
  const old=storage([[key,large],['geod-agent-theme','dark']]),records=new Map();let fail=true;
  const persistence={read:async()=>new Map(records),write:async entries=>{if(fail)throw new Error('disk failure');for(const[k,v]of entries)v===null?records.delete(k):records.set(k,v);}};
  const state=createLocalState(persistence,old,()=>{});
  await assert.rejects(state.initialize(),/disk failure/);assert.equal(old.getItem(key),large);assert.equal(records.size,0);
  fail=false;await state.initialize();assert.equal(state.store.getItem(key),large);assert.equal(old.getItem(key),null);assert.equal(old.getItem('geod-agent-theme'),'dark');
  state.store.setItem(key,large+'saved');await state.flush();
  const reopened=createLocalState(persistence,old,()=>{});await reopened.initialize();assert.equal(reopened.store.getItem(key),large+'saved');
});

test('a newer value written during an active transaction is persisted before flush resolves',async()=>{
  const records=new Map();let release;const gate=new Promise(r=>release=r);let first=true;
  const state=createLocalState({read:async()=>records,write:async entries=>{if(first){first=false;await gate;}for(const[k,v]of entries)records.set(k,v);}},storage(),()=>{});
  await state.initialize();const key='geod-map-session-1:qa';state.store.setItem(key,'old');const flushing=state.flush();state.store.setItem(key,'new');release();await flushing;assert.equal(records.get(key),'new');
});

test('failed pending writes remain retryable and a stale legacy copy does not overwrite committed records',async()=>{
  const key='geod-agent-pending-generations-0.1:account:qa',records=new Map([[key,'committed']]);let fail=false;const errors=[];
  const state=createLocalState({read:async()=>new Map(records),write:async entries=>{if(fail)throw new Error('disk full');for(const[k,v]of entries)v===null?records.delete(k):records.set(k,v);}},storage([[key,'stale']]),e=>errors.push(e));
  await state.initialize();assert.equal(state.store.getItem(key),'committed');fail=true;state.store.setItem(key,'next');await assert.rejects(state.flush(),/disk full/);assert.equal(records.get(key),'committed');
  await new Promise(r=>setTimeout(r,0));assert(errors.length);fail=false;await state.flush();assert.equal(records.get(key),'next');state.store.removeItem(key);await state.flush();assert(!records.has(key));
});

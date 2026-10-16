import test from 'node:test';
import assert from 'node:assert/strict';
import {createTurnInterrupt} from '../src-tauri/codex-control.mjs';

test('stop during startup and repeated stop events issue one Core interrupt',async()=>{
  const run={threadId:'thread',turnId:null};let cancelled=0,calls=0,release;
  const interrupt=createTurnInterrupt({getRun:()=>run,cancel:()=>cancelled++,rpc:async()=>{calls++;await new Promise(resolve=>{release=resolve;});}});
  await interrupt();await interrupt();assert.equal(cancelled,1);assert.equal(calls,0);
  run.turnId='turn';const a=interrupt(),b=interrupt();assert.equal(calls,1);release();await Promise.all([a,b]);
  run.completed=true;await interrupt();assert.equal(calls,1);
});
test('a completion racing with stop is benign, while unrelated RPC failures remain errors',async()=>{
  for(const message of ['no active turn to interrupt','transport disconnected']){
    const interrupt=createTurnInterrupt({getRun:()=>({threadId:'t',turnId:'r'}),cancel:()=>{},rpc:async()=>{throw Error(message);}});
    if(message.startsWith('no active'))await interrupt();else await assert.rejects(interrupt(),/transport disconnected/);
  }
  await createTurnInterrupt({getRun:()=>null,cancel:()=>{throw Error('idle should not cancel');},rpc:()=>{throw Error('idle RPC');}})();
});

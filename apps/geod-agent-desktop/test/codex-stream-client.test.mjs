import test from 'node:test';
import assert from 'node:assert/strict';
import {followNativeRun} from '../src/codex-stream-client.ts';
const timing={tickMs:1,silenceMs:2,callTimeoutMs:50,recoveryMs:0};
test('a normal completion drains the durable tail before committing the answer',{timeout:2000},async()=>{
  const events=[];let starts=0,checks=0;
  const result=await followNativeRun({...timing,runId:'r',start:async receive=>{starts++;receive({sequence:1,runId:'r',type:'text'});return {status:'completed'};},reconnect:async(after,receive)=>{checks++;assert.equal(after,1);receive({sequence:2,runId:'r',type:'steered'});return {status:'completed',result:{status:'completed'}};},onEvent:e=>events.push(e.type),onConnection:()=>{}});
  assert.deepEqual(events,['text','steered']);assert.equal(result.status,'completed');assert.equal(starts,1);assert.equal(checks,1);
});
test('reconnect replays gaps in order, ignores duplicate and wrong-run events, starts Core once',{timeout:2000},async()=>{
  let starts=0,checks=0;const events=[],connections=[];
  const result=await followNativeRun({...timing,runId:'run',start:receive=>{starts++;receive({runId:'old',sequence:1,type:'tool'});receive({runId:'run',sequence:1,text:'A'});receive({runId:'run',sequence:3,text:'C'});return new Promise(()=>{});},
    reconnect:async(after,receive)=>{checks++;assert.equal(after,1);for(const sequence of [1,2,3,3])receive({runId:'run',sequence,text:String(sequence)});return {status:'completed',result:{text:'ABC'}};},
    onEvent:event=>events.push(event.sequence),onConnection:value=>connections.push(value),
  });
  assert.deepEqual(events,[1,2,3]);assert.equal(starts,1);assert.equal(checks,1);assert.equal(result.text,'ABC');assert.equal(connections.at(-1).state,'connected');
});
test('lost invoke acknowledgement resolves original run snapshot without starting another turn',{timeout:2000},async()=>{
  let starts=0;const result=await followNativeRun({...timing,runId:'r',start:async()=>{starts++;throw Error('view disconnected');},reconnect:async()=>({status:'completed',result:{status:'completed'}}),onEvent:()=>{},onConnection:()=>{}});
  assert.equal(starts,1);assert.equal(result.status,'completed');
});
test('restored subscriptions surface unresolved callbacks independently of saved display cursor',{timeout:2000},async()=>{
  const events=[];let checks=0;
  const result=await followNativeRun({...timing,runId:'r',afterSequence:10,reconnect:async after=>{assert.equal(after,10);return ++checks===1?{status:'running',pendingCallbacks:[{runId:'r',type:'tool',requestId:'job'}]}:{status:'completed',result:{ok:true}};},onEvent:event=>events.push(event),onConnection:()=>{}});
  assert.equal(events.length,1);assert.equal(events[0].requestId,'job');assert.equal(result.ok,true);
});
test('unavailable execution preserves uncertain state and never retries model or tool work',{timeout:2000},async()=>{
  let starts=0;const states=[];
  await assert.rejects(followNativeRun({...timing,runId:'r',start:async()=>{starts++;throw Error('broken channel');},reconnect:async()=>({status:'unavailable'}),onEvent:()=>{},onConnection:s=>states.push(s)}),{code:'CODEX_CONNECTION_UNKNOWN'});
  assert.equal(starts,1);assert.equal(states.at(-1).state,'unavailable');assert(states.every(s=>s.maxAttempts===undefined));
});
test('callback uncertainty detaches subscription without cancelling or restarting native work',{timeout:2000},async()=>{
  const controller=new AbortController();let starts=0;
  await assert.rejects(followNativeRun({...timing,runId:'r',signal:controller.signal,start:()=>{starts++;return new Promise(()=>{});},reconnect:async()=>{controller.abort(Object.assign(Error('check job'),{code:'CODEX_TOOL_OUTCOME_UNKNOWN'}));return {status:'running'};},onEvent:()=>{},onConnection:()=>{}}),{code:'CODEX_TOOL_OUTCOME_UNKNOWN'});
  assert.equal(starts,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {guardedCodexTurn} from '../src/codex-liveness.ts';

const timing={tickMs:5,probeAfterMs:10,probeTimeoutMs:10,startupTimeoutMs:70};
test('timeout retains busy state until native stop has finished',async()=>{
 let release,finished=false;
 const guarded=guardedCodexTurn(()=>new Promise(()=>{}),{...timing,startupTimeoutMs:5,interrupt:()=>new Promise(resolve=>{release=resolve;}),probe:async()=>{},stopTimeoutMs:500}).catch(()=>{finished=true;});
 await new Promise(resolve=>setTimeout(resolve,30));assert.equal(finished,false);assert.equal(typeof release,'function');release();await guarded;assert.equal(finished,true);
});
test('an unreachable stop command is bounded',async()=>{
 await assert.rejects(guardedCodexTurn(()=>new Promise(()=>{}),{...timing,startupTimeoutMs:5,stopTimeoutMs:15,interrupt:()=>new Promise(()=>{}),probe:async()=>{}}),/启动未完成/);
});
test('lost native IPC ends waiting even if its original promise never settles',async()=>{
 let interrupted=0;
 await assert.rejects(guardedCodexTurn(activity=>{activity();return new Promise(()=>{});},{...timing,probe:()=>new Promise(()=>{}),interrupt:async()=>{interrupted++;}}),/本机引擎连接已中断/);
 assert.equal(interrupted,1);
});
test('startup with no engine events ends instead of spinning forever',async()=>{
 await assert.rejects(guardedCodexTurn(()=>new Promise(()=>{}),{...timing,probe:async()=>({state:'connected'}),interrupt:async()=>{}}),/启动未完成/);
});
test('healthy engine activity can take longer than the startup deadline',async()=>{
 const result=await guardedCodexTurn(activity=>new Promise(resolve=>{activity();const heartbeat=setInterval(activity,5);setTimeout(()=>{clearInterval(heartbeat);resolve('done');},100);}),{...timing,probe:async()=>{},interrupt:async()=>{}});
 assert.equal(result,'done');
});
test('normal turn errors reach the caller and release the guard',async()=>{
 await assert.rejects(guardedCodexTurn(async()=>{throw new Error('actual error');},{...timing,probe:async()=>{},interrupt:async()=>{}}),/actual error/);
});
test('a responsive native service cannot hide a lost turn event channel',async()=>{
 let interrupted=0,probes=0;
 await assert.rejects(guardedCodexTurn(activity=>{activity();return new Promise(()=>{});},{...timing,silenceTimeoutMs:40,probe:async()=>{probes++;return {state:'connected'};},interrupt:async()=>{interrupted++;}}),/本次执行的消息连接已中断/);
 assert(probes>0);assert.equal(interrupted,1);
});
test('ongoing heartbeats preserve long model and user-input waits',async()=>{
 let interrupted=0;
 const result=await guardedCodexTurn(activity=>new Promise(resolve=>{activity();const heartbeat=setInterval(activity,5);setTimeout(()=>{clearInterval(heartbeat);resolve('actual result');},110);}),{...timing,silenceTimeoutMs:30,probe:async()=>{},interrupt:async()=>{interrupted++;}});
 assert.equal(result,'actual result');assert.equal(interrupted,0);
});

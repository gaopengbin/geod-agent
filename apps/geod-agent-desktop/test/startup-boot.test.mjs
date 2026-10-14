import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/startup-boot.js',import.meta.url),'utf8');
function bootContext({nativeError=false,reduced=false}={}){
 const frames=[],timers=[],calls=[];let removed=0,observer,failed=false;
 const boot={classList:{add(){}},querySelectorAll:()=>[],querySelector:()=>null,remove:()=>removed++};
 const window={__TAURI_INTERNALS__:{invoke:async command=>{calls.push(command);if(nativeError)throw Error('old native');return true;}}};
 const context={window,document:{getElementById:id=>id==='geod-startup-boot'?boot:{},querySelector:()=>failed?{}:null},MutationObserver:class{constructor(fn){observer=fn;}observe(){}disconnect(){}},localStorage:{getItem:()=>null},navigator:{language:'zh-CN'},matchMedia:()=>({matches:reduced}),performance:{now:()=>1200},requestAnimationFrame:fn=>frames.push(fn),setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length}};
 vm.runInNewContext(source,context);
 return{state:window.__GEOD_STARTUP__,calls,timers,frames,get removed(){return removed},async frame(){for(const fn of frames.splice(0))await fn()},async tick(ms){for(const task of timers.splice(0).filter(t=>t.ms===ms))await task.fn()},failRecords(){failed=true;observer();}};
}
test('first screen signals native visibility once even when hidden WebView animation frames do not run',async()=>{
 const ctx=bootContext();assert.deepEqual(ctx.calls,[]);await ctx.tick(80);await ctx.state.ready;assert.deepEqual(ctx.calls,['desktop_boot_ready']);assert.equal(ctx.state.startedAt,1200);
 await ctx.frame();await ctx.frame();assert.equal(ctx.calls.length,1,'late frames cannot repeat window reveal');
});
test('normal first-paint frames signal readiness without waiting for App or stored conversations',async()=>{
 const ctx=bootContext();await ctx.frame();assert.equal(ctx.calls.length,0);await ctx.frame();await ctx.state.ready;assert.equal(ctx.calls.length,1);assert.equal(ctx.removed,0,'readiness does not dismiss the startup surface');
});
test('startup dismissal is idempotent and reduced motion requires no decorative delay',async()=>{
 for(const reduced of [false,true]){const ctx=bootContext({reduced});const one=ctx.state.finish(),two=ctx.state.finish();assert.equal(one,two);assert.equal(ctx.removed,0);await ctx.tick(reduced?0:180);await one;assert.equal(ctx.removed,1);}
});
test('older native binaries and record-storage recovery keep a usable first screen',async()=>{
 const ctx=bootContext({nativeError:true});await ctx.tick(80);await ctx.state.ready;assert.equal(ctx.removed,0);ctx.failRecords();await ctx.tick(180);assert.equal(ctx.removed,1,'record error UI must not be hidden behind a permanent splash');
});

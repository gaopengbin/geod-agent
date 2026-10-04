// Verify a native WebView receives a real Vite module update without navigation.
import assert from 'node:assert/strict';
import {writeFileSync,unlinkSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const file=resolve('test/native-hmr-probe.ts'),nonce=crypto.randomUUID();
const source=value=>`window.__geodHmrProof=${JSON.stringify({nonce,value})}; if(import.meta.hot) import.meta.hot.accept();\n`;
writeFileSync(file,source(1));
const pages=await(await fetch('http://127.0.0.1:9233/json/list')).json(),page=pages.find(p=>p.title==='GeoD Agent');assert(page);
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));
let sequence=0;const pending=new Map();socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(pending.has(data.id)){pending.get(data.id)(data);pending.delete(data.id);}});
const call=(expression)=>new Promise(r=>{const id=++sequence;pending.set(id,r);socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});
try{
 const before=await call(`(async()=>{window.__geodHmrNavigationProof=${JSON.stringify(nonce)};await import('/test/native-hmr-probe.ts');return {proof:window.__geodHmrProof,timeOrigin:performance.timeOrigin};})()`);
 assert.equal(before.result.result.value.proof.value,1);
 writeFileSync(file,source(2));
 let current;
 for(let n=0;n<100;n++){await new Promise(r=>setTimeout(r,100));const response=await call(`({proof:window.__geodHmrProof,navigation:window.__geodHmrNavigationProof,timeOrigin:performance.timeOrigin})`);current=response.result.result.value;if(current.proof?.value===2)break;}
 assert.equal(current.proof?.value,2,'The running native WebView must receive the module update');
 assert.equal(current.navigation,nonce,'HMR must not reload the page');assert.equal(current.timeOrigin,before.result.result.value.timeOrigin);
 const evidence={pass:true,withoutReload:true,initialValue:1,updatedValue:2,timeOrigin:current.timeOrigin,checkedAt:new Date().toISOString()};
 const output=resolve('../../docs/implementation/evidence/native-hmr-2026-10-02.json');mkdirSync(resolve(output,'..'),{recursive:true});writeFileSync(output,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await call('delete window.__geodHmrProof; delete window.__geodHmrNavigationProof;');socket.close();unlinkSync(file);}

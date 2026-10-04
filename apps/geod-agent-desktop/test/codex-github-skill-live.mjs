// Verify the actual native GitHub package fetch, retaining no test installation.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const page=(await(await fetch('http://127.0.0.1:9233/json')).json()).find(p=>p.type==='page'&&p.url.includes('1420'));
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
let serial=0;const pending=new Map();socket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id){const callback=pending.get(value.id);pending.delete(value.id);value.error?callback?.reject(new Error(value.error.message)):callback?.resolve(value.result);}});
async function evaluate(expression){const id=++serial;const value=await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description??value.exceptionDetails.text);return value.result.value;}
let staged;
try{
 const exists=await evaluate(`(async()=>{const {api}=await import('/src/api.ts');return (await api.extensionsList()).skills.some(s=>s.name==='skill-creator')})()`);assert.equal(exists,false,'Keep any existing user installation untouched');
 staged=await evaluate(`(async()=>{const {api}=await import('/src/api.ts');return await api.skillRemoteStage('https://raw.githubusercontent.com/openai/skills/main/skills/.system/skill-creator/SKILL.md')})()`);
 const store=JSON.parse(readFileSync(join(process.env.APPDATA,'dev.geod-agent.desktop/agent-extensions.json'),'utf8'));
 const skill=store.skills.find(s=>s.id===staged.id);const files=Object.keys(skill.files);
 assert.ok(files.some(path=>path.startsWith('scripts/')));assert.ok(files.length>1);assert.match(staged.sourceUrl,/\/openai\/skills\/[a-f0-9]{40}\//);assert.equal(staged.enabled,false);
 const evidence={...staged,files,totalResourceBytes:Object.values(skill.files).reduce((sum,value)=>sum+value.length,0)};
 writeFileSync('../../docs/implementation/evidence/codex-github-skill-2026-10-01.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{if(staged)await evaluate(`(async()=>{const {api}=await import('/src/api.ts');await api.skillRemove(${JSON.stringify(staged.id)})})()`);socket.close();}

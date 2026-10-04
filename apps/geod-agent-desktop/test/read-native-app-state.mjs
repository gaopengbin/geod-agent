// Read-only diagnostic for the currently visible native WebView.
import {writeFileSync} from 'node:fs';
const pages=await (await fetch('http://127.0.0.1:9233/json/list')).json(),page=pages.find(p=>p.title==='GeoD Agent');
if(!page)throw Error('No GeoD Agent WebView');
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((ok,fail)=>{socket.addEventListener('open',ok,{once:true});socket.addEventListener('error',fail,{once:true});});
let serial=0;const waiting=new Map();socket.addEventListener('message',event=>{const data=JSON.parse(event.data),pending=waiting.get(data.id);if(!pending)return;waiting.delete(data.id);data.error?pending.reject(data.error):pending.resolve(data.result);});
const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;waiting.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const result=await call('Runtime.evaluate',{expression:`JSON.stringify({title:document.querySelector('.agent-header')?.textContent, busy:!!document.querySelector('button[aria-label="停止回复"]'), text:document.querySelector('.agent-primary')?.innerText.slice(-7000), alerts:[...document.querySelectorAll('[role="alert"]')].map(e=>e.textContent)})`,returnByValue:true});console.log(result.result.value);
const data=await call('Runtime.evaluate',{expression:`JSON.stringify(Object.keys(localStorage).filter(k=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(k=>JSON.parse(localStorage.getItem(k)||'[]')).filter(c=>c.display.some(m=>m.role==='user'&&m.content.startsWith('矢量数据验收'))).map(c=>({id:c.conversationId,calls:c.display.filter(m=>m.role==='tool').map(m=>({tool:m.toolName,status:m.toolStatus,details:m.details})).slice(-6)})))`,returnByValue:true});console.log(data.result.value);
if(process.argv[2]){const shot=await call('Page.captureScreenshot',{format:'png'});writeFileSync(process.argv[2],Buffer.from(shot.data,'base64'));}
socket.close();

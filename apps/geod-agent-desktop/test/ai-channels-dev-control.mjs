// Readiness and graceful development restart, without changing user chats.
const target=(await(await fetch('http://127.0.0.1:9233/json/list')).json()).find(p=>p.type==='page'&&p.url.includes('127.0.0.1:1420'));
if(!target)throw new Error('Development desktop unavailable');
const socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});
let serial=0;const pending=new Map();
socket.addEventListener('message',e=>{const v=JSON.parse(e.data),p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(new Error(v.error.message)):p.resolve(v.result);}});
socket.addEventListener('close',()=>{for(const p of pending.values())p.resolve({result:{value:null}});pending.clear();});
async function evaluate(expression){const response=await new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});if(response.exceptionDetails)throw new Error(response.exceptionDetails.exception?.description??response.exceptionDetails.text);return response.result.value;}
try{
  const result=await evaluate(`(async()=>{
    const invoke=(command,args)=>window.__TAURI_INTERNALS__.invoke(command,args);
    const stopped=!!document.querySelector('button[aria-label="停止回复"]');
    const background=await invoke('background_status');
    if(stopped||background.activeDownloads||background.activeCommands||background.activeAiTurns)throw new Error('Development runtime has active user work');
    const active=document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id');
    const stoppedBackground=${process.argv.includes('--stop')}?await invoke('background_stop'):null;
    return {activeConversation:active,background,stoppedBackground};
  })()`);
  console.log(JSON.stringify(result));
  if(process.argv.includes('--stop'))await evaluate(`import('/node_modules/@tauri-apps/api/window.js').then(m=>m.getCurrentWindow().close())`);
}finally{socket.close();}

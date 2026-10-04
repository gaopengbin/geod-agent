// Reload only the renderer, after all acceptance turns have finished.
const pages=await(await fetch('http://127.0.0.1:9233/json/list')).json(),page=pages.find(p=>p.title==='GeoD Agent');
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));let serial=0;const pending=new Map();
const seen=new Set();
const log=value=>{const text=JSON.stringify(value);if(seen.size<40&&!seen.has(text)){seen.add(text);console.log(text);}};
socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.method==='Log.entryAdded')log({log:data.params.entry.level,text:data.params.entry.text});if(data.method==='Runtime.consoleAPICalled')log({type:data.params.type,text:data.params.args.map(v=>v.value).join(' ')});if(pending.has(data.id)){pending.get(data.id)(data);pending.delete(data.id);}});
const call=(method,params={})=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);socket.send(JSON.stringify({id,method,params}));});
await call('Log.enable');await call('Runtime.enable');await call('Page.reload');await new Promise(resolve=>setTimeout(resolve,1600));socket.close();

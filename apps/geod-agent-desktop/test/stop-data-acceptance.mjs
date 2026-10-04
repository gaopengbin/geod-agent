// Interrupt only this script's visible acceptance conversation, not other runs.
const pages=await(await fetch('http://127.0.0.1:9233/json/list')).json(),page=pages.find(p=>p.title==='GeoD Agent');
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
const result=new Promise(resolve=>socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id===1)resolve(data);}));
socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`(()=>{if(!document.querySelector('.agent-header')?.textContent.startsWith('矢量数据验收'))throw Error('Not the acceptance chat');document.querySelector('button[aria-label="停止回复"]')?.click();return true;})()`,returnByValue:true}}));
console.log(await result);socket.close();

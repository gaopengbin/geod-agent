// Read-only integration check against the running development desktop's IPC.
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
const pages = await (await fetch('http://127.0.0.1:9233/json/list')).json();
const page = pages.find(item => item.title === 'GeoD Agent');
if (!page) throw new Error('GeoD development desktop is not running');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let serial = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const data = JSON.parse(event.data), request = pending.get(data.id); if (!request) return;
  pending.delete(data.id); clearTimeout(request.timer);
  data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result);
});
function evaluate(expression) {
  return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('IPC request timeout')); }, 120_000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
try {
  if (process.argv.includes('--serve')) {
    const allowed = new Set(['sources_list','sources_get','source_thumbnail_metadata','map_preview_tile']);
    const server = createServer(async (req,res)=>{
      if(req.headers.origin !== 'http://127.0.0.1:1420'){res.writeHead(403).end();return;}
      res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:1420');res.setHeader('Access-Control-Allow-Headers','content-type');
      if(req.method==='OPTIONS'){res.writeHead(204).end();return;}
      if(req.method!=='POST'||req.url!=='/rpc'){res.writeHead(404).end();return;}
      try {
        let body=''; for await(const chunk of req){body+=chunk;if(body.length>8192)throw new Error('Request too large');}
        const {command,args}=JSON.parse(body);if(!allowed.has(command))throw new Error('Read-only preview adapter');
        const result=await evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args??{})}).then(value=>({value}),error=>({error}))`);
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result.result.value));
      }catch(error){res.writeHead(500).end(JSON.stringify({error:String(error)}));}
    });
    server.listen(1422,'127.0.0.1',()=>console.log('Read-only source thumbnail IPC adapter: localhost:1422'));
    await new Promise(resolve=>{for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();resolve();});});
  } else if (process.argv.includes('--status')) {
    const result = await evaluate(`window.__TAURI_INTERNALS__.invoke('jobs_active').then(ids=>({activeWorkers:ids.length}))`);
    console.log(JSON.stringify(result.result.value));
  } else {
    const output = resolve('../../docs/implementation/evidence/ui-librechat-2026-10-02/source-thumbnails');
    await mkdir(output, { recursive: true });
    const result = await evaluate(`(async()=>{const {api,errorMessage}=await import('/src/api.ts');const {getSourceThumbnail}=await import('/src/source-thumbnails.ts');const sources=await api.sourcesList();const results=[];for(const source of sources.slice(0,4)){try{const image=await getSourceThumbnail({registered:source},true);results.push({id:source.id,image});const stored=await api.sourcesGet(source.id);const draft={source:{...stored.endpoint,id:'unsaved-preview-'+source.id},minZoom:source.minZoom,maxZoom:source.maxZoom};const preview=await getSourceThumbnail({draft},true);results.push({id:'unsaved-preview-'+source.id,image:preview})}catch(error){results.push({id:source.id,error:errorMessage(error)})}}const after=await api.sourcesList();return {count:sources.length,configurationUnchanged:JSON.stringify(sources)===JSON.stringify(after),results}})()`);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    const value = result.result.value;
    for (const row of value.results) {
      if (!row.image) continue;
      const mime = row.image.url.startsWith('data:image/jpeg') ? 'jpg' : 'png';
      await writeFile(resolve(output, `${row.id.replace(/[^a-z0-9_-]/gi,'_')}.${mime}`), Buffer.from(row.image.url.split(',')[1], 'base64'));
      row.bytes = Buffer.from(row.image.url.split(',')[1], 'base64').length;
      delete row.image.url;
    }
    await writeFile(resolve(output, 'native-readback.json'), JSON.stringify(value, null, 2));
    console.log(JSON.stringify(value));
    if (!value.configurationUnchanged || value.results.some(row=>row.error) || !value.results.length) throw new Error('Real source preview verification failed');
  }
} finally { socket.close(); }

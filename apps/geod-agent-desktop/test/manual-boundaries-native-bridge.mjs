// Isolated native boundary acceptance bridge; shares no downloads or active chat state.
import { createServer } from 'node:http';
const pages = await (await fetch('http://127.0.0.1:9233/json/list')).json();
const page = pages.find(item => item.title === 'GeoD Agent');
if (!page) throw new Error('Native desktop debug port is not available');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let serial = 0; const pending = new Map();
socket.addEventListener('message', event => { const message = JSON.parse(event.data); const request = pending.get(message.id); if (request) { pending.delete(message.id); clearTimeout(request.timer); request.resolve(message.result); } });
function evaluate(expression) { return new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native boundary timeout')); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }); }
const allowed = new Set(['boundary_inspect', 'boundaries_save', 'boundaries_get', 'boundaries_list']);
const server = createServer(async (req, res) => {
  if (req.headers.origin !== 'http://127.0.0.1:1420') { res.writeHead(403).end(); return; }
  res.setHeader('Access-Control-Allow-Origin', 'http://127.0.0.1:1420'); res.setHeader('Access-Control-Allow-Headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  try {
    let body = ''; for await (const part of req) { body += part; if (body.length > 4_000_000) throw new Error('Body too large'); }
    const { command, args } = JSON.parse(body); if (!allowed.has(command)) throw new Error('Unsupported test command');
    if (command !== 'boundary_inspect' && !args.conversationId?.startsWith('manual-boundary-acceptance-')) throw new Error('Only isolated acceptance conversations are allowed');
    const result = await evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)}).then(value=>({value}),error=>({error}))`);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result?.result?.value ?? { error: result?.exceptionDetails?.text ?? 'Native command failed' }));
  } catch (error) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(1422, '127.0.0.1', () => console.log('Native boundary acceptance bridge: http://127.0.0.1:1422'));
socket.addEventListener('close', () => { server.close(); process.exit(0); });

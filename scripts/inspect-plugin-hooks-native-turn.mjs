/** Probe native discovery and stop before any model request is sent. */
import {pathToFileURL} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-hooks'),saved=JSON.parse(fs.readFileSync(path.join(root,'restart-state.json'),'utf8'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
try{
 const result=await page.evaluate(async({originalIds,runId})=>{
  const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts'),{Channel,invoke}=await import('/node_modules/.vite/deps/@tauri-apps_api_core.js');
  const store=accountChatStore(localStateStore,(await api.authStatus()).userId),active=store.getItem('geod-agent-active-conversation-0.1');if(originalIds.includes(active))throw new Error('This is not the owned QA conversation');
  const messages=[],events=new Channel();events.onmessage=value=>{messages.push({type:value.type,method:value.method});if(value.type==='model')void invoke('codex_command',{runId,command:{type:'interrupt'}});};
  try{return {conversationId:active,messages,result:await invoke('codex_turn',{runId,conversationId:active,input:'核对本机自动化发现，停在模型请求之前。',history:[],events,images:[]})};}catch(error){return{conversationId:active,messages,error};}
 },{originalIds:saved.original.chatIds,runId:randomUUID()});
 fs.writeFileSync(path.join(root,'native-discovery-probe.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 const runtime=path.join(process.env.APPDATA,'dev.geod-agent.desktop','codex-runtime');
 const homes=fs.readdirSync(runtime,{withFileTypes:true}).filter(e=>e.name.startsWith('account-')).flatMap(owner=>fs.readdirSync(path.join(runtime,owner.name),{withFileTypes:true}).filter(e=>e.name.startsWith('conversation-')).map(e=>path.join(runtime,owner.name,e.name,'hooks.json.discovery.json'))).filter(file=>fs.existsSync(file)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
 if(result.error&&homes[0]){console.log(fs.readFileSync(homes[0],'utf8'));fs.copyFileSync(homes[0],path.join(root,'native-discovery-diagnostic.json'));}
}finally{await browser.close();}

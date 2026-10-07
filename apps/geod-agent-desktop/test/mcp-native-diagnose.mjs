import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try {
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
 const report=await page.evaluate(async()=>{
  const invoke=window.__TAURI_INTERNALS__.invoke;
  const {localStateStore}=await import('/src/local-state.ts');
  const auth=await invoke('auth_status'),chats=JSON.parse(localStateStore.getItem('geod-agent-conversations-0.1:account:'+auth.userId)||'[]');
  const chat=chats.find(c=>c.conversationId===document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id'));
  const network=await invoke('network_get');
  return {status:await invoke('background_status'),questions:chat?.display.filter(m=>m.userInput).map(m=>m.userInput),registry:await invoke('mcp_registry_search',{query:'amap'}).then(r=>({results:r}),e=>({error:e})),network:{mode:network.settings?.mode,effective:network.effective}};
 });console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}

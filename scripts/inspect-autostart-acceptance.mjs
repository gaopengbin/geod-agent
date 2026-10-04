import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));console.log(JSON.stringify(await page.evaluate(async()=>{
  const call=async(command,args={})=>Promise.race([window.__TAURI_INTERNALS__.invoke(command,args).then(value=>({value})).catch(error=>({error})),new Promise(resolve=>setTimeout(()=>resolve({timeout:true}),5000))]);
  return {settings:await call('desktop_settings_get'),channels:await call('ai_channels_list'),desktopBackground:await call('background_status')};
})));}finally{await browser.close();}

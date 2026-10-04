/** Normal shutdown only; do not terminate user work to unlock the executable. */
const {chromium}=await import(process.argv[2]);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
if(!page)throw new Error('Development desktop is not connected');
const active=await page.evaluate(async()=>{
  const invoke=window.__TAURI_INTERNALS__.invoke;
  const [background,jobs]=await Promise.all([invoke('background_status'),invoke('jobs_active')]);
  const busy=!!document.querySelector('button[aria-label="停止生成"],button[aria-label="停止回复"],button[title="停止"]');
  return{background,jobs,busy};
});
if(active.busy||active.jobs.length||active.background.activeDownloads||active.background.activeCommands||active.background.activeAiTurns||active.background.maintenanceActive)throw new Error('Development desktop has active work; rebuild deferred');
await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('background_stop'));
try{await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|close'));}catch(error){if(!String(error.message).includes('has been closed'))throw error;}
await browser.close();
console.log('Development window and idle background closed normally');

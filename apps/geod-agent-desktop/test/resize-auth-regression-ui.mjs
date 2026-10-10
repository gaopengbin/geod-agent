// Real layout/transcript/auth components, simulated streaming and isolated IPC only.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const out='../../artifacts/resize-auth-20261009';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route(/^https:\/\//,route=>route.abort());
const checks=[];
async function metrics(){return page.locator('.resizable-workspace').evaluate(e=>({columns:getComputedStyle(e).gridTemplateColumns.split(' ').map(Number.parseFloat),width:e.clientWidth,renders:Number(e.dataset.renderCount),stream:Number(document.querySelector('[data-stream-chunks]')?.dataset.streamChunks),right:document.querySelector('.right-panel').getBoundingClientRect().right,viewport:innerWidth}));}
try {
  await page.goto('http://127.0.0.1:1420/test/workspace-harness.html?stream=1');
  await page.locator('[data-stream-chunks]').waitFor();await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(300);
  const before=await metrics();
  const handle=await page.getByRole('separator',{name:'地图区与任务区宽度'}).boundingBox();
  const x=handle.x+handle.width/2,y=handle.y+60;
  await page.mouse.move(x,y);await page.mouse.down();
  for(let step=1;step<=40;step++){await page.mouse.move(x-step*12,y);await page.waitForTimeout(16);}
  const during=await metrics();
  assert.ok(during.renders-before.renders<=2,JSON.stringify({before,during}));
  assert.ok(during.stream>before.stream+5);
  assert.ok(during.columns[3]>before.columns[3]+200);
  assert.ok(during.columns[1]<before.columns[1]);
  assert.ok(Math.abs(during.columns.reduce((a,b)=>a+b,0)-during.width)<1);
  await page.mouse.up();await page.waitForTimeout(60);
  const after=await metrics();
  assert.ok(after.renders-before.renders<=3);assert.deepEqual(after.columns,during.columns);
  await page.screenshot({path:`${out}/streaming-resize-wide.png`});
  checks.push({name:'Streaming continues while dragging; root renders only at drag boundaries',before,during,after});
  await page.reload();await page.locator('[data-stream-chunks]').waitFor();await page.waitForTimeout(150);
  assert.deepEqual((await metrics()).columns,after.columns);
  for(const width of [1920,1280,1120]){
    await page.setViewportSize({width,height:900});await page.waitForTimeout(150);
    const m=await metrics();assert.equal(m.columns.length,4);assert.ok(Math.abs(m.columns.reduce((a,b)=>a+b,0)-width)<1);assert.ok(m.right<=width&&m.right>width-25);
    const task=await page.locator('.right-panel').boundingBox(), map=await page.locator('.map-column').boundingBox();assert.ok(task.x>=map.x+map.width);
    await page.screenshot({path:`${out}/layout-${width}.png`});checks.push({name:`Panels fit ${width}px without overlap or stranded space`,...m});
  }
  await page.addInitScript(()=>{
    window.isTauri=true;
    const fixture=window.__AUTH_SYNC__={state:'connected',errorCode:'AUTH_REQUIRED',reads:0};
    window.__TAURI_INTERNALS__={invoke:async command=>{
      if(command==='auth_status'){fixture.reads++;return {state:fixture.state,userId:fixture.state==='connected'?'auth-sync-owner':null,error:null};}
      if(command==='account_profile')return {accountId:'auth-sync-owner',email:'fixture@example.test',nickname:'Fixture',avatar:null,avatarDataUrl:null};
      if(command==='workspace_get')throw {code:fixture.errorCode,message:'fixture authorization error'};
      throw Error(`Unexpected fixture IPC ${command}`);
    }};
  });
  await page.goto('http://127.0.0.1:1420/test/auth-sync-harness.html');await page.locator('[data-auth-state="connected"]').waitFor();
  await page.evaluate(()=>{window.__AUTH_SYNC__.state='disconnected';});await page.getByRole('button',{name:'读取工作区'}).click();
  await page.locator('[data-auth-state="disconnected"]').waitFor();assert.equal(await page.locator('main').getAttribute('data-auth-owner'),'');
  checks.push({name:'AUTH_REQUIRED reconciles cached connected UI with authoritative signed-out state'});
  await page.reload();await page.locator('[data-auth-state="connected"]').waitFor();
  await page.evaluate(()=>{window.__AUTH_SYNC__.state='disconnected';window.__AUTH_SYNC__.errorCode='WORKSPACE_DENIED';});
  const reads=await page.evaluate(()=>window.__AUTH_SYNC__.reads);await page.getByRole('button',{name:'读取工作区'}).click();await page.waitForTimeout(100);
  assert.equal(await page.locator('main').getAttribute('data-auth-state'),'connected');assert.equal(await page.evaluate(()=>window.__AUTH_SYNC__.reads),reads);
  checks.push({name:'Ordinary authorization errors do not force sign-out or replay workspace operations'});
  assert.deepEqual(errors,[]);writeFileSync(`${out}/acceptance.json`,JSON.stringify({passed:true,realModelCalled:false,realOAuthStarted:false,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks,errors},null,2));
}finally{await browser.close();}

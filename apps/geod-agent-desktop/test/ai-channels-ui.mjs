import {chromium} from 'file:///G:/code/cesium-mcp/node_modules/playwright/index.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const output=resolve(process.argv[2]??'artifacts/ai-channels-integration-20261004-r2/ui');mkdirSync(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');const context=browser.contexts()[0],page=context.pages().find(p=>p.url().includes('127.0.0.1:1420'));
if(!page)throw new Error('Development desktop unavailable');
const session=await context.newCDPSession(page);let profileId;
const results={};
const theme=()=>page.evaluate(()=>document.documentElement.classList.contains('dark')||document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light');
const originalTheme=await theme();
async function openModels(){await page.getByRole('button',{name:'账号与设置',exact:true}).click();await page.getByRole('button',{name:'模型与渠道',exact:true}).click();await page.getByRole('heading',{name:'模型与渠道',exact:true}).waitFor();}
async function setTheme(wanted){if(await theme()===wanted)return;await page.getByRole('button',{name:'账号与设置',exact:true}).click();await page.getByRole('button',{name:wanted==='light'?'浅色外观':'深色外观',exact:true}).click();}
async function capture(name){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:join(output,name),animations:'disabled'});}
try{
  await openModels();await setTheme('light');
  await page.getByRole('button',{name:'添加渠道',exact:true}).click();
  await page.getByLabel('渠道名称',{exact:true}).fill('界面验收渠道');
  await page.getByLabel('API 基础地址',{exact:true}).fill('https://api.deepseek.com/v1');
  await page.getByLabel('API Key',{exact:true}).fill('invalid-ui-acceptance');
  // Catalogue discovery works before any model ID or saved profile exists.
  await page.getByRole('button',{name:'读取模型目录',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'拒绝认证'}).waitFor();results.catalogueBeforeSaveShowsActualAuthenticationError=true;
  await page.getByLabel('模型 ID',{exact:true}).fill('deepseek-flash');await page.getByLabel('显示名称',{exact:true}).fill('Flash');
  await page.getByRole('button',{name:'手动添加',exact:true}).click();
  await page.getByLabel('模型 ID',{exact:true}).nth(1).fill('deepseek-v4-pro');await page.getByLabel('显示名称',{exact:true}).nth(1).fill('Pro');
  await page.getByRole('button',{name:'保存渠道',exact:true}).click();await page.getByRole('heading',{name:'界面验收渠道',exact:true}).waitFor();
  const profile=await page.evaluate(async()=>{const {aiChannels}=await import('/src/ai-channels.ts');return(await aiChannels.list()).channels.find(c=>c.name==='界面验收渠道');});profileId=profile.id;
  assert(profile.models.length===2&&!('apiKey'in profile));results.twoModelSaveAndSecretFreeReadback=true;
  await capture('channels-light.png');
  await page.locator('.ai-channel-row').filter({hasText:'界面验收渠道'}).getByRole('button',{name:'编辑',exact:true}).click();
  assert.equal(await page.getByLabel('API Key',{exact:true}).inputValue(),'');results.savedKeyNotReadBack=true;
  await page.locator('.ai-model-advanced').first().locator('summary').click();await capture('channel-form-light.png');
  await setTheme('dark');await capture('channel-form-dark.png');
  await session.send('Emulation.setDeviceMetricsOverride',{width:820,height:760,deviceScaleFactor:1,mobile:false});await capture('channel-form-narrow-dark.png');
  results.noHorizontalOverflow=await page.evaluate(()=>{const panel=document.querySelector('.ai-channels-page');return panel.scrollWidth<=panel.clientWidth&&document.documentElement.scrollWidth<=window.innerWidth;});assert(results.noHorizontalOverflow);
  await session.send('Emulation.clearDeviceMetricsOverride');
  await page.getByRole('button',{name:'返回列表',exact:true}).click();await page.getByRole('button',{name:'返回对话',exact:true}).click();
  const modelTrigger=page.locator('.prompt-input-model-trigger');await modelTrigger.click();
  await page.getByRole('option',{name:'界面验收渠道 · Flash',exact:true}).waitFor();await page.getByRole('option',{name:'界面验收渠道 · Pro',exact:true}).waitFor();results.composerShowsActualConfiguredModels=true;
  await page.keyboard.press('Escape');
  results.actualFonts=await page.evaluate(()=>({body:getComputedStyle(document.body).fontFamily,interReady:document.fonts.check('14px Inter'),chineseReady:document.fonts.check('14px "GeoD Noto Sans SC"'),loadedFaces:Array.from(document.fonts).filter(f=>f.status==='loaded').map(f=>f.family)}));
  await openModels();await setTheme(originalTheme);
  writeFileSync(join(output,'ui-verification.json'),JSON.stringify({passed:true,...results},null,2));console.log(JSON.stringify({passed:true,...results}));
}finally{
  await session.send('Emulation.clearDeviceMetricsOverride').catch(()=>{});
  if(profileId)await page.evaluate(async id=>{const {aiChannels,notifyChannelsChanged}=await import('/src/ai-channels.ts');await aiChannels.remove(id);notifyChannelsChanged();},profileId).catch(()=>{});
  await setTheme(originalTheme).catch(()=>{});
  // Refresh the visible inline page after deleting our isolated UI fixture.
  await page.getByRole('button',{name:'返回对话',exact:true}).click().catch(()=>{});await openModels().catch(()=>{});
  await browser.close();
}

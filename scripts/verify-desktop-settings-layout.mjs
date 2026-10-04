/** Inspect the actual desktop dialog without changing startup or update settings. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);
await page.locator('textarea:not([disabled])').waitFor();
const output=path.resolve('artifacts/product-gaps-20261004/desktop-settings');fs.mkdirSync(output,{recursive:true});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const original=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight}));
const cases=[];
try{
  for(const [language,theme] of [['zh-CN','light'],['en','dark']]){
    await page.evaluate(async({language,theme})=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language});document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;window.dispatchEvent(new Event('geod:desktop-settings-open'));},{language,theme});
    const dialog=page.getByRole('dialog');await dialog.getByRole('switch').first().waitFor();
    await page.setViewportSize({width:1000,height:720});
    await page.waitForFunction(()=>document.querySelector('[role=dialog]')?.getBoundingClientRect().width>400);
    const layout=await dialog.evaluate(element=>{
      const title=element.querySelector('h2').getBoundingClientRect(),close=element.querySelector('.dialog-heading button').getBoundingClientRect(),bounds=element.getBoundingClientRect();
      return {width:bounds.width,height:bounds.height,titleY:title.y+title.height/2,closeY:close.y+close.height/2,closeRight:close.right,dialogRight:bounds.right,overflow:document.documentElement.scrollWidth>innerWidth,dialogOverflow:element.scrollWidth>element.clientWidth};
    });
    assert(Math.abs(layout.titleY-layout.closeY)<3,'Title and close control should share one row');
    assert(layout.closeRight>layout.dialogRight-45,'Close control should align with the right edge');
    assert.equal(layout.overflow,false);assert.equal(layout.dialogOverflow,false);assert(layout.height<=672);
    const settings=await page.evaluate(async()=>{const {api}=await import('/src/api.ts');return api.desktopSettings();});assert.equal(settings.updateConfigured,false);
    assert.equal(await dialog.getByRole('button',{name:/^检查更新$|^Check for updates$/}).isDisabled(),true);
    const channelMessage=await page.evaluate(async()=>{const {t}=await import('/src/i18n.ts');return t('正式更新渠道尚未发布。');});assert(await dialog.getByText(channelMessage,{exact:true}).count());
    await page.screenshot({path:path.join(output,`settings-${theme}-${language}-layout.png`)});cases.push({language,theme,...layout});
    await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
  }
  assert.deepEqual(errors,[]);
  const report={passed:true,actualDesktop:true,unpublishedChannelShownHonestly:true,cases,pageErrors:errors};fs.writeFileSync(path.join(output,'layout-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
  await page.keyboard.press('Escape').catch(()=>{});
  await page.evaluate(async original=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences(original.language?JSON.parse(original.language):{language:'auto',replyLanguage:'auto'});document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},original).catch(()=>{});
  await page.setViewportSize({width:original.width,height:original.height});await browser.close();
}

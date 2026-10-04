import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);
await page.locator('textarea:not([disabled])').waitFor();
const output=path.resolve('artifacts/product-gaps-20261004/locale-ui');fs.mkdirSync(output,{recursive:true});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const original=await page.evaluate(()=>({language:localStorage.getItem('geod-agent-language-v1'),theme:localStorage.getItem('geod-agent-theme')}));
async function open(){await page.evaluate(()=>window.dispatchEvent(new Event('geod-language-open')));await page.getByRole('dialog').waitFor();}
async function choose(label,option){await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option',{name:option,exact:true}).click();}
try{
  await open();await choose(/界面语言|Interface language/,'English');
  await page.getByRole('dialog').getByRole('heading',{name:'Language',exact:true}).waitFor();
  await choose('AI reply language','English');
  const contentBefore=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus();return JSON.parse(accountChatStore(localStateStore,auth.userId).getItem(CHAT_LIST_KEY)??'[]').flatMap(chat=>chat.display.filter(message=>message.role==='user'||message.role==='assistant').map(message=>({id:message.id,content:message.content})));});
  await page.screenshot({path:path.join(output,'language-settings-en-verified.png')});
  await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
  await page.reload();await page.locator('textarea:not([disabled])').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
  await open();assert.equal(await page.getByRole('combobox',{name:'Interface language',exact:true}).textContent(),'English');assert.equal(await page.getByRole('combobox',{name:'AI reply language',exact:true}).textContent(),'English');
  await choose('Interface language','简体中文');await page.getByRole('dialog').getByRole('heading',{name:'语言',exact:true}).waitFor();
  await page.getByRole('dialog').getByRole('button',{name:'完成',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.lang),'zh-CN');
  const contentAfter=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');const auth=await api.authStatus();return JSON.parse(accountChatStore(localStateStore,auth.userId).getItem(CHAT_LIST_KEY)??'[]').flatMap(chat=>chat.display.filter(message=>message.role==='user'||message.role==='assistant').map(message=>({id:message.id,content:message.content})));});
  assert.deepEqual(contentAfter,contentBefore);
  const auto=await page.evaluate(async()=>{const {setLanguagePreferences,getLocale}=await import('/src/i18n.ts');const system=navigator.language;setLanguagePreferences({language:'auto'});return{system,actual:getLocale(),expected:system.toLowerCase().startsWith('zh')?'zh-CN':'en'};});assert.equal(auto.actual,auto.expected);
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});});
  await page.setViewportSize({width:1000,height:720});await page.screenshot({path:path.join(output,'conversation-en-narrow.png')});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.equal(overflow,false);
  await open();await page.screenshot({path:path.join(output,'language-en-narrow.png')});await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
  const report={passed:true,interfaceSwitchesImmediately:true,replyLanguageSaved:true,persistedAfterReload:true,savedUserAndAiTextPreserved:true,followsSystem:auto,narrowWindow:{width:1000,height:720,horizontalOverflow:false},pageErrors:errors};assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'language-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
  await page.setViewportSize({width:1440,height:900});await page.evaluate(async original=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences(original.language?JSON.parse(original.language):{language:'auto',replyLanguage:'auto'});},original).catch(()=>{});await page.reload().catch(()=>{});await browser.close();
}

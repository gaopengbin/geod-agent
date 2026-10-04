/** Resume the verified package after a test locator matched the wrong button. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
const root=path.resolve("artifacts/product-gaps-20261004/plugin-marketplaces");
const file=path.join(root,"native-result.json"),report=JSON.parse(fs.readFileSync(file,"utf8")),catalog=JSON.parse(fs.readFileSync(path.join(root,"actual-community-catalog.json"),"utf8"));
assert.equal(report.cases.length,6);
fs.copyFileSync(file,path.join(root,"native-locator-failure.json"));
const installedId=report.cases[5].installed.id;
const {chromium}=await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const browser=await chromium.connectOverCDP("http://127.0.0.1:9233"),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(":1420"));assert(page);
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const wait=async(condition,label)=>{const end=Date.now()+140000;while(Date.now()<end){const value=await condition();if(value)return value;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error("Timeout: "+label);};
const passed=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
let original,customId;
try{
  original=await page.evaluate(async()=>{
    const {api}=await import("/src/api.ts"),{localStateStore,flushLocalState}=await import("/src/local-state.ts"),{accountChatStore,CHAT_LIST_KEY}=await import("/src/pending-generations.ts");
    await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);
    return{userId:auth.userId,active:store.getItem("geod-agent-active-conversation-0.1"),chatIds:JSON.parse(store.getItem(CHAT_LIST_KEY)||"[]").map(c=>c.conversationId),language:localStorage.getItem("geod-agent-language-v1"),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight};
  });
  const plugins=(await rpc("plugins_list")).plugins,installed=plugins.find(p=>p.id===installedId);assert(installed);assert.equal(installed.source.commit,catalog.commit);
  const baselineIds=plugins.filter(p=>p.id!==installedId).map(p=>p.id);
  fs.writeFileSync(path.join(root,"restart-state.json"),JSON.stringify({installedId,original,baselineIds,partial:true},null,2));
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import("/src/i18n.ts");setLanguagePreferences({language:"zh-CN"});document.documentElement.dataset.theme="dark";document.documentElement.style.colorScheme="dark";});
  await page.setViewportSize({width:1000,height:720});
  await page.getByRole("button",{name:"技能与连接器",exact:true}).click();await page.getByRole("button",{name:"插件",exact:true}).click();
  await page.locator(".plugin-tabs").getByRole("button",{name:/^已添加/}).click();
  const installedRow=page.locator(".memory-row").filter({hasText:"ReviewOps Auditor"});
  await installedRow.getByRole("button",{name:"启用",exact:true}).click();
  await wait(async()=>(await rpc("plugins_list")).plugins.find(p=>p.id===installedId)?.enabledSkills===4,"Actual plugin enabled");
  passed("Actual installed-plugin control enables all four namespaced skills",{pluginId:installedId});
  await page.getByRole("button",{name:"浏览插件",exact:true}).click();await page.getByRole("button",{name:"添加目录",exact:true}).click();
  await page.getByRole("dialog").getByRole("textbox").fill("openai/community-plugins@"+catalog.commit);await page.getByRole("dialog").getByRole("button",{name:"添加目录",exact:true}).click();
  await page.getByRole("dialog").waitFor({state:"hidden",timeout:120000});
  const custom=await wait(async()=>(await rpc("plugin_marketplaces_list")).marketplaces.find(m=>!m.builtin&&m.reference===catalog.commit),"Custom pinned catalog");customId=custom.id;
  passed("Actual add-catalog form connects a pinned GitHub revision",{id:custom.id,repository:custom.repository,commit:custom.commit});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import("/src/i18n.ts");setLanguagePreferences({language:"en"});document.documentElement.dataset.theme="light";document.documentElement.style.colorScheme="light";});
  await page.getByRole("textbox",{name:"Search plugins"}).fill("reviewops");await page.screenshot({path:path.join(root,"actual-catalog-light-en-1000.png")});
  assert.equal(await page.getByRole("button",{name:"Add catalog",exact:true}).count(),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  passed("Actual English light narrow catalog uses translated controls without horizontal overflow",{viewport:{width:1000,height:720}});
  fs.writeFileSync(path.join(root,"restart-state.json"),JSON.stringify({installedId,customId,original,baselineIds},null,2));
  delete report.error;report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));throw error;}
finally{
  if(original){await page.evaluate(async original=>{const {setLanguagePreferences}=await import("/src/i18n.ts");if(original.language)setLanguagePreferences(JSON.parse(original.language));document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},{language:original.language,theme:original.theme}).catch(()=>{});await page.setViewportSize({width:original.width,height:original.height}).catch(()=>{});}
  await browser.close();
}

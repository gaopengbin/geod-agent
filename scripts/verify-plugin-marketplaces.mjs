/** Real public catalogs, native install snapshots and the actual desktop UI. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root=path.resolve("artifacts/product-gaps-20261004/plugin-marketplaces");
fs.mkdirSync(root,{recursive:true});
const {chromium}=await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const browser=await chromium.connectOverCDP("http://127.0.0.1:9233");
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(":1420"));
assert(page);await page.locator(".conversation-account-trigger").waitFor();
const file=path.join(root,"native-result.json"),report={passed:false,cases:[]},ids=[],stages=[];
const rpc=async(command,args={})=>{
  const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});
  if(!result.ok)throw result.error;return result.value;
};
const passed=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(condition,label,timeout=170000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await condition();if(value)return value;await delay(250);}throw new Error("Timeout: "+label);};
let original,installedId,customId;
if(fs.existsSync(file))fs.copyFileSync(file,path.join(root,"native-attempt-"+Date.now()+".json"));
try{
  original=await page.evaluate(async()=>{
    const {api}=await import("/src/api.ts"),{localStateStore,flushLocalState}=await import("/src/local-state.ts"),{accountChatStore,CHAT_LIST_KEY}=await import("/src/pending-generations.ts");
    await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);
    return{userId:auth.userId,active:store.getItem("geod-agent-active-conversation-0.1"),chatIds:JSON.parse(store.getItem(CHAT_LIST_KEY)||"[]").map(c=>c.conversationId),language:localStorage.getItem("geod-agent-language-v1"),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight};
  });
  const baseline=(await rpc("plugins_list")).plugins;
  const listed=(await rpc("plugin_marketplaces_list")).marketplaces;
  const official=listed.find(item=>item.repository==="openai/plugins"),community=listed.find(item=>item.repository==="openai/community-plugins");
  assert(official&&community);passed("Official and community catalogs are available before installation",{catalogs:listed.map(m=>({id:m.id,repository:m.repository}))});
  const upstream=await rpc("plugin_marketplace_refresh",{id:official.id});
  assert(upstream.entries.length>=60);assert.equal(upstream.commit.length,40);
  const linear=upstream.entries.find(e=>e.name==="linear");assert.equal(linear.displayName,"Linear");assert(linear.components.includes("apps"));
  fs.writeFileSync(path.join(root,"actual-official-catalog.json"),JSON.stringify(upstream,null,2));
  passed("Actual official GitHub catalog loads manifest names, components and a pinned commit",{entries:upstream.entries.length,commit:upstream.commit});
  const catalog=await rpc("plugin_marketplace_refresh",{id:community.id});
  assert(catalog.entries.some(e=>e.name==="reviewops-auditor-benchmark"&&!e.unavailableReason));
  fs.writeFileSync(path.join(root,"actual-community-catalog.json"),JSON.stringify(catalog,null,2));
  passed("Actual community catalog includes installable independent skill packages",{entries:catalog.entries.length,commit:catalog.commit});
  let unsupported;
  try{await rpc("plugin_marketplace_prepare",{marketplaceId:official.id,name:"linear"});throw new Error("An unmapped App plugin was accepted");}catch(error){unsupported=error;assert.equal(error.code,"PLUGIN_COMPONENT_UNSUPPORTED");}
  assert.deepEqual((await rpc("plugins_list")).plugins.map(p=>p.id),baseline.map(p=>p.id));
  passed("A registered App package reports its missing mapping and does not claim installation",{error:unsupported});
  const prepared=await rpc("plugin_marketplace_prepare",{marketplaceId:community.id,name:"reviewops-auditor-benchmark"});stages.push(prepared.stageId);
  assert.equal(prepared.bundle.skills.length,4);assert(prepared.bundle.skills.every(s=>s.name.length<=64));assert.equal(prepared.bundle.source.commit,catalog.commit);
  const stageFolder=path.join(process.env.APPDATA,"dev.geod-agent.desktop","cache","plugin-marketplace-staging");
  const ownerFolders=fs.readdirSync(stageFolder,{withFileTypes:true}).filter(entry=>entry.isDirectory());
  const staged=ownerFolders.map(entry=>path.join(stageFolder,entry.name,prepared.stageId)).find(folder=>fs.existsSync(path.join(folder,"stage.json")));
  assert(staged);const skillFile=path.join(staged,"bundle","skills","normalize-review-runs","SKILL.md"),before=fs.readFileSync(skillFile);
  fs.appendFileSync(skillFile,"\nQA change after review\n");
  let changed;try{await rpc("plugin_marketplace_install",{stageId:prepared.stageId,expectedSha256:prepared.bundle.sha256,enabled:false});throw new Error("Changed package was accepted");}catch(error){changed=error;assert.equal(error.code,"PLUGIN_CHANGED");}
  fs.writeFileSync(skillFile,before);
  await rpc("plugin_marketplace_discard",{stageId:prepared.stageId});assert(!fs.existsSync(staged));
  passed("Pinned package resources and long upstream skill names survive preview; changed content is refused",{skills:prepared.bundle.skills.map(s=>s.name),sha256:prepared.bundle.sha256,error:changed});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import("/src/i18n.ts");setLanguagePreferences({language:"zh-CN"});document.documentElement.dataset.theme="dark";document.documentElement.style.colorScheme="dark";});
  await page.setViewportSize({width:1000,height:720});
  await page.getByRole("button",{name:"技能与连接器",exact:true}).click();
  await page.getByRole("button",{name:"插件",exact:true}).click();
  await page.getByRole("button",{name:"浏览插件",exact:true}).click();
  await page.getByRole("combobox",{name:"插件目录"}).click();await page.getByRole("option",{name:"Community Plugins",exact:true}).click();
  await page.getByRole("textbox",{name:"搜索插件"}).fill("reviewops");
  const row=page.locator(".plugin-catalog-row").filter({hasText:"ReviewOps Auditor"});
  await row.waitFor();assert.equal(await page.locator(".plugin-catalog-row").count(),1);
  await page.screenshot({path:path.join(root,"actual-catalog-dark-1000.png")});
  await row.getByRole("button",{name:"检查",exact:true}).click();
  const dialog=page.getByRole("dialog");await dialog.waitFor({timeout:170000});
  await dialog.locator("summary").first().click();
  const bounds=await dialog.boundingBox();assert(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.y+bounds.height<=720);
  await page.screenshot({path:path.join(root,"actual-preview-dark-1000.png")});
  await dialog.getByRole("button",{name:"仅添加",exact:true}).click();await dialog.waitFor({state:"hidden",timeout:30000});
  const added=await wait(async()=>(await rpc("plugins_list")).plugins.find(p=>p.name==="reviewops-auditor-benchmark"),"Actual UI import");
  assert(!baseline.some(p=>p.id===added.id));installedId=added.id;ids.push(added.id);assert.equal(added.enabledSkills,0);assert.equal(added.source.commit,catalog.commit);
  passed("Actual dark narrow UI filters, previews and imports a community package without enabling it",{installed:added});
  fs.writeFileSync(path.join(root,"restart-state.json"),JSON.stringify({installedId,original,baselineIds:baseline.map(p=>p.id),partial:true},null,2));
  await page.locator(".plugin-tabs").getByRole("button",{name:/^已添加/}).click();
  const installedRow=page.locator(".memory-row").filter({hasText:"ReviewOps Auditor"});
  await installedRow.getByRole("button",{name:"启用",exact:true}).click();
  await wait(async()=>(await rpc("plugins_list")).plugins.find(p=>p.id===added.id)?.enabledSkills===4,"Actual plugin enabled");
  passed("Actual installed-plugin control enables all four namespaced skills",{pluginId:added.id});
  await page.getByRole("button",{name:"浏览插件",exact:true}).click();
  await page.getByRole("button",{name:"添加目录",exact:true}).click();
  await page.getByRole("dialog").getByRole("textbox").fill("openai/community-plugins@"+catalog.commit);
  await page.getByRole("dialog").getByRole("button",{name:"添加目录",exact:true}).click();
  await page.getByRole("dialog").waitFor({state:"hidden",timeout:120000});
  const custom=await wait(async()=>(await rpc("plugin_marketplaces_list")).marketplaces.find(m=>!m.builtin&&m.reference===catalog.commit),"Custom pinned catalog");customId=custom.id;
  passed("Actual add-catalog form connects a pinned GitHub revision",{id:custom.id,repository:custom.repository,commit:custom.commit});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import("/src/i18n.ts");setLanguagePreferences({language:"en"});document.documentElement.dataset.theme="light";document.documentElement.style.colorScheme="light";});
  await page.getByRole("textbox",{name:"Search plugins"}).fill("reviewops");
  await page.screenshot({path:path.join(root,"actual-catalog-light-en-1000.png")});
  assert.equal(await page.getByRole("button",{name:"Add catalog",exact:true}).count(),1);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  passed("Actual English light narrow catalog uses translated controls without horizontal overflow",{viewport:{width:1000,height:720}});
  fs.writeFileSync(path.join(root,"restart-state.json"),JSON.stringify({installedId,customId,original,baselineIds:baseline.map(p=>p.id)},null,2));
  report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));
}catch(error){
  report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));
  await page.screenshot({path:path.join(root,"native-failure.png")}).catch(()=>{});
  throw error;
}finally{
  for(const stageId of stages)await rpc("plugin_marketplace_discard",{stageId}).catch(()=>{});
  if(original){
    await page.evaluate(async original=>{const {setLanguagePreferences}=await import("/src/i18n.ts");if(original.language)setLanguagePreferences(JSON.parse(original.language));document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},{language:original.language,theme:original.theme}).catch(()=>{});
    await page.setViewportSize({width:original.width,height:original.height}).catch(()=>{});
  }
  await browser.close();
}

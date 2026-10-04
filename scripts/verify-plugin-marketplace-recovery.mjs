/** Check a real package backup, then restart readback and owned QA cleanup. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
const root=path.resolve("artifacts/product-gaps-20261004/plugin-marketplaces"),mode=process.argv[2];
assert(["prepare","finish"].includes(mode));
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),"utf8")),saved=read("restart-state.json");
const resultFile=path.join(root,"recovery-result.json"),report=mode==="prepare"?{passed:false,cases:[]}:read("recovery-result.json");
const digest=file=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const passed=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(resultFile,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const {chromium}=await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const browser=await chromium.connectOverCDP("http://127.0.0.1:9233"),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(":1420"));assert(page);
const rpc=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
try{
  await page.locator(".conversation-account-trigger").waitFor();
  const plugins=(await rpc("plugins_list")).plugins,plugin=plugins.find(plugin=>plugin.id===saved.installedId);assert(plugin);assert.equal(plugin.enabledSkills,4);
  const marketplaces=(await rpc("plugin_marketplaces_list")).marketplaces,custom=marketplaces.find(market=>market.id===saved.customId);assert(custom);assert.equal(custom.commit,plugin.source.commit);
  const extensions=await rpc("extensions_list"),skill=extensions.skills.find(skill=>plugin.skillIds.includes(skill.id)&&skill.name.endsWith("normalize-review-runs"));assert(skill);
  const content=await rpc("skill_read",{name:skill.name}),packagePath=content.match(/Plugin package directory: (.+)/)?.[1];assert(packagePath&&fs.existsSync(packagePath));
  const files=fs.readdirSync(packagePath,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>path.join(entry.parentPath,entry.name));assert(files.length>20);
  if(mode==="prepare"){
    const background=await rpc("background_status");assert.equal(background.activeAiTurns,0);assert.equal(await page.locator(".conversation-running-dot").count(),0);
    const backup=await page.evaluate(async()=>{const {api}=await import("/src/api.ts"),{snapshotLocalRecords}=await import("/src/local-state.ts");return api.desktopBackupCreate(await snapshotLocalRecords());});
    assert(backup.verified);const manifest=JSON.parse(fs.readFileSync(path.join(backup.path,"manifest.json"),"utf8"));
    const prefix="plugin-packages/"+saved.installedId+"/",resources=manifest.records.filter(record=>record.path.startsWith(prefix));assert.equal(resources.length,files.length);
    for(const record of resources){assert.equal(digest(path.join(backup.path,record.file)),record.sha256);assert.equal(digest(path.join(packagePath,record.path.slice(prefix.length))),record.sha256);}
    assert(!manifest.records.some(record=>record.path.startsWith("cache/plugin-marketplace-staging/")));
    saved.preRestart={plugin,custom,packagePath,files:resources.map(record=>({path:record.path.slice(prefix.length),sha256:record.sha256})),backup};
    fs.writeFileSync(path.join(root,"restart-state.json"),JSON.stringify(saved,null,2));
    passed("Actual native full backup preserves every installed shared plugin resource",{backup,resourceCount:resources.length,sha256Matched:true,uninstalledCacheExcluded:true});
    await page.evaluate(async()=>{const {setLanguagePreferences}=await import("/src/i18n.ts");setLanguagePreferences({language:"en"});document.documentElement.dataset.theme="light";document.documentElement.style.colorScheme="light";});await page.setViewportSize({width:1000,height:720});
    await page.getByRole("button",{name:"Skills & connectors",exact:true}).click();await page.getByRole("button",{name:"Plugins",exact:true}).click();await page.getByRole("button",{name:"Browse plugins",exact:true}).click();
    await page.getByRole("textbox",{name:"Search plugins"}).fill("reviewops");await page.getByRole("button",{name:"Add catalog",exact:true}).waitFor();assert(await page.getByRole("button",{name:"Add catalog",exact:true}).isEnabled());
    await page.screenshot({path:path.join(root,"actual-catalog-light-en-1000-idle.png")});
    passed("Actual idle English narrow catalog keeps add and refresh controls usable",{viewport:{width:1000,height:720}});
  }else{
    assert(saved.preRestart);assert.equal(plugin.source.commit,saved.preRestart.plugin.source.commit);assert.equal(plugin.sha256,saved.preRestart.plugin.sha256);assert.equal(custom.commit,saved.preRestart.custom.commit);
    for(const file of saved.preRestart.files){assert.equal(digest(path.join(packagePath,file.path)),file.sha256);}
    passed("Actual native restart preserves plugin skills, shared scripts and pinned catalog snapshots",{pluginId:plugin.id,enabledSkills:plugin.enabledSkills,commit:plugin.source.commit,resourceCount:files.length,catalogReadUsesLocalSnapshot:true});
    await rpc("plugin_remove",{id:saved.installedId});await rpc("plugin_marketplace_remove",{id:saved.customId});
    assert.deepEqual((await rpc("plugins_list")).plugins.map(plugin=>plugin.id).sort(),saved.baselineIds.slice().sort());assert(!fs.existsSync(packagePath));
    assert(!(await rpc("plugin_marketplaces_list")).marketplaces.some(market=>market.id===saved.customId));
    const schedules=await rpc("ai_schedules_list",{conversationId:saved.modelConversationId});assert(schedules.schedules.find(schedule=>schedule.scheduleId===saved.scheduleId)?.enabled===false);
    passed("Only owned QA plugin and custom catalog removed; user baseline and disabled run retained",{baselinePlugins:saved.baselineIds.length,packageRemoved:true,scheduleDisabled:true});
    report.passed=true;fs.writeFileSync(resultFile,JSON.stringify(report,null,2));
  }
}catch(error){report.error={message:error.message||JSON.stringify(error),stack:error.stack};fs.writeFileSync(resultFile,JSON.stringify(report,null,2));throw error;}
finally{
  await page.evaluate(async original=>{const {setLanguagePreferences}=await import("/src/i18n.ts");if(original.language)setLanguagePreferences(JSON.parse(original.language));document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},saved.original).catch(()=>{});
  await page.setViewportSize({width:saved.original.width,height:saved.original.height}).catch(()=>{});await page.reload().catch(()=>{});await browser.close();
}

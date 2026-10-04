/** An actual hosted Codex turn and companion turn use the installed upstream fixture. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {pathToFileURL} from "node:url";
const root=path.resolve("artifacts/product-gaps-20261004/plugin-marketplaces"),saved=JSON.parse(fs.readFileSync(path.join(root,"restart-state.json"),"utf8"));
const expected=JSON.parse(fs.readFileSync(path.join(root,"independent-fixture-result.json"),"utf8"));
assert.equal(expected.status,"COMPLETE");assert.equal(expected.bundles.length,2);assert(expected.bundles.every(b=>b.acceptedRecordCount===80));
const {chromium}=await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const browser=await chromium.connectOverCDP("http://127.0.0.1:9233"),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(":1420"));assert(page);
const file=path.join(root,"model-result.json"),report={passed:false,cases:[]};
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const state=()=>page.evaluate(async()=>{
  const {api}=await import("/src/api.ts"),{localStateStore,flushLocalState}=await import("/src/local-state.ts"),{accountChatStore,CHAT_LIST_KEY}=await import("/src/pending-generations.ts");
  await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem("geod-agent-active-conversation-0.1"),chats:JSON.parse(store.getItem(CHAT_LIST_KEY)||"[]")};
});
const wait=async(condition,label,timeout=220000)=>{const end=Date.now()+timeout;while(Date.now()<end){const value=await condition();if(value)return value;await new Promise(resolve=>setTimeout(resolve,400));}throw new Error("Timeout: "+label);};
const passed=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
let uiId,scheduleId,original;
try{
  await page.locator(".conversation-account-trigger").waitFor();
  original={...(await state()),...(await page.evaluate(()=>({language:localStorage.getItem("geod-agent-language-v1"),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight})))};
  const plugin=(await rpc("plugins_list")).plugins.find(p=>p.id===saved.installedId);assert(plugin&&plugin.enabledSkills===4);
  const extensions=await rpc("extensions_list"),skill=extensions.skills.find(s=>plugin.skillIds.includes(s.id)&&s.name.endsWith("normalize-review-runs"));assert(skill);
  const content=await rpc("skill_read",{name:skill.name});assert(content.includes("/plugin-packages/"+plugin.id));assert(!content.includes("<installed-plugin-root>"));
  passed("Actual restarted native Skill read resolves its installed shared scripts",{pluginId:plugin.id,skillName:skill.name});
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import("/src/i18n.ts");setLanguagePreferences({language:"zh-CN"});document.documentElement.dataset.theme="dark";document.documentElement.style.colorScheme="dark";});
  await page.locator(".sidebar-new-chat").click();
  uiId=await wait(async()=>{const current=await state();return current.chats.find(c=>!original.chats.some(old=>old.conversationId===c.conversationId))?.conversationId;},"Actual QA conversation");
  const workspace=await rpc("workspace_get",{conversationId:uiId});
  await rpc("workspace_set",{conversationId:uiId,directory:workspace.directory,permission:"fullAccess"});
  await rpc("ai_model_select",{conversationId:uiId,channelId:"hosted",modelId:"hosted"});
  await page.reload();await page.getByRole("textbox",{name:"发送给 GeoD Agent"}).waitFor();
  const prompt="插件真实验收：明确使用已启用的 "+skill.name+"（$normalize-review-runs）技能，运行插件自带的 synthetic 样例规范化流程。只处理插件自带样例，不读取或改动我们的项目资料。请根据实际执行结果简短汇总总体状态、两组 bundle 名称及各自接受、拒绝、重复记录数；说明它是合成样例。";
  await page.getByRole("textbox",{name:"发送给 GeoD Agent"}).fill(prompt);await page.getByRole("button",{name:"发送消息",exact:true}).click();
  const chat=await wait(async()=>{const chat=(await state()).chats.find(c=>c.conversationId===uiId);return chat&&!chat.pendingId&&chat.messages.at(-1)?.role==="assistant"&&!(await page.getByRole("button",{name:"停止回复",exact:true}).count())?chat:null;},"Actual model uses the plugin");
  fs.writeFileSync(path.join(root,"actual-model-chat.json"),JSON.stringify(chat,null,2));
  const commands=chat.display.filter(item=>item.itemType==="commandExecution"&&item.content.includes("reviewops.mjs"));
  assert(commands.length&&commands.some(item=>item.toolStatus==="success"),"No completed plugin command in actual model trace");
  const answer=chat.messages.at(-1).content;assert(answer.includes("portable-core")&&answer.includes("best-system")&&answer.includes("80"));
  assert(chat.codexContext?.inputTokens>0);
  await page.setViewportSize({width:1000,height:720});await page.screenshot({path:path.join(root,"actual-model-dark-1000.png")});
  passed("Real Codex and DeepSeek discover the installed skill and execute its actual bundled sample",{conversationId:uiId,commands:commands.map(c=>c.content),actualAnswer:answer,inputTokens:chat.codexContext.inputTokens});
  const schedule=await rpc("ai_schedules_create",{conversationId:uiId,name:"Actual online plugin background QA",prompt:prompt,nextRunAt:new Date(Date.now()+1000).toISOString(),repeatSeconds:null,executionId:randomUUID()});scheduleId=schedule.scheduleId;
  saved.modelConversationId=uiId;saved.scheduleId=scheduleId;fs.writeFileSync(path.join(root,"restart-state.json"),JSON.stringify(saved,null,2));
  const background=await wait(async()=>{const status=await rpc("ai_schedules_list",{conversationId:uiId}),run=status.runs.find(r=>r.scheduleId===scheduleId);return run&&!["queued","running"].includes(run.state)?rpc("ai_schedules_run_events",{runId:run.runId}):null;},"Actual companion plugin turn");
  fs.writeFileSync(path.join(root,"actual-background-model.json"),JSON.stringify(background,null,2));
  assert.equal(background.run.state,"succeeded");assert.equal(background.run.result?.status,"completed");
  const backgroundAnswer=background.run.result.text;assert(backgroundAnswer.includes("portable-core")&&backgroundAnswer.includes("best-system")&&backgroundAnswer.includes("80"));
  assert(background.events.some(event=>event.method==="item/completed"&&event.params?.item?.type==="commandExecution"&&event.params.item.command.includes("reviewops.mjs")&&event.params.item.exitCode===0));
  await rpc("ai_schedules_set_enabled",{scheduleId,enabled:false});
  passed("Actual companion scheduled AI discovers and executes the same installed plugin",{runId:background.run.runId,actualAnswer:backgroundAnswer});
  report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));await page.screenshot({path:path.join(root,"model-failure.png")}).catch(()=>{});throw error;}
finally{
  if(scheduleId)await rpc("ai_schedules_set_enabled",{scheduleId,enabled:false}).catch(()=>{});
  if(uiId&&original){
    if((await state()).active===uiId&&await page.getByRole("button",{name:"停止回复",exact:true}).count()) {await page.getByRole("button",{name:"停止回复",exact:true}).click();await wait(async()=>!(await page.getByRole("button",{name:"停止回复",exact:true}).count()),"Stop owned QA turn",15000).catch(()=>{});}
    await page.evaluate(async({userId,active,uiId})=>{const {localStateStore,flushLocalState}=await import("/src/local-state.ts"),{accountChatStore,CHAT_LIST_KEY}=await import("/src/pending-generations.ts");const store=accountChatStore(localStateStore,userId),chats=JSON.parse(store.getItem(CHAT_LIST_KEY)||"[]");store.setItem(CHAT_LIST_KEY,JSON.stringify(chats.filter(c=>c.conversationId!==uiId)));store.setItem("geod-agent-active-conversation-0.1",active);await flushLocalState();},{userId:original.userId,active:original.active,uiId}).catch(()=>{});
    await page.reload();await page.locator(".conversation-account-trigger").waitFor();
  }
  if(original){await page.evaluate(async original=>{const {setLanguagePreferences}=await import("/src/i18n.ts");if(original.language)setLanguagePreferences(JSON.parse(original.language));document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},{language:original.language,theme:original.theme}).catch(()=>{});await page.setViewportSize({width:original.width,height:original.height}).catch(()=>{});}
  await browser.close();
}

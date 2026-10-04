/** Installed command approval, actual native resource checks and real desktop controls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-hooks'),fixture=path.join(root,'native package with spaces'),marker='HOOK_NATIVE_'+randomUUID().replaceAll('-','');
fs.mkdirSync(path.join(fixture,'hooks'),{recursive:true});
fs.mkdirSync(path.join(fixture,'.codex-plugin'),{recursive:true});
fs.writeFileSync(path.join(fixture,'.codex-plugin','plugin.json'),JSON.stringify({name:'geod-hooks-qa',version:'1.0.0',description:'Local lifecycle acceptance fixture',interface:{displayName:'Hook lifecycle acceptance'}}));
const command='node "'+'$'+'{PLUGIN_ROOT}/hooks/collect.mjs"';
const hooks=Object.fromEntries(['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop'].map(event=>[event,[{hooks:[{type:'command',command,timeout:15,...(event==='Stop'?{async:true}:{})}]}]]));
fs.writeFileSync(path.join(fixture,'hooks','hooks.json'),JSON.stringify({hooks}));
fs.writeFileSync(path.join(fixture,'hooks','collect.mjs'),"import fs from 'node:fs';let text='';process.stdin.setEncoding('utf8');for await(const part of process.stdin)text+=part;const event=JSON.parse(text);fs.appendFileSync(process.env.PLUGIN_DATA+'/events.jsonl',JSON.stringify({event,root:process.env.PLUGIN_ROOT,data:process.env.PLUGIN_DATA,bridgeVisible:Boolean(process.env.GEOD_CODEX_BRIDGE_TOKEN),at:new Date().toISOString()})+'\\n');if(event.hook_event_name==='SessionStart')console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'SessionStart',additionalContext:'Local plugin verification marker: "+marker+". This marker came from an actual SessionStart command.'}}));");
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const file=path.join(root,'native-result.json'),report={passed:false,cases:[]};
const pass=(name,details={})=>{report.cases.push({name,passed:true,...details});fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({name,passed:true}));};
const wait=async(condition,label)=>{const until=Date.now()+20000;while(Date.now()<until){const result=await condition();if(result)return result;await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('Timeout '+label);};
let original;
try{
 await page.locator('.conversation-account-trigger').waitFor();
 original=await page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return{userId:auth.userId,active:store.getItem('geod-agent-active-conversation-0.1'),chatIds:JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]').map(c=>c.conversationId),language:localStorage.getItem('geod-agent-language-v1'),theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight};});
 const baseline=(await rpc('plugins_list')).plugins;assert(!baseline.some(plugin=>plugin.name==='geod-hooks-qa'));
 const preview=await rpc('plugin_preview',{path:fixture});assert.equal(preview.hooks.length,5);assert.equal(preview.skills.length,0);assert.equal(preview.connectors.length,0);
 const installed=await rpc('plugin_import',{path:fixture,expectedSha256:preview.sha256,enabled:true});assert.equal(installed.hooksCount,5);assert.equal(installed.enabledHooks,0);assert.equal(installed.hooksReviewed,false);
 const installedRoot=path.join(process.env.APPDATA,'dev.geod-agent.desktop','plugin-packages',installed.id),dataRoot=path.join(process.env.APPDATA,'dev.geod-agent.desktop','plugin-data',installed.id);
 const saved={installedId:installed.id,sha256:preview.sha256,fixture,installedRoot,dataRoot,marker,original,baselineIds:baseline.map(plugin=>plugin.id)};fs.writeFileSync(path.join(root,'restart-state.json'),JSON.stringify(saved,null,2));
 assert(fs.existsSync(path.join(installedRoot,'hooks','collect.mjs')));assert(!fs.existsSync(path.join(dataRoot,'events.jsonl')));
 pass('Actual hook-only plugin imports without executing or enabling commands',{pluginId:installed.id,hooks:preview.hooks.map(group=>group.event)});
 const script=path.join(installedRoot,'hooks','collect.mjs'),before=fs.readFileSync(script);fs.appendFileSync(script,'\n// altered after review');
 let changed;try{await rpc('plugin_hooks_preview',{id:installed.id});throw new Error('Changed resources were accepted');}catch(error){changed=error;assert.equal(error.code,'PLUGIN_CHANGED');}finally{fs.writeFileSync(script,before);}
 pass('Actual installed resource change refuses old approval before execution',{error:changed});
 await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});document.documentElement.dataset.theme='dark';document.documentElement.style.colorScheme='dark';});
 await page.setViewportSize({width:1000,height:720});await page.getByRole('button',{name:'技能与连接器',exact:true}).click();await page.getByRole('button',{name:'插件',exact:true}).click();
 const row=page.locator('.memory-row').filter({hasText:'Hook lifecycle acceptance'});await row.waitFor();await row.getByRole('button',{name:'自动化 0/5',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.waitFor();assert.equal(await dialog.locator('.plugin-hook-row').count(),5);assert.equal(await dialog.getByRole('button',{name:'启用自动化',exact:true}).isEnabled(),false);
 const bounds=await dialog.boundingBox();assert(bounds&&bounds.y>=0&&bounds.y+bounds.height<=720);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({path:path.join(root,'actual-review-dark-1000.png')});
 await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'启用自动化',exact:true}).click();await dialog.waitFor({state:'hidden'});
 const enabled=await wait(async()=>(await rpc('plugins_list')).plugins.find(plugin=>plugin.id===installed.id)?.enabledHooks===5,'Actual native enable');assert(enabled);assert(!fs.existsSync(path.join(dataRoot,'events.jsonl')));
 pass('Actual dark narrow review requires explicit consent; enabling alone does not execute scripts');
 await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});document.documentElement.dataset.theme='light';document.documentElement.style.colorScheme='light';});
 await row.getByRole('button',{name:'Automation 5/5',exact:true}).click();await dialog.waitFor();assert.equal(await dialog.getByRole('button',{name:'Disable automation',exact:true}).count(),1);await page.screenshot({path:path.join(root,'actual-review-light-en-1000.png')});
 await dialog.getByRole('button',{name:'Disable automation',exact:true}).click();await dialog.waitFor({state:'hidden'});await wait(async()=>(await rpc('plugins_list')).plugins.find(plugin=>plugin.id===installed.id)?.enabledHooks===0,'Disable automation');
 await row.getByRole('button',{name:'Automation 0/5',exact:true}).click();await dialog.waitFor();assert.equal(await dialog.getByRole('button',{name:'Enable automation',exact:true}).isEnabled(),false);await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'Enable automation',exact:true}).click();await dialog.waitFor({state:'hidden'});
 pass('Actual English light controls disable automation and require renewed consent to enable it');
 report.passed=true;fs.writeFileSync(file,JSON.stringify(report,null,2));
}catch(error){report.error={message:error.message||JSON.stringify(error),code:error.code,stack:error.stack};fs.writeFileSync(file,JSON.stringify(report,null,2));await page.screenshot({path:path.join(root,'native-failure.png')}).catch(()=>{});throw error;}
finally{if(original){await page.evaluate(async original=>{const {setLanguagePreferences}=await import('/src/i18n.ts');if(original.language)setLanguagePreferences(JSON.parse(original.language));document.documentElement.dataset.theme=original.theme;document.documentElement.style.colorScheme=original.theme;},{language:original.language,theme:original.theme});await page.setViewportSize({width:original.width,height:original.height});}await browser.close();}

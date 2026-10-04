/** Update only the recorded QA package after its deliberately short deadline. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-mcp-hooks'),stateFile=path.join(root,'restart-state.json'),saved=JSON.parse(fs.readFileSync(stateFile,'utf8'));
assert(!saved.baselineIds.includes(saved.installedId));fs.copyFileSync(path.join(root,'actual-model-chat.json'),path.join(root,'initial-short-timeout-chat.json'));fs.copyFileSync(path.join(root,'model-result.json'),path.join(root,'initial-short-timeout-result.json'));
const document=JSON.parse(fs.readFileSync(path.join(saved.fixture,'hooks','hooks.json'),'utf8'));for(const groups of Object.values(document.hooks))for(const group of groups)for(const handler of group.hooks)handler.timeout=10;fs.writeFileSync(path.join(saved.fixture,'hooks','hooks.json'),JSON.stringify(document));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href),browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
const rpc=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
try{
 const original=(await rpc('plugins_list')).plugins.find(p=>p.id===saved.installedId);assert.equal(original.name,'geod-mcp-hooks-qa');assert.equal(original.sha256,saved.sha256);
 await rpc('plugin_remove',{id:saved.installedId});assert(!fs.existsSync(saved.installedRoot));const preview=await rpc('plugin_preview',{path:saved.fixture}),installed=await rpc('plugin_import',{path:saved.fixture,expectedSha256:preview.sha256,enabled:true});assert.equal(installed.enabledHooks,0);
 saved.initialPackage={id:saved.installedId,sha256:saved.sha256};saved.installedId=installed.id;saved.sha256=preview.sha256;saved.installedRoot=path.join(process.env.APPDATA,'dev.geod-agent.desktop','plugin-packages',installed.id);fs.writeFileSync(stateFile,JSON.stringify(saved,null,2));
 await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});await page.getByRole('button',{name:'技能与连接器',exact:true}).click();await page.getByRole('button',{name:'插件',exact:true}).click();await page.locator('.memory-row').filter({hasText:'MCP lifecycle acceptance'}).getByRole('button',{name:'自动化 0/5',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'启用自动化',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await page.reload();await page.locator('.conversation-account-trigger').waitFor();console.log(JSON.stringify({reviewedReplacement:true,pluginId:installed.id}));
}finally{await browser.close();}

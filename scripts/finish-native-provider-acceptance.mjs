/** Finish the UI-only test-controller correction; do not repeat paid requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=path.resolve('artifacts/product-gaps-20261004/native-providers'),report=JSON.parse(fs.readFileSync(path.join(output,'result.json'),'utf8'));
assert.equal(report.cases.length,7);assert(report.cases.every(c=>c.passed));assert(report.error?.message.includes('Back to chat'));
fs.writeFileSync(path.join(output,'ui-controller-failed-attempt.json'),JSON.stringify(report,null,2));
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
const original=await page.evaluate(async()=>{const {localStateEntries}=await import('/src/local-state.ts');return{language:localStorage.getItem('geod-agent-language-v1'),activeChats:localStateEntries().filter(([key])=>key.includes('geod-agent-active-conversation-0.1'))};});
try{
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});});
  if(!await page.getByRole('button',{name:'Back to conversation',exact:true}).count()){
    await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:'Models & Channels',exact:true}).click();
  }
  const back=page.getByRole('button',{name:'Back to conversation',exact:true});await back.waitFor();await back.click();await page.locator('textarea:not([disabled])').waitFor();
  assert.deepEqual(await page.evaluate(async()=>{const {localStateEntries}=await import('/src/local-state.ts');return localStateEntries().filter(([key])=>key.includes('geod-agent-active-conversation-0.1'));}),original.activeChats);
  const channels=await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('ai_channels_list'));
  assert(!channels.channels.some(c=>c.name.startsWith('原生协议验收')),'Temporary provider key/channel remains');
  const wire=JSON.parse(fs.readFileSync(path.join(output,'wire-evidence.json'),'utf8')),audit=JSON.parse(fs.readFileSync(path.join(output,'credential-audit.json'),'utf8'));
  for(const protocol of ['anthropic','gemini']){
    const records=wire.records.filter(r=>r.protocol===protocol&&r.generationId);assert(records.length>=5);assert(records.every(r=>r.nativeAuthenticationValidated));assert(records.some(r=>r.replayedSignatureBlocks>0&&r.toolCalls.length===0));
    assert(records.every(r=>r.usage.prompt_tokens>0&&r.usage.completion_tokens>0));
  }
  assert.equal(audit.passed,true);
  report.cases.push({name:'Return to original user chat and remove temporary native vault keys',passed:true});
  report.harnessIssue='Initial controller used Back to chat instead of the actual Back to conversation label; seven completed cases retained, this final navigation corrected without new model requests.';
  delete report.error;report.passed=true;report.actualUpstreamRequests=wire.records.filter(r=>r.generationId).length;report.credentialAudit=audit;
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,cases:report.cases.length,actualUpstreamRequests:report.actualUpstreamRequests,credentialAudit:audit}));
}finally{
  if(original.language)await page.evaluate(async value=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences(JSON.parse(value));},original.language);
  await browser.close();
}

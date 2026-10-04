/** Verify original unit counts with a new actual model turn after the tool contract fix. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const root='artifacts/product-gaps-20261004/legacy-office',saved=JSON.parse(fs.readFileSync(root+'/qa-state.json','utf8'));
assert(!saved.baselineChatIds.includes(saved.conversationId));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');let page;
for(let attempt=0;attempt<100&&!page;attempt++){page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));if(!page)await new Promise(resolve=>setTimeout(resolve,300));}assert(page);await page.locator('.conversation-account-trigger').waitFor();
const state=()=>page.evaluate(async()=>{const {api}=await import('/src/api.ts'),{localStateStore,flushLocalState}=await import('/src/local-state.ts'),{accountChatStore,CHAT_LIST_KEY}=await import('/src/pending-generations.ts');await flushLocalState();const auth=await api.authStatus(),store=accountChatStore(localStateStore,auth.userId);return JSON.parse(store.getItem(CHAT_LIST_KEY)||'[]');});
try{
  await page.locator('[data-conversation-id="'+saved.conversationId+'"]').click();
  const before=(await state()).find(chat=>chat.conversationId===saved.conversationId);const count=before.display.length;
  const prompt='请重新调用 attachment_list，再用 attachment_read 实际核对 beijing-table.xls 和 beijing-slides.ppt。仅根据工具返回，给出 JSON 数组：每项包含 name、units、unitLabel；Excel 另含 B9 的已保存数值与公式，PPT 另含实际幻灯片顺序。只读附件。';
  await page.locator('textarea').fill(prompt);await page.locator('textarea').press('Enter');
  let chat,final;const deadline=Date.now()+180000;
  while(Date.now()<deadline){chat=(await state()).find(chat=>chat.conversationId===saved.conversationId);final=chat.display.slice(count).find(item=>item.role==='assistant'&&item.phase==='final');if(final)break;await new Promise(resolve=>setTimeout(resolve,1000));}assert(final);
  fs.writeFileSync(root+'/actual-unit-metadata-chat.json',JSON.stringify(chat,null,2));
  const first=final.content.indexOf('['),last=final.content.lastIndexOf(']');const rows=JSON.parse(final.content.slice(first,last+1));
  for(const [name,unitLabel] of [['beijing-table.xls','sheets'],['beijing-slides.ppt','slides']]){const row=rows.find(row=>row.name===name);assert(row);assert.equal(row.units,2);assert.equal(row.unitLabel,unitLabel);}
  const operations=chat.display.slice(count);assert(operations.some(item=>item.toolName==='attachment_list'));assert(operations.filter(item=>item.toolName==='attachment_read').length>=2);
  assert(/REORDERED_FIRST_SLIDE/.test(final.content)&&/ORIGINAL_FIRST_SLIDE/.test(final.content));
  assert.equal(chat.display.slice(0,count).filter(item=>item.phase==='final')[0].content,before.display.filter(item=>item.phase==='final')[0].content,'Do not rewrite the original model reply');
  fs.writeFileSync(root+'/unit-metadata-result.json',JSON.stringify({passed:true,cases:[{name:'Actual model reads XLS/PPT original unit counts and cached values after clarified character-read contract',passed:true,actualAnswer:final.content}]},null,2));
  console.log(JSON.stringify({passed:true,actualAnswer:final.content}));
}catch(error){console.error(error);process.exitCode=1;fs.writeFileSync(root+'/unit-metadata-failure.json',JSON.stringify({message:error.message,stack:error.stack},null,2));}finally{await browser.close();}

import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const output=path.resolve('artifacts/product-gaps-20261004/locale-ui');fs.mkdirSync(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
const cases=[],errors=[];page.on('pageerror',error=>errors.push(error.message));
const snapshot=async name=>{
  await page.waitForTimeout(400);
  const remaining=await page.evaluate(()=>{
    const result=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){
      const node=walker.currentNode,parent=node.parentElement,text=node.textContent?.trim();
      if(!text||!/[\u3400-\u9fff]/u.test(text)||!parent||parent.closest('.chat-markdown,.conversation-item,.workspace-collapse,.agent-header,.agent-user-message,.account-menu-identity'))continue;
      if(parent.getClientRects().length&&getComputedStyle(parent).visibility!=='hidden'&&!parent.closest('[hidden],[aria-hidden="true"]'))result.push({text,tag:parent.tagName,className:parent.className});
    }return result;
  });
  await page.screenshot({path:path.join(output,`${name}.png`)});cases.push({name,remaining});
};
try{
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});});
  await page.getByRole('button',{name:'New chat',exact:true}).waitFor();await snapshot('conversation-en');
  await page.locator('.sidebar-source').click();await snapshot('sources-en');
  await page.locator('.sidebar-extensions').click();await snapshot('extensions-en');
  await page.evaluate(()=>window.dispatchEvent(new Event('geod-language-open')));await snapshot('language-en');
  await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
  await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'zh-CN'});});
  await page.locator('.conversation-item.active').click().catch(()=>{});
  await page.getByRole('button',{name:'新对话',exact:true}).waitFor();await snapshot('conversation-zh');
  fs.writeFileSync(path.join(output,'inspection.json'),JSON.stringify({cases,errors},null,2));
  console.log(JSON.stringify({errors,cases:cases.map(item=>({name:item.name,remaining:item.remaining}))}));
}finally{await browser.close();}

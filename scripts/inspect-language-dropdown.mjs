import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.argv[2]).href),browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
await page.evaluate(()=>window.dispatchEvent(new Event('geod-language-open')));await page.getByRole('combobox').first().click();
console.log(JSON.stringify(await page.evaluate(()=>{
  const option=[...document.querySelectorAll('[role=option]')].find(element=>element.textContent==='English'),rect=option.getBoundingClientRect();
  const describe=element=>({tag:element.tagName,classes:element.className,z:getComputedStyle(element).zIndex,position:getComputedStyle(element).position,pointer:getComputedStyle(element).pointerEvents,rect:element.getBoundingClientRect().toJSON()});
  const parents=[];for(let node=option;node;node=node.parentElement)parents.push(describe(node));
  return{parents,atPoint:document.elementsFromPoint(rect.x+rect.width/2,rect.y+rect.height/2).map(describe)};
})));await page.screenshot({path:'artifacts/product-gaps-20261004/locale-ui/dropdown-debug.png'});await page.keyboard.press('Escape');await page.keyboard.press('Escape');await browser.close();

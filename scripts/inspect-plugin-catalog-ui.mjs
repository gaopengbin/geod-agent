import assert from "node:assert/strict";
import fs from "node:fs";
import {pathToFileURL} from "node:url";
const {chromium}=await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const browser=await chromium.connectOverCDP("http://127.0.0.1:9233"),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(":1420"));assert(page);
try{
  await page.getByRole("button",{name:"技能与连接器",exact:true}).click();await page.getByRole("button",{name:"插件",exact:true}).click();await page.getByRole("button",{name:"浏览插件",exact:true}).click();
  await page.getByRole("textbox",{name:"搜索插件"}).waitFor();
  const tabs=await page.locator(".plugin-tabs button").evaluateAll(buttons=>buttons.map(button=>({text:button.innerText,pressed:button.getAttribute("aria-pressed"),class:button.className,background:getComputedStyle(button).backgroundColor})));
  console.log(JSON.stringify(tabs));
  await page.getByRole("combobox",{name:"插件目录"}).click();const options=await page.getByRole("option").allTextContents();console.log(JSON.stringify(options));
  await page.getByRole("option",{name:"Community Plugins",exact:true}).click();await page.getByRole("textbox",{name:"搜索插件"}).fill("reviewops");await page.mouse.move(900,100);
  await page.locator(".plugin-catalog-row").filter({hasText:"ReviewOps Auditor"}).waitFor();
  await page.screenshot({path:"artifacts/product-gaps-20261004/plugin-marketplaces/actual-catalog-dark-idle.png"});
  fs.writeFileSync("artifacts/product-gaps-20261004/plugin-marketplaces/actual-catalog-tabs.json",JSON.stringify(tabs,null,2));
}finally{await page.reload().catch(()=>{});await browser.close();}

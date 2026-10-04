// Actual native cache commands through the test adapter; no fabricated cache state.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : "playwright");
const rpc=async(command,args={})=>{const result=await(await fetch("http://127.0.0.1:1421/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;};
const before=await rpc("cache_inventory");
const maintenance = !process.argv.includes("--no-maintenance");
if(maintenance) assert.equal(before.activeJobs.length,0,"Run this audit after imagery jobs finish");
const output=resolve("../../docs/implementation/evidence/cache-manager");mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:"msedge",headless:true});
const page=await browser.newPage({viewport:{width:1100,height:780},deviceScaleFactor:1});
const errors=[];page.on("pageerror",error=>errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:1420/test/cache-manager-harness.html");
  await page.getByText("当前保存位置",{exact:true}).waitFor();
  assert(await page.getByText(before.directory,{exact:true}).isVisible());
  if(maintenance){await page.getByRole("button",{name:"核验",exact:true}).click();await page.getByText("操作完成",{exact:true}).waitFor({timeout:120000});}
  await page.screenshot({path:resolve(output,"cache-light.png")});
  if(await page.getByRole("button",{name:"更改位置",exact:true}).isEnabled()){
    await page.getByRole("button",{name:"更改位置",exact:true}).click();
    await page.getByRole("textbox",{name:"新的缓存目录"}).fill(before.directory);
    await page.getByRole("button",{name:"检查目标",exact:true}).click();
    await page.getByText("目标目录已经存在，请选择新的目录名称",{exact:true}).waitFor();
    assert(await page.getByRole("button",{name:"开始迁移",exact:true}).isDisabled());
  }
  const rejection=await rpc("cache_relocation_preflight",{targetPath:before.directory});assert(rejection.blockers.length>0);
  await page.getByRole("button",{name:"关闭缓存设置",exact:true}).click();
  await page.getByRole("button",{name:"下载缓存",exact:true}).click();
  await page.getByText("当前保存位置",{exact:true}).waitFor();
  await page.goto("http://127.0.0.1:1420/test/cache-manager-harness.html?theme=dark");
  await page.getByText("当前保存位置",{exact:true}).waitFor();
  await page.screenshot({path:resolve(output,"cache-dark.png")});
  await page.setViewportSize({width:390,height:720});
  if(await page.getByRole("button",{name:"更改位置",exact:true}).isEnabled())await page.getByRole("button",{name:"更改位置",exact:true}).click();
  await page.screenshot({path:resolve(output,"cache-narrow.png")});
  const layout=await page.evaluate(()=>{const r=document.querySelector('[role="dialog"]').getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right};});
  assert(layout.scroll<=layout.width);assert(layout.left>=0&&layout.right<=layout.width);
  const after=await rpc("cache_inventory");assert.equal(after.directory,before.directory);assert.equal(errors.length,0,errors.join("\n"));
  writeFileSync(resolve(output,"acceptance.json"),JSON.stringify({pass:true,checkedAt:new Date().toISOString(),checks:["real native inventory",...(maintenance?["background SHA and decode verification"]:[]),"unchanged current cache directory","existing target preflight rejection","reopen","light dark narrow UI"],before,after,rejection,layout,errors},null,2));
  console.log("Cache manager native UI acceptance passed");
} finally {await browser.close();}

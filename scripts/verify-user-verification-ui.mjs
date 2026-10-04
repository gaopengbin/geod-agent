import {pathToFileURL} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('artifacts/product-gaps-20261004/user-verification');mkdirSync(output,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'});
const report={mode:'component fixture; not an actual MCP verification flow',cases:[]};
try{
 for(const theme of ['light','dark'])for(const language of ['zh-CN','en']){
  const page=await browser.newPage({viewport:{width:680,height:520}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:1420/test/user-verification-harness.html?theme=${theme}&language=${language}`);
  const card=page.locator('.codex-request-card');await card.waitFor();
  const text=await card.innerText();
  assert(text.includes(language==='en'?'Device identity verification':'设备身份验证'));
  assert(!text.includes('PRIVATE_CHALLENGE')&&!text.includes('PRIVATE_METADATA'));
  assert.equal(await card.getByRole('button').count(),1);
  await page.screenshot({path:join(output,`identity-${theme}-${language}.png`)});
  await card.getByRole('button',{name:language==='en'?'Cancel':'取消',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.fixtureResult),{action:'cancel',content:null,_meta:null});
  assert.deepEqual(errors,[]);
  report.cases.push({theme,language,passed:true,privateChallengeRendered:false,cancelOnly:true});
  await page.close();
 }
 report.passed=true;writeFileSync(join(output,'component-ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}

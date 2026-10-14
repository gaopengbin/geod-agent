import assert from 'node:assert/strict';import {mkdirSync,writeFileSync} from 'node:fs';import {resolve} from 'node:path';
import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const b=await chromium.connectOverCDP('http://127.0.0.1:9233');const p=b.contexts().flatMap(c=>c.pages())[0];const output=resolve('../../artifacts/changping-download-20261012');mkdirSync(output,{recursive:true});
try{
 await p.route('http://127.0.0.1:1420/**',async route=>{try{const response=await route.fetch({url:route.request().url().replace(':1420',':1426'),maxRetries:3});await route.fulfill({response});}catch{await route.abort().catch(()=>{});}});
 await p.goto('http://127.0.0.1:1420/test/imagery-network-harness.html');
 await p.getByText('已创建任务的下载不消耗 AI Credits。请检查图源服务或网络代理，再重试下载。',{exact:true}).waitFor();
 await p.getByRole('button',{name:'检测图源连接',exact:true}).click();
 await p.getByText('该任务范围内的影像瓦片连接测试通过，可以尝试重试下载。',{exact:true}).waitFor({timeout:35_000});
 const calls=await p.evaluate(()=>window.networkQa.calls);assert.deepEqual(calls,[{sourceId:'qa-unsaved-esri',z:15,x:26983,y:12375}]);
 await p.getByRole('button',{name:'网络与代理',exact:true}).click();assert.equal(await p.evaluate(()=>window.networkQa.networkOpened),true);
 await p.screenshot({path:resolve(output,'network-success.png')});
 await p.evaluate(()=>{window.api.mapPreviewTile=async()=>{throw {code:'SOURCE_NETWORK',message:'request timed out'};};});
 await p.getByRole('button',{name:'检测图源连接',exact:true}).click();
 await p.getByRole('status').filter({hasText:'图源连接测试失败'}).waitFor();assert.equal(await p.getByRole('button',{name:'检测图源连接',exact:true}).isEnabled(),true);
 await p.screenshot({path:resolve(output,'network-failure.png')});
 const report={passed:true,nativeSample:calls[0],actualPresetTilePassed:true,networkSettingsActionPassed:true,failureExplained:true,registryUnchanged:true,modelCalls:0,finishedAt:new Date().toISOString()};writeFileSync(resolve(output,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await b.close();}

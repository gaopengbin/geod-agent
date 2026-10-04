// Actual native keyring/SQLite and production UI; fixture credentials are synthetic.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'playwright');
const rpc=async(command,args={})=>{const result=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;};
const output=resolve('../../docs/implementation/evidence/tiles3d-connections');mkdirSync(output,{recursive:true});
const conversationId=`credential-test-${randomUUID()}`,workspace=resolve('../../artifacts/desktop-parity',conversationId);mkdirSync(workspace,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1050,height:820},deviceScaleFactor:1});
const checks=[],errors=[],owned=[];page.on('pageerror',error=>errors.push(error.message));
const existingIds=new Set((await rpc('tiles3d_connections_list')).map(c=>c.id));
try {
  await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
  const ion=await rpc('tiles3d_connection_prepare',{draft:{name:'Cesium Ion 验收连接',kind:'cesiumIon',assetId:7,requiredHeaders:['Referer']}});owned.push(ion.id);assert(!ion.credentialReady);
  const plan=await rpc('data_download_plan',{conversationId,title:'凭证版本绑定验收',idempotencyKey:randomUUID(),request:{kind:'tiles3d',spec:{connectionId:ion.id}}});assert.equal(plan.request.spec.connectionRevision,ion.revision);checks.push('AI draft connection and native plan reference');
  await page.goto(`http://127.0.0.1:1420/test/tiles3d-connections-harness.html?connection=${ion.id}`);
  await page.getByLabel('Access Token',{exact:true}).fill('synthetic-ion-acceptance-token');
  await page.getByLabel('请求头 1 内容',{exact:true}).fill('https://fixture.invalid/viewer');
  await page.getByRole('button',{name:'保存连接',exact:true}).click();
  await page.getByRole('status').filter({hasText:'连接已保存'}).waitFor();
  assert.equal(await page.getByLabel('Access Token',{exact:true}).inputValue(),'');assert.equal(await page.getByLabel('请求头 1 内容',{exact:true}).inputValue(),'');
  const saved=(await rpc('tiles3d_connections_list')).find(c=>c.id===ion.id);assert(saved.credentialReady);assert.notEqual(saved.revision,ion.revision);assert(!JSON.stringify(saved).includes('synthetic-ion'));checks.push('native Windows Vault save and no credential readback');
  await assert.rejects(()=>rpc('data_download_start_auto',{conversationId,taskId:plan.id,planHash:plan.planHash}),error=>error.code==='DATA_CONNECTION_CHANGED');checks.push('credential change invalidates old plan before network execution');
  await page.screenshot({path:resolve(output,'ion-light.png')});
  await page.goto(`http://127.0.0.1:1420/test/tiles3d-connections-harness.html?theme=dark&connection=${ion.id}`);await page.getByLabel('Access Token',{exact:true}).waitFor();
  await page.screenshot({path:resolve(output,'ion-dark.png')});
  await page.getByRole('button',{name:'添加',exact:true}).click();await page.getByLabel('请求头 2 名称',{exact:true}).fill('X-API-Key');await page.getByLabel('请求头 2 内容',{exact:true}).fill('synthetic-header-acceptance');
  await page.getByRole('button',{name:'保存连接',exact:true}).click();await page.getByRole('status').waitFor();
  await page.getByRole('button',{name:'移除请求头 2',exact:true}).click();await page.getByRole('button',{name:'保存连接',exact:true}).click();await page.getByRole('status').waitFor();
  assert(!(await rpc('tiles3d_connections_list')).find(c=>c.id===ion.id).requiredHeaders.includes('x-api-key'));checks.push('add and remove header credentials');
  await page.setViewportSize({width:390,height:700});await page.screenshot({path:resolve(output,'ion-narrow.png')});
  const layout=await page.evaluate(()=>{const r=document.querySelector('[role="dialog"]').getBoundingClientRect();return{width:innerWidth,scroll:document.documentElement.scrollWidth,left:r.left,right:r.right};});assert(layout.scroll<=layout.width);assert(layout.left>=0&&layout.right<=layout.width);
  await page.setViewportSize({width:1050,height:820});await page.getByRole('button',{name:'连接列表',exact:true}).click();await page.getByRole('button',{name:'添加连接',exact:true}).click();
  await page.getByLabel('连接名称',{exact:true}).fill('官方三维样例');await page.getByLabel('服务地址',{exact:true}).fill('https://raw.githubusercontent.com/CesiumGS/3d-tiles-samples/main/1.0/TilesetWithRequestVolume/tileset.json');
  await page.getByRole('button',{name:'保存并测试',exact:true}).click();await page.getByRole('status').filter({hasText:'连接成功'}).waitFor({timeout:65000});
  const direct=(await rpc('tiles3d_connections_list')).find(c=>c.name==='官方三维样例');owned.push(direct.id);checks.push('actual public tileset connection test from production form');
  await page.getByRole('button',{name:'连接列表',exact:true}).click();await page.screenshot({path:resolve(output,'connections-dark.png')});
  await page.getByRole('button',{name:'删除连接 官方三维样例',exact:true}).click();await page.getByRole('button',{name:'删除连接 官方三维样例',exact:true}).waitFor({state:'detached'});checks.push('connection removal');
  assert.equal(errors.length,0,errors.join('\n'));writeFileSync(resolve(output,'acceptance.json'),JSON.stringify({pass:true,checkedAt:new Date().toISOString(),checks,layout,errors,ionLiveAsset:'credential-dependent; no user Ion token provided'},null,2));console.log(JSON.stringify({pass:true,checks}));
} finally {
  for(const connection of await rpc('tiles3d_connections_list').catch(()=>[]))if(!existingIds.has(connection.id)&&['官方三维样例','Cesium Ion 验收连接'].includes(connection.name))owned.push(connection.id);
  for(const id of owned)await rpc('tiles3d_connection_remove',{connectionId:id}).catch(()=>{});
  await browser.close();
}

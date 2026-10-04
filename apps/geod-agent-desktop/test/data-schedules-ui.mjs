import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'playwright');
const rpc=async(command,args={})=>{const result=await (await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;};
const conversationId=`data-schedule-ui-${randomUUID()}`,workspace=resolve('../../artifacts/desktop-parity',conversationId),output=resolve('../../docs/implementation/evidence/data-schedules-ui');mkdirSync(workspace,{recursive:true});mkdirSync(output,{recursive:true});
await rpc('workspace_set',{conversationId,directory:workspace,permission:'confirmEach'});
const task=await rpc('data_download_plan',{conversationId,title:'柏林建筑矢量',idempotencyKey:randomUUID(),request:{kind:'vector',spec:{source:{type:'osm',id:'osm-berlin',name:'OpenStreetMap 柏林建筑',tags:[{key:'building'}]},bounds:[13.404,52.52,13.406,52.522],outputs:['geojson','gpkg']}}});
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:850,height:820}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const base=`http://127.0.0.1:1420/test/data-schedule-harness.html?conversation=${conversationId}&task=${task.id}`;
try {
 await page.goto(base);await page.getByRole('button',{name:'新建',exact:true}).click();
 await page.getByLabel('任务名称',{exact:true}).fill('柏林建筑每日更新');
 await page.getByRole('combobox').click();await page.getByRole('option',{name:'每天',exact:true}).click();
 await page.screenshot({path:resolve(output,'form-dark.png')});
 await page.getByRole('button',{name:'保存定时任务',exact:true}).click();await page.getByText('柏林建筑每日更新',{exact:true}).waitFor();
 let schedules=await rpc('data_schedules_list',{conversationId});assert.equal(schedules.length,1);assert.equal(schedules[0].repeatSeconds,86400);
 await page.getByRole('button',{name:'暂停',exact:true}).click();await page.getByText('已停止后续触发',{exact:true}).waitFor();assert.equal((await rpc('data_schedules_list',{conversationId}))[0].enabled,false);
 await page.getByRole('button',{name:'启用',exact:true}).click();await page.getByRole('button',{name:'暂停',exact:true}).waitFor();assert.equal((await rpc('data_schedules_list',{conversationId}))[0].enabled,true);
 await page.screenshot({path:resolve(output,'list-dark.png')});await page.goto(base+'&theme=light');await page.getByText('柏林建筑每日更新',{exact:true}).waitFor();await page.screenshot({path:resolve(output,'list-light.png')});
 await page.setViewportSize({width:300,height:700});await page.getByRole('button',{name:'新建',exact:true}).click();await page.screenshot({path:resolve(output,'form-narrow.png')});
 const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(layout.scroll<=layout.width,JSON.stringify(layout));assert.equal(errors.length,0,errors.join('\n'));
 writeFileSync(resolve(output,'acceptance.json'),JSON.stringify({pass:true,conversationId,taskId:task.id,checks:['real native schedule creation','styled frequency selector','pause','resume','reload','light dark and narrow render'],layout,errors},null,2));console.log(JSON.stringify({pass:true,conversationId,output}));
} finally {for(const schedule of await rpc('data_schedules_list',{conversationId}))await rpc('data_schedules_set_enabled',{scheduleId:schedule.id,enabled:false}).catch(()=>{});await browser.close();}

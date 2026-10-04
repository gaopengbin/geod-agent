/** Actual desktop conversation and hosted model using the real Docker WFS. */
import fs from 'node:fs/promises';
import path from 'node:path';
const [playwrightModule,evidencePath]=process.argv.slice(2);
const {chromium}=await import(playwrightModule);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;
for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page)break;await new Promise(r=>setTimeout(r,100));}
const report={pass:false,cases:[]};
try{
  if(!page)throw new Error('No actual GeoD desktop');
  await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
  await page.locator('.sidebar-new-chat').click();
  const before=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([,v])=>JSON.parse(v)).map(c=>c.conversationId));
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill('请先通过 extensions_list 查找数据输入连接器，用它的 online_services_discover 列出这个实际 WFS 服务的全部图层：http://127.0.0.1:18083/geoserver/wfs?service=WFS&version=2.0.0 。然后通过 data_input_read 读取实际发现的 geod:boundary 图层，作为当前会话范围。报告原服务图层名、实际坐标系、面数量和范围，不要下载影像，也不要用命令行绕过数据工具。');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  let chat;
  for(let i=0;i<240;i++){
    const state=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([,v])=>JSON.parse(v)));
    chat=state.find(c=>c.display?.some(m=>m.role==='user'&&m.content.startsWith('请先通过 extensions_list 查找数据输入连接器')));
    if(chat&&!chat.pendingId&&chat.messages?.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count()))break;
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!chat||chat.pendingId||chat.messages?.at(-1)?.role!=='assistant')throw new Error('Actual model did not finish');
  const traces=chat.display.filter(m=>m.role==='tool');
  const native=await page.evaluate(async conversationId=>window.__TAURI_INTERNALS__.invoke('boundaries_list',{conversationId}),chat.conversationId);
  if(!native.some(b=>b.polygonCount===1&&b.bounds.every((n,i)=>Math.abs(n-[116.1,39.6,116.3,39.8][i])<1e-6)))throw new Error('Actual model did not save the WFS boundary');
  if(!JSON.stringify(traces).includes('online_services_discover')||!JSON.stringify(traces).includes('data_input_read'))throw new Error('Actual tool sequence missing');
  const final=chat.messages.at(-1).content;
  if(!final.includes('geod:boundary')||final.includes('图层名显示为 `online`'))throw new Error('Source layer identity was lost');
  report.cases.push({name:'Actual Codex + hosted model discovers and reads WFS',pass:true,conversationId:chat.conversationId,boundaries:native,final});report.pass=true;
  await fs.writeFile(path.join(evidencePath,'actual-ai-conversation.json'),JSON.stringify(chat,null,2));
}catch(error){report.cases.push({name:'Actual WFS AI',pass:false,error:String(error.message??error)});}
finally{await fs.mkdir(evidencePath,{recursive:true});await fs.writeFile(path.join(evidencePath,'ai-acceptance.json'),JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({pass:report.pass,cases:report.cases.map(c=>({name:c.name,pass:c.pass,error:c.error}))}));
if(!report.pass)process.exitCode=1;

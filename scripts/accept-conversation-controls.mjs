/** Real desktop controls, actual Codex threads and actual hosted model outputs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [playwrightModule,evidencePath]=process.argv.slice(2);
const {chromium}=await import(playwrightModule);
await fs.mkdir(evidencePath,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
const report={pass:false,cases:[],nonceA:crypto.randomBytes(6).toString('hex'),nonceB:crypto.randomBytes(6).toString('hex')};
const assert=(v,m)=>{if(!v)throw new Error(m);};
const chats=()=>page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([,v])=>JSON.parse(v)));
const active=async()=>{const title=await page.locator('.conversation-item.active > span').innerText();return(await chats()).find(c=>(c.title||c.display.find(m=>m.role==='user')?.content.slice(0,34)||'新对话')===title);};
const rpc=async(command,args={})=>{const r=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(r.error)throw r.error;return r.value;};
const send=async text=>{await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(text);await page.getByRole('button',{name:'发送消息',exact:true}).click();};
const finish=async(id,minUsers=1)=>{
  for(let i=0;i<240;i++){const chat=(await chats()).find(c=>c.conversationId===id);if(chat&&!chat.pendingId&&chat.messages?.at(-1)?.role==='assistant'&&chat.display.filter(m=>m.role==='user').length>=minUsers&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count()))return chat;await new Promise(r=>setTimeout(r,1000));}
  throw new Error('Actual model did not finish');
};
let source,branch;
try{
  if(process.argv[4]==='--resume'){
    const previous=JSON.parse(await fs.readFile(path.join(evidencePath,'acceptance.json'),'utf8'));
    Object.assign(report,previous,{pass:false,cases:previous.cases.filter(c=>c.pass)});
    const fork=report.cases.find(c=>c.sourceConversationId&&c.branchConversationId);
    source=(await chats()).find(c=>c.conversationId===fork?.sourceConversationId);branch=(await chats()).find(c=>c.conversationId===fork?.branchConversationId);
    assert(source&&branch,'Owned acceptance conversations missing');
  }else{
  await page.locator('.sidebar-new-chat').click();
  await page.locator('input[aria-label="选择图片附件"]').setInputFiles(path.join(evidencePath,'input.png'));
  await page.locator('.composer-images img').waitFor({state:'visible'});
  const first=`分支验收 ${report.nonceA}。请记住本会话的状态码是 ${report.nonceA}，回复该码即可。附图是一张测试图片。无需调用工具。`;
  await send(first);
  for(let i=0;i<50;i++){source=(await chats()).find(c=>c.display.some(m=>m.role==='user'&&m.content===first));if(source)break;await new Promise(r=>setTimeout(r,100));}
  assert(source,'Source UI conversation missing');source=await finish(source.conversationId);
  assert(source.messages.at(-1).content.includes(report.nonceA),'Source actual answer missing nonce');
  await page.getByRole('button',{name:'创建会话分支',exact:true}).click();
  for(let i=0;i<80;i++){branch=(await chats()).find(c=>c.forkFromConversationId===source.conversationId);if(branch)break;await new Promise(r=>setTimeout(r,250));}
  assert(branch,'Actual UI did not create a branch');
  assert(branch.conversationId!==source.conversationId&&branch.messages.length===source.messages.length,'Fork history incomplete');
  const originalImage=source.display.find(m=>m.images?.length).images[0];
  const clonedImage=branch.display.find(m=>m.images?.length).images[0];
  assert(originalImage.id!==clonedImage.id&&clonedImage.conversationId===branch.conversationId&&clonedImage.sha256===originalImage.sha256,'Fork images not separately owned');
  assert((await rpc('image_attachment_preview',{conversationId:branch.conversationId,id:clonedImage.id})).startsWith('data:image/png;base64,'),'Fork preview unavailable');
  try{await rpc('image_attachment_preview',{conversationId:branch.conversationId,id:originalImage.id});throw new Error('Old attachment accepted');}catch(error){assert(error.code==='IMAGE_NOT_FOUND','Cross-conversation image guard missing');}
  const status=await rpc('auth_status');
  const index=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'dev.geod-agent.desktop','codex-runtime',`account-${crypto.createHash('sha256').update(status.userId).digest('hex')}`,'geod-threads.json'),'utf8'));
  assert(index[source.conversationId]&&index[branch.conversationId]&&index[source.conversationId]!==index[branch.conversationId],'Native fork did not create separate Codex thread IDs');
  report.cases.push({name:'Actual UI creates Codex thread fork with separately owned image',pass:true,sourceConversationId:source.conversationId,branchConversationId:branch.conversationId,sourceThreadId:index[source.conversationId],branchThreadId:index[branch.conversationId],originalImageId:originalImage.id,clonedImageId:clonedImage.id});console.log('Actual native Codex fork and image ownership PASS');
  const sourceTitle=source.display.find(m=>m.role==='user').content.slice(0,34);
  await page.locator('.conversation-item').filter({has:page.locator('span').filter({hasText:sourceTitle})}).filter({hasNotText:'· 分支'}).first().click();
  await send(`请将本会话的状态码更新为 ${report.nonceB}，回复新状态码即可。无需工具。`);source=await finish(source.conversationId,2);
  await page.locator('.conversation-item').filter({hasText:branch.title}).click();
  await send('只回答本会话之前记住的状态码。');branch=await finish(branch.conversationId,2);
  assert(branch.messages.at(-1).content.includes(report.nonceA)&&!branch.messages.at(-1).content.includes(report.nonceB),'Fork leaked the later parent state');
  await page.locator('.conversation-item').filter({has:page.locator('span').filter({hasText:sourceTitle})}).filter({hasNotText:'· 分支'}).first().click();
  await send('只回答本会话现在的状态码。');source=await finish(source.conversationId,3);
  assert(source.messages.at(-1).content.includes(report.nonceB),'Parent state overwritten by fork');
  report.cases.push({name:'Actual model history forks and later turns remain isolated',pass:true,parentAnswer:source.messages.at(-1).content,branchAnswer:branch.messages.at(-1).content});console.log('Actual hosted model fork isolation PASS');
  }
  if(!(await page.getByRole('dialog').count()))await page.getByRole('button',{name:/工作区权限：/}).click();
  await page.getByRole('dialog').getByRole('button').filter({hasText:'完全访问'}).click();
  await page.getByRole('button',{name:'确认允许完全访问',exact:true}).click();
  const waitPrompt='请运行一次本机命令：用 Python 等待 20 秒后输出 QUEUE_READY，不读写文件。命令结束后仅回复 QUEUE_READY。';
  await send(waitPrompt);
  await page.getByRole('button',{name:'加入消息队列',exact:true}).waitFor({state:'visible'});
  const second=`下一轮只回复 QUEUE_SECOND_${report.nonceA}。`;
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(second);await page.getByRole('button',{name:'加入消息队列',exact:true}).click();
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill('这条消息将取消，不要执行。');await page.getByRole('button',{name:'加入消息队列',exact:true}).click();
  await page.getByRole('button',{name:/移除待发送消息：这条消息将取消/}).click();
  await page.getByRole('region',{name:'待发送消息'}).getByRole('button',{name:'暂停',exact:true}).click();
  source=await finish(source.conversationId,4);
  assert(source.display.some(m=>m.itemType==='commandExecution'&&m.toolStatus==='success'&&String(m.details).includes('QUEUE_READY')),'Actual native command execution evidence missing');
  assert(source.queuedInputs?.length===1&&source.queuePaused&&source.queuedInputs[0].text===second,'Queue did not pause/persist/cancel correctly');
  assert(!source.display.some(m=>m.role==='user'&&m.content===second),'Queue ran while paused');
  await page.screenshot({path:path.join(evidencePath,'paused-queue.png')});
  await page.getByRole('region',{name:'待发送消息'}).getByRole('button',{name:'继续发送',exact:true}).click();
  source=await finish(source.conversationId,5);
  assert(source.messages.at(-1).content.includes(`QUEUE_SECOND_${report.nonceA}`)&&!source.queuedInputs?.length,'Queued message did not become a later actual model turn');
  assert(!source.display.some(m=>m.role==='user'&&m.content==='这条消息将取消，不要执行。'),'Removed message was sent');
  report.cases.push({name:'Actual command then queued model turn; pause, persistence, remove and resume',pass:true,answer:source.messages.at(-1).content});console.log('Actual model queue controls PASS');
  await fs.writeFile(path.join(evidencePath,'actual-parent-conversation.json'),JSON.stringify(source,null,2));await fs.writeFile(path.join(evidencePath,'actual-branch-conversation.json'),JSON.stringify(branch,null,2));
  report.pass=true;
}catch(error){report.cases.push({name:'Conversation controls',pass:false,error:String(error.message??JSON.stringify(error))});console.error(JSON.stringify(report.cases.at(-1)));}
finally{report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(report,null,2));await browser.close();}
console.log(JSON.stringify({pass:report.pass,cases:report.cases.length}));if(!report.pass)process.exitCode=1;

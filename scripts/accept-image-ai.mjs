import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const [playwrightModule,evidenceDirectory]=process.argv.slice(2);
const folder=path.resolve(evidenceDirectory),expected=JSON.parse(await fs.readFile(path.join(folder,'expected.json'),'utf8'));
const {chromium}=await import(playwrightModule);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
const rpc=async(command,args={})=>{const reply=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!reply.ok)throw reply.error;return reply.value;};
const record=()=>page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('geod-agent-conversations-0.1:account:')).flatMap(key=>JSON.parse(localStorage.getItem(key)||'[]')));
try{
  await page.locator('.sidebar-new-chat').click();
  await page.locator('input[aria-label="选择图片附件"]').setInputFiles(path.join(folder,'visual-check.png'));
  await page.locator('.composer-images img').waitFor();
  await page.screenshot({path:path.join(folder,'attachment-before-send.png')});
  const prompt='请读取图片上的六位数字，再说出下面三个图形从左到右各自的颜色和形状。仅根据图片回答，不调用工具。';
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(prompt);
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  let chat;
  for(let i=0;i<360;i++){
    chat=(await record()).find(chat=>chat.display.some(item=>item.role==='user'&&item.content===prompt));
    if(chat?.messages.at(-1)?.role==='assistant'&&!chat.pendingId&&await page.getByRole('button',{name:'停止回复',exact:true}).count()===0)break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert(chat,'Native conversation was not persisted');
  const answer=chat.messages.at(-1)?.content??'';
  assert(answer.includes(expected.nonce),`Image nonce was not read: ${answer}`);
  for(const color of ['红','蓝','绿'])assert(answer.includes(color),`Missing visual color ${color}`);
  assert(answer.includes('圆')&&answer.includes('三角')&&(answer.includes('方')||answer.includes('矩形')),'Visual shapes were not read');
  const images=chat.display.find(item=>item.role==='user').images;assert.equal(images?.length,1);
  assert(!JSON.stringify(chat).includes('data:image/'),'Image bytes leaked into localStorage chat records');
  const preview=await rpc('image_attachment_preview',{conversationId:chat.conversationId,id:images[0].id});assert(preview.startsWith('data:image/png;base64,'));
  try{await rpc('image_attachment_preview',{conversationId:crypto.randomUUID(),id:images[0].id});throw new Error('Cross-conversation image read allowed');}catch(error){assert.equal(error.code,'IMAGE_NOT_FOUND');}
  try{await rpc('image_attachment_add',{conversationId:chat.conversationId,name:'bad.png',base64:Buffer.from('not an image').toString('base64')});throw new Error('Invalid image allowed');}catch(error){assert.equal(error.code,'IMAGE_INVALID');}
  await page.screenshot({path:path.join(folder,'real-model-image-answer.png')});
  await fs.writeFile(path.join(folder,'acceptance.json'),JSON.stringify({pass:true,conversationId:chat.conversationId,prompt,answer,images,expected,checks:['actual UI attachment','actual Codex and hosted model image inference','native preview persists','no base64 in chat localStorage','cross-conversation read blocked','invalid bytes rejected']},null,2));
  console.log('Actual image inference and attachment persistence PASS');
}finally{await browser.close();}

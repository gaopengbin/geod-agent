/** Actual native stores, installed MCP processes/HTTP, production UI and hosted Codex AI. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
const [modulePath, output] = process.argv.slice(2), { chromium } = await import(modulePath);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':1420'));
const report={pass:false,cases:[]}, errors=[], pluginIds=[], memories=[];
page.on('pageerror',e=>errors.push(e.message));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(run,label,timeout=150000)=>{const end=Date.now()+timeout;while(Date.now()<end){const v=await run();if(v)return v;await sleep(250);}throw new Error(`Timeout: ${label}`);};
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(result.error)throw Object.assign(new Error(JSON.stringify(result.error)),result.error);return result.value;};
const chats=()=>page.evaluate(async()=>{const{localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();return localStateEntries().filter(([k])=>k.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([,v])=>JSON.parse(v));});
const token=crypto.randomUUID(), localValue=crypto.randomUUID(), remoteValue=crypto.randomUUID(), preference=crypto.randomUUID();
const passed=async(name,value)=>{assert(!JSON.stringify(value).includes(token),'Credential appeared in results');report.cases.push({name,pass:true,value});await fs.writeFile(path.join(output,'acceptance.json'),JSON.stringify(report,null,2));console.log(name,'PASS');};
const root=path.resolve(output), source=path.join(root,'portable-plugin'), pluginName=`qa-${crypto.randomBytes(5).toString('hex')}`;
const fixture=http.createServer(async(req,res)=>{
  if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end();return;}
  if(req.method!=='POST'){res.writeHead(405).end();return;}
  let body='';for await(const c of req)body+=c;const request=JSON.parse(body);
  if(request.id===undefined){res.writeHead(202).end();return;}
  const result=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'qa-private-http',version:'1.0'}}:
    request.method==='tools/list'?{tools:[{name:'read_http_marker',description:'Read the actual HTTP fixture data file',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}:
    {content:[{type:'text',text:await fs.readFile(path.join(root,'remote-marker.json'),'utf8')}]};
  res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
let conversationId, workspaceDirectory, markerPath;
const markerFilename=`geod-plugin-qa-${crypto.randomBytes(8).toString('hex')}.json`;
async function newChat(){
  const before=new Set((await chats()).map(c=>c.conversationId));
  await page.locator('.sidebar-new-chat').click();
  const id=await wait(async()=>(await chats()).find(c=>!before.has(c.conversationId))?.conversationId,'Actual new conversation');
  const workspace=await rpc('workspace_get',{conversationId:id});
  workspaceDirectory??=workspace.directory;assert.equal(workspace.directory,workspaceDirectory);
  await rpc('workspace_set',{conversationId:id,directory:workspace.directory,permission:'fullAccess'});
  await page.reload();await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();return id;
}
async function ask(id,message){
  const count=(await chats()).find(c=>c.conversationId===id)?.display.filter(v=>v.role==='user').length??0;
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).fill(message);
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  const chat=await wait(async()=>{const c=(await chats()).find(c=>c.conversationId===id);return c&&!c.pendingId&&c.display.filter(v=>v.role==='user').length>count&&c.messages?.at(-1)?.role==='assistant'&&!(await page.getByRole('button',{name:'停止回复',exact:true}).count())?c:null;},'Actual hosted model turn');
  await fs.writeFile(path.join(root,`actual-ai-${report.cases.length}.json`),JSON.stringify(chat,null,2));return chat;
}
try{
  await page.getByRole('textbox',{name:'发送给 GeoD Agent'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'停止回复',exact:true}).count(),0);
  conversationId=await newChat();
  markerPath=path.join(workspaceDirectory,markerFilename);
  await fs.writeFile(markerPath,JSON.stringify({code:localValue,origin:'actual workspace file'}),{flag:'wx'});
  await fs.copyFile(markerPath,path.join(root,'actual-workspace-marker.json'));
  await fs.writeFile(path.join(root,'remote-marker.json'),JSON.stringify({code:remoteValue,origin:'actual HTTP file'}));
  await fs.mkdir(path.join(source,'skills/read-markers'),{recursive:true});
  const skill=`---\nname: read-markers\ndescription: Read the actual local and remote QA data markers through this plugin\n---\n通过 extensions_list 发现“QA 数据读取”插件的 local-reader 和 http-reader 连接器，按返回的工具 schema 调用 read_workspace_marker（filename 为 ${markerFilename}）与 read_http_marker。只汇总实际读取结果，不编造数据，不返回认证值。`;
  await fs.writeFile(path.join(source,'plugin.json'),JSON.stringify({name:pluginName,version:'1.0.0',description:'本地插件包真实验收',extensions:{'com.openai':{interface:{displayName:'QA 数据读取'}}}}));
  await fs.writeFile(path.join(source,'skills/read-markers/SKILL.md'),skill);
  await fs.writeFile(path.join(source,'server.mjs'),`import fs from 'node:fs/promises';import path from 'node:path';import {createInterface} from 'node:readline';\nif(!process.env.QA_PLUGIN_AUTH)throw new Error('Auth missing');\ncreateInterface({input:process.stdin}).on('line',async line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'qa-installed-file-reader',version:'1.0'}};else if(q.method==='tools/list')result={tools:[{name:'read_workspace_marker',description:'Read an actual file in this current workspace',inputSchema:{type:'object',properties:{filename:{type:'string'}},required:['filename'],additionalProperties:false}}]};else{if(q.params.arguments.filename!==${JSON.stringify(markerFilename)})throw new Error('Invalid QA file');result={content:[{type:'text',text:await fs.readFile(path.join(process.cwd(),${JSON.stringify(markerFilename)}),'utf8')}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`);
  const node=path.resolve('apps/geod-agent-desktop/src-tauri/resources/codex/node.exe');
  await fs.writeFile(path.join(source,'mcp.json'),JSON.stringify({mcpServers:{'local-reader':{type:'stdio',command:node,args:['${PLUGIN_ROOT}/server.mjs'],env:{QA_PLUGIN_AUTH:token}},'http-reader':{type:'streamable-http',url:`http://127.0.0.1:${fixture.address().port}/mcp`,headers:{Authorization:`Bearer ${token}`}}}}));
  const preview=await rpc('plugin_preview',{path:source});assert.equal(preview.skills.length,1);assert.equal(preview.connectors.length,2);
  assert.equal(preview.skills[0].name,`${pluginName}-read-markers`);assert(!JSON.stringify(preview).includes(token));
  await passed('Portable plugin preview identifies skills/transports and redacts authentication',preview);
  await fs.writeFile(path.join(source,'changed.txt'),'snapshot change');
  await assert.rejects(rpc('plugin_import',{path:source,expectedSha256:preview.sha256,enabled:true}),e=>e.code==='PLUGIN_CHANGED');
  // Revert only the owned fixture file; no user files are touched.
  await fs.unlink(path.join(source,'changed.txt'));
  const installed=await rpc('plugin_import',{path:source,expectedSha256:preview.sha256,enabled:true});pluginIds.push(installed.id);
  const again=await rpc('plugin_import',{path:source,expectedSha256:preview.sha256,enabled:true});assert.equal(again.id,installed.id);
  await passed('Import pins the reviewed snapshot and repeated import reuses the package',installed);
  // Move the owned fixture folder to prove execution uses the application's copy.
  await fs.rename(source,path.join(root,'portable-source-after-import'));
  const extensions=await rpc('extensions_list');
  for(const id of installed.connectorIds){
    const connector=extensions.connectors.find(c=>c.id===id);const tools=await rpc('mcp_tools',{id,conversationId});
    const name=tools.tools[0].name;const result=await rpc('mcp_call',{id,toolName:name,arguments:name==='read_workspace_marker'?{filename:markerFilename}:{},executionId:crypto.randomUUID(),conversationId});
    assert(JSON.stringify(result).includes(name==='read_workspace_marker'?localValue:remoteValue));
    await passed(`Installed ${connector.transport} MCP reads real data after moving source folder`,{connector,tools,result});
  }
  await rpc('plugin_set_enabled',{id:installed.id,enabled:false});
  await assert.rejects(rpc('skill_read',{name:preview.skills[0].name}),e=>e.code==='SKILL_NOT_ENABLED');
  await assert.rejects(rpc('mcp_call',{id:installed.connectorIds[0],toolName:'read_workspace_marker',arguments:{filename:markerFilename},executionId:crypto.randomUUID(),conversationId}),e=>e.code==='MCP_NOT_ENABLED');
  await rpc('plugin_set_enabled',{id:installed.id,enabled:true});
  await passed('Group disable stops skill and MCP use; enabling restores the actual bundle',{id:installed.id});
  const compat=path.join(root,'codex-plugin');await fs.mkdir(path.join(compat,'.codex-plugin'),{recursive:true});await fs.mkdir(path.join(compat,'skills/read-markers'),{recursive:true});
  await fs.writeFile(path.join(compat,'.codex-plugin/plugin.json'),JSON.stringify({name:`${pluginName}-compat`,version:'0.1.0',skills:'./skills/'}));await fs.writeFile(path.join(compat,'skills/read-markers/SKILL.md'),skill);
  const cp=await rpc('plugin_preview',{path:compat});assert.equal(cp.format,'codex');
  const ci=await rpc('plugin_import',{path:compat,expectedSha256:cp.sha256,enabled:false});pluginIds.push(ci.id);
  await passed('Codex compatibility manifest imports separately with a distinct skill namespace',ci);
  const ai=await ask(conversationId,`读取并使用已启用的 ${preview.skills[0].name} 技能，调用插件工具读取本工作区和 HTTP 服务的数据编号，简短报告真实结果。`);
  const last=ai.display.findLastIndex(m=>m.role==='user'), trace=JSON.stringify(ai.display.slice(last+1).filter(m=>m.role==='tool'));
  assert(trace.includes('read_workspace_marker')&&trace.includes('read_http_marker'));assert(ai.messages.at(-1).content.includes(localValue)&&ai.messages.at(-1).content.includes(remoteValue));
  await passed('Real Codex/hosted AI uses the installed skill and both native private MCP transports',{conversationId,answer:ai.messages.at(-1).content});
  const account=await rpc('agent_memory_save',{conversationId,draft:{title:'QA 账号范围',content:'语言偏好为中文',scope:'account',enabled:true}});memories.push({conversationId,entry:account});
  const workspace=await rpc('agent_memory_save',{conversationId,draft:{title:'QA 仅当前工作区',content:'此条只属于插件验收文件夹',scope:'workspace',enabled:true}});memories.push({conversationId,entry:workspace});
  const other=path.join(root,'other-workspace');await fs.mkdir(other,{recursive:true});const foreign=crypto.randomUUID();await rpc('workspace_set',{conversationId:foreign,directory:other,permission:'fullAccess'});
  const visible=await rpc('agent_memory_list',{conversationId:foreign});assert(visible.entries.some(e=>e.id===account.id));assert(!visible.entries.some(e=>e.id===workspace.id));
  await assert.rejects(rpc('agent_memory_remove',{conversationId:foreign,id:workspace.id,expectedRevision:workspace.revision}),e=>e.code==='MEMORY_NOT_FOUND');
  await assert.rejects(rpc('agent_memory_save',{conversationId,draft:{...workspace,createdAt:undefined,updatedAt:undefined,revision:undefined,id:workspace.id,expectedRevision:0}}),e=>e.code==='MEMORY_CONFLICT');
  await passed('Native memory scope, account reuse and stale-revision rejection',{account,workspace,otherVisibleIds:visible.entries.map(e=>e.id)});
  const remembered=await ask(conversationId,`请只记住一条当前工作区偏好：标题“QA 默认备注”，内容“默认方案备注为 ${preference}”，用于后续对话。请实际保存，不要只口头答应。`);
  const notes=await rpc('agent_memory_list',{conversationId,query:'QA 默认备注'});assert.equal(notes.entries.length,1);const note=notes.entries[0];assert(note.content.includes(preference));memories.push({conversationId,entry:note});
  assert(JSON.stringify(remembered.display.filter(m=>m.role==='tool')).includes('agent_memory_save'));
  await passed('Real AI saves an explicitly requested workspace preference',{entry:note,answer:remembered.messages.at(-1).content});
  const recallId=await newChat();const recall=await ask(recallId,'使用已启用的工作区偏好，告诉我默认方案备注是什么。不要另行保存记忆。');assert(recall.messages.at(-1).content.includes(preference));
  await passed('Fresh actual Codex conversation recalls persisted workspace memory',{conversationId:recallId,answer:recall.messages.at(-1).content});
  await page.getByRole('button',{name:'技能与连接器',exact:true}).click();await page.getByRole('button',{name:'记忆',exact:true}).click();
  await page.getByRole('button',{name:'编辑记忆 QA 默认备注',exact:true}).waitFor();
  await page.getByRole('button',{name:'编辑记忆 QA 默认备注',exact:true}).click();
  const editor=page.getByRole('form',{name:'编辑记忆'});await editor.getByText('用于后续对话',{exact:true}).locator('input').uncheck();await editor.getByRole('button',{name:'保存',exact:true}).click();
  const disabled=await wait(async()=>{const p=await rpc('agent_memory_list',{conversationId:recallId,query:'QA 默认备注'});return p.entries[0]&&!p.entries[0].enabled?p.entries[0]:null;},'Native UI memory disable');
  await page.locator('.extension-store').screenshot({path:path.join(root,'actual-memory-ui.png')});
  memories.find(m=>m.entry.id===note.id).entry=disabled;
  await page.getByRole('button',{name:'插件',exact:true}).click();await page.getByRole('button',{name:'移除插件 QA 数据读取',exact:true}).waitFor();await page.locator('.extension-store').screenshot({path:path.join(root,'actual-plugin-ui.png')});
  await passed('Production memory editor disables preference; plugin manager shows installed components',{disabled});
  const finalId=await newChat();const forget=await ask(finalId,'请实际忘记并删除标题为“QA 默认备注”的工作区记忆。简短告知结果，不要改动其他条目。');
  const removed=await rpc('agent_memory_list',{conversationId:finalId,query:'QA 默认备注'});assert.equal(removed.entries.length,0);
  assert(JSON.stringify(forget.display.filter(m=>m.role==='tool')).includes('agent_memory_remove'));
  memories.splice(memories.findIndex(m=>m.entry.id===note.id),1);
  await passed('Real AI deletes the actual stored preference',{conversationId:finalId,answer:forget.messages.at(-1).content});
  assert.equal(errors.length,0,JSON.stringify(errors));report.pass=true;
}catch(error){report.failure=error.stack??error;console.error(report.failure);process.exitCode=1;}
finally{
  if(markerPath)await fs.unlink(markerPath).catch(()=>{});
  for(const id of pluginIds){try{await rpc('plugin_remove',{id});}catch(e){report.cleanupError??=[];report.cleanupError.push(e);}}
  for(const {conversationId,entry} of memories){try{const p=await rpc('agent_memory_list',{conversationId,query:entry.title});const current=p.entries.find(e=>e.id===entry.id);if(current)await rpc('agent_memory_remove',{conversationId,id:current.id,expectedRevision:current.revision});}catch(e){report.cleanupError??=[];report.cleanupError.push(e);}}
  const remaining=await rpc('plugins_list').catch(()=>({plugins:[]}));assert(!remaining.plugins.some(p=>pluginIds.includes(p.id)));
  report.pageErrors=errors;report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(root,'acceptance.json'),JSON.stringify(report,null,2));
  await browser.close();fixture.closeAllConnections();await new Promise(r=>fixture.close(r));
}
console.log(JSON.stringify({pass:report.pass,cases:report.cases.length}));

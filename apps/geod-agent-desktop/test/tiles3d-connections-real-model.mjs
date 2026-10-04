// Actual hosted model uses the public connection contract and production dispatch.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const rpc=async(command,args={})=>{const r=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(r.error)throw r.error;return r.value;};
const conversationId=`connection-model-${randomUUID()}`,workspace=resolve('../../artifacts/desktop-parity',conversationId),calls=[],created=[];
mkdirSync(workspace,{recursive:true});await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
const runId=randomUUID(),started=Date.now();
const url='https://cdn.jsdelivr.net/gh/CesiumGS/3d-tiles-samples@a30bfdf2d6cc55f4c3078e8aea3a793af6ebfd56/1.0/TilesetWithRequestVolume/tileset.json';
try {
 await rpc('test_codex_start',{runId,conversationId,input:`请用三维连接工具登记一个名为“公开模型连接验收”的测试连接，地址 ${url}。实际测试此连接并列出已保存连接，然后使用它的 connectionId 为当前工作区生成三维下载计划，本次只建计划。请通过工具执行，简短告知实际结果，不要运行脚本。`});
 let final;
 while(Date.now()-started<180000){
  const state=await rpc('test_codex_poll',{runId});
  for(const event of state.events??[]){
   if(event.type==='request')throw new Error(`Unexpected request ${event.method}`);
   if(event.type!=='tool')continue;
   let result;
   try {
    if(event.tool==='workspace_status')result=await rpc('workspace_get',{conversationId});
    else if(event.tool==='extensions_list')result=await rpc('extensions_list');
    else if(event.tool.startsWith('tiles3d_connection')||event.tool==='data_download_plan')result=await rpc('test_domain_tool',{conversationId,tool:event.tool,arguments:event.arguments,executionId:`${runId}:${event.requestId}`});
    else throw new Error(`Unexpected tool ${event.tool}`);
   }catch(error){result={error};}
   calls.push({tool:event.tool,arguments:event.arguments,result});
   if(event.tool==='tiles3d_connection_prepare'&&result?.id)created.push(result.id);
   console.log(event.tool,result?.error?'ERROR':'OK');
   await rpc('codex_command',{runId,command:{type:'response',requestId:event.requestId,value:{result}}});
  }
  if(state.done){assert(!state.error,JSON.stringify(state.error));assert.equal(state.value.status,'completed');final=state.value;break;}
  await new Promise(r=>setTimeout(r,200));
 }
 assert(final,'Model did not finish');
 for(const tool of ['tiles3d_connection_prepare','tiles3d_connections_list','tiles3d_connection_test','data_download_plan'])assert(calls.some(c=>c.tool===tool&&!c.result?.error),tool);
 assert(calls.some(c=>c.tool==='tiles3d_connection_test'&&c.result.connected));
 const plan=calls.find(c=>c.tool==='data_download_plan');assert(created.includes(plan.arguments.connectionId));
 const task=await rpc('data_download_get',{conversationId,taskId:plan.result.id??plan.result.taskId});assert.equal(task.status,'pending');assert.equal(task.request.spec.connectionId,plan.arguments.connectionId);assert(task.request.spec.connectionRevision);
 writeFileSync('../../docs/implementation/evidence/tiles3d-connections-real-model-2026-10-02.json',JSON.stringify({pass:true,conversationId,durationMs:Date.now()-started,calls,task,answer:final.text},null,2));
 console.log(JSON.stringify({pass:true,tools:calls.map(c=>c.tool),answer:final.text}));
}finally{
 await rpc('codex_command',{runId,command:{type:'interrupt'}}).catch(()=>{});
 for(const connectionId of created)await rpc('tiles3d_connection_remove',{connectionId});
}

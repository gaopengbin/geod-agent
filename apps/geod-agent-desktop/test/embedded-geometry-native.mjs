// Migrate the actual retained map export into an owned local receipt without
// changing saved history, calling a model or writing the user's workspace.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/repeated-output-limit-20261007');mkdirSync(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 let page;for(let i=0;i<80;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page)break;await delay(250);}assert(page,'Desktop unavailable');
 await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke&&document.querySelector('.conversation-item.active'));
 const report=await page.evaluate(async()=>{
  const invoke=window.__TAURI_INTERNALS__.invoke,background=await invoke('background_status');
  if(document.querySelector('button[aria-label="停止回复"]')||background.activeDownloads||background.activeCommands||background.activeAiTurns)throw new Error('User work is active');
  const conversationId='0b3f3b0a-19ca-4fe9-a70a-ae1524f6864e';
  if(document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')!==conversationId)throw new Error('User changed conversations');
  const {localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();
  const read=()=>localStateEntries().filter(([key])=>key.startsWith('geod-agent-conversations-0.1')).flatMap(([,v])=>JSON.parse(v)).find(c=>c.conversationId===conversationId);
  const chat=read(),original=JSON.stringify(chat),proofBefore=await invoke('billing_run_snapshot',{runId:'c1e0f803-7064-490c-b605-978ebb7f1cf2'});
  const {persistEmbeddedGeometryHistory}=await import('/@fs/G:/code/geod-agent/packages/codex-protocol/bulk-data.mjs');
  const {continueTaskContext}=await import('/src/continue-task.ts');
  const receipts=[];
  const wire=await persistEmbeddedGeometryHistory(chat.messages,async data=>{
   const summary=await invoke('mcp_embedded_result_save',{id:data.connectorId,toolName:data.toolName,arguments:data.arguments,result:data.result,executionId:`codex:${conversationId}:${data.callId}`,conversationId});
   const retry=await invoke('mcp_embedded_result_save',{id:data.connectorId,toolName:data.toolName,arguments:data.arguments,result:data.result,executionId:summary.executionId,conversationId});
   if(JSON.stringify(retry)!==JSON.stringify(summary))throw new Error('Receipt retry changed reference');
   const readback=await invoke('mcp_result_read',{executionId:summary.executionId,offset:0});
   if(!readback.bulkData||readback.sha256!==summary.sha256)throw new Error('Owned native receipt readback differs');
   receipts.push({toolName:data.toolName,executionId:summary.executionId,rawBytes:summary.bytes,summaryChars:JSON.stringify(summary).length,pointCounts:summary.geometryFields.map(f=>f.pointCount),sha256:summary.sha256,idempotent:true});
   return summary;
  });
  if(!receipts.length)throw new Error('No actual old embedded export found');
  const workspace=await invoke('workspace_get',{conversationId});let writePermissionEnforced=false;
  if(workspace.permission==='confirmEach'){
   try{await invoke('mcp_result_export',{executionId:receipts[0].executionId,conversationId,jsonPointer:'/geojson'});throw new Error('Unexpected workspace write');}
   catch(error){if(error?.code!=='MCP_APPROVAL_REQUIRED')throw error;writePermissionEnforced=true;}
  }
  const context=continueTaskContext('继续刚才的任务',chat.display),resume=JSON.parse(context.split('<geod_resume_context>\n')[1]?.split('\n')[0]??'null');
  if(!resume?.confirmedAnswers?.length)throw new Error('Accepted choices missing from continuation');
  if(JSON.stringify(read())!==original)throw new Error('Saved chat changed');
  const proofAfter=await invoke('billing_run_snapshot',{runId:proofBefore.runId??'c1e0f803-7064-490c-b605-978ebb7f1cf2'});
  if(proofAfter.generations.length!==proofBefore.generations.length)throw new Error('A model generation was unexpectedly created');
  const changed=wire.filter((m,i)=>m.content!==chat.messages[i].content);
  return {receipts,wireOutputsChanged:changed.length,wireOutputsUseLocalReference:changed.every(m=>JSON.parse(m.content).result?.bulkData),historyPreserved:true,acceptedAnswerCount:resume.confirmedAnswers.length,originalRequestPreserved:resume.originalRequest==='把沿途1公里范围内的影像下载',workspacePermission:workspace.permission,writePermissionEnforced,paidModelCalls:0,downloadJobsStarted:0,workspaceWrites:0,currentNativeRunStatus:proofAfter.status};
 });
 assert.equal(report.wireOutputsChanged,1);assert(report.wireOutputsUseLocalReference);assert(report.originalRequestPreserved);assert(report.writePermissionEnforced);
 await page.reload({waitUntil:'domcontentloaded'});
 const outcomes=page.locator('.agent-turn-outcome');await outcomes.last().waitFor();
 assert.equal(await outcomes.count(),2,'Both actual incomplete turns remain visible');
 assert(await outcomes.last().getByRole('button',{name:'继续处理'}).isEnabled());
 assert.equal(await page.locator('.agent-live-status').count(),0);
 assert.equal(await page.locator('.agent-error').count(),0);
 await outcomes.last().scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'native-resume.png')});
 const full={passed:true,...report,continueAvailable:true,idleWithoutSpinner:true};
 writeFileSync(join(output,'native-migration-report.json'),JSON.stringify(full,null,2));console.log(JSON.stringify(full));
}finally{await browser.close();}

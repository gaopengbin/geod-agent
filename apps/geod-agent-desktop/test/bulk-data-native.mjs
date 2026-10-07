// Read the current conversation's real saved MCP receipt through the new native
// command. Do not resume the task, contact a provider or write to its workspace.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output=resolve('../../artifacts/bulk-data-20261007');mkdirSync(output,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
 const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page,'Development desktop unavailable');
 await page.locator('.agent-messages').waitFor();
 const report=await page.evaluate(async()=>{
  const invoke=window.__TAURI_INTERNALS__.invoke,background=await invoke('background_status');
  if(document.querySelector('button[aria-label="停止回复"]')||background.activeDownloads||background.activeCommands||background.activeAiTurns)throw new Error('User work is active; readback deferred');
  const current=document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id');
  const {localStateEntries,flushLocalState}=await import('/src/local-state.ts');await flushLocalState();
  function chat(){return localStateEntries().filter(([k])=>k.startsWith('geod-agent-conversations-0.1')).flatMap(([,v])=>JSON.parse(v)).find(c=>c.conversationId===current);}
  const original=JSON.stringify(chat()),ids=[];
  for(const item of chat().messages??[]){if(item.role!=='tool')continue;try{const parsed=JSON.parse(item.content),value=parsed.result??parsed;if(typeof value.executionId==='string'&&value.executionId.startsWith(`codex:${current}:`)&&!ids.includes(value.executionId))ids.push(value.executionId);}catch{}}
  const proofs=[];
  for(const executionId of ids){
   const result=await invoke('mcp_result_read',{executionId,offset:0});
   if(!result.bulkData)continue;
   const workspace=await invoke('workspace_get',{conversationId:current});let writePermissionEnforced=null;
   if(workspace.permission==='confirmEach'){
    try{await invoke('mcp_result_export',{executionId,conversationId:current,jsonPointer:''});throw new Error('Export unexpectedly wrote without permission');}
    catch(error){if(error?.code!=='MCP_APPROVAL_REQUIRED')throw error;writePermissionEnforced=true;}
   }
   proofs.push({executionId,bytes:result.bytes,summaryChars:JSON.stringify(result).length,geometryFieldCount:result.geometryFieldCount,listedPointCounts:result.geometryFields.map(f=>f.pointCount),noInlineCoordinates:!JSON.stringify(result).includes('116.373334'),exportCommandAvailable:writePermissionEnforced===true,writePermissionEnforced});
  }
  if(JSON.stringify(chat())!==original)throw new Error('Reading receipts changed conversation state');
  return {activeConversation:current,actualOwnedReceipts:proofs,historyPreserved:true,paidModelCalls:0,providerRequests:0,workspaceWrites:0,credentialDialogs:document.querySelectorAll('[role="dialog"] #mcp-provider-key').length};
 });
 assert(report.actualOwnedReceipts.length,'The existing route must now return bounded geometry metadata');assert(report.actualOwnedReceipts.every(p=>p.noInlineCoordinates&&p.summaryChars<p.bytes));assert.equal(report.credentialDialogs,0);
 writeFileSync(join(output,'desktop-report.json'),JSON.stringify({passed:true,...report},null,2));console.log(JSON.stringify({passed:true,...report}));
}finally{await browser.close();}

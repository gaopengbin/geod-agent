// Observe the old failed test without changing its outcome or any application data.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeReceipt} from './schedule-acceptance-receipts.mjs';

const root=resolve(process.argv[2]??'');
assert(root.startsWith(resolve('artifacts/schedule-stability-native-20261005')+'\\fixture-'));
const previous=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));
assert.equal(previous.passed,false,'This recovery audit is only for a failed run');
const baseline=JSON.parse(readFileSync('artifacts/schedule-stability-native-20261005/fixture-00ad7009289c2a7e/cleanup.json','utf8'));
assert.equal(baseline.passed,true);
function support(action,value={}){
  const result=spawnSync('python',['-X','utf8','scripts/schedule-stability-support.py',action],{input:JSON.stringify(value),encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
const profile=support('profile-audit'),processes=support('snapshot');
const children=support('child-process-audit',{observedChildren:previous.samples.flatMap(sample=>sample.children)});
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
try{
  const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url()==='http://127.0.0.1:1420/');assert(page);
  const state=await page.evaluate(async()=>{
    await window.__GEOD_LOCAL_STATE__?.flush();
    const records=await new Promise((resolve,reject)=>{
      const open=indexedDB.open('geod-ui-state-v1',1);open.onerror=()=>reject(open.error);
      open.onsuccess=()=>{const db=open.result,tx=db.transaction('records','readonly'),store=tx.objectStore('records'),keys=store.getAllKeys(),values=store.getAll();
        tx.oncomplete=()=>{db.close();const records=Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)]));keys.result.forEach((k,i)=>records[k]=values.result[i]);resolve(records);};tx.onabort=()=>reject(tx.error);};
    });
    const key=Object.keys(records).find(key=>key.startsWith('geod-agent-conversations-0.1:account:'));if(!key)throw Error('Original history unavailable');
    const chats=JSON.parse(records[key]),{api}=await import('/src/api.ts');
    return {chats:chats.map(c=>({conversationId:c.conversationId,title:c.title??null,messages:c.messages,display:c.display,planId:c.planId??null,planIds:c.planIds??[]})),
      background:await api.backgroundStatus(),payment:await api.agentPaymentSnapshot()};
  });
  const sha=createHash('sha256').update(JSON.stringify(state.chats)).digest('hex');
  const matches=state.chats.length===baseline.originalConversations&&sha===baseline.originalChatSha256;
  const ownProcesses=processes.processes.filter(item=>item.exe.toLowerCase().includes('schedule-stability'));
  const safe=profile.schedulesIntegrity==='ok'&&profile.channelsIntegrity==='ok'&&profile.enabledScheduleIds.length===0&&profile.channelCredentialReferences===0&&children.passed&&ownProcesses.length===0&&matches;
  const ownershipPath=join(root,'ownership.json'),owned=existsSync(ownershipPath)?JSON.parse(readFileSync(ownershipPath,'utf8')):null;
  const keyRemoval=owned?.channelId?support('channel-credentials',{channelId:owned.channelId,references:owned.channelReferences}):null;
  if(keyRemoval)assert(keyRemoval.references.length===0&&keyRemoval.credentials.every(item=>!item.credentialExists),'Recorded QA credentials must be absent');
  const recoveredPath=join(root,'recovery-cleanup.json');
  const report={observedAt:new Date().toISOString(),safeToStartAnotherIsolatedRun:safe,previousTestPassed:false,
    previousCleanupFullyProven:existsSync(join(root,'cleanup.json'))&&JSON.parse(readFileSync(join(root,'cleanup.json'),'utf8')).passed,
    recoveryCleanup:existsSync(recoveredPath)?JSON.parse(readFileSync(recoveredPath,'utf8')):null,recordedCredentialRemoval:keyRemoval,
    limitation:owned?'The original failed acceptance and cleanup receipts remain failed; this records subsequent scoped recovery only.':'The interrupted run did not persist its loopback identity origin or credential references; individual vault removal cannot be reconstructed from this observation.',
    profile,children,processes,originalConversations:state.chats.length,originalChatSha256:sha,originalHistoryMatchesBaseline:matches,
    background:state.background,localPayment:state.payment};
  writeReceipt(join(root,'recovery-observation.json'),report);
  assert(safe,'Inspect the recovery observation before starting another test');
  console.log(JSON.stringify({safeToStartAnotherIsolatedRun:safe,originalConversations:state.chats.length,originalHistoryMatchesBaseline:matches,qaProcessesRemaining:ownProcesses.length,channelCredentialReferences:profile.channelCredentialReferences}));
}finally{await browser.close();}

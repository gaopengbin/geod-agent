// Read-only tools in the already running development desktop; no chat/UI edits.
import {writeFileSync, mkdirSync} from 'node:fs';
import {resolve, join} from 'node:path';
const output = resolve(process.argv[2] ?? 'artifacts/ai-channels-verification-20261003'); mkdirSync(output, {recursive: true});
const target = (await (await fetch('http://127.0.0.1:9233/json/list')).json()).find(page => page.type === 'page' && page.url.includes('127.0.0.1:1420'));
if (!target) throw new Error('Development desktop is not available');
const socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => {socket.addEventListener('open', r, {once: true}); socket.addEventListener('error', j, {once: true});});
let serial = 0; const pending = new Map();
socket.addEventListener('message', event => {const value = JSON.parse(event.data); const entry = pending.get(value.id); if (!entry) return; pending.delete(value.id); value.error ? entry.reject(new Error(value.error.message)) : entry.resolve(value.result);});
function call(method, params) {return new Promise((resolve, reject) => {const id = ++serial; pending.set(id, {resolve, reject}); socket.send(JSON.stringify({id, method, params}));});}
async function evaluate(expression) {const result = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value;}
try {
  const result = await evaluate(`(async()=>{
    const {api}=await import('/src/api.ts'); const {runCodexTurn}=await import('/src/codex-client.ts');
    const status=await api.authStatus(); if(status.state!=='connected')throw new Error('AUTH_REQUIRED');
    if(document.querySelector('button[aria-label="停止回复"]'))throw new Error('The current user turn is active');
    const activeBefore=document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id');
    const id=crypto.randomUUID(), tools=[], generations=[], events=[];
    await api.workspaceGet(id);
    const result=await runCodexTurn(crypto.randomUUID(),id,'只调用一次 sources_list 读取已登记图源。最终仅返回 JSON 对象：count 为实际登记条目数量，names 为全部实际图源名称数组（包括重名条目）。不要下载，不修改配置，不运行命令。',[],{
      onEvent:event=>{if(event.type==='event'&&event.method==='item/agentMessage/delta')events.push(event.method);},
      onModel:()=>{}, onGeneration:g=>generations.push({generationId:g.generationId,state:g.state,model:g.model,inputTokens:g.inputTokens,outputTokens:g.outputTokens}),
      onRequest:async()=>({decision:'decline'}), execute:async call=>{
        if(call.function.name!=='sources_list')return{result:{error:'QA_READ_ONLY_TOOL_ONLY'}};
        const sources=await api.sourcesList(); tools.push({tool:'sources_list',names:sources.map(source=>source.displayName),count:sources.length});return{result:{sources:sources.map(source=>({id:source.id,name:source.displayName,license:source.license,attribution:source.attribution,minZoom:source.minZoom,maxZoom:source.maxZoom}))}};
      }
    });
    return{scope:'actual development desktop and native sources_list',status:result.status,text:result.text,threadId:result.threadId,tools,generations,streamingDeltas:events.length,
      uiConversationPreserved:activeBefore===document.querySelector('.conversation-item.active')?.getAttribute('data-conversation-id')};
  })()`);
  const answer = JSON.parse(result.text.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));
  result.answerVerified = answer.count === result.tools[0]?.count && JSON.stringify([...answer.names].sort()) === JSON.stringify([...result.tools[0].names].sort());
  result.passed = result.status === 'completed' && result.tools.length === 1 && result.generations.length >= 2 && result.streamingDeltas > 0 && result.uiConversationPreserved && result.answerVerified;
  writeFileSync(join(output, 'native-baseline.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1;
} finally {socket.close();}

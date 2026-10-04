import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preparePluginHooks,reviewPluginHookTrust,createPluginMcpHookGate} from '../src-tauri/codex-host.mjs';

test('native trust only receives the reviewed app-owned commands, leaving workspace hooks untrusted',async()=>{
 const root=mkdtempSync(join(tmpdir(),"geod hook 'quoted' "));
 try{
  const prepared=preparePluginHooks(root,[{pluginId:'ebd3908e-e9b3-40ab-b637-38f742be81e5',pluginName:'Package',packageRoot:root,dataRoot:root,event:'Stop',matcher:null,handlers:[{type:'command',command:'node script.mjs'}]}]);
  const command=[...prepared.commands][0];
  if(process.platform==='win32'){assert(command.startsWith('& '));assert.match(command,/''quoted''/);}
  const calls=[],local={sourcePath:prepared.file,key:'owned',handlerType:'command',eventName:'stop',matcher:null,command,currentHash:'reviewed-hash'};
  await reviewPluginHookTrust(async(method,params)=>{calls.push({method,params});return method==='hooks/list'?{data:[{hooks:[local,{...local,sourcePath:join(root,'workspace','.codex','hooks.json'),key:'workspace'}]}]}:{};},prepared,root);
  assert.deepEqual(calls[1].params.edits[0].value,{owned:{enabled:true,trusted_hash:'reviewed-hash'}});
  await assert.rejects(()=>reviewPluginHookTrust(async()=>({data:[{hooks:[{...local,command:'changed after review'}]}]}),prepared,root),/RUNTIME_MISMATCH/);
  preparePluginHooks(root,[]);assert.deepEqual(JSON.parse(readFileSync(prepared.file,'utf8')),{hooks:{}});
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('MCP automation retains engine templates and only the actual reviewed lifecycle grants a call',async()=>{
 const root=mkdtempSync(join(tmpdir(),'geod mcp hooks '));
 try{
  const prepared=preparePluginHooks(root,[{pluginId:'ebd3908e-e9b3-40ab-b637-38f742be81e5',sha256:'a'.repeat(64),groupIndex:4,serverBindings:{notes:'original-connector'},pluginName:'Package',packageRoot:root,dataRoot:root,event:'UserPromptSubmit',matcher:null,handlers:[{type:'mcp_tool',server:'notes',tool:'actual_tool',input:{event:'${hook_event_name}',prompt:'${prompt}'},timeout:5}]}]);
  const definition=prepared.definitions[0],runtime=JSON.parse(readFileSync(prepared.file,'utf8')).hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(runtime.type,'mcp_tool');assert.deepEqual(runtime.input,{event:'${hook_event_name}',prompt:'${prompt}'});assert.equal(runtime.command,undefined);
  assert.deepEqual(prepared.proxies.get(runtime.server).get(runtime.tool),{pluginId:'ebd3908e-e9b3-40ab-b637-38f742be81e5',sha256:'a'.repeat(64),groupIndex:4,handlerIndex:0,connectorId:'original-connector'});
  const listed={...definition,sourcePath:prepared.file,key:'mcp-reviewed',currentHash:'hash',displayOrder:3,timeoutSec:5},calls=[];
  await reviewPluginHookTrust(async(method,params)=>{calls.push({method,params});return method==='hooks/list'?{data:[{hooks:[listed]}]}:{};},prepared,root);
  assert.deepEqual(calls[1].params.edits[0].value,{'mcp-reviewed':{enabled:true,trusted_hash:'hash'}});
  const gate=createPluginMcpHookGate(prepared),event={threadId:'actual-thread',run:{id:'actual-hook',handlerType:'mcpTool',eventName:definition.eventName,displayOrder:3,sourcePath:prepared.file}};
  assert.equal(gate.claim(runtime.server,runtime.tool,'actual-thread'),null);
  gate.observe('hook/started',{...event,run:{...event.run,sourcePath:join(root,'unreviewed-hooks.json')}});assert.equal(gate.claim(runtime.server,runtime.tool,'actual-thread'),null);
  gate.observe('hook/started',event);assert.equal(gate.claim(runtime.server,runtime.tool,'other-thread'),null);
  const first=gate.claim(runtime.server,runtime.tool,'actual-thread');assert.equal(first.id,'actual-hook');assert.equal(gate.claim(runtime.server,runtime.tool,'actual-thread'),null);
  gate.observe('hook/completed',event);assert.equal(gate.claim(runtime.server,runtime.tool,'actual-thread'),null);
  // Codex can repeat a Stop hook with the same summary ID in one turn. Its new
  // real started event must receive a fresh native execution receipt.
  gate.observe('hook/started',event);const repeated=gate.claim(runtime.server,runtime.tool,'actual-thread');assert.notEqual(repeated.invocationId,first.invocationId);assert.equal(gate.claim(runtime.server,runtime.tool,'actual-thread'),null);
  await assert.rejects(()=>reviewPluginHookTrust(async()=>({data:[{hooks:[{...listed,tool:'unreviewed_tool'}]}]}),prepared,root),/RUNTIME_MISMATCH/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

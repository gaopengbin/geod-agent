// Bundled Codex + real hosted model + the same configuration function as chat.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
const rpc=async(command,args={})=>{const result=await(await fetch("http://127.0.0.1:1421/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;};
const runId=randomUUID(),conversationId=`source-auth-${randomUUID()}`,calls=[],start=Date.now();
let completed=false;
await rpc("test_codex_start",{runId,conversationId,input:"请添加天地图影像注记图源，图源 ID 用 tianditu-cia-w。Key 我稍后在图源管理填写，先保存需要 tk 参数的认证连接即可。通过图源 Creator 检查参数并实际配置，最后用 sources_list 核对。不要下载。"});
try {
  while(Date.now()-start<180000) {
    const state=await rpc("test_codex_poll",{runId});
    for(const event of state.events??[]) {
      if(event.type==="request")throw new Error(`Unexpected request ${event.method}`);
      if(event.type!=="tool")continue;
      const args=event.arguments;let result;
      switch(event.tool) {
        case "sources_list": result={sources:await rpc("sources_list")};break;
        case "extensions_list": result=await rpc("extensions_list");break;
        case "skill_read": result=await rpc("skill_read",{name:args.name});break;
        case "workspace_status": {const workspace=await rpc("workspace_get",{conversationId});result={permission:workspace.permission};break;}
        case "mcp_call": assert.equal(args.connectorId,"builtin-source-creator");result={connectorId:args.connectorId,kind:"builtin",toolName:args.toolName,result:await rpc("source_creator_call",{toolName:args.toolName,arguments:args.arguments})};break;
        case "source_configure": assert.equal(args.id,"tianditu-cia-w");result=await rpc("test_source_configure",args);break;
        default: throw new Error(`Unexpected domain tool ${event.tool}`);
      }
      calls.push({tool:event.tool,arguments:args,result});
      await rpc("codex_command",{runId,command:{type:"response",requestId:event.requestId,value:{result}}});
    }
    if(state.done) {
      assert(!state.error,JSON.stringify(state.error));assert.equal(state.value?.status,"completed");
      assert(calls.some(call=>call.tool==="source_configure"&&call.result.saved&&call.result.credentialRequired));
      const stored=await rpc("sources_get",{sourceId:"tianditu-cia-w"});assert.equal(stored.endpoint.authentication.mode,"queryToken");assert.equal(stored.endpoint.authentication.parameter,"tk");assert.equal(stored.endpoint.authentication.version,"pending");
      const report={pass:true,durationMs:Date.now()-start,model:"deepseek-flash",status:state.value.status,answer:state.value.text,calls};
      writeFileSync("../../docs/implementation/evidence/source-auth-real-model-2026-10-02.json",JSON.stringify(report,null,2));
      completed=true;console.log(JSON.stringify({pass:true,seconds:Math.round(report.durationMs/1000),tools:calls.map(call=>call.tool),answer:report.answer}));break;
    }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert(completed,"Real model turn did not complete");
}catch(error){await rpc("codex_command",{runId,command:{type:"interrupt"}}).catch(()=>{});throw error;}

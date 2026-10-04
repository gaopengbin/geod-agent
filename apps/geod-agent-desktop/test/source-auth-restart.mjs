import assert from "node:assert/strict";
import { readFileSync,writeFileSync } from "node:fs";
const rpc=async(command,args={})=>{const r=await(await fetch("http://127.0.0.1:1421/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command,args})})).json();if(r.error)throw r.error;return r.value;};
const file="../../docs/implementation/evidence/authenticated-sources-native-2026-10-02.json", report=JSON.parse(readFileSync(file,"utf8"));
for(const id of report.sources.slice(0,3)) {
  const stored=await rpc("sources_get",{sourceId:id});assert(stored.endpoint.authentication);assert(!JSON.stringify(stored).includes("declared-local-auth"));
  const data=Buffer.from(await rpc("map_preview_tile",{sourceId:id,z:4,x:8,y:8}),"base64");assert(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
}
const pending=await rpc("sources_get",{sourceId:"tianditu-img-w"});assert.equal(pending.endpoint.authentication.version,"pending");
Object.assign(report,{credentialsSurviveDesktopRestart:true,tiandituPendingConnectionSurvivesRestart:true});writeFileSync(file,JSON.stringify(report,null,2));
console.log(JSON.stringify({pass:true,credentialsSurviveDesktopRestart:true,tiandituPendingConnectionSurvivesRestart:true}));

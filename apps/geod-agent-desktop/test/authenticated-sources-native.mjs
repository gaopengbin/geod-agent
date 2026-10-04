// Real native IPC + Windows keyring + controlled HTTP tile server, no provider keys.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const rpc = async (command, args = {}) => {
  const response = await (await fetch("http://127.0.0.1:1421/rpc", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({command,args}) })).json();
  if (response.error) throw response.error; return response.value;
};
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit=0;bit<8;bit++) crc=(crc>>>1)^(crc&1 ? 0xedb88320 : 0); }
  const size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(data.length); sum.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([size,body,sum]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256,0); ihdr.writeUInt32BE(256,4); ihdr[8]=8;ihdr[9]=2;
const pixels = Buffer.alloc(256*(1+256*3));
for (let y=0;y<256;y++) for(let x=0;x<256;x++) { const i=y*769+1+x*3; pixels[i]=30+x%50;pixels[i+1]=100+y%50;pixels[i+2]=170; }
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(pixels)),chunk("IEND",Buffer.alloc(0))]);
const key = "declared-local-auth-test", rotated = "declared-local-auth-rotation";
const counts = { query:0, bearer:0, header:0, rejected:0 };
let slow = false, acceptedQuery = key;
const server = createServer(async(req,res) => {
  const url = new URL(req.url,"http://127.0.0.1:15443"), mode=url.pathname.split("/")[1];
  const token = mode==="query" ? url.searchParams.get("tk") : mode==="bearer" ? req.headers.authorization?.replace(/^Bearer /,"") : req.headers["x-api-key"];
  if(token !== (mode==="query" ? acceptedQuery : key)) { counts.rejected++;res.writeHead(401,{"content-type":"application/json"}).end(JSON.stringify({error:"fixture rejected authentication"})); return; }
  assert.equal(url.searchParams.get("LAYER"),"fixture"); counts[mode]++;
  if(slow) await new Promise(resolve=>setTimeout(resolve,350));
  res.writeHead(200,{"content-type":"image/png"}).end(png);
});
await new Promise(resolve=>server.listen(15443,"127.0.0.1",resolve));
if(process.argv.includes("--serve")) { acceptedQuery=rotated; console.log("Controlled authenticated tile fixture ready on localhost:15443"); }
else {
  const report={createdAt:new Date().toISOString(),tests:[],sources:[],counts};
  const conversationId=randomUUID(), directory=join(tmpdir(),`geod-auth-${conversationId}`);mkdirSync(directory,{recursive:true});
  const modes=[["query","queryToken","tk"],["bearer","bearerToken","Authorization"],["header","headerToken","X-API-Key"]];
  await rpc("workspace_set",{conversationId,directory,permission:"fullAccess"});
  async function wait(jobId,state) { const deadline=Date.now()+20000; while(Date.now()<deadline) { const job=await rpc("jobs_get",{jobId}); if(job.state===state && !(await rpc("jobs_active")).includes(jobId))return job; assert(!["failed","partial"].includes(job.state),JSON.stringify(job));await new Promise(r=>setTimeout(r,50)); }throw new Error(`Timed out waiting for ${state}`); }
  async function plan(sourceId, zoom=4) { const result=await rpc("test_imagery_plan",{conversationId,executionId:randomUUID(),batch:false,arguments:{sourceId,bounds:[-10,-10,10,10],zoom,outputFormats:["geotiff"]}});assert.equal(result.errors.length,0,JSON.stringify(result));return result.plans[0].stored; }
  try {
    for(const [path,mode,parameter] of modes) {
      const id=`auth-fixture-${path}-${conversationId}`,endpoint={id,name:`认证测试 ${path}`,attribution:"Controlled local synthetic pixels",license:"",urlTemplate:`http://127.0.0.1:15443/${path}/{z}/{x}/{y}?LAYER=fixture`,scheme:"XYZ",tileSize:256,networkPolicy:"UserTrustedHttp",minIntervalMs:0};
      const credential={mode,parameter,token:key};report.sources.push(id);
      const saved=await rpc("sources_save",{endpoint,minZoom:0,maxZoom:18,replaceExisting:false,credential});
      const stored=await rpc("sources_get",{sourceId:id});assert(!JSON.stringify(stored).includes(key));assert(saved.credentialRefVersion);
      const preview=await rpc("map_preview_tile",{sourceId:id,z:4,x:8,y:8});assert(Buffer.from(preview,"base64").equals(png));
      const wrong=await rpc("map_preview_tile",{endpoint,z:4,x:8,y:8,credential:{...credential,token:"deliberately-wrong-test-token"}}).then(()=>null,error=>error);
      assert.equal(wrong.code,"SOURCE_CREDENTIAL_REJECTED");assert(!JSON.stringify(wrong).includes(key));
      const planned=await plan(id);slow=true;
      const job=await rpc("jobs_start_auto",{conversationId,planId:planned.planId,idempotencyKey:randomUUID()});
      if(path==="query") { await rpc("jobs_pause",{jobId:job.jobId});await wait(job.jobId,"paused"); await rpc("jobs_resume",{jobId:job.jobId}); }
      await wait(job.jobId,"completed");slow=false;
      const manifest=await rpc("artifacts_inspect",{jobId:job.jobId});assert.equal(manifest.quality.status,"complete");assert.equal(manifest.quality.missingTiles,0);assert(!JSON.stringify(manifest).includes(key));
      for(const asset of manifest.assets) if(asset.kind==="manifest") assert(!readFileSync(join(planned.plan.spec.outputDirectory,asset.path),"utf8").includes(key));
      report.tests.push({mode,preview:true,wrongTokenRejected:true,download:true,resumed:path==="query",jobId:job.jobId,tiles:planned.plan.totalTiles,quality:manifest.quality});
      if(path==="query") {
        const oldPlan=await plan(id);acceptedQuery=rotated;
        const updated=await rpc("sources_save",{endpoint:stored.endpoint,minZoom:0,maxZoom:18,replaceExisting:true,credential:{...credential,token:rotated}});
        assert.notEqual(updated.configRevision,saved.configRevision);assert.notEqual(updated.credentialRefVersion,saved.credentialRefVersion);
        const stale=await rpc("jobs_start_auto",{conversationId,planId:oldPlan.planId,idempotencyKey:randomUUID()}).then(()=>null,error=>error);assert(stale);
        assert(Buffer.from(await rpc("map_preview_tile",{sourceId:id,z:4,x:8,y:8}),"base64").equals(png));
        report.tests.push({rotationInvalidatesOldPlan:true,staleCode:stale.code});
      }
    }
    const first=await rpc("sources_get",{sourceId:report.sources[0]});first.endpoint.urlTemplate=first.endpoint.urlTemplate.replace("15443","15444");
    const wrongOrigin=await rpc("map_preview_tile",{endpoint:first.endpoint,z:4,x:8,y:8}).then(()=>null,error=>error);assert.equal(wrongOrigin.code,"INVALID_SOURCE_AUTH");
    report.tests.push({originBinding:true});
    const pending={...first.endpoint,id:`auth-fixture-pending-${conversationId}`,authentication:null};report.sources.push(pending.id);
    const saved=await rpc("sources_save",{endpoint:pending,minZoom:0,maxZoom:18,credential:{mode:"queryToken",parameter:"tk"}});assert.equal(saved.credentialRefVersion,"pending");
    const missing=await rpc("map_preview_tile",{sourceId:pending.id,z:4,x:8,y:8}).then(()=>null,error=>error);assert.equal(missing.code,"SOURCE_CREDENTIAL_REQUIRED");
    const pendingPlan=await plan(pending.id);const failedStart=await rpc("jobs_start_auto",{conversationId,planId:pendingPlan.planId,idempotencyKey:randomUUID()}).then(()=>null,error=>error);assert.equal(failedStart.code,"SOURCE_CREDENTIAL_REQUIRED");
    report.tests.push({pendingConnection:true,missingTokenRejectedBeforeStart:true});report.pass=true;
    const template = await plan(report.sources[2]);
    const schedule = await rpc("schedules_create", { conversationId, planId:template.planId, name:"认证图源定时执行验收", nextRunAt:new Date(Date.now()+1500).toISOString(), repeatSeconds:null, maxRetries:0, executionId:randomUUID() });
    const deadline=Date.now()+20000;let scheduled;
    while(Date.now()<deadline) {
      scheduled=(await rpc("schedules_runs",{conversationId})).find(run=>run.scheduleId===schedule.scheduleId);
      if(scheduled?.state==="succeeded")break;
      assert(!["failed","cancelled"].includes(scheduled?.state),JSON.stringify(scheduled));await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(scheduled?.state,"succeeded");
    assert.equal((await rpc("artifacts_inspect",{jobId:scheduled.jobId})).quality.status,"complete");
    report.tests.push({authenticatedSchedule:true,jobId:scheduled.jobId});
    writeFileSync("../../docs/implementation/evidence/authenticated-sources-native-2026-10-02.json",JSON.stringify(report,null,2));
    console.log(JSON.stringify({pass:true,tests:report.tests,counts}));
  } finally { server.close(); }
}

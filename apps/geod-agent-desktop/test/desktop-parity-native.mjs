// Real Tauri IPC and public imagery; output readback uses the map's GeoTIFF source.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const rpc=async(command,args={})=>{const r=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(r.error)throw r.error;return r.value;};
const conversationId=`parity-${randomUUID()}`,workspace=resolve('../../artifacts/desktop-parity',conversationId);mkdirSync(workspace,{recursive:true});
await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
const catalog=await rpc('source_creator_call',{toolName:'source_presets',arguments:{}});
const dem=catalog.presets.find(s=>s.id==='terrarium-dem');assert(dem?.elevationEncoding==='terrarium');
await rpc('sources_save',{endpoint:{id:dem.id,name:dem.name,urlTemplate:dem.urlTemplate,attribution:dem.attribution,license:'',scheme:'XYZ',tileSize:256,networkPolicy:'PublicHttps',minIntervalMs:0,elevationEncoding:'terrarium'},minZoom:0,maxZoom:15,replaceExisting:false});
const labels={id:'esri-reference-labels',name:'Esri 影像注记',urlTemplate:'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',attribution:'Esri and contributors',license:'',scheme:'XYZ',tileSize:256,networkPolicy:'PublicHttps',minIntervalMs:0};
await rpc('sources_save',{endpoint:labels,minZoom:0,maxZoom:19,replaceExisting:false});
const records=[];
const cases=[
 {name:'six-formats',args:{sourceId:'esri-world-imagery',bounds:[116.38,39.89,116.48,39.98],zoomMin:11,zoomMax:12,outputFormats:['geotiff','mbtiles','png','jpeg','gpkg','tiles'],exportOptions:{compression:'deflate',buildPyramid:true,generateSidecars:true,jpegQuality:90}}},
 {name:'annotation',args:{sourceId:'esri-world-imagery',bounds:[116.38,39.89,116.48,39.98],zoom:12,outputFormats:['geotiff'],overlaySourceIds:[labels.id]}},
 {name:'dem',args:{sourceId:dem.id,bounds:[116.2,39.8,116.6,40.1],zoom:10,outputFormats:['geotiff'],exportOptions:{buildPyramid:true}}},
];
for (const item of cases) {
 console.log(`START ${item.name}`);
 const result=await rpc('test_imagery_plan',{conversationId,executionId:`parity:${item.name}:${randomUUID()}`,arguments:item.args});assert.equal(result.errors.length,0,JSON.stringify(result.errors));
 const stored=result.plans[0].stored;if(item.name==='dem')assert.equal(stored.plan.spec.exportOptions.elevationEncoding,'terrarium');
 const job=await rpc('jobs_start_auto',{planId:stored.planId,conversationId,idempotencyKey:`parity:${randomUUID()}`});
 const deadline=Date.now()+120000;let status;
 do {status=await rpc('jobs_get',{jobId:job.jobId});if(['completed','failed','partial','cancelled'].includes(status.state))break;await new Promise(r=>setTimeout(r,250));}while(Date.now()<deadline);
 assert.equal(status.state,'completed',JSON.stringify(status));const manifest=await rpc('artifacts_inspect',{jobId:job.jobId});assert.equal(manifest.quality.status,'complete');
 const raster=await rpc('test_native_raster',{jobId:job.jobId});assert(raster.samples.some(v=>v>0));assert.equal(raster.dataTile.bandCount,item.name==='dem'?2:5);
 records.push({name:item.name,job,plan:stored,manifest,raster});
 writeFileSync(resolve('../../docs/implementation/evidence/desktop-parity-native-2026-10-02.json'),JSON.stringify({pass:records.length===cases.length,conversationId,workspace,records},null,2));
}
writeFileSync(resolve('../../docs/implementation/evidence/desktop-parity-native-2026-10-02.json'),JSON.stringify({pass:true,conversationId,workspace,records},null,2));
console.log(JSON.stringify({pass:true,workspace,jobs:records.map(r=>({name:r.name,id:r.job.jobId,assets:r.manifest.assets.length,bands:r.raster.dataTile.bandCount}))}));

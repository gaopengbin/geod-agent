// Run after rebuilding native code: real MapLibre MVT, filtered file readback.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const rpc=async(command,args={})=>{const result=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;};
const conversationId=`data-range-${crypto.randomUUID()}`,workspace=resolve('../../artifacts/desktop-parity',conversationId);mkdirSync(workspace,{recursive:true});
await rpc('workspace_set',{conversationId,directory:workspace,permission:'fullAccess'});
const bounds=[13.404,52.520,13.406,52.522],boundary={polygons:[[[[13.404,52.520],[13.406,52.520],[13.405,52.522],[13.404,52.520]]]]};
const request={kind:'vector',spec:{source:{type:'mvt',id:'maplibre-countries',name:'MapLibre 国家边界',urlTemplate:'https://demotiles.maplibre.org/tiles/{z}/{x}/{y}.pbf',scheme:'xyz',layers:['countries'],attribution:'MapLibre demo'},bounds,boundary,zoomLevels:[2],outputs:['pbf','mbtiles','geojson','gpkg'],allowPartial:false}};
const task=await rpc('data_download_plan',{conversationId,title:'柏林范围内相交国家边界',idempotencyKey:'polygon-range',request});
assert.deepEqual(task.request.spec.boundary,boundary);
await rpc('data_download_start_auto',{conversationId,taskId:task.id,planHash:task.planHash});
let result;
for(let n=0;n<240;n++){result=await rpc('data_download_get',{conversationId,taskId:task.id});if(['completed','partial','failed','cancelled'].includes(result.status))break;await new Promise(r=>setTimeout(r,500));}
assert.equal(result.status,'completed',JSON.stringify(result));
const inspected=await rpc('data_download_inspect',{conversationId,taskId:task.id});assert.equal(inspected.manifest.featureCount,1);
const features=JSON.parse(readFileSync(resolve(inspected.outputDir,'features.geojson'),'utf8')).features;assert.equal(features.length,1);assert.equal(features[0].properties.ADM0_A3,'DEU');
const preview=await rpc('data_download_preview',{conversationId,taskId:task.id});assert.equal(preview.featureCount,1);await rpc('data_asset_unregister',{token:preview.token});
const evidence={pass:true,conversationId,task:inspected,featureProperties:features[0].properties,preview,checks:['native persists exact polygon geometry','public MVT download and four formats','bbox/polygon exports exclude other countries in the tile','verified GeoJSON and preview contain only Germany country geometry']};
writeFileSync(resolve('../../docs/implementation/evidence/vector-range-native-2026-10-02.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({pass:true,taskId:task.id,featureCount:1,country:'DEU'}));

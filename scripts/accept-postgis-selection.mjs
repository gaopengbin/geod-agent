/** Actual bundled pgEdge MCP + disposable TLS PostGIS, without logging credentials. */
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
const [playwrightModule,evidencePath,credentialFile]=process.argv.slice(2);
const draft=JSON.parse(await fs.readFile(credentialFile,'utf8'));
const {chromium}=await import(playwrightModule);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!result.ok)throw result.error;return result.value;};
const conversationId=`postgis-selection-${crypto.randomUUID()}`;
await fs.mkdir(evidencePath,{recursive:true});
const report={conversationId,cases:[]},created=[];
const record=(name,result)=>{
  if(JSON.stringify(result).includes(draft.password))throw new Error('Credential leaked');
  report.cases.push({name,pass:true,result});console.log(name,'PASS');
};
try{
  await rpc('workspace_set',{conversationId,directory:evidencePath,permission:'fullAccess'});
  const connected=await rpc('data_connection_save',{draft});
  if(connected.error)throw connected.error;
  const id=connected.connection.id;created.push(id);
  if(!connected.layers.some(l=>l.name==='public.regions.geog'))throw new Error('Geography was not discovered');
  record('TLS verify-full, CA and geography discovery',{layers:connected.layers,mcp:connected.mcp});
  const selection={filters:[{field:'name',op:'eq',value:'east'}],bounds:[116.05,39.55,116.25,39.75],maxFeatures:1};
  const inspected=await rpc('data_layer_inspect',{connectionId:id,layer:'public.regions.geog',limit:5,selection});
  if(inspected.error||inspected.featureCount!==1||inspected.storageType!=='geography'||inspected.sampleRecords[0].name!=='east')throw new Error(JSON.stringify(inspected));
  record('geography attributes + spatial intersection',inspected);
  const range=await rpc('data_input_read',{conversationId,request:{connectionId:id,layer:'public.regions.geog',...selection}});
  if(range.error||range.boundary?.polygonCount!==1)throw new Error(JSON.stringify(range.error));
  record('filtered geography boundary through MCP',{bounds:range.boundary.bounds,polygonCount:range.boundary.polygonCount,mcp:range.mcp});
  const multi=await rpc('data_input_read',{conversationId,request:{connectionId:id,layer:'public.regions.geom',filters:[{field:'score',op:'gte',value:20},{field:'name',op:'in',value:['west','third']}],maxFeatures:2}});
  if(multi.error||multi.boundary?.polygonCount!==2)throw new Error(JSON.stringify(multi.error));
  record('multiple typed AND filters',{bounds:multi.boundary.bounds,polygonCount:multi.boundary.polygonCount,mcp:multi.mcp});
  const cap=await rpc('data_input_read',{conversationId,request:{connectionId:id,layer:'public.regions.geom',maxFeatures:1}});
  if(cap.error?.code!=='INPUT_TOO_LARGE'||cap.boundary)throw new Error('Truncated database boundary accepted');record('cap rejects a partial boundary',cap.error);
  const injected=await rpc('data_layer_inspect',{connectionId:id,layer:'public.regions.geom',selection:{filters:[{field:'name',op:'eq',value:"east' OR true; DROP TABLE public.regions;--"}]}});
  if(injected.error||injected.featureCount!==0)throw new Error('A filter value was interpreted as SQL');record('SQL-looking value is an attribute value',{featureCount:injected.featureCount,mcp:injected.mcp});
  const invalid=await rpc('data_layer_inspect',{connectionId:id,layer:'public.regions.geom',selection:{filters:[{field:'name); DROP TABLE public.regions;--',op:'eq',value:'east'}]}});
  if(invalid.error?.code!=='INPUT_FILTER_INVALID')throw new Error('Undiscovered field accepted');record('only discovered fields can be filtered',invalid.error);
  for(const [name,change,expected]of [['hostname mismatch',{host:'127.0.0.1'},'INPUT_TLS_FAILED'],['unknown CA',{sslRootCert:undefined},'INPUT_TLS_FAILED'],['verify-ca without hostname validation',{host:'127.0.0.1',sslMode:'verify-ca'},null]]){
    const value=await rpc('data_connection_save',{draft:{...draft,...change}});
    if(expected){if(value.error?.code!==expected)throw new Error(JSON.stringify(value.error));record(name,value.error);}
    else{if(value.error)throw value.error;created.push(value.connection.id);record(name,{sslMode:value.connection.sslMode,mcp:value.mcp});}
  }
  const unchanged=await rpc('data_layer_inspect',{connectionId:id,layer:'public.regions.geom'});
  if(unchanged.featureCount!==3)throw new Error('Database fixture changed unexpectedly');record('read-only fixture remains intact',{featureCount:unchanged.featureCount,mcp:unchanged.mcp});
}catch(error){report.failure=error?.message??error;console.error(JSON.stringify(report.failure));process.exitCode=1;}
finally{for(const id of created)await rpc('data_connection_remove',{connectionId:id}).catch(()=>{});await fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(report,null,2));await browser.close();}

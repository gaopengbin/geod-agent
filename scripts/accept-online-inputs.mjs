/** Actual native IPC + public providers + explicitly labelled local fault fixtures. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [playwrightModule,evidencePath]=process.argv.slice(2);
const {chromium}=await import(playwrightModule);
await fs.mkdir(evidencePath,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;
for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page)break;await new Promise(resolve=>setTimeout(resolve,100));}
if(!page)throw new Error('No actual desktop WebView');
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{ok:false,error}}},{command,args});if(!result.ok)throw result.error;return result.value;};
const conversationId=`online-accept-${crypto.randomUUID()}`;
const token=crypto.randomUUID();
const hits=[];
let foreignRequests=0;
const foreign=http.createServer((request,response)=>{foreignRequests++;response.end('{}');});
await new Promise(resolve=>foreign.listen(0,'127.0.0.1',resolve));
const feature=i=>({type:'Feature',id:i,properties:{name:`fixture-${i}`},geometry:{type:'Polygon',coordinates:[[[20+i,10],[20.1+i,10],[20.1+i,10.1],[20+i,10.1],[20+i,10]]]}});
const fixture=http.createServer((request,response)=>{
  const url=new URL(request.url,'http://localhost');
  response.setHeader('content-type','application/json');
  const authenticated=request.headers.authorization===`Bearer ${token}`&&url.searchParams.get('token')===token;
  hits.push({path:url.pathname,index:url.searchParams.get('offset'),bbox:url.searchParams.get('bbox'),authenticated});
  if(!authenticated){response.writeHead(401);response.end('{}');return;}
  if(url.pathname==='/collections'){response.end(JSON.stringify({collections:[{id:'ranges',title:'分页面范围',links:[{rel:'items',type:'application/geo+json',href:'/collections/ranges/items'}]}]}));return;}
  const offset=Number(url.searchParams.get('offset')??0);
  const special=url.searchParams.get('fixture');
  let next=offset<2?`/collections/ranges/items?offset=${offset+1}${special?`&fixture=${special}`:''}`:null;
  if(special==='loop')next='/collections/ranges/items?fixture=loop';
  if(special==='foreign')next=`http://127.0.0.1:${foreign.address().port}/steal`;
  if(special==='truncated')next=null;
  response.end(JSON.stringify({type:'FeatureCollection',numberMatched:3,numberReturned:1,features:[feature(offset)],links:next?[{rel:'next',href:next}]:[]}));
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${fixture.address().port}/collections`;
const report={conversationId,public:[],fixtures:[],failures:[]};
const compact=value=>({selectedLayer:value.selectedLayer,online:value.online,boundary:value.boundary?{bounds:value.boundary.bounds,polygonCount:value.boundary.polygonCount}:null,error:value.error});
try{
  await rpc('workspace_set',{conversationId,directory:evidencePath,permission:'fullAccess'});
  const connection=await rpc('online_connection_save',{draft:{name:'在线分页验收 fixture',url:`${url}?token=${token}`,headers:{Authorization:`Bearer ${token}`}}});
  report.connectionMetadata=connection;
  if(JSON.stringify(connection).includes(token))throw new Error('Secret leaked into connection metadata');
  report.fixtures.push({case:'private discovery',value:await rpc('online_services_discover',{connectionId:connection.id})});
  const result=await rpc('data_input_read',{conversationId,request:{onlineConnectionId:connection.id,layer:'ranges',bounds:[20,10,23.2,10.2],pageSize:1,maxFeatures:3}});
  if(result.error||result.online?.featureCount!==3||result.boundary?.polygonCount!==3)throw new Error(`Incomplete private pages: ${JSON.stringify(compact(result))}`);
  report.fixtures.push({case:'complete 3 pages',value:compact(result)});
  for(const [name,suffix,code,maxFeatures]of [['truncated','fixture=truncated','INPUT_PAGED_RESULT',3],['loop','fixture=loop','INPUT_PAGED_RESULT',3],['foreign origin','fixture=foreign','INPUT_REDIRECT',3],['feature cap','','INPUT_TOO_LARGE',2]]){
    const conn=await rpc('online_connection_save',{draft:{name:`fixture ${name}`,url:`${url}/ranges/items?token=${token}&${suffix}`,headers:{Authorization:`Bearer ${token}`}}});
    try {await rpc('data_input_read',{conversationId,request:{onlineConnectionId:conn.id,maxFeatures,pageSize:1}});throw new Error(`Expected ${code}`);}
    catch(error){if(error?.code!==code)throw error;report.fixtures.push({case:name,error});}
    await rpc('online_connection_remove',{connectionId:conn.id});
  }
  if(foreignRequests!==0)throw new Error('Credentials were forwarded to a foreign origin');
  await rpc('online_connection_remove',{connectionId:connection.id});
  const publicCases=[
    {name:'ArcGIS Census MapServer',discover:'https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer',url:"https://sampleserver6.arcgisonline.com/arcgis/rest/services/Census/MapServer/3/query?where=STATE_NAME%20IN%20(%27Colorado%27,%27Utah%27)",pageSize:1},
    {name:'OGC pygeoapi lakes',discover:'https://demo.pygeoapi.io/master/collections',url:'https://demo.pygeoapi.io/master/collections/lakes/items',pageSize:1},
  ];
  for(const value of publicCases){
    try {const discovery=await rpc('online_services_discover',{url:value.discover});const result=await rpc('data_input_read',{conversationId,request:{url:value.url,pageSize:value.pageSize,maxFeatures:100}});if(result.error)throw result.error;report.public.push({name:value.name,discovery,value:compact(result)});}
    catch(error){report.failures.push({name:value.name,error});}
  }
  report.fixtures.push({case:'authentication forwarding',allAuthenticated:hits.every(h=>h.authenticated),foreignRequests,hits});
  if(!hits.every(h=>h.authenticated))throw new Error('A saved credential was not applied');
  console.log(JSON.stringify(report));
}catch(error){report.failures.push({name:'native fixture acceptance',error});console.error(JSON.stringify(error));process.exitCode=1;}
finally{await fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(report,null,2));await browser.close();fixture.close();foreign.close();}
if(report.failures.length)process.exitCode=1;

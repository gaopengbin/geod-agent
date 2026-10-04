/** Real native importer + Docker GeoServer/PostGIS; Content-Crs fault fixtures are labelled. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
const [playwrightModule,evidencePath]=process.argv.slice(2);
const {chromium}=await import(playwrightModule);
await fs.mkdir(evidencePath,{recursive:true});
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
let page;
for(let i=0;i<100;i++){page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));if(page)break;await new Promise(r=>setTimeout(r,100));}
if(!page)throw new Error('No actual GeoD desktop');
await page.waitForFunction(()=>!!window.__TAURI_INTERNALS__);
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{value:await window.__TAURI_INTERNALS__.invoke(command,args)}}catch(error){return{error}}},{command,args});if(result.error)throw result.error;return result.value;};
const conversationId=`wfs-accept-${crypto.randomUUID()}`;
const report={conversationId,provider:'Docker GeoServer + PostGIS',cases:[],pass:false};
const base='http://127.0.0.1:18083/geoserver/wfs';
const query=values=>`${base}?${new URLSearchParams({service:'WFS',...values})}`;
const compact=value=>({online:value.online,selectedLayer:value.selectedLayer,fields:value.fields,layers:value.layers,boundary:value.boundary?{bounds:value.boundary.bounds,polygonCount:value.boundary.polygonCount,holes:value.boundary.geometry.polygons.map(p=>p.length-1)}:null,error:value.error});
const check=async(name,fn)=>{try{const result=await fn();report.cases.push({name,pass:true,result});console.log(`${name} PASS`);}catch(error){report.cases.push({name,pass:false,error});console.log(`${name} FAIL ${JSON.stringify(error)}`);}};
const assert=(value,message)=>{if(!value)throw new Error(message);};
const bound=value=>{if(value.error)throw value.error;assert(value.boundary,'No actual imported boundary');assert(value.boundary.bounds.every((n,i)=>Math.abs(n-[116.1,39.6,116.3,39.8][i])<1e-6),`Incorrect CRS/axis: ${value.boundary.bounds}`);return compact(value);};
let fixture;
try{
  await rpc('workspace_set',{conversationId,directory:evidencePath,permission:'fullAccess'});
  for(const version of ['1.0.0','1.1.0','2.0.0']){
    await check(`WFS ${version} actual catalog and fields`,async()=>{
      const value=await rpc('online_services_discover',{url:query({version,typeNames:'geod:many_regions'})});
      assert(value.kind==='wfs'&&value.version===version&&value.layers.some(l=>l.name==='geod:many_regions'),'Actual capability metadata missing');
      assert(value.fields.some(f=>f.name==='id')&&value.fields.some(f=>f.name==='geom'),'DescribeFeatureType fields missing');return value;
    });
    await check(`WFS ${version} GeoJSON 3-page CQL filtered read`,async()=>{
      const value=await rpc('data_input_read',{conversationId,request:{url:query({version,CQL_FILTER:'id <= 3',sortBy:'id',outputFormat:'application/json'}),layer:'geod:many_regions',pageSize:1,maxFeatures:3}});
      assert(value.online?.complete===true&&value.online.featureCount===3&&value.online.requests>=4,'Three features were not fully paged');
      assert(value.boundary?.polygonCount===3,'Polygon features lost');return bound(value);
    });
    await check(`WFS ${version} WGS84 bbox axis order`,async()=>bound(await rpc('data_input_read',{conversationId,request:{url:query({version}),layer:'geod:boundary',bounds:[116,39.5,116.4,39.9],pageSize:1,maxFeatures:1}})));
  }
  for(const [name,values]of [
    ['WFS 2.0 projected GeoJSON EPSG:3857',{version:'2.0.0',srsName:'EPSG:3857',outputFormat:'application/json'}],
    ['WFS 1.0 GML2 3 pages',{version:'1.0.0',srsName:'EPSG:4326',outputFormat:'GML2'}],
    ['WFS 1.1 GML3 3 pages',{version:'1.1.0',srsName:'urn:ogc:def:crs:EPSG::4326',outputFormat:'text/xml; subtype=gml/3.1.1'}],
    ['WFS 2.0 GML3.2 3 pages and lat/lon axes',{version:'2.0.0',srsName:'urn:ogc:def:crs:EPSG::4326',outputFormat:'application/gml+xml; version=3.2'}],
  ])await check(name,async()=>{
    const value=await rpc('data_input_read',{conversationId,request:{url:query({...values,CQL_FILTER:'id <= 3',sortBy:'id'}),layer:'geod:many_regions',maxFeatures:3,pageSize:1}});
    assert(value.online?.featureCount===3&&value.boundary?.polygonCount===3,'Incomplete paged data');
    assert(value.boundary.geometry.polygons.every(p=>p.length===2),'Polygon holes lost');return bound(value);
  });
  await check('WFS MultiPolygon retained',async()=>{
    const value=await rpc('data_input_read',{conversationId,request:{url:base,layer:'geod:regions',pageSize:1}});assert(value.boundary?.polygonCount===2,'MultiPolygon lost');assert(value.boundary.bounds.every((n,i)=>Math.abs(n-[116.1,39.6,116.7,39.8][i])<1e-6),'MultiPolygon extent incorrect');return compact(value);
  });
  for(const [name,request,code]of [
    ['WFS 10,001 features bounded',{url:base,layer:'geod:many_regions',pageSize:1},'INPUT_TOO_LARGE'],
    ['WFS missing layer selection',{url:base},'INPUT_LAYER_REQUIRED'],
    ['WFS unknown layer',{url:base,layer:'geod:does_not_exist'},'INPUT_LAYER_NOT_FOUND'],
  ])await check(name,async()=>{try{await rpc('data_input_read',{conversationId,request});throw new Error(`Expected ${code}`);}catch(error){assert(error.code===code,`Wrong native error ${JSON.stringify(error)}`);return error;}});
  const projected=await (await fetch(query({version:'2.0.0',request:'GetFeature',typeNames:'geod:boundary',outputFormat:'application/json',srsName:'EPSG:3857'}))).json();
  delete projected.crs;
  fixture=http.createServer((request,response)=>{response.setHeader('Content-Type','application/geo+json');response.setHeader('Content-Crs','<http://www.opengis.net/def/crs/EPSG/0/3857>');response.end(JSON.stringify(request.url==='/disagree'?{...projected,crs:{type:'name',properties:{name:'EPSG:4326'}}}:projected));});
  await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
  await check('Labelled Content-Crs fixture projected response',async()=>bound(await rpc('data_input_read',{conversationId,request:{url:`http://127.0.0.1:${fixture.address().port}/items`}})));
  await check('Labelled Content-Crs fixture rejects disagreement',async()=>{try{await rpc('data_input_read',{conversationId,request:{url:`http://127.0.0.1:${fixture.address().port}/disagree`}});throw new Error('Expected INPUT_CRS_REQUIRED');}catch(error){assert(error.code==='INPUT_CRS_REQUIRED','CRS disagreement was accepted');return error;}});
}catch(error){report.cases.push({name:'setup',pass:false,error});}
finally{report.pass=report.cases.length>0&&report.cases.every(c=>c.pass);report.finishedAt=new Date().toISOString();await fs.writeFile(path.join(evidencePath,'acceptance.json'),JSON.stringify(report,null,2));await browser.close();fixture?.close();}
console.log(JSON.stringify({pass:report.pass,cases:report.cases.length,failed:report.cases.filter(c=>!c.pass).map(c=>c.name)}));
if(!report.pass)process.exitCode=1;

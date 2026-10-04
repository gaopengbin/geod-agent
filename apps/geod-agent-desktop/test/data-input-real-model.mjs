// Real bundled Codex + local gateway + Tauri. No fabricated domain tool outputs.
import { createServer } from 'node:http';
import { readFileSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
async function rpc(command,args={}){const result=await(await fetch('http://127.0.0.1:1421/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command,args})})).json();if(result.error)throw new Error(JSON.stringify(result.error));return result.value;}
const fixture=join(tmpdir(),'geod-data-input-fixtures');
const requested=(process.env.GEOD_TEST_SCENARIOS??'sources,gpkg,online,postgis').split(',').filter(Boolean);
if(!requested.length||requested.some(name=>!['sources','gpkg','online','postgis','postgis-connect'].includes(name)))throw new Error('Unknown real model test scenario');
const selected=new Set(requested);
const reportPath=process.env.GEOD_TEST_REPORT??'../../docs/implementation/evidence/data-input-real-model-2026-10-01.json';
const databaseLayer=process.env.GEOD_TEST_DB_LAYER??'public.input_polygons.geom';
const server=createServer((req,res)=>{res.setHeader('Content-Type','application/geo+json');res.end(readFileSync(join(fixture,'boundary.geojson')))});
await new Promise(resolve=>server.listen(15439,'127.0.0.1',resolve));
const databaseDraft=process.env.GEOD_TEST_DB_DRAFT_FILE?{...JSON.parse(readFileSync(process.env.GEOD_TEST_DB_DRAFT_FILE,'utf8')),name:'PostGIS real model test'}:{name:'PostGIS real model test',host:'127.0.0.1',port:55437,database:'postgres',user:'geod_test',password:readFileSync(join(tmpdir(),'geod-postgis-test/test-password.txt'),'utf8').trim(),sslMode:'disable'};
const connection=selected.has('postgis')?await rpc('data_connection_save',{draft:databaseDraft}):null;
if(connection&&!connection.connection)throw new Error(JSON.stringify(connection));
const connectionId=connection?.connection.id;
const createdConnections=[];
const report=[];
async function scenario(name,prepare,input){
 const conversationId=`cost-test-${name}-${randomUUID()}`,runId=randomUUID();
 if(name==='postgis-connect')await rpc('workspace_set',{conversationId,directory:process.env.GEOD_TEST_DB_WORKSPACE,permission:'confirmEach'});
 let boundary=null,plans=[];
 const prepared=prepare?await prepare(conversationId):null;
 const text=input(prepared),start=Date.now(),calls=[];
 await rpc('test_codex_start',{runId,conversationId,input:text});
 while(Date.now()-start<240000){
  const state=await rpc('test_codex_poll',{runId});
  for(const event of state.events??[]){
   if(event.type==='request')throw new Error('Unexpected approval/request '+event.method);
   if(event.type!=='tool')continue;
   const args=event.arguments;let result;
   try{
    let tool=event.tool;
    if(tool==='mcp_call'&&args.connectorId==='builtin-data-input'){tool=args.toolName;Object.assign(args,args.arguments);}
    if(name==='postgis-connect'&&['data_connection_connect','data_layer_inspect','data_input_read','data_connections_list'].includes(tool)){
     const value=await rpc('test_data_tool',{conversationId,tool,arguments:args});result=value.result;
     if(value.boundary)boundary=value.boundary;
     if(tool==='data_connection_connect'&&result.connection)createdConnections.push(result.connection.id);
    }else if(tool==='data_input_read'){
     const value=await rpc('data_input_read',{conversationId,request:Object.fromEntries(['url','relativePath','handle','connectionId','layer','sourceCrs'].filter(k=>typeof args[k]==='string').map(k=>[k,args[k]]))});
     if(value.boundary)boundary=value.boundary;
     result={...value,boundary:value.boundary?{name:value.boundary.name,bounds:value.boundary.bounds,polygonCount:value.boundary.polygonCount,attachedToDesktopPlan:true}:undefined};
    }else if(tool==='data_connection_connect'){result=await rpc('data_connection_connect',{conversationId,request:args});if(result.connection)createdConnections.push(result.connection.id);
    }else if(tool==='data_layer_inspect'){result=await rpc('data_layer_inspect',{connectionId:args.connectionId,layer:args.layer,limit:args.limit??5});
    }else if(tool==='data_connections_list'){result={connections:(await rpc('data_connections_list')).filter(c=>name==='postgis-connect'||c.id===connectionId).map(({id,name})=>({id,name,readOnly:true}))};
    }else if(tool==='extensions_list'){const installed=await rpc('extensions_list');const tools=JSON.parse(readFileSync('src-tauri/codex-tools.json','utf8')).filter(t=>['data_connection_connect','data_layer_inspect','data_input_read','data_connections_list'].includes(t.function.name)).map(({function:t})=>({name:t.name,description:t.description,inputSchema:t.parameters}));result={...installed,mcp:[{connectorId:'builtin-data-input',name:'数据范围 · 文件 / 在线 / PostGIS',enabled:true,kind:'builtin',tools}]};
    }else if(tool==='sources_list'){result={sources:await rpc('sources_list')};
    }else if(tool==='workspace_status'){const value=await rpc('workspace_get',{conversationId});result={permission:value.permission,defaultOutput:'当前工作区新文件夹'};
    }else if(tool==='plan_imagery'){
     const spec={schemaVersion:'0.1',kind:'imagery',sourceId:args.sourceId,bounds:boundary?.bounds??args.bounds,...(boundary?{boundary:boundary.geometry}:{}),zoomLevels:[args.zoom],outputFormats:args.outputFormats,outputDirectory:await rpc('output_directory_suggest',{conversationId}),limits:{maxTiles:4096,maxDecodedRgbaBytes:512*1024*1024}};
     const value=await rpc('plans_create',{spec,toolExecutionId:`cost-test:${runId}:${event.callId}`});plans.push(value.planId);
     result={planId:value.planId,source:value.plan.sourceName,bounds:value.plan.spec.bounds,polygonCount:boundary?.polygonCount,totalTiles:value.plan.totalTiles,requiredFreeDiskBytes:value.plan.requiredFreeDiskBytes,zoomLevels:value.plan.spec.zoomLevels,outputFormats:value.plan.spec.outputFormats,requiresPlanConfirmation:true};
    }else if(tool==='plans_get'){const value=await rpc('plans_get',{planId:args.planId});result=value?{planId:value.planId,totalTiles:value.plan.totalTiles,bounds:value.plan.spec.bounds}:null;
    }else{throw new Error('Test does not implement domain tool '+tool);}
   }catch(error){result={error:String(error)};}
   calls.push({tool:event.tool,args:{...args,password:undefined},result});
   await rpc('codex_command',{runId,command:{type:'response',requestId:event.requestId,value:{result}}});
  }
  if(state.done){
   const value=state.value;const hasTool=tool=>calls.some(call=>call.tool===tool||(call.tool==='mcp_call'&&call.args.toolName===tool));const pass=!state.error&&value?.status==='completed'&&(name==='sources'||(plans.length>0&&!!boundary))&&(name!=='postgis-connect'||(['data_connection_connect','data_layer_inspect','data_input_read'].every(hasTool)&&createdConnections.length>0));
   const record={scenario:name,conversationId,durationMs:Date.now()-start,pass,status:value?.status,answer:value?.text,error:state.error,calls,plans};report.push(record);console.log(name,pass?'PASS':'FAIL',Math.round(record.durationMs/1000)+'s');return;
  }
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 await rpc('codex_command',{runId,command:{type:'interrupt'}});throw new Error('Real model scenario timed out');
}
try{
 if(selected.has('sources'))await scenario('sources',null,()=> '读取当前图源，简短列出名称和类型。只查询，不修改。');
 if(selected.has('gpkg'))await scenario('gpkg',cid=>rpc('data_input_read',{conversationId:cid,request:{files:[{name:'multi.gpkg',base64:readFileSync(join(fixture,'multi.gpkg')).toString('base64')}]}}),prepared=>`我的 GeoPackage 已暂存，handle 是 ${prepared.handle}。读取其中 polygons 图层作为裁剪范围，使用已登记 Esri World Imagery 创建 Z12 / GeoTIFF 计划。只生成计划，不下载。请用 data_input_read 读取真实数据。`);
 if(selected.has('online'))await scenario('online',null,()=> '从 http://127.0.0.1:15439/boundary.geojson 读取用户在线范围，使用已登记 Esri World Imagery 创建 Z12 / GeoTIFF 计划。只生成计划，不下载。');
 if(selected.has('postgis'))await scenario('postgis',null,()=>`从已保存的 PostGIS 连接 ${connectionId} 读取 ${databaseLayer} 图层作为范围，使用已登记 Esri World Imagery 创建 Z12 / GeoTIFF 计划。只生成计划，不下载。`);
 if(selected.has('postgis-connect'))await scenario('postgis-connect',null,()=>`请新建一个名为 Agent 对话实测的 PostGIS 连接，配置在当前工作区的 ${process.env.GEOD_TEST_DB_CREDENTIAL_FILE}，由原生连接工具读取认证信息，不要用 shell 读取文件或展示密码。连接并发现图层，读取 ${databaseLayer} 的字段和两条属性样例，再将这个面图层作为范围，使用已登记 Esri World Imagery 创建 Z12 / GeoTIFF 裁剪计划。只生成计划，不下载。完成后用简短中文说明实际字段和范围。`);
}finally{
 for(const id of [connectionId,...createdConnections].filter(Boolean))await rpc('data_connection_remove',{connectionId:id});server.close();
 writeFileSync(reportPath,JSON.stringify({model:'deepseek-flash',codexVersion:'0.159.2',databaseLayer,scenarios:report},null,2));
}
if(report.some(record=>!record.pass)||report.length!==selected.size)process.exitCode=1;

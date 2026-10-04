// The native service owns credentials and transports the complete Codex model contract.
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,renameSync,mkdirSync,readdirSync,existsSync,copyFileSync,statSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const frame=(res,type,value)=>{if(!res.destroyed)res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`);};
const terminalRouteErrors=new Set(['SPONSOR_INVALID','SPONSOR_UNAVAILABLE','SPONSOR_DISABLED','SPONSOR_NOT_STARTED','SPONSOR_ENDED','SPONSOR_CHANGED','SPONSOR_MODEL_MISSING','SPONSOR_IMAGE_UNSUPPORTED']);
const modelError=error=>({code:['SPONSOR_QUOTA_EXCEEDED','QUOTA_EXCEEDED'].includes(error.code)?'insufficient_quota':terminalRouteErrors.has(error.code)?'invalid_prompt':'geod_gateway_error',message:String(error.message)});
const textItem=(id,text,phase)=>({id,type:'message',role:'assistant',status:'completed',phase,content:[{type:'output_text',text,annotations:[]}]});
export function sendGeneration(res,generation,id,{streamedText='',streamedReasoning=''}={}) {
  if(generation?.state!=='settled'||!generation.result)throw new Error(generation?.errorCode??'GATEWAY_GENERATION_INCOMPLETE');
  const result=generation.result,calls=result.toolCalls??[],output=[];
  if(result.reasoning||result.providerState)output.push({id:`reason_${id}`,type:'reasoning',summary:result.reasoning?[{type:'summary_text',text:result.reasoning}]:[],...(result.providerState?{encrypted_content:result.providerState}:{})});
  if(result.content)output.push(textItem(`msg_${id}`,result.content,result.phase??(calls.length?'commentary':'final_answer')));
  for(const call of calls)output.push(call.custom
    ?{id:`fc_${call.id}`,type:'custom_tool_call',status:'completed',call_id:call.id,name:call.function.name,input:call.input,...(call.namespace?{namespace:call.namespace}:{})}
    :{id:`fc_${call.id}`,type:'function_call',status:'completed',call_id:call.id,name:call.function.name,arguments:call.function.arguments,...(call.namespace?{namespace:call.namespace}:{})});
  for(const [index,item] of output.entries()) {
    const streamed=item.type==='message'?streamedText:item.type==='reasoning'?streamedReasoning:'';
    if(!streamed) {
      frame(res,'response.output_item.added',{output_index:index,item:{...item,status:'in_progress'}});
      if(item.type==='message')frame(res,'response.output_text.delta',{item_id:item.id,output_index:index,content_index:0,delta:result.content});
      if(item.type==='reasoning'&&result.reasoning)frame(res,'response.reasoning_summary_text.delta',{item_id:item.id,output_index:index,summary_index:0,delta:result.reasoning});
    }
    frame(res,'response.output_item.done',{output_index:index,item});
  }
  const usage=Number.isSafeInteger(generation.inputTokens)&&Number.isSafeInteger(generation.outputTokens)
    ?{input_tokens:generation.inputTokens,output_tokens:generation.outputTokens,total_tokens:generation.inputTokens+generation.outputTokens,
      input_tokens_details:{cached_tokens:result.usage?.cachedInputTokens??0},
      output_tokens_details:{reasoning_tokens:result.usage?.reasoningTokens??0}}:null;
  frame(res,'response.completed',{response:{id,object:'response',status:'completed',output,usage}});res.end();
}

export function prepareSqliteHome(home,sqliteHome=home) {
  if(resolve(home)===resolve(sqliteHome))return;
  mkdirSync(sqliteHome,{recursive:true});
  const marker=join(sqliteHome,'geod-migrated.json');
  if(existsSync(marker))return;
  // Called before app-server boots and after the native pool closes the old
  // host. Preserve the offline DB and WAL together; shared-memory indexes are
  // rebuilt by SQLite. Originals remain available for rollback.
  for(const name of readdirSync(home).filter(name=>/\.sqlite(?:-wal)?$/.test(name))) {
    const source=join(home,name);if(statSync(source).size===0)continue;
    const destination=join(sqliteHome,name),temporary=destination+'.geod-migrate';
    copyFileSync(source,temporary);renameSync(temporary,destination);
  }
  writeFileSync(marker,JSON.stringify({source:home,completedAt:new Date().toISOString()}));
}
export function codexApprovalPolicy(permission,background=false){
  if(permission!=='fullAccess')return'on-request';
  if(background)return'never';
  // Full workspace execution still permits a connector's explicit browser/form
  // interaction. `never` would silently decline these genuine user requests.
  return{granular:{sandbox_approval:false,rules:false,skill_approval:false,request_permissions:false,mcp_elicitations:true}};
}
export function preparePluginHooks(home,groups=[]) {
  const hooks={},commands=new Set(),definitions=[],proxies=new Map(),folder=join(home,'geod-plugin-hooks');
  mkdirSync(folder,{recursive:true});
  for(const [groupIndex,group]of groups.entries()) {
    if(!/^[a-z0-9-]{36}$/i.test(group.pluginId)||typeof group.packageRoot!=='string'||typeof group.dataRoot!=='string')throw new Error('PLUGIN_HOOK_DESCRIPTOR_INVALID');
    const handlers=group.handlers.map((handler,handlerIndex)=>{
      const eventName=group.event.charAt(0).toLowerCase()+group.event.slice(1),matcher=group.matcher??null;
      if(handler.type==='mcp_tool') {
        const connectorId=group.serverBindings?.[handler.server];
        if(!/^[a-f0-9]{64}$/i.test(group.sha256)||!Number.isSafeInteger(group.groupIndex)||!connectorId||group.event==='SessionEnd')throw new Error('PLUGIN_HOOK_DESCRIPTOR_INVALID');
        const server='geod_hook_'+group.pluginId.replaceAll('-',''),tool='hook_g'+group.groupIndex+'_h'+handlerIndex;
        const target={pluginId:group.pluginId,sha256:group.sha256,groupIndex:group.groupIndex,handlerIndex,connectorId};
        if(!proxies.has(server))proxies.set(server,new Map());
        if(proxies.get(server).has(tool))throw new Error('PLUGIN_HOOK_DESCRIPTOR_INVALID');
        proxies.get(server).set(tool,target);
        const runtime={...handler,server,tool,statusMessage:group.pluginName+' · '+(handler.statusMessage??group.event)};
        definitions.push({handlerType:'mcpTool',eventName,matcher,server,tool});
        return runtime;
      }
      if(handler.type!=='command')throw new Error('PLUGIN_HOOK_DESCRIPTOR_INVALID');
      const file=join(folder,group.pluginId+'-'+groupIndex+'-'+handlerIndex+'.json');
      writeFileSync(file,JSON.stringify({packageRoot:group.packageRoot,dataRoot:group.dataRoot,handler}));
      // The bundled engine uses the thread's detected PowerShell on Windows.
      // A quoted executable needs the call operator; cmd quoting silently fails here.
      const quote=value=>process.platform==='win32'?"'"+value.replaceAll("'","''")+"'":"'"+value.replaceAll("'","'\"'\"'")+"'";
      const command=(process.platform==='win32'?'& ':'')+[process.execPath,join(home,'plugin-hook-runner.mjs'),file].map(quote).join(' ');
      commands.add(command);
      definitions.push({handlerType:'command',eventName,matcher,command});
      const runtime={...handler,command,commandWindows:command,statusMessage:group.pluginName+' · '+(handler.statusMessage??group.event)};
      delete runtime.command_windows;return runtime;
    });
    const value={hooks:handlers};if(group.matcher!==null&&group.matcher!==undefined)value.matcher=group.matcher;
    (hooks[group.event]??=[]).push(value);
  }
  const file=join(home,'hooks.json'),source=JSON.stringify({hooks});writeFileSync(file,source);
  return {file,commands,definitions,proxies,sha256:createHash('sha256').update(source).digest('hex'),listed:[]};
}
const canonicalHookPath=value=>{let result;try{result=realpathSync.native(value);}catch{result=resolve(value);}result=result.replace(/^\\\\\?\\/,'');return process.platform==='win32'?result.toLowerCase():result;};
export async function reviewPluginHookTrust(rpc,prepared,workspace) {
  if(!prepared.definitions.length)return;
  // MSIX can expose one file through both Roaming and its package LocalCache path.
  const samePath=value=>canonicalHookPath(value)===canonicalHookPath(prepared.file);
  const listed=await rpc('hooks/list',{cwds:[workspace]});
  const local=listed.data.flatMap(entry=>entry.hooks).filter(hook=>samePath(hook.sourcePath));
  const identity=hook=>JSON.stringify([hook.handlerType,hook.eventName,hook.matcher??null,hook.handlerType==='command'?hook.command:hook.server,hook.handlerType==='command'?null:hook.tool]);
  const expected=prepared.definitions.map(identity).sort(),actual=local.map(identity).sort();
  if(JSON.stringify(expected)!==JSON.stringify(actual)||createHash('sha256').update(readFileSync(prepared.file)).digest('hex')!==prepared.sha256){
    writeFileSync(prepared.file+'.discovery.json',JSON.stringify({expectedFile:prepared.file,expectedCount:expected.length,matchedCount:local.length,expected,actual},null,2));
    throw new Error('PLUGIN_HOOK_RUNTIME_MISMATCH: 插件自动化配置未被配套引擎完整识别');
  }
  const value=Object.fromEntries(local.map(hook=>[hook.key,{enabled:true,trusted_hash:hook.currentHash}]));
  await rpc('config/batchWrite',{edits:[{keyPath:'hooks.state',value,mergeStrategy:'upsert'}],reloadUserConfig:true});
  prepared.listed=local;
}
// These routes are never advertised as model tools. Only an actual reviewed
// engine lifecycle notification can grant one call for its exact handler.
export function createPluginMcpHookGate(prepared) {
  const active=new Map();let sequence=0;
  return {
    observe(method,params) {
      const value=params?.run;if(!value||value.handlerType!=='mcpTool')return;
      if(method==='hook/completed'){active.delete(value.id);return;}
      if(method!=='hook/started'||typeof value.sourcePath!=='string'||canonicalHookPath(value.sourcePath)!==canonicalHookPath(prepared.file))return;
      const hook=prepared.listed.find(hook=>hook.handlerType==='mcpTool'&&hook.displayOrder===value.displayOrder&&hook.eventName===value.eventName);
      if(hook)active.set(value.id,{...hook,id:value.id,invocationId:value.id+':'+(++sequence),threadId:params.threadId,claimed:false});
    },
    claim(server,tool,threadId) {
      const hook=[...active.values()].find(hook=>!hook.claimed&&hook.server===server&&hook.tool===tool&&hook.threadId===threadId);
      if(hook)hook.claimed=true;return hook??null;
    },
    clear(){active.clear();},
  };
}
export async function createHost({codex,home,sqliteHome=home,toolsFile,emit,receive,capabilities={}}) {
  mkdirSync(home,{recursive:true});
  prepareSqliteHome(home,sqliteHome);
  const declared=JSON.parse(readFileSync(toolsFile,'utf8')),allowed=new Set(declared.map(t=>t.function.name));
  const secret=randomUUID()+randomUUID(),callbacks=new Map(),rpcPending=new Map();
  let child,run=null,closed=false,serial=0,initialized=false,preparedHooks,hookGate;
  const indexFile=join(home,'geod-threads.json');
  let index={};try{index=JSON.parse(readFileSync(indexFile,'utf8'));}catch{}
  const threadRecord=value=>typeof value==='string'?{id:value}:value;
  const notify=value=>emit({...value,...(run?{runId:run.runId}:{})});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const rpc=(method,params)=>new Promise((resolve,reject)=>{
    const id=++serial,timer=setTimeout(()=>{rpcPending.delete(id);reject(new Error(`Codex ${method} timed out`));},100000);
    rpcPending.set(id,{resolve,reject,timer});send({id,method,params});
  });
  const ask=(type,data,{requestId=randomUUID(),timeout=type==='request'?600000:180000}={})=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{callbacks.delete(requestId);reject(new Error(`${type} timed out`));},timeout);
    callbacks.set(requestId,{resolve,reject,timer});notify({type,requestId,...data});
  });
  const heartbeat=setInterval(()=>{if(run)notify({type:'heartbeat'});},3000);
  const interrupt=async()=>{if(run?.turnId)await rpc('turn/interrupt',{threadId:run.threadId,turnId:run.turnId});else if(run)run.interrupt=true;};
  const server=createServer(async(req,res)=>{
    let streamStarted=false;
    try {
      const actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${secret}`);
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected)){res.writeHead(401).end();return;}
      if(req.url?.startsWith('/plugin-hooks/')) {
        const alias=req.url.slice('/plugin-hooks/'.length),targets=preparedHooks?.proxies.get(alias);
        if(!targets||req.method!=='POST'){res.writeHead(404).end();return;}
        let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>64*1024)throw new Error('MCP request too large');}
        const message=JSON.parse(raw),respond=result=>{if(!res.destroyed)res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));};
        if(message.id===undefined){res.writeHead(202).end();return;}
        if(message.method==='initialize'){respond({protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'geod-plugin-hook',version:'0.2.0'}});return;}
        if(message.method==='tools/list'){respond({tools:[]});return;}
        if(message.method==='ping'){respond({});return;}
        if(message.method!=='tools/call'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}}));return;}
        const activeRun=run,target=targets.get(message.params?.name),threadId=message.params?._meta?.threadId;
        let hook=target&&activeRun?hookGate.claim(alias,message.params.name,threadId):null;
        // stdout notifications and HTTP arrive on different pipes; wait briefly
        // for the engine's actual event, without granting a speculative call.
        const until=Date.now()+750;
        while(target&&activeRun&&run===activeRun&&!hook&&Date.now()<until){await new Promise(resolve=>setTimeout(resolve,10));hook=hookGate.claim(alias,message.params.name,threadId);}
        if(!hook){respond({isError:true,content:[{type:'text',text:'PLUGIN_HOOK_NOT_ACTIVE: This tool is reserved for a reviewed lifecycle event.'}]});return;}
        const requestId=randomUUID(),callId=createHash('sha256').update(hook.invocationId).digest('hex');
        let settled=false;res.on('close',()=>{if(!settled)notify({type:'pluginHookMcpCancel',requestId});});
        try {
          const result=await ask('pluginHookMcp',{target,arguments:message.params.arguments??{},callId,hookRunId:hook.id,threadId,conversationId:activeRun.params.conversationId},{requestId,timeout:Math.min(hook.timeoutSec??600,900)*1000+1000});
          settled=true;respond(result);
        }catch(cause){settled=true;notify({type:'pluginHookMcpCancel',requestId});respond({isError:true,content:[{type:'text',text:String(cause.message)}]});}
        return;
      }
      if(req.method!=='POST'||req.url!=='/responses'||!run){res.writeHead(404).end();return;}
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>48_000_000)throw new Error('Responses request too large');}
      const request=JSON.parse(raw),id=`geod_${randomUUID()}`;
      if(capabilities.isolatedWorker){
        // The gateway contract rejects calls outside this exact worker allowlist.
        request.tools=(request.tools??[]).filter(tool=>tool.type==='function'&&allowed.has(tool.name));
        request.tool_choice='auto';
      }
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.flushHeaders();streamStarted=true;
      const nativeResponses=capabilities.protocol==='responses';
      if(!nativeResponses)frame(res,'response.created',{response:{id,object:'response',status:'in_progress',output:[]}});
      let streamedText='',streamedReasoning='',textIndex=null,reasonIndex=null,itemCount=0,wireCompleted=null,holdingWire=false;
      const heldWire=[];
      const requestId=randomUUID();
      const generation=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{callbacks.delete(requestId);reject(new Error('GeoD gateway timed out'));},180000);
        callbacks.set(requestId,{resolve,reject,timer,wire:(type,value)=>{
          if(!nativeResponses)return;
          // Codex can execute a tool as soon as its item is done, before the
          // overall response is completed. Preserve the ordered stream tail
          // from the first tool completion until native settlement is durable.
          if(type==='response.completed')wireCompleted=value;
          if(holdingWire||type==='response.completed'||type==='response.function_call_arguments.done'||type==='response.custom_tool_call_input.done'||(type==='response.output_item.done'&&['function_call','custom_tool_call'].includes(value?.item?.type))){holdingWire=true;heldWire.push([type,value]);}
          else frame(res,type,value);
        },delta:(part,text)=>{
          if(!text)return;
          if(part==='reasoning'){
            if(reasonIndex===null){reasonIndex=itemCount++;frame(res,'response.output_item.added',{output_index:reasonIndex,item:{id:`reason_${id}`,type:'reasoning',summary:[]}});frame(res,'response.reasoning_summary_part.added',{item_id:`reason_${id}`,output_index:reasonIndex,summary_index:0,part:{type:'summary_text',text:''}});}
            streamedReasoning+=text;frame(res,'response.reasoning_summary_text.delta',{item_id:`reason_${id}`,output_index:reasonIndex,summary_index:0,delta:text});
          }else{
            if(textIndex===null){textIndex=itemCount++;frame(res,'response.output_item.added',{output_index:textIndex,item:{...textItem(`msg_${id}`,'','commentary'),status:'in_progress',content:[]}});frame(res,'response.content_part.added',{item_id:`msg_${id}`,output_index:textIndex,content_index:0,part:{type:'output_text',text:'',annotations:[]}});}
            streamedText+=text;frame(res,'response.output_text.delta',{item_id:`msg_${id}`,output_index:textIndex,content_index:0,delta:text});
          }
        }});
        notify({type:'model',requestId,generationId:randomUUID(),conversationId:run.params.conversationId,request});
      });
      notify({type:'generation',generationId:generation.generationId,inputTokens:generation.inputTokens,state:generation.state,model:generation.model});
      if(nativeResponses){
        if(!wireCompleted||generation?.state!=='settled')throw new Error('PROVIDER_STREAM_INCOMPLETE');
        for(const [type,value]of heldWire)frame(res,type,value);res.end();
      }else sendGeneration(res,generation,id,{streamedText,streamedReasoning});
    }catch(error){
      if(!streamStarted)res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:String(error.message)}}));
      else {frame(res,'response.failed',{response:{id:'geod_failed',status:'failed',error:modelError(error)}});res.end();}
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const configure=params=>{
    preparedHooks=preparePluginHooks(home,capabilities.isolatedWorker?[]:(params.pluginHooks??[]));
    hookGate=createPluginMcpHookGate(preparedHooks);
    const model=capabilities.model??'deepseek-flash',window=capabilities.contextWindow??128000;
    const instructions=capabilities.isolatedWorker?'You are an isolated GeoD task agent. Complete only the assigned task using the declared workspace file tools. Reply concisely in the user language.':'You are GeoD Agent. Use actual tools and data to complete the user request. Communicate in the user language and distinguish executed results from plans.';
    writeFileSync(join(home,'geod-models.json'),JSON.stringify({models:[{slug:model,display_name:model,description:capabilities.providerName??'GeoD hosted model',input_modalities:capabilities.inputModalities??(model==='deepseek-flash'?['text','image']:['text']),context_window:window,max_context_window:window,effective_context_window_percent:95,default_reasoning_level:'high',supported_reasoning_levels:[{effort:'high',description:'Use model reasoning'}],shell_type:'unified_exec',visibility:'list',supported_in_api:true,priority:1,base_instructions:instructions,model_messages:{instructions_template:instructions,instructions_variables:{},approvals:null},default_reasoning_summary:'none',supports_reasoning_summaries:true,support_verbosity:true,default_verbosity:'low',apply_patch_tool_type:'freeform',web_search_tool_type:'text',truncation_policy:{mode:'tokens',limit:10000},supports_parallel_tool_calls:true,supports_image_detail_original:true,include_skills_usage_instructions:false,experimental_supported_tools:[],prefer_websockets:false,use_responses_lite:false}]}));
    const proxyServers=[...preparedHooks.proxies.keys()].map(name=>({name,url:`http://127.0.0.1:${server.address().port}/plugin-hooks/${name}`,hookProxy:true}));
    const mcp=[...(capabilities.isolatedWorker?[]:params.mcpServers??[]),...proxyServers].map(({name,url,hookProxy})=>`\n[mcp_servers.${JSON.stringify(name)}]\nurl = ${JSON.stringify(url)}\n${hookProxy?'bearer_token_env_var = "GEOD_CODEX_BRIDGE_TOKEN"\n':''}default_tools_approval_mode = ${JSON.stringify(params.permission==='fullAccess'?'approve':'writes')}\ntool_timeout_sec = 900\n`).join('');
    writeFileSync(join(home,'config.toml'),`model = ${JSON.stringify(model)}\nmodel_provider = "geod_hosted"\nmodel_context_window = ${window}\nmodel_auto_compact_token_limit = ${Math.floor(window*.8)}\nproject_doc_max_bytes = ${capabilities.isolatedWorker?0:32768}\nmodel_catalog_json = ${JSON.stringify(join(home,'geod-models.json'))}\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\nweb_search = "disabled"\n[model_providers.geod_hosted]\nname = "GeoD hosted model"\nbase_url = "http://127.0.0.1:${server.address().port}"\nwire_api = "responses"\nenv_key = "GEOD_CODEX_BRIDGE_TOKEN"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nmulti_agent = false\n${capabilities.isolatedWorker?'shell_tool = false\n':''}${process.platform==='win32'?'\n[windows]\nsandbox = "unelevated"\n':''}${mcp}`);
  };
  const unsubscribe=receive(async command=>{
    try {
      if(command.type==='response'){
        const entry=callbacks.get(command.requestId);if(!entry)return;callbacks.delete(command.requestId);clearTimeout(entry.timer);
        command.error?entry.reject(Object.assign(new Error(command.error),{code:command.errorCode})):entry.resolve(command.value);
      }else if(command.type==='wire')callbacks.get(command.requestId)?.wire?.(command.event,command.value??command.data);
      else if(command.type==='delta')callbacks.get(command.requestId)?.delta?.(command.part??'content',command.text);
      else if(command.type==='interrupt')await interrupt();
      else if(command.type==='steer'&&run?.turnId){await rpc('turn/steer',{threadId:run.threadId,expectedTurnId:run.turnId,input:[{type:'text',text:command.text}]});notify({type:'steered',text:command.text});}
    }catch(error){notify({type:'commandError',message:String(error.message)});}
  });
  const boot=async params=>{
    configure(params);
    if(initialized){await rpc('config/mcpServer/reload',{});await reviewPluginHookTrust(rpc,preparedHooks,params.workspace);return;}
    notify({type:'stage',stage:'starting',message:'正在连接 Codex 引擎…'});
    // A parent Codex session's policy/runtime variables belong to that session.
    const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CODEX_')));
    // Windows may discover a system proxy even with no proxy environment.
    // Core only reaches our loopback bridge; that connection must stay local.
    const bypass=[environment.NO_PROXY,environment.no_proxy,'127.0.0.1','localhost','::1'].filter(Boolean).join(',');
    environment.NO_PROXY=bypass;environment.no_proxy=bypass;
    child=spawn(codex,['app-server','--stdio','--enable','hooks'],{cwd:params.workspace,env:{...environment,CODEX_HOME:home,CODEX_SQLITE_HOME:sqliteHome,GEOD_CODEX_BRIDGE_TOKEN:secret},windowsHide:true,stdio:['pipe','pipe','pipe']});
    const failed=error=>{run?.reject(error);for(const entry of rpcPending.values()){clearTimeout(entry.timer);entry.reject(error);}rpcPending.clear();initialized=false;};
    let stderr='';
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString('utf8')).slice(-16384);});
    child.on('error',failed);child.on('exit',code=>{
      if(stderr)try{writeFileSync(join(home,'codex-stderr.log'),stderr);}catch{}
      if(!closed)failed(new Error(`Codex process exited (${code})${stderr?'；详细错误已保存在本机引擎日志':''}`));
    });
    createInterface({input:child.stdout}).on('line',async line=>{
      let value;try{value=JSON.parse(line);}catch{return;}
      if('id'in value&&!value.method){const pending=rpcPending.get(value.id);if(pending){rpcPending.delete(value.id);clearTimeout(pending.timer);value.error?pending.reject(new Error(value.error.message)):pending.resolve(value.result);}return;}
      if('id'in value&&value.method){
        try{
          if(value.params?.threadId&&run?.threadId&&value.params.threadId!==run.threadId)throw new Error('THREAD_NOT_IN_RUN');
          if(value.method==='item/tool/call'){
            const {tool,arguments:args,callId}=value.params;
            if(!allowed.has(tool)){send({id:value.id,result:{success:false,contentItems:[{type:'inputText',text:'TOOL_NOT_ALLOWED'}]}});return;}
            const output=await ask('tool',{tool,arguments:args,callId,threadId:run?.threadId});
            send({id:value.id,result:{success:!output.result?.error,contentItems:[{type:'inputText',text:JSON.stringify(output.result)}]}});
          }else {const output=await ask('request',{method:value.method,params:value.params});send({id:value.id,result:output});}
        }catch(error){send({id:value.id,error:{code:-32000,message:String(error.message)}});}return;
      }
      if(!run)return;
      if(value.params?.threadId&&run.threadId&&value.params.threadId!==run.threadId)return;
      if(value.method==='turn/started'){run.turnId=value.params.turn.id;if(run.interrupt)void interrupt();}
      if(value.method==='item/agentMessage/delta'){const id=value.params.itemId;run.output.set(id,(run.output.get(id)??'')+value.params.delta);}
      if(value.method==='item/completed'&&value.params.item.type==='agentMessage')run.output.set(value.params.item.id,value.params.item.text);
      hookGate?.observe(value.method,value.params);
      notify({type:'event',method:value.method,params:value.params});
      if(value.method==='turn/completed')run.resolve({threadId:run.threadId,...value.params.turn,text:[...run.output.values()].at(-1)??''});
    });
    const info=await rpc('initialize',{clientInfo:{name:'geod_agent_desktop',title:'GeoD Agent',version:'0.2.0'},capabilities:{experimentalApi:true}});
    if(!info.userAgent?.includes('/0.159.2 '))throw new Error('此版本需要配套的 Codex 0.159.2 引擎。');
    send({method:'initialized'});initialized=true;
    await reviewPluginHookTrust(rpc,preparedHooks,params.workspace);
  };
  return {
    async fork(params){
      if(run)throw new Error('Codex 正在处理上一轮对话');
      await boot(params);
      const source=threadRecord(params.sourceThread??index[params.sourceConversationId]);
      const sourceThreadId=source?.id;
      if(!sourceThreadId)throw new Error('CODEX_THREAD_NOT_FOUND: 原对话还没有可分支的 Codex 线程');
      if(index[params.conversationId])throw new Error('CODEX_FORK_CONFLICT: 目标对话已经存在');
      const value=await rpc('thread/fork',{threadId:sourceThreadId,...(source.path?{path:source.path}:{}),cwd:params.workspace,model:capabilities.model??'deepseek-flash',modelProvider:'geod_hosted',approvalPolicy:codexApprovalPolicy(params.permission),sandbox:params.permission==='fullAccess'?'workspace-write':'read-only',excludeTurns:true,...(params.lastTurnId?{lastTurnId:params.lastTurnId}:{})});
      if(!value.thread?.id||value.thread.id===sourceThreadId)throw new Error('Codex 没有创建独立的会话分支');
      index[params.conversationId]={id:value.thread.id,path:value.thread.path};
      const temporary=indexFile+'.tmp';writeFileSync(temporary,JSON.stringify(index));renameSync(temporary,indexFile);
      return{threadId:value.thread.id,sourceThreadId,forkedFromId:value.thread.forkedFromId??sourceThreadId};
    },
    async turn(params,runId=randomUUID()){
      if(run)throw new Error('Codex 正在处理上一轮对话');
      let resolveTurn,rejectTurn;const finished=new Promise((resolve,reject)=>{resolveTurn=resolve;rejectTurn=reject;});finished.catch(()=>{});
      run={runId,params,output:new Map(),resolve:resolveTurn,reject:rejectTurn,threadId:null,turnId:null,interrupt:false};
      try{
        await boot(params);notify({type:'capabilities',capabilities:{...capabilities,engine:'Codex',version:'0.159.2'}});
        notify({type:'stage',stage:'restoring',message:'正在准备会话上下文…'});
        const permission=params.permission??'confirmEach';
        const overrides={model:capabilities.model??'deepseek-flash',modelProvider:'geod_hosted',cwd:params.workspace,
          approvalPolicy:codexApprovalPolicy(permission,!!params.background),sandbox:permission==='fullAccess'?'workspace-write':'read-only',
          developerInstructions:`You are GeoD Agent. Reply in the user's language, including all commentary before tool calls. Respect an explicit reply-language preference in the current request; otherwise follow its input language. Use GeoD tools for map, sources and imagery jobs, and available Skills/MCP/tools for other GIS work. For a 2D map, discover OpenLayers through extensions_list. For a 3D scene, camera, globe, basemap, buildings or scene entities, discover Cesium through extensions_list and use builtin-cesium-mcp exact returned tool names and schemas via mcp_call. Cesium getSceneState reports whether this conversation has an open 3D scene; if not, use data_download_load on its completed 3D task first. OpenLayers and Cesium are separate actual views: loading a 2D source never changes the 3D basemap. Cesium loadSource uses native saved source credentials; setBasemap(osm) adds the 3D globe basemap, getView/setView/flyTo control its camera, and fitScene targets the actual download bounds. This MCP runs inside the desktop map; shell MCP configurations do not enumerate it. loadSource displays a registered source; loadArtifact displays a verified GeoTIFF result by jobId. For vector ranges, online feature URLs and PostGIS, discover builtin-data-input through extensions_list and use its exact tools via mcp_call, or data_input_read when available. It saves supported vector ranges with stable boundaryId values. boundaries_list retrieves previous ranges in this conversation. Looking up or reading another region never removes saved ranges. Use explicit boundaryId in plan_imagery. For multiple regions use plan_imagery_batch(mode merge or split) with actual IDs; merge clips to the union, split creates separately named plans. Discover source creator lookup_neighbors for actual shared-boundary neighbors and lookup_boundaries for multiple administrative regions. Resolve all requested ranges and report per-region failures. Do not guess surrounding cities or claim that multiple boundaries cannot be combined. Do not ask users to convert supported files manually. Use data_connection_connect to establish PostgreSQL/PostGIS connections from the conversation, discover actual layers, and use data_layer_inspect for field types and sample records. Reuse saved connections by ID. Missing authentication opens a native password form; wait for that result and then continue reading. A user-provided credentialFile is read only by the native connector, never via shell or file tools. Passwords stay native; do not ask for them in chat. Missing CRS and multi-layer choices must be resolved from actual metadata or user input, not guesses. Current conversation permission: ${permission}; native executors enforce it. Source configuration is a technical task, not a licensing review. When explicitly asked to schedule imagery, use schedules_create with an existing plan template. This local scheduler runs without further model turns while the independent local background process is running, including after the desktop window closes; it coalesces missed occurrences after restart, refreshes the plan and output directory, and enforces the current workspace permission. schedules_list includes durable run records. The imagery scheduler itself does not schedule arbitrary AI prompts; use ai_schedules_create for that. Hand downloads off to native background monitoring; do not repeatedly poll. Answer concisely from actual tool results; keep identifiers and implementation details in tool records unless requested.`};
        overrides.developerInstructions+=' For requests to switch to 2D/3D or return to the map, use Cesium getViewMode and setViewMode(mode:2d or 3d). These control the actual GeoD workspace view, not Cesium camera pitch or scene morphing. Temporary 2D mode retains the 3D camera and layers; closeScene releases it. getSceneState opened:true with visible:false means the scene is retained while the workspace displays 2D. Use setViewMode(3d) to show it again. Do not ask the user to click X when the view-switch tool is available.';
        overrides.developerInstructions+=' For explicitly requested later or recurring AI instructions, use ai_schedules_create. This executes real Codex in the independent local background process, retains actual run results and tool records, and uses current account/workspace permission. Each schedule has its own Codex thread; retries retain that schedule thread. While the computer sleeps or the background process is stopped, execution pauses; on restart, an overdue once-only schedule runs once and missed recurring occurrences are coalesced into one run. ai_schedules_list reads both schedules and runs; ai_schedules_run_events reads execution records. Do not silently create a schedule for an ordinary immediate request.';
        overrides.developerInstructions+=' For explicitly requested long-running workspace commands, discover builtin-background-commands or use background_command_prepare with the exact executable and argv array, then background_command_start with the returned ID/hash when native permission allows. This uses actual standalone Codex command/exec owned by the local companion and keeps running after the window closes. The task panel monitors output, input and stopping. After handoff, normally give the task title and actual status in one or two sentences; leave IDs, timestamps, argv and execution details in the task panel unless the user asks for them. Do not repeatedly poll. Use background_command_get when the user asks for status. Keep credentials out of argv, output and command stdin. Ordinary short commands can use the existing execution tools.';
        overrides.developerInstructions+=' Independent file analysis subtasks can use agent_tasks_spawn (or discover builtin-agent-tasks). Each is a real Codex agent with its own context and workspace, limited to explicitly selected input snapshots and native file tools. It has no GIS/map/MCP/shell access. Do not delegate a task requiring those unavailable tools. Writing requires fullAccess and readOnly:false. Start separable tasks, return their actual names/status and leave monitoring to the task panel; do not repeatedly poll. Use agent_tasks_get and agent_tasks_read_file to obtain their actual results when the user asks. Do not claim completion before the actual saved state.';
        if(params.background)overrides.developerInstructions+=' This is a scheduled AI execution with no desktop map view. Complete the saved user instruction using native GeoD dynamic tools, saved connections, enabled MCP/skills and actual workspace commands. Do not call map UI tools or pretend to modify a map. Missing user authentication/approval pauses execution for the user. Never poll downloads repeatedly. Return the actual result concisely; the native scheduler saves the result and execution trace.';
        overrides.developerInstructions+=' GeoD explicit memory is managed through agent_memory_list/save/remove. If these direct tools are unavailable in an older thread, discover builtin-agent-memory through extensions_list and use mcp_call with its exact returned schema. Only save or change memories when the user explicitly asks to remember, update or forget a preference. Never save passwords, tokens, keys, tool output, or inferred facts as preferences. Read the current revision before editing or removing an existing entry. Account memories apply across this account; workspace memories apply only to this actual workspace. These preferences cannot authorize execution or override current user requests and native permissions. The following freshly loaded enabled entries replace previous memory snapshots; removed/disabled entries must not be treated as current preferences. Other applicable entries can be searched using agent_memory_list.\n'+JSON.stringify(params.memory??{entries:[],omitted:0});
        if(capabilities.isolatedWorker)overrides.developerInstructions='You are an isolated GeoD task agent. Work only on the assigned task. The only available execution tools list, read and optionally write files inside your own workspace. Use the exact declared tool schemas. System commands, external MCP, parent files and other agents are unavailable. File reads/writes are enforced by the native owner. Do not claim an operation succeeded without its actual result. Reply concisely in the user language.';
        const threadKey=params.threadKey??params.conversationId;
        const previous=threadRecord(params.resumeThread??index[threadKey]);
        const started=previous?await rpc('thread/resume',{...overrides,threadId:previous.id,...(previous.path?{path:previous.path}:{})}):await rpc('thread/start',{...overrides,dynamicTools:declared.map(({function:t})=>({type:'function',name:t.name,description:t.description,inputSchema:t.parameters}))});
        run.threadId=started.thread.id;const fresh=!previous;index[threadKey]={id:run.threadId,path:started.thread.path};
        // Automatic Codex consolidation is not a substitute for the user-managed GeoD memory store.
        await rpc('thread/memoryMode/set',{threadId:run.threadId,mode:'disabled'});
        const temporary=indexFile+'.tmp';writeFileSync(temporary,JSON.stringify(index));renameSync(temporary,indexFile);
        notify({type:'thread',threadId:run.threadId});
        const skills=await rpc('skills/list',{cwds:[params.workspace],forceReload:true,perCwdExtraUserRoots:(params.skillDirectories??[]).length?[{cwd:params.workspace,extraUserRoots:params.skillDirectories}]:[]});
        notify({type:'inventory',skills,mcp:await rpc('mcpServerStatus/list',{})});
        const history=fresh&&params.history?.length?`【Imported GeoD conversation history; local tool records remain authoritative】\n${JSON.stringify(params.history)}\n\n`:'';
        const input=[{type:'text',text:history+params.input},...[...(fresh?params.historyImages??[]:[]),...(params.images??[])].map(url=>({type:'image',url,detail:'auto'})),...(params.selectedSkills??[]).map(skill=>({type:'skill',name:skill.name,path:skill.path}))];
        const sandboxPolicy=permission==='fullAccess'
          ?{type:'workspaceWrite',writableRoots:[params.workspace],networkAccess:false,excludeTmpdirEnvVar:false,excludeSlashTmp:false}
          :{type:'readOnly',networkAccess:false};
        // Resume can rejoin an already loaded thread; refresh execution permissions per turn.
        const turn=await rpc('turn/start',{threadId:run.threadId,input,cwd:params.workspace,runtimeWorkspaceRoots:[params.workspace],approvalPolicy:overrides.approvalPolicy,sandboxPolicy});run.turnId=turn.turn.id;if(run.interrupt)await interrupt();
        return await finished;
      }finally{
        hookGate?.clear();
        for(const entry of callbacks.values()){clearTimeout(entry.timer);entry.reject(new Error('Codex turn ended'));}callbacks.clear();run=null;
      }
    },
    async close(){
      if(closed)return;closed=true;unsubscribe?.();clearInterval(heartbeat);run?.reject(new Error('Codex host closed'));
      for(const entry of callbacks.values()){clearTimeout(entry.timer);entry.reject(new Error('Codex host closed'));}callbacks.clear();
      for(const entry of rpcPending.values()){clearTimeout(entry.timer);entry.reject(new Error('Codex host closed'));}rpcPending.clear();
      if(child&&child.exitCode===null){child.stdin.end();const timeout=setTimeout(()=>child.kill(),2000);await new Promise(resolve=>{child.once('exit',resolve);if(child.exitCode!==null)resolve();});clearTimeout(timeout);}
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    },
    get processId(){return child?.pid;},
  };
}
export async function runHost(options){const host=await createHost(options);try{return await host.turn(options.params);}finally{await host.close();}}
async function main(){
  const lines=createInterface({input:process.stdin});let listener=null,host=null;
  const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
  lines.on('line',async line=>{
    let value;try{value=JSON.parse(line);}catch{return;}
    if(value.type==='start'||value.type==='fork'){
      try{if(!host)host=await createHost({...value.options,emit,receive:fn=>{listener=fn;return()=>{listener=null;};}});emit({type:'done',runId:value.runId,result:value.type==='fork'?await host.fork(value.params):await host.turn(value.params,value.runId)});}
      catch(error){emit({type:'failed',runId:value.runId,error:String(error.message)});}
    }else if(value.type==='close'){await host?.close();lines.close();process.stdin.destroy();}
    else listener?.(value);
  });
  lines.on('close',()=>{void host?.close();});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();

// Durable cross-tool steps. Codex still decides what work to propose; this layer
// owns dependency checks, receipts and verification, never native authorization.
import {readFileSync,writeFileSync,renameSync,mkdirSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const specification=s=>Object.fromEntries(['id','title','dependsOn','tool','arguments','acceptance'].map(k=>[k,s[k]]));
const copy=v=>JSON.parse(JSON.stringify(v));
const fail=(code,message,extra={})=>({error:code,message,runtimePolicy:true,...extra});
const object={type:'object',additionalProperties:true};
export const WORKFLOW_TOOLS=[
 {type:'function',function:{name:'runtime_workflow_plan',description:'Persist a multi-tool delivery as dependent steps before executing it. Each step binds an actual tool, arguments and acceptance. Start with known steps and amend as receipts arrive. Native checks apply to managed job/download or artifact receipts; plans and database queries use result conditions. Use workflow_repair for one failed step. References {$step:"id",pointer:"/resultField"} read a dependency receipt. Acceptance paths can use {$result:"/field"}. This grants no permission. Preserve completed compatible steps on amendment; changing a step invalidates its dependants only. Do not use for simple one-tool requests.',parameters:{type:'object',properties:{title:{type:'string',minLength:1,maxLength:200},expectedRevision:{type:'integer',minimum:0},steps:{type:'array',minItems:1,maxItems:256,items:{type:'object',properties:{id:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,64}$'},title:{type:'string',minLength:1,maxLength:200},dependsOn:{type:'array',items:{type:'string'},uniqueItems:true},tool:{type:'string',minLength:1,maxLength:120},arguments:object,acceptance:{type:'array',minItems:1,maxItems:16,items:{type:'object',properties:{kind:{type:'string',enum:['native','result','file','json','raster','vector']},path:{},pointer:{type:'string'},equals:{},minItems:{type:'integer',minimum:0},requiredFields:{type:'array',items:{type:'string'}},crs:{type:'string'},layout:{type:'string'},compression:{type:'string'},width:{type:'integer',minimum:1},height:{type:'integer',minimum:1},bands:{type:'integer',minimum:1},overviews:{type:'array',items:{type:'integer',minimum:2}},minFeatures:{type:'integer',minimum:0}},required:['kind'],additionalProperties:false}}},required:['id','title','tool','arguments','acceptance'],additionalProperties:false}}},required:['title','expectedRevision','steps'],additionalProperties:false}}},
 {type:'function',function:{name:'runtime_workflow_run',description:'Execute one persisted step through the existing native executor and approvals; enforce dependencies and native acceptance. Completed steps are verified and reused without resubmission. An interrupted step with an unknown side effect must be reconciled before retry. Failed steps can be retried with unchanged valid parameters; do not recreate downloads or reconfirm already accepted parameters.',parameters:{type:'object',properties:{stepId:{type:'string',minLength:1,maxLength:64}},required:['stepId'],additionalProperties:false}}},
 {type:'function',function:{name:'runtime_workflow_state',description:'Read cross-tool step states, verified receipts and the precise local recovery position. Returns compact state, not verbose archived outputs. No model polling is needed while a native step waits.',parameters:{type:'object',properties:{stepId:{type:'string',maxLength:64},includeResult:{type:'boolean'}},additionalProperties:false}}},
];
WORKFLOW_TOOLS.push({type:'function',function:{name:'runtime_workflow_repair',description:'Repair only one saved step after inspecting its actual receipt. Change acceptance conditions or corrected arguments without copying/rebuilding the whole graph. Existing operation receipts are retained when only acceptance changes. Changed operation arguments invalidate only this step and its dependants; native approvals still apply.',parameters:{type:'object',properties:{stepId:{type:'string',minLength:1,maxLength:64},expectedRevision:{type:'integer',minimum:0},arguments:object,acceptance:WORKFLOW_TOOLS[0].function.parameters.properties.steps.items.properties.acceptance},required:['stepId','expectedRevision'],additionalProperties:false}}});
// Existing durable Core threads may retain their original dynamic tool names.
// Keep a repair entry on the original plan tool as well as the concise alias.
WORKFLOW_TOOLS[0].function.parameters.properties.repair={type:'object',properties:{stepId:{type:'string',minLength:1,maxLength:64},arguments:object,acceptance:WORKFLOW_TOOLS.at(-1).function.parameters.properties.acceptance},required:['stepId'],additionalProperties:false};
WORKFLOW_TOOLS[0].function.parameters.properties.append=WORKFLOW_TOOLS[0].function.parameters.properties.steps;
WORKFLOW_TOOLS[0].function.parameters.required=['expectedRevision'];
WORKFLOW_TOOLS[0].function.description+=' Append only NEW steps with expectedRevision and append:[stepSpecs], preserving the existing graph. Repair one existing step with expectedRevision and repair:{stepId,acceptance or arguments}; omit title/steps. Do not resend the whole graph for local work.';
WORKFLOW_TOOLS[0].function.description+=' Result pointers and dependency references use the normalized acceptanceResult returned by runtime_workflow_state(includeResult:true): MCP text JSON is parsed, so raster_info uses /data/crs, not /result/structuredContent/data/crs. A result check requires equals, minItems or requiredFields; a pointer alone is not a condition. json checks verify a JSON file and require path.';
export function pointer(value,path=''){
 if(path==='')return value;if(!path.startsWith('/'))throw new Error('JSON pointer must start with /');
 for(const key of path.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'))){if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))throw new Error('Receipt field is unavailable: '+path);value=value[key];}return value;
}
function payload(result){
 let v=result?.connectorId&&result?.toolName&&'result'in result?result.result:result;
 if(v?.isError)throw new Error('Tool reported an error');
 if(Array.isArray(v?.content)){const part=v.content.find(p=>p.type==='text');if(part){try{return JSON.parse(part.text);}catch{}}}
 return v;
}
function toolFailed(v){try{const p=payload(v);return !!(v?.error||v?.isError||v?.result?.error||v?.result?.isError||p?.error||['failed','cancelled','partial','paused','unknown'].includes(p?.backgroundResult?.state));}catch{return true;}}
const compactCheck=report=>Object.fromEntries(['kind','path','pointer','verified','error','message','resultRootKeys','failedChecks','sha256','bytes','crs','layout','compression','overviews','width','height','bands','features','jobId','taskId','state'].filter(key=>report[key]!==undefined).map(key=>[key,report[key]]));
export class RuntimeWorkflow {
 constructor(home,{verify,nativeEvidence,descriptor,knownTool}={}){
  this.file=join(home,'workflow-checkpoint.json');this.receipts=join(home,'workflow-results');mkdirSync(this.receipts,{recursive:true});
  this.verify=verify??(async()=>({verified:false,error:'WORKFLOW_VERIFIER_UNAVAILABLE'}));this.nativeEvidence=nativeEvidence;this.descriptor=descriptor;this.knownTool=knownTool;this.active=new Set();this.writing=false;
  try{this.state=JSON.parse(readFileSync(this.file,'utf8'));if(this.state.version!==1)throw new Error('Unsupported workflow checkpoint');}catch(e){if(e.code!=='ENOENT')throw e;this.state={version:1,revision:0,steps:[]};}
  for(const s of this.state.steps)if(['running','verifying'].includes(s.state)){s.state='unknown';s.recovery={action:'reconcile',message:'执行中断；先核对已产生的成果与原操作回执。'};}
  this.save();
 }
 save(){const tmp=this.file+'.tmp',fd=openSync(tmp,'w');try{writeFileSync(fd,JSON.stringify(this.state));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,this.file);}
 bind(params){const scope=digest([params.threadKey??params.conversationId,params.workspace]);if(this.state.scope&&this.state.scope!==scope)throw new Error('WORKFLOW_SCOPE_MISMATCH');this.state.scope=scope;this.save();}
 view(){return{workflowId:this.state.id??null,revision:this.state.revision,title:this.state.title,complete:this.state.steps.length>0&&this.state.steps.every(s=>s.state==='completed'),steps:this.state.steps.map(({id,title,dependsOn,state,attempts,checks,recovery})=>({id,title,dependsOn,state,attempts,checks:checks?.map(compactCheck),recovery})),ready:this.state.steps.filter(s=>['pending','failed'].includes(s.state)&&s.dependsOn.every(id=>this.step(id)?.state==='completed')).map(s=>s.id)};}
 step(id){return this.state.steps.find(s=>s.id===id);}
 repair(args){const current=this.step(args.stepId);if(!current)return fail('WORKFLOW_STEP_NOT_FOUND','No such step.');if(!args.arguments&&!args.acceptance)return fail('WORKFLOW_REPAIR_EMPTY','Supply corrected arguments or acceptance conditions.');return this.plan({title:this.state.title,expectedRevision:args.expectedRevision,steps:this.state.steps.map(s=>{const spec=Object.fromEntries(['id','title','dependsOn','tool','arguments','acceptance'].map(k=>[k,s[k]]));return s.id===args.stepId?{...spec,...(args.arguments?{arguments:args.arguments}:{}),...(args.acceptance?{acceptance:args.acceptance}:{})}:spec;})});}
 match(tool,args){for(const s of this.state.steps)if(s.tool===tool){try{if(digest(this.resolve(s.arguments,s))===digest(args))return s.id;}catch{}}return null;}
 result(step){return JSON.parse(readFileSync(join(this.receipts,step.receipt),'utf8'));}
 acceptanceResult(step){return copy(payload(this.result(step)));}
 resolve(value,step,result){
  if(Array.isArray(value))return value.map(v=>this.resolve(v,step,result));
  if(value&&typeof value==='object'){
   if(Object.hasOwn(value,'$step')){const dep=this.step(value.$step);if(!this.ancestors(step).has(value.$step)||dep?.state!=='completed')throw new Error('Reference must name a completed dependency');return copy(pointer(payload(this.result(dep)),value.pointer??''));}
   if(Object.hasOwn(value,'$result'))return copy(pointer(payload(result),value.$result));
   return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.resolve(v,step,result)]));
  }return value;
 }
 ancestors(step,seen=new Set()){for(const id of step.dependsOn){if(seen.has(id))continue;seen.add(id);const dep=this.step(id);if(dep)this.ancestors(dep,seen);}return seen;}
 plan(args){
  if(args.append){if(args.steps||args.repair)return fail('WORKFLOW_APPEND_CONFLICT','Append new steps or repair/propose a graph, not both.');if(args.append.some(s=>this.step(s.id)))return fail('WORKFLOW_STEP_EXISTS','Append only new step IDs; use repair for an existing step.');return this.plan({title:args.title??this.state.title,expectedRevision:args.expectedRevision,steps:[...this.state.steps.map(s=>Object.fromEntries(['id','title','dependsOn','tool','arguments','acceptance'].map(k=>[k,s[k]]))),...args.append]});}
  if(args.repair){if(args.steps||args.title)return fail('WORKFLOW_REPAIR_CONFLICT','Repair one existing step or propose a graph, not both.');return this.repair({...args.repair,expectedRevision:args.expectedRevision});}
  if(!args.title||!Array.isArray(args.steps)||!args.steps.length)return fail('WORKFLOW_GRAPH_REQUIRED','A graph proposal needs title and steps; a local repair needs repair.stepId and acceptance or arguments.');
  if(args.expectedRevision!==this.state.revision)return fail('WORKFLOW_REVISION_CONFLICT','Read runtime_workflow_state before amending the current workflow.');
  if(this.active.size||this.state.steps.some(s=>['running','verifying','unknown'].includes(s.state)))return fail('WORKFLOW_UNRESOLVED','Reconcile running or unknown steps before changing the workflow.');
  const ids=new Set(args.steps.map(s=>s.id));if(ids.size!==args.steps.length)return fail('WORKFLOW_GRAPH_INVALID','Duplicate step identifiers.');
  const specs=args.steps.map(s=>({...copy(s),dependsOn:s.dependsOn??[]}));
  for(const s of specs){if(s.tool.startsWith('runtime_workflow_')||!this.knownTool(s.tool,s.arguments))return fail('WORKFLOW_TOOL_UNAVAILABLE','Steps must bind an available non-workflow tool.');if(s.dependsOn.some(id=>!ids.has(id)||id===s.id))return fail('WORKFLOW_GRAPH_INVALID','Missing or self dependency.');
   if(s.acceptance.some(c=>c.kind==='result'&&!Object.hasOwn(c,'equals')&&c.minItems===undefined&&!c.requiredFields))return fail('WORKFLOW_RESULT_CONDITION_REQUIRED','A result pointer alone cannot prove success. Supply equals, minItems or requiredFields against acceptanceResult.',{stepId:s.id});
   if((s.arguments.output||s.arguments.arguments?.output)&&!s.acceptance.some(c=>['file','json','raster','vector'].includes(c.kind)))return fail('WORKFLOW_ARTIFACT_CHECK_REQUIRED','An output file needs native artifact acceptance, not only a success field.',{stepId:s.id});
  }
  const visiting=new Set(),visited=new Set();const visit=s=>{if(visiting.has(s.id))throw new Error('Cyclic step dependency');if(visited.has(s.id))return;visiting.add(s.id);s.dependsOn.forEach(id=>visit(specs.find(v=>v.id===id)));visiting.delete(s.id);visited.add(s.id);};
  try{specs.forEach(visit);}catch(e){return fail('WORKFLOW_GRAPH_INVALID',e.message);}
  const changed=new Set(specs.filter(s=>!this.step(s.id)||digest(specification(this.step(s.id)))!==digest(s)).map(s=>s.id));
  let more=true;while(more){more=false;for(const s of specs)if(!changed.has(s.id)&&s.dependsOn.some(id=>changed.has(id))){changed.add(s.id);more=true;}}
  this.state.steps=specs.map(spec=>{const old=this.step(spec.id);if(old&&!changed.has(spec.id))return{...old,fingerprint:digest(spec)};
   const sameOperation=old&&digest([old.tool,old.arguments,old.dependsOn])===digest([spec.tool,spec.arguments,spec.dependsOn])&&!spec.dependsOn.some(id=>changed.has(id));
   return sameOperation&&old.receipt?{...spec,fingerprint:digest(spec),state:'failed',attempts:old.attempts,receipt:old.receipt,resolvedArguments:old.resolvedArguments,recovery:{action:'verify',message:'验收条件已更新，先重新检查现有成果。'}}:{...spec,fingerprint:digest(spec),state:'pending',attempts:0};});
  this.state.id??=randomUUID();this.state.title=args.title;this.state.revision++;this.save();return this.view();
 }
 async check(step,result,args,{recheck=false}={}){
  const reports=[];
  for(const raw of step.acceptance){let c,report;try{c=this.resolve(raw,step,result);
   if(c.kind==='native'){
    report={kind:'native',verified:this.nativeEvidence(step.tool,args,result)===true};
    if(recheck&&report.verified){const raw=result?.result??result;report=await this.verify({kind:'native',resourceKind:raw.jobId?'imagery':'data',resourceId:raw.jobId??raw.taskId??raw.id});}
   }
   else if(c.kind==='result'){
    const actual=pointer(payload(result),c.pointer??'');let ok=true;
    if(Object.hasOwn(c,'equals'))ok&&=JSON.stringify(actual)===JSON.stringify(c.equals);
    if(c.minItems!==undefined)ok&&=Array.isArray(actual)&&actual.length>=c.minItems;
    if(c.requiredFields)ok&&=!!actual&&c.requiredFields.every(k=>Object.hasOwn(actual,k));
    if(!Object.hasOwn(c,'equals')&&c.minItems===undefined&&!c.requiredFields)ok=false;
    report={kind:'result',pointer:c.pointer??'',verified:ok};
   }else{
    const target=args?.output??args?.relativePath??args?.arguments?.output??args?.arguments?.relativePath,root=payload(result),produced=root?.output??root?.data?.output;
    // A write cannot pass by naming an unrelated existing file.
    if(target&&c.path!==target&&c.path!==produced)report={kind:c.kind,verified:false,error:'WORKFLOW_OUTPUT_MISMATCH'};
    else report=await this.verify(c);
    if(recheck&&report.verified){const previous=step.checks?.find(v=>v.path===report.path&&v.kind===report.kind);if(previous?.sha256&&previous.sha256!==report.sha256)report={...report,verified:false,error:'WORKFLOW_ARTIFACT_CHANGED'};}
   }
   }catch{let resultRootKeys=[];try{const normalized=payload(result);if(normalized&&typeof normalized==='object')resultRootKeys=Object.keys(normalized).slice(0,24);}catch{}
    report={kind:raw.kind,pointer:raw.pointer,verified:false,error:'WORKFLOW_ACCEPTANCE_FIELD_UNAVAILABLE',resultRootKeys,message:'Read runtime_workflow_state for this step with includeResult:true. Pointers are relative to acceptanceResult, not the raw MCP envelope. Repair the check; do not repeat the operation.'};}
   reports.push(report);
  }return reports;
 }
 async run(id,dispatch,{cancelled=()=>false,reconcile}={}){
  const s=this.step(id);if(!s)return fail('WORKFLOW_STEP_NOT_FOUND','No such step in the current workflow.');
  if(this.active.has(id))return fail('WORKFLOW_STEP_BUSY','This step is already executing.');
  // Validate upstream artifacts again before using their receipts.
  for(const depId of this.ancestors(s)){const dep=this.step(depId);if(dep.state!=='completed')return fail('WORKFLOW_DEPENDENCY_REQUIRED','Complete the dependency first.',{stepId:depId});const checks=await this.check(dep,this.result(dep),dep.resolvedArguments,{recheck:true});if(checks.some(c=>!c.verified)){this.invalidate(dep.id);dep.state='failed';dep.checks=checks;dep.recovery={action:'repair',message:'已完成步骤的成果已变动或不可读，请修复后继续。'};this.save();return fail('WORKFLOW_DEPENDENCY_CHANGED','A dependency no longer passes verification.',{stepId:depId});}}
  let args;try{args=this.resolve(s.arguments,s);}catch(e){return fail('WORKFLOW_REFERENCE_INVALID',e.message);}
  if(s.state==='completed'){
   const result=this.result(s),checks=await this.check(s,result,args,{recheck:true});
   if(checks.every(c=>c.verified))return{stepId:id,state:'completed',reused:true,result,checks};
   this.invalidate(id);s.state='failed';s.checks=checks;s.recovery={action:'repair',message:'成果已变化；请修复此步骤。'};this.save();return fail('WORKFLOW_ARTIFACT_CHANGED','The saved artifact no longer matches its receipt.',{stepId:id});
  }
  if(s.state==='unknown'){
   // Only recorded results or a native operation reconciler may prove completion.
   const result=s.receipt?this.result(s):await reconcile?.(s,args);
   if(result&&!toolFailed(result)){const checks=await this.check(s,result,args);if(checks.every(c=>c.verified)){this.record(s,result,args,checks);return{stepId:id,state:'completed',reconciled:true,result,checks};}}
   s.recovery={action:'reconcile',message:'上次操作结果未知。先核对原操作或实际成果，不自动重发。'};this.save();return fail('WORKFLOW_RECONCILIATION_REQUIRED',s.recovery.message,{stepId:id});
  }
  if(s.state==='failed'&&s.receipt){
   const result=this.result(s),checks=await this.check(s,result,args);
   if(checks.every(c=>c.verified)){this.record(s,result,args,checks);return{stepId:id,state:'completed',reconciled:true,result,checks};}
   return fail('WORKFLOW_ACCEPTANCE_FAILED','The previous operation returned; repair acceptance or amend this step rather than repeating its side effect.',{stepId:id,checks});
  }
  if(cancelled())return fail('EXECUTION_CANCELLED','Execution stopped before step dispatch.');
  const writing=this.descriptor?.(s.tool,args)?.effect!=='read';
  if(this.writing||writing&&this.active.size)return fail('WORKFLOW_RESOURCE_BUSY','Wait for the current project mutation before dispatching another step.');
  if(writing)this.writing=true;
  this.active.add(id);s.state='running';s.resolvedArguments=args;s.attempts++;delete s.recovery;this.save();
  try{
   const result=await dispatch(s.tool,args,s.id);
   if(toolFailed(result)){s.state=/(UNKNOWN|DETACHED|UNCERTAIN)/.test(JSON.stringify(result))?'unknown':'failed';s.recovery={action:s.state==='unknown'?'reconcile':'retry',message:s.state==='unknown'?'先核对原操作回执，再恢复此步骤。':'保留上游成果，修复当前步骤后继续。'};s.lastError=copy(result);this.save();return{stepId:id,state:s.state,result,recovery:s.recovery,error:'WORKFLOW_STEP_FAILED'};}
   s.state='verifying';s.receipt=this.writeResult(s,result);this.save();const checks=await this.check(s,result,args);
   if(checks.some(c=>!c.verified)){s.state='failed';s.checks=checks;s.recovery={action:'verify',message:'操作已返回，但成果未通过验收；修复或修改此步骤，不重做上游。'};this.save();return{error:'WORKFLOW_ACCEPTANCE_FAILED',stepId:id,state:s.state,result,checks,recovery:s.recovery};}
   this.record(s,result,args,checks);return{stepId:id,state:'completed',result,checks};
  }catch(e){s.state=s.state==='verifying'?'failed':'unknown';s.recovery={action:s.state==='unknown'?'reconcile':'verify',message:'执行或验收中断；保留已完成依赖并核对当前步骤。'};this.save();return fail('WORKFLOW_STEP_INTERRUPTED',s.recovery.message,{stepId:id,state:s.state});}
  finally{this.active.delete(id);if(writing)this.writing=false;}
 }
 writeResult(s,result){const file=s.id+'-'+digest(result)+'.json',tmp=join(this.receipts,file+'.tmp'),fd=openSync(tmp,'w');try{writeFileSync(fd,JSON.stringify(result));fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,join(this.receipts,file));return file;}
 record(s,result,args,checks){s.receipt=this.writeResult(s,result);s.resolvedArguments=args;s.state='completed';s.checks=checks;delete s.recovery;delete s.lastError;this.save();}
 invalidate(id){const ids=new Set([id]);let changed=true;while(changed){changed=false;for(const s of this.state.steps)if(!ids.has(s.id)&&s.dependsOn.some(v=>ids.has(v))){ids.add(s.id);changed=true;}}for(const s of this.state.steps)if(ids.has(s.id)){s.state='pending';s.checks=[];delete s.receipt;}}
}

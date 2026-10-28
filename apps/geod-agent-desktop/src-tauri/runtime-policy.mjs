// Execution policy belongs to the host, outside Codex's model loop. Model
// proposals never grant native permissions or turn a reply into completion.
import {readFileSync,writeFileSync,renameSync,mkdirSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {GEOD_POLICY,ERROR_CLASSES,completionEvidence} from './runtime-policy-geod.mjs';
import {RuntimeWorkflow,WORKFLOW_TOOLS} from './runtime-workflow.mjs';
import {buildTaskFeedback} from './task-feedback.mjs';

export const POLICY_VERSION=1;
export const RUNTIME_TOOLS=[
 ...WORKFLOW_TOOLS,
 {type:'function',function:{name:'runtime_task_report',description:'End this reply with a factual blocker/partial-result report when a verified prerequisite or capability prevents the requested work. Use executionBlocker IDs returned by failed tools. Choose this after assessing valid alternatives, not after correctable argument errors or just because a task is slow. The runtime preserves confirmed parameters, reports native results and unknowns, and produces the final reply locally without another model request. It does not cancel downloads, approve work, or mark the objective successful.',parameters:{type:'object',properties:{blockerIds:{type:'array',minItems:1,maxItems:6,uniqueItems:true,items:{type:'string',minLength:1,maxLength:80}}},required:['blockerIds'],additionalProperties:false}}},
 {type:'function',function:{name:'runtime_task_state',description:'Read the durable execution checkpoint: goal revision, confirmed requirements, unresolved operations, failure recovery conditions and evidence. Page evidence with offset/limit. This is not a download status poll.',parameters:{type:'object',properties:{offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:64}},additionalProperties:false}}},
 {type:'function',function:{name:'runtime_task_update',description:'Propose a new structured goal or explicitly amend requirements. Routine native downloads and their verified completion are registered automatically; do not call this tool just to record completion. expectedRevision prevents stale changes. Proposals cannot grant permissions or verify outputs. An explicit complete requires native evidence. Conversation budget remains cumulative.',parameters:{type:'object',properties:{expectedRevision:{type:'integer',minimum:1},action:{type:'string',enum:['amend','start','complete']},objective:{type:'string',maxLength:2000},deliverables:{type:'array',description:'Exact native jobId/taskId strings only, without prefixes or descriptive labels. Submitted download IDs are bound automatically.',maxItems:32,items:{type:'string',maxLength:200}},evidenceIds:{type:'array',maxItems:32,items:{type:'string'}},invalidateRequirements:{type:'array',maxItems:32,items:{type:'string'}}},required:['expectedRevision','action'],additionalProperties:false}}},
];
const clean=value=>value===undefined?null:JSON.parse(JSON.stringify(value));
export function stable(value){
 if(Array.isArray(value))return value.map(stable);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!['readAt','observedAt','durationMs','createdAt','updatedAt','requestId','callId'].includes(k)).map(k=>[k,stable(value[k])]));
 return value;
}
export const hash=value=>createHash('sha256').update(JSON.stringify(stable(value===undefined?null:value))).digest('hex');
const error=(code,message,extra={})=>({error:code,message,runtimePolicy:true,...extra});
const unwrap=value=>value?.connectorId&&value?.toolName&&'result'in value?value.result:value;
// Keep the accepted vocabulary explicit. Unsupported validation keywords are a
// capability error, never a reason to dispatch arguments without checking them.
const SCHEMA_KEYS=new Set('$schema $id $anchor $comment $defs definitions $ref title description default examples deprecated readOnly writeOnly format contentEncoding contentMediaType type enum const anyOf oneOf allOf not if then else minLength maxLength pattern minimum maximum exclusiveMinimum exclusiveMaximum multipleOf minItems maxItems uniqueItems prefixItems items additionalItems contains required properties additionalProperties'.split(' '));
export function unsupportedSchemaErrors(schema,path='$',depth=0){
 if(depth>64)return[`${path}: schema nesting limit`];
 if(typeof schema==='boolean')return[];
 if(!schema||typeof schema!=='object'||Array.isArray(schema))return[`${path}: invalid schema`];
 const errors=Object.keys(schema).filter(k=>!SCHEMA_KEYS.has(k)&&!k.startsWith('x-')).map(k=>`${path}: unsupported schema keyword ${k}`);
 for(const keyword of ['properties','$defs','definitions'])for(const [key,child]of Object.entries(schema[keyword]??{}))errors.push(...unsupportedSchemaErrors(child,`${path}.${keyword}.${key}`,depth+1));
 for(const keyword of ['anyOf','oneOf','allOf','prefixItems'])for(const [i,child]of (schema[keyword]??[]).entries())errors.push(...unsupportedSchemaErrors(child,`${path}.${keyword}[${i}]`,depth+1));
 for(const keyword of ['not','if','then','else','items','additionalItems','additionalProperties','contains'])if(schema[keyword]!==undefined){
  if(Array.isArray(schema[keyword]))for(const [i,child]of schema[keyword].entries())errors.push(...unsupportedSchemaErrors(child,`${path}.${keyword}[${i}]`,depth+1));
  else errors.push(...unsupportedSchemaErrors(schema[keyword],`${path}.${keyword}`,depth+1));
 }
 return errors.slice(0,12);
}
export function schemaErrors(value,schema,path='$',root=schema,depth=0){
 if(depth>64)return[`${path}: schema nesting limit`];
 if(schema===true||schema===undefined)return[];if(schema===false)return[`${path}: forbidden`];
 const validate=(v,s,p=path)=>schemaErrors(v,s,p,root,depth+1);
 if(schema.$ref){if(!schema.$ref.startsWith('#/'))return[`${path}: nonlocal schema reference`];const referenced=schema.$ref.slice(2).split('/').reduce((v,k)=>v?.[k.replaceAll('~1','/').replaceAll('~0','~')],root);if(!referenced)return[`${path}: unresolved schema reference`];return validate(value,referenced);}
 for(const keyword of ['anyOf','oneOf'])if(schema[keyword]){const matches=schema[keyword].filter(s=>!validate(value,s).length).length;if(keyword==='oneOf'?matches!==1:matches===0)return[`${path}: ${keyword} constraint`];}
 if(schema.allOf){const errors=schema.allOf.flatMap(s=>validate(value,s));if(errors.length)return errors;}
 if(schema.not&&!validate(value,schema.not).length)return[`${path}: excluded by not`];
 if(schema.if){const conditional=validate(value,schema.if).length?schema.else:schema.then;if(conditional){const errors=validate(value,conditional);if(errors.length)return errors;}}
 if(schema.enum&&!schema.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))return[`${path}: expected one of ${JSON.stringify(schema.enum)}`];
 if('const'in schema&&JSON.stringify(schema.const)!==JSON.stringify(value))return[`${path}: expected ${JSON.stringify(schema.const)}`];
 const types=Array.isArray(schema.type)?schema.type:schema.type?[schema.type]:[];
 const matches=t=>t==='null'?value===null:t==='array'?Array.isArray(value):t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):t==='integer'?Number.isSafeInteger(value):t==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===t;
 if(types.length&&!types.some(matches))return[`${path}: expected ${types.join('|')}`];
 const errors=[];
 if(typeof value==='string'){
  if(schema.minLength!==undefined&&[...value].length<schema.minLength)errors.push(`${path}: too short`);
  if(schema.maxLength!==undefined&&[...value].length>schema.maxLength)errors.push(`${path}: too long`);
  if(schema.pattern){try{if(!new RegExp(schema.pattern,'u').test(value))errors.push(`${path}: pattern mismatch`);}catch{errors.push(`${path}: unsupported pattern`);}}
 }
 if(typeof value==='number')for(const [key,compare]of Object.entries({minimum:n=>value<n,maximum:n=>value>n,exclusiveMinimum:n=>value<=n,exclusiveMaximum:n=>value>=n,multipleOf:n=>Math.abs(value/n-Math.round(value/n))>1e-10}))if(schema[key]!==undefined&&compare(schema[key]))errors.push(`${path}: ${key} ${schema[key]}`);
 if(Array.isArray(value)){
  if(schema.minItems!==undefined&&value.length<schema.minItems)errors.push(`${path}: too few items`);
  if(schema.maxItems!==undefined&&value.length>schema.maxItems)errors.push(`${path}: too many items`);
  if(schema.uniqueItems&&new Set(value.map(v=>JSON.stringify(v))).size!==value.length)errors.push(`${path}: duplicate items`);
  errors.push(...value.flatMap((v,i)=>validate(v,schema.prefixItems?.[i]??(Array.isArray(schema.items)?schema.items[i]??schema.additionalItems:schema.items),`${path}[${i}]`)));
  if(schema.contains&&!value.some(v=>!validate(v,schema.contains).length))errors.push(`${path}: contains constraint`);
 }
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  for(const key of schema.required??[])if(!(key in value))errors.push(`${path}.${key}: required`);
  for(const [key,v]of Object.entries(value)){
   if(schema.properties&&key in schema.properties)errors.push(...validate(v,schema.properties[key],`${path}.${key}`));
   else if(schema.additionalProperties===false)errors.push(`${path}.${key}: unknown field`);
   else if(typeof schema.additionalProperties==='object')errors.push(...validate(v,schema.additionalProperties,`${path}.${key}`));
  }
 }
 return errors.slice(0,12);
}
export function failureOf(result){
 if(result?.runtimePolicy)return null;
 let value=unwrap(result);
 if(value?.content&&Array.isArray(value.content))for(const part of value.content){if(part.type==='text'){try{const nested=JSON.parse(part.text);if(nested.error||nested.isError)value=nested;}catch{const code=value.isError&&part.text?.match(/^([A-Z][A-Z0-9_]{2,80}):/);if(code)value={error:code[1]};}}}
 const code=typeof value?.error==='string'?value.error:value?.error?.code??(value?.isError?value.code??'TOOL_FAILED':null);
 if(!code)return null;
 const declared=value.recovery?.category;
 const category=Object.hasOwn(ERROR_CLASSES,declared)?declared:Object.entries(ERROR_CLASSES).find(([,v])=>v.codes.includes(code)||v.pattern&&new RegExp(v.pattern).test(code))?.[0]??'internal';
 const requiredBytes=value.partition?.requiredFreeDiskBytes??value.requiredFreeDiskBytes;
 const effective=value.error?.planningConflict?.conditionFingerprint;
 return{code,category,condition:ERROR_CLASSES[category].condition,retryAfterMs:Number.isFinite(value.retryAfterMs)?Math.max(0,value.retryAfterMs):0,...(Number.isSafeInteger(requiredBytes)&&requiredBytes>0?{requiredBytes}: {}),...(typeof effective==='string'&&/^[a-f0-9]{64}$/.test(effective)?{effectiveKey:effective}:{})};
}
function bounded(value,limit=3000){const text=JSON.stringify(value);return text.length<=limit?value:{summary:text.slice(0,limit),omitted:true,sha256:hash(value)};}

export class RuntimePolicy {
 constructor(home,declared,{now=()=>Date.now(),onSignal=()=>{},verifyArtifact}={}){
  this.now=now;this.onSignal=onSignal;this.schemas=new Map(declared.map(({function:t})=>[t.name,t.parameters]));this.home=home;mkdirSync(home,{recursive:true});
  this.file=join(home,'execution-checkpoint.json');this.results=join(home,'execution-results');mkdirSync(this.results,{recursive:true});this.discoveryMemo=new Map();this.pending=new Map();this.callRevisions=new Map();this.cancelled=true;this.facts={};
  try{this.state=JSON.parse(readFileSync(this.file,'utf8'));if(this.state.version!==POLICY_VERSION)throw new Error('Unsupported checkpoint version');}
  catch(cause){if(cause.code!=='ENOENT')throw cause;this.state={version:POLICY_VERSION,revision:1,goal:null,requirements:{},operations:{},failures:{},evidence:{},metrics:{executed:0,reused:0,blocked:0,retries:0,strategyReviews:0},stagnation:0};}
  // A pending side effect after a crash is UNKNOWN, not permission to resend.
  for(const op of Object.values(this.state.operations))if(op.state==='pending'){op.state='unknown';op.recovery='reconcile';}
  this.state.nativeResources??={};this.save();
  this.workflow=new RuntimeWorkflow(home,{verify:verifyArtifact,nativeEvidence:(tool,args,result)=>{const d=this.descriptor(tool,args);return completionEvidence(d.canonicalTool??tool,d.canonicalArgs??args,unwrap(result));},descriptor:(tool,args)=>this.descriptor(tool,args),knownTool:(tool,args)=>this.schemas.has(tool)&&!(tool==='mcp_call'&&args?.connectorId==='builtin-runtime-workflow')});
 }
 save(){const temporary=this.file+'.tmp';const fd=openSync(temporary,'w');try{writeFileSync(fd,JSON.stringify(this.state));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,this.file);}
 audit(kind,fields={}){this.state.lastDecision={at:this.now(),kind,...fields};this.save();const fd=openSync(join(this.home,'execution-decisions.jsonl'),'a');try{writeFileSync(fd,JSON.stringify({version:POLICY_VERSION,revision:this.state.revision,goalId:this.state.goal?.id,runId:this.state.run?.id,...this.state.lastDecision})+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
 begin(params,capabilities={}){
  this.workflow.bind(params);
  this.params=params;this.capabilities=capabilities;this.cancelled=false;this.pending.clear();this.callRevisions.clear();
  const key=params.threadKey??params.conversationId;
  if(this.state.conversation&&this.state.conversation!==key)throw new Error('POLICY_SCOPE_MISMATCH');this.state.conversation=key;
   this.state.revision++;this.state.run={id:params.runId??randomUUID(),state:'running',inputRevision:this.state.revision,resourceIds:[]};
  if(!this.state.goal)this.state.goal={id:randomUUID(),revision:1,state:'active',objective:params.input.slice(0,2000),source:'user',deliverables:[]};
  // Upgrade a legacy greeting placeholder from the next real human request.
  // Keep confirmed requirements, resource identities and the native revision.
  if(/^(?:你好|您好|嗨|hello|hi)[!！。,.，\s]*$/i.test(this.state.goal.objective)&&! /^(?:你好|您好|嗨|hello|hi)[!！。,.，\s]*$/i.test(params.input))this.state.goal.objective=params.input.slice(0,2000);
  this.state.latestUserInput=params.input.slice(0,2000);this.setFacts({permission:params.permission??'confirmEach',outputCrs:params.outputCrs??null});
  const contract=hash([...this.schemas]);const capabilitiesHash=hash(capabilities);
  if(this.state.contract!==contract||this.state.capabilitiesHash!==capabilitiesHash){this.state.contract=contract;this.state.capabilitiesHash=capabilitiesHash;this.state.discovered={};}
  this.audit('run-start');
 }
 setFacts(facts){
  if(this.facts.connectionsRevision&&facts.connectionsRevision!==this.facts.connectionsRevision){this.state.discovered={};this.state.discoveryRevision=null;}
  this.facts=clean(facts);const crs=facts.outputCrs;
  if(this.state.goal&&this.state.requirements['conversation.outputCrs']?.value!==(crs??undefined)){this.state.goal.revision++;this.state.revision++;}
  if(crs)this.state.requirements['conversation.outputCrs']={value:crs,source:'native-user-selection',scope:'conversation',confirmed:true,revision:this.state.revision};
  else delete this.state.requirements['conversation.outputCrs'];
   if(facts.planningOutput?.available===true){
    const revision=facts.planningOutput.revision??null;
    if((this.state.planningOutputRevision??null)!==revision){this.state.planningOutputRevision=revision;this.state.goal.revision++;this.state.revision++;}
    if(facts.planningOutput.conditions)this.state.requirements['task.output']={value:facts.planningOutput.conditions,source:'native-human-output-selection',scope:'task',confirmed:true,revision:this.state.revision};
    else delete this.state.requirements['task.output'];
   }
  // The owned ledger's completed transition follows the worker's verification.
  // Reuse that evidence; do not force another artifact read merely to finish.
  for(const task of facts.imagery?.tasks??[])if(task.state==='completed'&&this.state.goal?.deliverables.includes(task.jobId)){
   const id=hash(['native-ledger',this.state.goal.id,task.jobId,task.state]);this.state.evidence[id]={id,goalId:this.state.goal.id,resourceIds:[task.jobId],verified:true,source:'native-ledger',summary:{jobId:task.jobId,planId:task.planId,state:task.state}};
  }
  // Only a freshly read native job record may reconcile an uncertain start.
  for(const op of Object.values(this.state.operations))if(op.state==='unknown'&&op.tool==='jobs_start'){
   const job=facts.imagery?.tasks?.find(t=>t.planId===op.resource?.[0]&&t.jobId&&t.state!=='not_started');
   if(job){op.state='succeeded';op.result={jobId:job.jobId,planId:job.planId,state:job.state,reconciled:true};delete op.recovery;}
  }
  for(const task of facts.imagery?.data?.tasks??[])this.reconcileDataSubmission(task);
 }
 reconcileDataSubmission(task){
  const id=task?.taskId??task?.id,state=task?.state??task?.status;
  if(!id||!task.planHash||!['pending','queued','downloading','processing','verifying','completed','partial','failed','cancelled','paused','interrupted'].includes(state))return;
  for(const op of Object.values(this.state.operations))if(op.state==='unknown'&&op.tool==='data_download_start'&&op.resource?.[0]===id&&op.nativePlanHash===task.planHash){
   op.state=state==='pending'?'not-submitted':'succeeded';
   if(op.state==='succeeded')op.result={taskId:id,planHash:task.planHash,status:state,reconciled:true};
   delete op.recovery;
  }
 }
 view(){return{version:this.state.version,revision:this.state.revision,goal:this.state.goal,run:this.state.run,requirements:this.state.requirements,workflow:this.workflow.view(),contract:this.state.contract,capabilities:{inputModalities:this.capabilities?.inputModalities??['text']},unresolvedOperations:Object.values(this.state.operations).filter(o=>['pending','unknown'].includes(o.state)).map(({id,tool,state,recovery})=>({id,tool,state,recovery})),failures:Object.values(this.state.failures).slice(-12),evidence:Object.values(this.state.evidence).slice(-12),metrics:this.state.metrics,lastDecision:this.state.lastDecision};}
 compactView(){
  const view=this.view(),resources=Object.values(this.state.nativeResources).filter(r=>r.goalId===this.state.goal?.id),submitted=resources.filter(r=>this.state.run?.resourceIds?.includes(r.id));
  return{version:view.version,revision:view.revision,goal:view.goal,requirements:view.requirements,unresolvedOperations:view.unresolvedOperations,workflow:view.workflow,
   failures:view.failures.map(({code,category,recovery,condition,retryAt})=>({code,category,recovery,condition,retryAt})),
   resources:resources.map(({id,kind,state,verified,evidenceId})=>({id,kind,state,verified,evidenceId})),
   completionRegistration:{automatic:true,scope:'submitted-native-resources',complete:submitted.length>0&&submitted.every(r=>r.verified),ids:submitted.map(r=>r.id)},
   evidence:view.evidence.filter(e=>e.verified&&e.goalId===this.state.goal?.id).map(({id,tool,resourceIds,verified})=>({id,tool,resourceIds,verified})),
   blockers:Object.values(this.state.run?.blockers??{}).map(({id,code,category})=>({id,code,category})),
   detailsTool:'runtime_task_state'};
 }
 rememberBlocker(failure,desc,run=this.state.run){
  if(!run||run!==this.state.run||['parameter'].includes(failure.category)||['USER_STOPPED','USER_INPUT_CANCELLED','USER_INPUT_SAVED','EXECUTION_CANCELLED'].includes(failure.code))return null;
  run.blockers??={};const scope=this.failureScope(failure,desc),condition=this.condition(failure,desc);
  const previous=Object.values(run.blockers).find(b=>b.code===failure.code&&b.scope===scope&&b.condition===condition);
   const blocker=previous??{id:'blocker-'+randomUUID(),code:failure.code,category:failure.category,scope,condition,...(failure.requiredBytes?{requiredBytes:failure.requiredBytes}:{}),...(failure.effectiveKey?{effectiveKey:failure.effectiveKey}:{}),descriptor:{effect:desc.effect,purpose:desc.purpose,resource:desc.resource,conditionScope:desc.conditionScope}};
  run.blockers[blocker.id]=blocker;
  while(Object.keys(run.blockers).length>16)delete run.blockers[Object.keys(run.blockers)[0]];
  return {id:blocker.id,code:blocker.code,category:blocker.category,reportTool:'runtime_task_report',instruction:'This is a verified blocker, not a tool-call limit. If no valid authorized path remains, report it and finish clearly; do not keep exploring or retrying the unchanged condition. Preserve partial results and unknown outcomes.'};
 }
 reportForRun(){
  const report=this.state.run?.taskReport;if(!report||report.revision!==this.state.revision)return null;
  return report.blockerIds.every(id=>{const b=this.state.run.blockers?.[id];return b&&b.condition===this.condition(b,b.descriptor);})?report:null;
 }
 reportBlocked(args){
  const blockers=args.blockerIds.map(id=>this.state.run?.blockers?.[id]);
  if(blockers.some(b=>!b||b.condition!==this.condition(b,b.descriptor)))return error('REPORT_EVIDENCE_REQUIRED','Use current executionBlocker IDs with unchanged prerequisites. Old errors or model assertions cannot prove that work is blocked.');
  const current=new Set(this.state.run.resourceIds),resources=Object.values(this.state.nativeResources).filter(r=>current.has(r.id));
  const english=/^Use English\b/.test(this.params.input),feedback=buildTaskFeedback({code:blockers[0].code,resources,unresolved:this.view().unresolvedOperations.length,factsKnown:this.facts.imagery?.available===true&&this.facts.imagery?.data?.available===true,english});
  this.state.run.taskReport={id:randomUUID(),revision:this.state.revision,blockerIds:args.blockerIds,feedback,english};
  this.audit('task-blocker-reported',{codes:blockers.map(b=>b.code),status:feedback.status});
  return {reported:true,feedback,preserved:true,downloadsCancelled:false,objectiveComplete:false};
 }
 context(request){
  const marker='[GeoD execution checkpoint]';const input=(request.input??[]).filter(item=>!(item.role==='developer'&&JSON.stringify(item.content).includes(marker)));
   return{...request,input:[...input,{role:'developer',content:[{type:'input_text',text:marker+'\n'+JSON.stringify(this.compactView())+'\nNative runtime facts supersede old summaries. Resolve blocked conditions before repeating. Native submissions and verified completion are registered automatically; no task-update calls are needed for routine completion. Summarize verified results when the requested work is done. Preserve additional user-requested work; registered resources are not proof of the whole user objective. Read runtime_task_state only when checkpoint details are needed.'}]}]};
 }
 update(args){
  if(args.expectedRevision!==this.state.revision)return error('TASK_REVISION_CONFLICT','Read runtime_task_state and amend the current revision.');
  if(args.action==='start'){
   if(Object.values(this.state.operations).some(o=>o.state==='pending'||o.state==='unknown'))return error('TASK_UNRESOLVED_OPERATIONS','Reconcile the previous effects before starting a new goal.');
   this.state.goal={id:randomUUID(),revision:1,state:'active',objective:args.objective??this.state.latestUserInput,source:'model-proposal',userInputRevision:this.state.run.inputRevision,deliverables:args.deliverables??[]};
   this.state.requirements=Object.fromEntries(Object.entries(this.state.requirements).filter(([,v])=>v.scope==='conversation'));this.state.stagnation=0;
  }else if(args.action==='complete'){
   if(this.workflow.state.steps.length&&!this.workflow.view().complete)return error('WORKFLOW_ACCEPTANCE_REQUIRED','The saved delivery still has unfinished or unverified steps. Resume or repair those steps before registering the goal complete.',{workflow:this.workflow.view()});
   const evidence=(args.evidenceIds??[]).map(id=>this.state.evidence[id]);
   if(!this.state.goal.deliverables.length||!evidence.length||evidence.some(e=>!e||e.goalId!==this.state.goal.id||e.verified!==true)||this.state.goal.deliverables.some(id=>!evidence.some(e=>e.resourceIds?.includes(id)))||Object.values(this.state.operations).some(o=>o.state==='unknown'||o.state==='pending'))return error('COMPLETION_EVIDENCE_REQUIRED','Declare the required native job/task IDs as deliverables. Every deliverable needs verified native evidence; a final reply or partial output is insufficient.');
   this.state.goal.state='complete';this.state.goal.acceptedEvidence=args.evidenceIds;
  }else{
   if(args.objective)this.state.goal.objective=args.objective;
   if(args.deliverables)this.state.goal.deliverables=args.deliverables;
   for(const key of args.invalidateRequirements??[]){if(this.state.requirements[key]?.scope!=='conversation')delete this.state.requirements[key];}
   this.state.goal.revision++;
  }
   this.state.revision++;this.audit('goal-update',{action:args.action});return this.compactView();
 }
 descriptor(tool,args){
  if(tool==='mcp_call'){
   const contract=this.state.discovered?.[args.connectorId]?.[args.toolName];
   const native=GEOD_POLICY.nativeConnectors.includes(args.connectorId)&&GEOD_POLICY.tools[args.toolName]?this.descriptor(args.toolName,args.arguments):null;
   return native?{...native,schema:contract?.inputSchema,canonicalTool:args.toolName,canonicalArgs:args.arguments}:{purpose:'mcp:'+args.toolName,resource:args.connectorId,schema:contract?.inputSchema,effect:contract?.annotations?.readOnlyHint===true?'read':contract?.annotations?.idempotentHint===true?'external':'opaque',conditionScope:args.connectorId};
  }
  const spec={...(GEOD_POLICY.tools[tool]??{effect:'external',purpose:tool})};
  // A denied remote URL must not disable every other data source. Hash the
  // exact request without exposing service URLs or embedded credentials.
  if(tool==='data_input_read')spec.conditionScope='data-input:'+hash(args);
   if(tool==='data_download_plan')spec.conditionScope='data-source:'+hash({kind:args.kind,url:args.sourceUrl,connectionId:args.connectionId,onlineConnectionId:args.onlineConnectionId,sourceBoundaryId:args.sourceBoundaryId});
   if(['plan_imagery','plan_imagery_batch'].includes(tool))spec.conditionScope='imagery-planning:'+hash(args);
  return{...spec,resource:spec.resource?spec.resource.map(k=>args[k]??null):['planId','jobId','taskId','scheduleId','connectionId','boundaryId','sourceId'].filter(k=>args[k]!==undefined).map(k=>args[k]),conditionScope:spec.conditionScope??spec.purpose??tool};
 }
 sourceConditions(desc){
  const facts=this.facts.sourceReadiness;
  if(!facts)return null;
  const ids=[...new Set((desc.resource??[]).flatMap(id=>facts.plans?.[id]??(facts.sources?.[id]?[id]:[])))].sort();
  return ids.length?ids.map(id=>({sourceId:id,...facts.sources?.[id]})):null;
 }
 failureScope(failure,desc){
   if(failure.category==='requirements'&&failure.effectiveKey)return hash(['resolved-planning',failure.effectiveKey]);
  if(failure.category==='authentication'&&failure.code.startsWith('SOURCE_CREDENTIAL'))return hash(['source-credential',this.sourceConditions(desc)?.map(s=>s.sourceId)??desc.resource]);
   if(failure.category==='environment')return hash(['background-runtime',desc.requiresBackground?'companion':desc.effect==='read'?'read:'+desc.purpose:'mutation']);
  return failure.category==='business'||failure.category==='permission'&&desc.resource?.length?hash([desc.conditionScope,desc.resource]):['parameter','capability','internal'].includes(failure.category)?hash([desc.conditionScope,desc.purpose]):String(desc.conditionScope);
 }
 condition(failure,descriptor){
  const base={contract:this.state.contract,model:this.state.capabilitiesHash};
   if(failure.category==='requirements')return hash({...base,effectiveKey:failure.effectiveKey});
  if(failure.category==='authentication'&&failure.code.startsWith('SOURCE_CREDENTIAL'))return hash({sources:this.sourceConditions(descriptor),available:this.facts.sourceReadiness?.available});
  if(failure.category==='environment')return hash(this.facts.backgroundRuntime??{running:'unknown'});
   if(['DISK_INSUFFICIENT','BATCH_DISK_INSUFFICIENT'].includes(failure.code))return hash({...base,storage:this.facts.storageCapacity?.identity,known:this.facts.storageCapacity?.availableBytes!=null,enough:failure.requiredBytes!=null&&this.facts.storageCapacity?.availableBytes>=failure.requiredBytes});
  if(failure.category==='permission'){
   const imagery=this.facts.imagery;
   const relevant=tasks=>(tasks??[]).filter(t=>descriptor.resource?.some(id=>id===t.planId||id===t.jobId||id===t.taskId));
   return hash({...base,permission:this.facts.permission,
    imagery:descriptor.resource?.length?relevant(imagery?.tasks):imagery?.counts??imagery?.summary,
    data:descriptor.resource?.length?relevant(imagery?.data?.tasks):imagery?.data?.counts});
  }
  if(failure.category==='authentication'||failure.category==='capability')return hash({...base,connections:this.facts.connectionsRevision,discovery:this.state.discoveryRevision,conditionScope:descriptor.conditionScope});
   return hash({...base,...(failure.category==='business'?{objectState:this.facts.imagery?.tasks?.filter(t=>descriptor.resource.includes(t.planId)||descriptor.resource.includes(t.jobId))}: {})});
 }
 async reconcileWorkflow(tool,args){
  const desc=this.descriptor(tool,args),canonical=desc.canonicalTool??tool,values=desc.canonicalArgs??args;
  const op=Object.values(this.state.operations).find(o=>o.goalId===this.state.goal.id&&o.tool===canonical&&o.argsHash===hash(values)&&o.state==='succeeded');
  if(!op)return null;
  let result=op.resultRef?JSON.parse(readFileSync(join(this.results,op.resultRef),'utf8')):op.result;
  if(['jobs_start','data_download_start'].includes(canonical)&&result){
   const kind=canonical==='jobs_start'?'imagery':'data',id=kind==='imagery'?result.jobId:result.taskId??result.id;
   if(!id)return null;const checked=await this.workflow.verify({kind:'native',resourceKind:kind,resourceId:id});
   if(!checked.verified)return null;result={...result,backgroundResult:checked};
  }
  return result?(tool==='mcp_call'?{connectorId:args.connectorId,toolName:args.toolName,result}:result):null;
 }
 async execute(tool,args,callId,dispatch,workflowStep=false){
  args=clean(args);const schema=this.schemas.get(tool);
  if(this.cancelled)return error('EXECUTION_CANCELLED','The run was cancelled; no new operation was dispatched.');
  if(this.reportForRun())return error('TASK_REPORTED_BLOCKED','A factual task report is ready. End this reply; do not issue further effects. Existing background work remains intact.');
  if(this.callRevisions.has(callId)&&this.callRevisions.get(callId)!==this.state.revision)return error('TASK_REVISION_CHANGED','This call was generated before a user correction or confirmed requirement changed. Replan from the current checkpoint.');
  if(!schema)return error('TOOL_NOT_ALLOWED','Use a tool from the current contract.');
   const unsupported=unsupportedSchemaErrors(schema);if(unsupported.length){this.state.metrics.blocked++;this.noProgress(tool,'TOOL_SCHEMA_UNSUPPORTED','schema:'+tool);this.audit('unsupported-contract',{tool});return error('TOOL_SCHEMA_UNSUPPORTED','This tool contract uses validation constraints that the runtime cannot safely enforce. Refresh the capability or use a supported tool.',{constraints:unsupported});}
  const invalid=schemaErrors(args,schema);if(invalid.length){this.state.metrics.blocked++;this.noProgress(tool,'TOOL_ARGUMENT_INVALID',hash([tool,'parameter']));this.audit('schema-rejected',{tool});return error('TOOL_ARGUMENT_INVALID','Arguments failed the declared schema.',{constraints:invalid});}
  if(tool==='runtime_task_report')return this.reportBlocked(args);
  // Stable MCP entry for durable Core threads created before workflow tools existed.
  if(tool==='mcp_call'&&args.connectorId==='builtin-runtime-workflow'){
   if(!WORKFLOW_TOOLS.some(t=>t.function.name===args.toolName))return error('TOOL_NOT_ALLOWED','Use an actual runtime workflow tool.');
   return this.execute(args.toolName,args.arguments,callId,dispatch,workflowStep);
  }
  if(tool==='runtime_task_state'){const all=Object.values(this.state.evidence),offset=args.offset??Math.max(0,all.length-12),limit=args.limit??12;return{...this.view(),evidence:all.slice(offset,offset+limit),evidencePage:{offset,total:all.length,nextOffset:offset+limit<all.length?offset+limit:null}};}if(tool==='runtime_task_update')return this.update(args);
  if(this.state.goal.state==='complete')return error('TASK_ALREADY_COMPLETE','The declared goal has passed native evidence checks. Return its summary. For new user work, start a new goal revision before using more tools.');
  if(tool==='runtime_workflow_plan'){const result=this.workflow.plan(args);this.audit('workflow-plan',{workflowId:result.workflowId});return result;}
  if(tool==='runtime_workflow_repair'){const result=this.workflow.repair(args);this.audit('workflow-repair',{stepId:args.stepId});return result;}
  if(tool==='runtime_workflow_state'){const step=args.stepId?this.workflow.step(args.stepId):null;return{...this.workflow.view(),...(step?{step:Object.fromEntries(['id','title','dependsOn','tool','arguments','acceptance','state','recovery'].map(k=>[k,step[k]]))}:{}),...(step&&args.includeResult&&step.receipt?{result:this.workflow.result(step),acceptanceResult:this.workflow.acceptanceResult(step)}:{})};}
  if(tool==='runtime_workflow_run'){
   const result=await this.workflow.run(args.stepId,(name,arguments_,stepId)=>this.execute(name,arguments_,callId+':'+stepId,(v,id)=>dispatch(v,id,name),true),{cancelled:()=>this.cancelled,reconcile:(s,a)=>this.reconcileWorkflow(s.tool,a)});
   if(result.error)this.noProgress(tool,result.error,'workflow:'+args.stepId+':'+this.workflow.state.revision+':'+result.error);
   if(result.state==='completed'){const id=hash(['workflow',this.workflow.state.id,args.stepId,this.workflow.step(args.stepId)?.receipt]);this.state.evidence[id]={id,goalId:this.state.goal.id,tool:'runtime_workflow_run',resourceIds:[this.workflow.state.id+':'+args.stepId],verified:true,source:'native-workflow-acceptance',summary:{stepId:args.stepId,checks:result.checks}};}
   this.audit('workflow-step',{stepId:args.stepId,state:result.state??'blocked'});return result;
  }
  if(!workflowStep){const stepId=this.workflow.match(tool,args);if(stepId){const result=await this.workflow.run(stepId,(_name,v)=>this.execute(tool,v,callId,dispatch,true),{cancelled:()=>this.cancelled,reconcile:(s,a)=>this.reconcileWorkflow(s.tool,a)});this.audit('workflow-bound-tool',{stepId,state:result.state??'blocked'});return result.result&&!result.error?result.result:result;}}
  const desc=this.descriptor(tool,args);
  if(tool==='mcp_call'){
   if(!desc.schema)return error('TOOL_DISCOVERY_REQUIRED','Discover this connector and its current tool schema first.');
    const unsupported=unsupportedSchemaErrors(desc.schema);if(unsupported.length){this.state.metrics.blocked++;this.noProgress(tool,'TOOL_SCHEMA_UNSUPPORTED','schema:'+args.connectorId+':'+args.toolName);this.audit('unsupported-contract',{tool,connectorId:args.connectorId,toolName:args.toolName});return error('TOOL_SCHEMA_UNSUPPORTED','This MCP contract requires unsupported validation constraints; no call was dispatched.',{constraints:unsupported});}
    const invalid=schemaErrors(args.arguments,desc.schema);if(invalid.length){this.state.metrics.blocked++;this.noProgress(tool,'TOOL_ARGUMENT_INVALID','parameter:'+args.connectorId+':'+args.toolName);this.audit('schema-rejected',{tool,connectorId:args.connectorId,toolName:args.toolName});return error('TOOL_ARGUMENT_INVALID','MCP arguments failed its current schema.',{constraints:invalid});}
  }
  const goalId=this.state.goal.id,revision=this.state.revision;
  const canonicalTool=desc.canonicalTool??tool,canonicalArgs=desc.canonicalArgs??args;
   if(['plan_imagery','plan_imagery_batch'].includes(canonicalTool)&&this.facts.planningOutput?.available===false)return error('PLANNING_STATE_UNAVAILABLE','Confirmed planning conditions are unreadable. Neither a cached raw-argument success nor a fresh plan may replace the missing requirement state. Restore it first.');
  const rewrap=value=>tool==='mcp_call'?{connectorId:args.connectorId,toolName:args.toolName,result:value}:value;
  const operationKey=hash([goalId,this.state.goal.revision,canonicalTool,canonicalArgs]);
  const prior=this.state.operations[operationKey];
  const unknown=Object.values(this.state.operations).find(op=>op.state==='unknown'&&op.tool===canonicalTool&&op.argsHash===hash(canonicalArgs));
  // Reviewed native planning has its own durable, account/workspace-scoped
  // idempotency receipt. Legacy operations without that ID are only safe to
  // resume when a complete fresh native ledger proves no proposal exists.
  const legacyAbsent=this.facts.imagery?.available===true&&this.facts.imagery.planCount===0&&this.facts.imagery.omitted===0;
  const resumePrepare=desc.nativeIdempotentPrepare&&unknown&&(unknown.nativeExecutionId===true||legacyAbsent);
  if(unknown&&!resumePrepare)return error('OPERATION_RECONCILIATION_REQUIRED','A previous submission with these arguments has an unknown outcome; reconcile its native receipt first.',{operationId:unknown.id});
  if(desc.effect!=='read'&&desc.effect!=='interactive'&&prior){
   if(canonicalTool!=='data_download_plan'&&desc.effect!=='opaque'&&prior.state==='succeeded'&&(!prior.expiresAt||prior.expiresAt>this.now())){this.state.metrics.reused++;this.audit('operation-reused',{tool,operationId:prior.id});return rewrap(prior.resultRef?JSON.parse(readFileSync(join(this.results,prior.resultRef),'utf8')):clean(prior.result));}
   if(['pending','unknown'].includes(prior.state)&&!resumePrepare)return error('OPERATION_RECONCILIATION_REQUIRED','The previous submission may have taken effect. Read its native status/receipt before resubmitting.',{operationId:prior.id});
  }
  if(tool==='ask_user'){
   const reused={};let missing=false;
   for(const q of args.questions){const known=this.state.requirements['question:'+q.id];if(known?.confirmed&&known.contract===hash(q)&&known.scope===goalId)reused[q.id]=known.value;else missing=true;}
   if(!missing){this.state.metrics.reused++;this.audit('requirements-reused');return{answers:reused,answeredBy:'user',reusedPreviousAnswer:true};}
  }
  const blocked=Object.values(this.state.failures).find(f=>f.scope===this.failureScope(f,desc)&&['transient','permission','authentication','capability','business','environment'].includes(f.category)&&f.condition===this.condition(f,desc)&&(!f.retryAt||f.retryAt>this.now()));
  if(blocked){const executionBlocker=this.rememberBlocker(blocked,desc);this.noProgress(tool,blocked.code,hash([blocked.scope,blocked.category]));this.state.metrics.blocked++;this.audit('condition-blocked',{tool,category:blocked.category});return error('RECOVERY_CONDITION_UNCHANGED','A prerequisite has not changed. Reuse the known failure, obtain the missing condition, or use another valid capability.',{failure:blocked,executionBlocker});}
  // Memoize catalog/contract discovery only. Task status, SQL, file contents,
  // source availability and remote dataset searches remain live reads.
  const discovery=tool==='runtime_tools_search'||tool==='extensions_list';
  const discoveryKey=hash([tool,args,this.state.run?.id,this.state.revision,this.state.contract,this.facts.connectionsRevision,this.state.discoveryRevision]);
  const memo=this.discoveryMemo.get(discoveryKey);
  if(discovery&&memo&&memo.until>this.now()){
    this.state.metrics.reused++;this.noProgress(tool,'UNCHANGED_DISCOVERY','discovery:'+this.state.goal.id);this.audit('discovery-reused',{tool});
    return {...clean(memo.result),reusedDiscovery:true};
  }
  if(this.pending.has(operationKey))return this.pending.get(operationKey);
  const dispatchRun=this.state.run;
  const work=(async()=>{
    const operation={id:resumePrepare?unknown.id:randomUUID(),tool:canonicalTool,state:'pending',goalId,revision,argsHash:hash(canonicalArgs),resource:desc.resource,...(desc.nativeIdempotentPrepare?{nativeExecutionId:true}:{}),...(canonicalTool==='data_download_start'?{nativePlanHash:canonicalArgs.planHash}:{})};
   if(resumePrepare){unknown.state='resumed';unknown.recovery='native-idempotency-receipt';this.audit('prepare-receipt-resume',{tool,operationId:operation.id});}
   if(desc.effect!=='read'&&desc.effect!=='interactive')this.state.operations[operationKey]=operation;
   this.audit('dispatch',{tool,operationId:operation.id});
   let result;
   for(let attempt=0;;attempt++){
    if(this.cancelled||revision!==this.state.revision){result=error('TASK_REVISION_CHANGED','The user or requirements changed before dispatch. Replan with the current checkpoint.');break;}
    try{this.state.metrics.executed++;result=await dispatch(args,operation.id);}
    catch(cause){result={error:dispatchRun?.stopReason==='user'?'USER_STOPPED':cause.code??(desc.effect==='read'?'TOOL_INTERNAL_ERROR':'OPERATION_RESULT_UNKNOWN'),message:String(cause.message)};}
    if(result?.answers)this.learn(tool,args,result);
    const failure=failureOf(result);
    if(!failure||failure.category!=='transient'||desc.effect!=='read'||attempt>=GEOD_POLICY.transientRetries)break;
    const delay=Math.max(GEOD_POLICY.retryDelayMs*(2**attempt),failure.retryAfterMs);
    // Never shorten a server's requested cooldown, or hold a tool forever.
    if(delay>GEOD_POLICY.maxRetryDelayMs)break;
    this.state.metrics.retries++;await new Promise(resolve=>setTimeout(resolve,delay));
   }
   const failure=failureOf(result);
    if(failure?.code==='USER_STOPPED'){
     // Stopping an AI wait is not evidence that its native side effect failed
     // or was cancelled. Keep the exact operation for native reconciliation.
     operation.state=desc.effect==='read'||desc.effect==='interactive'?'cancelled':'unknown';
     operation.recovery=operation.state==='unknown'?'reconcile':'wait';
     this.audit('user-stopped-wait',{tool,operationId:operation.id,state:operation.state});
    }else if(failure){
    const scope=this.failureScope(failure,desc);
    const key=hash([scope,failure.category]),previous=this.state.failures[key];
    this.state.failures[key]={...failure,scope,condition:this.condition(failure,desc),attempts:(previous?.attempts??0)+1,recovery:ERROR_CLASSES[failure.category].recovery,retryAt:failure.category==='transient'?this.now()+Math.max(failure.retryAfterMs,GEOD_POLICY.cooldownMs):null};
    operation.state=failure.category==='unknownOutcome'?'unknown':'failed';operation.recovery=ERROR_CLASSES[failure.category].recovery;this.noProgress(tool,failure.code,key);
    const executionBlocker=this.rememberBlocker(failure,desc,dispatchRun);if(executionBlocker)result={...result,executionBlocker};
    // The domain executor has already saved an actual user decision card.
    // Finish from that native receipt rather than asking the model to retry
    // argument spellings or to generate another clarification round.
    const planning=unwrap(result)?.error?.planningConflict;
    if(['plan_imagery','plan_imagery_batch','ask_user'].includes(canonicalTool)&&failure.code==='OUTPUT_CRS_FORMAT_CONFLICT'&&planning?.source==='resolved-native-planning'&&planning.questionSaved===true&&executionBlocker){
      this.reportBlocked({blockerIds:[executionBlocker.id]});this.audit('planning-awaits-human',{effectiveKey:failure.effectiveKey,reused:planning.reused===true});
    }
   }else if(result?.runtimePolicy){operation.state='failed';}
   else{
    operation.state='succeeded';operation.expiresAt=Date.parse(result?.expiresAt??result?.plan?.expiresAt??'')||null;
    if(desc.effect!=='read'&&desc.effect!=='interactive'){operation.resultRef=operationKey+'.json';const destination=join(this.results,operation.resultRef),temporary=destination+'.tmp';writeFileSync(temporary,JSON.stringify(unwrap(result)));renameSync(temporary,destination);}
    if(tool==='extensions_list'&&(!args.query||/workflow|runtime_workflow|步骤|验收|交付/i.test(args.query)))result={...result,connectors:[...(result?.connectors??[]),{connectorId:'builtin-runtime-workflow',name:'任务步骤与验收',enabled:true,availableTools:WORKFLOW_TOOLS.map(t=>t.function.name),tools:args.query?WORKFLOW_TOOLS.map(t=>({name:t.function.name,description:t.function.description,inputSchema:t.function.parameters})):[]}]};
    this.learn(tool,args,result);
    if(tool==='extensions_list'&&/boundar|行政|范围|矢量|vector|geojson|gpkg|geopackage|export|导出/i.test(args.query??'')){
     const names=['us_county_boundary','boundaries_list','boundaries_combine','data_download_plan','data_download_start','data_download_inspect'];
     result={...result,nativeCapabilities:names.filter(name=>this.schemas.has(name)).map(name=>({name,parameters:this.schemas.get(name)})),nativeExportRoute:{tool:'data_download_plan',kind:'boundary',sourceBoundaryId:'actual saved boundary ID',outputFormats:['gpkg'],dissolve:true,source:'saved native geometry, no remote layer URL needed',runtime:'managed GIS component; no system Python/Conda/ogr2ogr installation required'}};
    }
    const evidenceHash=hash([desc.purpose,desc.resource,result]);
    const seen=Object.values(this.state.evidence).some(e=>e.fingerprint===evidenceHash);
    // Only adapter-defined result fields count as verified completion evidence.
    const verified=completionEvidence(canonicalTool,canonicalArgs,unwrap(result));
    const evidenceId=hash([goalId,evidenceHash]),nativeResult=unwrap(result);this.state.evidence[evidenceId]={id:evidenceId,goalId,tool,fingerprint:evidenceHash,resourceIds:[nativeResult?.jobId,nativeResult?.taskId].filter(Boolean),verified,summary:bounded(result,600),source:'tool-receipt'};
     this.registerResource(canonicalTool,nativeResult,evidenceId,verified);
     if(tool==='runtime_context_read'&&result.retrievalFingerprint&&result.reusedContext){
      result={...result,knownBlockers:Object.values(this.state.run?.blockers??{}).map(({id,code,category})=>({id,code,category})),next:'These exact records were already delivered. Use confirmed requirements and fresh native task state; another wording of the same retrieval is not progress. Resolve the actual blocker or issue runtime_task_report if no authorized path remains.'};
      this.noProgress(tool,'UNCHANGED_CONTEXT','context:'+result.retrievalFingerprint);
     }else if(tool==='runtime_tools_search'&&result.discoveryFingerprint){
     this.state.discoveryPages??={};const known=this.state.discoveryPages[result.discoveryFingerprint];
     if(known&&!result.newlyActivated?.length){result={...result,reusedDiscovery:true,previousQueries:known.queries,note:result.note+' This capability page is unchanged; follow capabilityRoutes or the next page instead of rephrasing the same search.'};this.noProgress(tool,'UNCHANGED_DISCOVERY','discovery:'+result.discoveryFingerprint);}
     else if(!seen)this.state.stagnation=0;
     this.state.discoveryPages[result.discoveryFingerprint]={queries:(known?.queries??0)+1};
    }else if(!seen){this.state.stagnation=0;}else if(desc.effect==='read'&&!desc.wait)this.noProgress(tool,'UNCHANGED_RESULT');
    for(const [key,f]of Object.entries(this.state.failures))if(f.scope===String(desc.conditionScope))delete this.state.failures[key];
   }
   if(discovery&&operation.state==='succeeded'){
     // Discovery can activate contracts and advance discoveryRevision itself.
     const key=hash([tool,args,this.state.run?.id,this.state.revision,this.state.contract,this.facts.connectionsRevision,this.state.discoveryRevision]);
     this.discoveryMemo.set(key,{until:this.now()+90000,result:clean(result)});
     if(this.discoveryMemo.size>100)this.discoveryMemo.delete(this.discoveryMemo.keys().next().value);
   }
   const native=unwrap(result),terminal=native?.backgroundResult;
   if(terminal&&['failed','partial'].includes(terminal.state)&&!failure){
    // Successful submission is distinct from failed/partial delivery. The
    // native monitor supplies only its recorded error code, never raw logs.
    const outcome=failureOf({error:terminal.errorCode??(terminal.state==='partial'?'PARTIAL_DELIVERY':'TASK_EXECUTION_FAILED')});
    const executionBlocker=this.rememberBlocker(outcome,desc,dispatchRun);if(executionBlocker)result={...result,executionBlocker};
   }
   this.audit('result',{tool,operationId:operation.id,state:operation.state});return clean(result);
  })();this.pending.set(operationKey,work);try{return await work;}finally{this.pending.delete(operationKey);}
 }
 learn(tool,args,result){
  if(tool==='mcp_call'&&GEOD_POLICY.nativeConnectors.includes(args.connectorId)){this.learn(args.toolName,args.arguments,unwrap(result));return;}
  if(['jobs_list','jobs_get','jobs_events'].includes(tool)){
   for(const job of result?.jobs??[result])if(job?.jobId&&job.planId&&job.state&&job.state!=='not_started')for(const op of Object.values(this.state.operations))if(op.state==='unknown'&&op.tool==='jobs_start'&&op.resource?.[0]===job.planId){op.state='succeeded';op.result={jobId:job.jobId,planId:job.planId,state:job.state,reconciled:true};delete op.recovery;}
  }
  if(['data_download_get','data_download_list'].includes(tool))for(const task of Array.isArray(result)?result:result?.tasks??[result])this.reconcileDataSubmission(task);
  if(tool==='ask_user'&&result?.answers){let changed=false;for(const q of args.questions){const value=result.answers[q.id];if(value?.answers?.length){const key='question:'+q.id;changed||=hash(this.state.requirements[key]?.value)!==hash(value);this.state.requirements[key]={value,contract:hash(q),source:'native-user-answer',scope:this.state.goal.id,confirmed:true,revision:this.state.revision};}}if(changed){this.state.revision++;this.state.goal.revision++;}}
  if(tool==='extensions_list'||tool==='gdal_connect'||tool==='mcp_connect'){
   const connectors=result?.connectors??(result?.connectorId?[result]:[]);
   for(const c of connectors)if(c.connectorId&&Array.isArray(c.tools)){this.state.discovered??={};this.state.discovered[c.connectorId]={...this.state.discovered[c.connectorId],...Object.fromEntries(c.tools.map(t=>[t.name,{inputSchema:t.inputSchema,annotations:t.annotations??{}}]))};}
   this.state.discoveryRevision=hash(this.state.discovered??{});
  }
 }
 noProgress(tool,code,bucket=tool){this.state.stagnation=this.state.stagnationBucket===bucket?this.state.stagnation+1:1;this.state.stagnationBucket=bucket;if(this.state.stagnation===GEOD_POLICY.stagnationThreshold){this.state.metrics.strategyReviews++;this.onSignal({reason:'repeat',tool,code,checkpoint:this.view()});}}
 registerResource(tool,result,evidenceId,verified){
  const submission=['jobs_start','data_download_start'].includes(tool),inspection=['artifacts_inspect','data_download_inspect'].includes(tool),observed=['jobs_get','data_download_get'].includes(tool)&&verified;
  if(!submission&&!inspection&&!observed)return;
  const id=result?.jobId??result?.taskId??result?.id;if(!id)return;
  const old=this.state.nativeResources[id];if(!submission&&!observed&&(!old||old.goalId!==this.state.goal.id))return;
  const kind=tool.startsWith('jobs_')||tool==='artifacts_inspect'?'imagery':'data';
  this.state.nativeResources[id]={id,kind,goalId:this.state.goal.id,state:result.backgroundResult?.state??(verified?'completed':result.state??result.status??'unknown'),verified:verified||old?.verified===true,evidenceId:verified?evidenceId:old?.evidenceId};
  if(!this.state.run.resourceIds.includes(id))this.state.run.resourceIds.push(id);
  if(submission||observed){this.state.goal.nativeDeliverables??=[];if(!this.state.goal.nativeDeliverables.includes(id))this.state.goal.nativeDeliverables.push(id);}
 }
 bindCall(callId,revision){if(callId)this.callRevisions.set(callId,revision);}
 steer(text){this.state.latestUserInput=text.slice(0,2000);this.state.revision++;this.state.goal.revision++;this.audit('user-correction');}
 builtinPre(event){
  const tool=event.tool_name??event.toolName??'';
  if(this.cancelled)return error('EXECUTION_CANCELLED','This run is cancelled.');
  if(this.callRevisions.has(event.tool_use_id)&&this.callRevisions.get(event.tool_use_id)!==this.state.revision)return error('TASK_REVISION_CHANGED','This call predates the latest user correction.');
   if(this.state.goal.state==='complete')return error('TASK_ALREADY_COMPLETE','This goal has passed native acceptance. Start a new goal only for new user work.');
   if(this.facts.permission!==undefined&&this.facts.permission!==(this.params.permission??'confirmEach'))return error('WORKSPACE_PERMISSION_CHANGED','The native workspace permission changed during this Core turn. Start the next turn with the current native permission before executing another Core tool.');
  if(/(?:^|[.:/])view_image$/.test(tool)&&!(this.capabilities.inputModalities??['text']).includes('image'))return error('MODEL_IMAGE_UNSUPPORTED','The selected model does not accept images. Choose a compatible model or a non-image method.');
  const key=hash(['core',tool,event.tool_input]);const previous=this.state.operations[key];
  if(previous?.state==='unknown')return error('OPERATION_RECONCILIATION_REQUIRED','This Core operation was interrupted before its result was recorded. Reconcile the external effect before repeating the same input.');
  this.state.operations[key]={id:event.tool_use_id??randomUUID(),tool:'core:'+tool,state:'pending',goalId:this.state.goal.id,revision:this.state.revision,argsHash:hash(event.tool_input)};
  this.audit('core-tool-preflight',{tool});return null;
 }
 builtinPost(event){
  const tool=event.tool_name??event.toolName??'',result=event.tool_response??event.tool_result;
  const operation=this.state.operations[hash(['core',tool,event.tool_input])];if(operation)operation.state='reported';
   if(event.error||result?.error||result?.exit_code||result?.exitCode){if(operation)operation.failureCounted=true;this.noProgress('core:'+tool,'CORE_TOOL_FAILURE','core-failure:'+tool);}
  this.audit('core-tool-result',{tool});
 }
 coreItemCompleted(item){
  if(!['commandExecution','fileChange','mcpToolCall'].includes(item?.type))return;
  const operation=Object.values(this.state.operations).find(op=>op.id===item.id&&op.tool.startsWith('core:'));
  if(operation){operation.state='reported';operation.status=item.status;this.audit('core-item-result',{tool:operation.tool,status:item.status});}
   if((item.status==='failed'||item.error||item.exitCode&&item.exitCode!==0)&&!operation?.failureCounted){const tool=operation?.tool??'core:'+item.type;if(operation)operation.failureCounted=true;this.noProgress(tool,'CORE_TOOL_FAILURE','core-failure:'+tool.replace(/^core:/,''));}
 }
 resume(){this.state.stagnation=0;this.audit('human-strategy-review');}
 cancel(reason='user'){this.cancelled=true;if(this.state.run){this.state.run.state='cancelled';this.state.run.stopReason=reason;}this.audit('cancel',{reason});}
 finish(status){if(this.state.run){this.state.run.state=status;this.state.run.completionRegistration={scope:'submitted-native-resources',resourceIds:this.state.run.resourceIds,complete:this.state.run.resourceIds.length>0&&this.state.run.resourceIds.every(id=>this.state.nativeResources[id]?.verified===true)};}this.cancelled=true;this.audit('run-finish');}
}

// Execution policy belongs to the host, outside Codex's model loop. Model
// proposals never grant native permissions or turn a reply into completion.
import {readFileSync,writeFileSync,renameSync,mkdirSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {GEOD_POLICY,ERROR_CLASSES,completionEvidence} from './runtime-policy-geod.mjs';

export const POLICY_VERSION=1;
export const RUNTIME_TOOLS=[
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
 return{code,category,condition:ERROR_CLASSES[category].condition,retryAfterMs:Number.isFinite(value.retryAfterMs)?Math.max(0,value.retryAfterMs):0};
}
function bounded(value,limit=3000){const text=JSON.stringify(value);return text.length<=limit?value:{summary:text.slice(0,limit),omitted:true,sha256:hash(value)};}

export class RuntimePolicy {
 constructor(home,declared,{now=()=>Date.now(),onSignal=()=>{}}={}){
  this.now=now;this.onSignal=onSignal;this.schemas=new Map(declared.map(({function:t})=>[t.name,t.parameters]));this.home=home;mkdirSync(home,{recursive:true});
  this.file=join(home,'execution-checkpoint.json');this.results=join(home,'execution-results');mkdirSync(this.results,{recursive:true});this.pending=new Map();this.callRevisions=new Map();this.cancelled=true;this.facts={};
  try{this.state=JSON.parse(readFileSync(this.file,'utf8'));if(this.state.version!==POLICY_VERSION)throw new Error('Unsupported checkpoint version');}
  catch(cause){if(cause.code!=='ENOENT')throw cause;this.state={version:POLICY_VERSION,revision:1,goal:null,requirements:{},operations:{},failures:{},evidence:{},metrics:{executed:0,reused:0,blocked:0,retries:0,strategyReviews:0},stagnation:0};}
  // A pending side effect after a crash is UNKNOWN, not permission to resend.
  for(const op of Object.values(this.state.operations))if(op.state==='pending'){op.state='unknown';op.recovery='reconcile';}
  this.state.nativeResources??={};this.save();
 }
 save(){const temporary=this.file+'.tmp';const fd=openSync(temporary,'w');try{writeFileSync(fd,JSON.stringify(this.state));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,this.file);}
 audit(kind,fields={}){this.state.lastDecision={at:this.now(),kind,...fields};this.save();const fd=openSync(join(this.home,'execution-decisions.jsonl'),'a');try{writeFileSync(fd,JSON.stringify({version:POLICY_VERSION,revision:this.state.revision,goalId:this.state.goal?.id,runId:this.state.run?.id,...this.state.lastDecision})+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
 begin(params,capabilities={}){
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
 }
 view(){return{version:this.state.version,revision:this.state.revision,goal:this.state.goal,run:this.state.run,requirements:this.state.requirements,contract:this.state.contract,capabilities:{inputModalities:this.capabilities?.inputModalities??['text']},unresolvedOperations:Object.values(this.state.operations).filter(o=>['pending','unknown'].includes(o.state)).map(({id,tool,state,recovery})=>({id,tool,state,recovery})),failures:Object.values(this.state.failures).slice(-12),evidence:Object.values(this.state.evidence).slice(-12),metrics:this.state.metrics,lastDecision:this.state.lastDecision};}
 compactView(){
  const view=this.view(),resources=Object.values(this.state.nativeResources).filter(r=>r.goalId===this.state.goal?.id),submitted=resources.filter(r=>this.state.run?.resourceIds?.includes(r.id));
  return{version:view.version,revision:view.revision,goal:view.goal,requirements:view.requirements,unresolvedOperations:view.unresolvedOperations,
   failures:view.failures.map(({code,category,recovery,condition,retryAt})=>({code,category,recovery,condition,retryAt})),
   resources:resources.map(({id,kind,state,verified,evidenceId})=>({id,kind,state,verified,evidenceId})),
   completionRegistration:{automatic:true,scope:'submitted-native-resources',complete:submitted.length>0&&submitted.every(r=>r.verified),ids:submitted.map(r=>r.id)},
   evidence:view.evidence.filter(e=>e.verified&&e.goalId===this.state.goal?.id).map(({id,tool,resourceIds,verified})=>({id,tool,resourceIds,verified})),
   detailsTool:'runtime_task_state'};
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
  const spec=GEOD_POLICY.tools[tool]??{effect:'external',purpose:tool};
  return{...spec,resource:spec.resource?spec.resource.map(k=>args[k]??null):['planId','jobId','taskId','scheduleId','connectionId','boundaryId','sourceId'].filter(k=>args[k]!==undefined).map(k=>args[k]),conditionScope:spec.conditionScope??spec.purpose??tool};
 }
 failureScope(failure,desc){return failure.category==='business'?hash([desc.conditionScope,desc.resource]):['parameter','capability','internal'].includes(failure.category)?hash([desc.conditionScope,desc.purpose]):String(desc.conditionScope);}
 condition(failure,descriptor){
  const base={contract:this.state.contract,model:this.state.capabilitiesHash};
  if(failure.category==='permission')return hash({...base,permission:this.facts.permission,approval:this.facts.imagery?.counts??this.facts.imagery?.summary});
  if(failure.category==='authentication'||failure.category==='capability')return hash({...base,connections:this.facts.connectionsRevision,discovery:this.state.discoveryRevision,conditionScope:descriptor.conditionScope});
   return hash({...base,...(failure.category==='business'?{objectState:this.facts.imagery?.tasks?.filter(t=>descriptor.resource.includes(t.planId)||descriptor.resource.includes(t.jobId))}: {})});
 }
 async execute(tool,args,callId,dispatch){
  args=clean(args);const schema=this.schemas.get(tool);
  if(this.cancelled)return error('EXECUTION_CANCELLED','The run was cancelled; no new operation was dispatched.');
  if(this.callRevisions.has(callId)&&this.callRevisions.get(callId)!==this.state.revision)return error('TASK_REVISION_CHANGED','This call was generated before a user correction or confirmed requirement changed. Replan from the current checkpoint.');
  if(!schema)return error('TOOL_NOT_ALLOWED','Use a tool from the current contract.');
   const unsupported=unsupportedSchemaErrors(schema);if(unsupported.length){this.state.metrics.blocked++;this.noProgress(tool,'TOOL_SCHEMA_UNSUPPORTED','schema:'+tool);this.audit('unsupported-contract',{tool});return error('TOOL_SCHEMA_UNSUPPORTED','This tool contract uses validation constraints that the runtime cannot safely enforce. Refresh the capability or use a supported tool.',{constraints:unsupported});}
  const invalid=schemaErrors(args,schema);if(invalid.length){this.state.metrics.blocked++;this.noProgress(tool,'TOOL_ARGUMENT_INVALID',hash([tool,'parameter']));this.audit('schema-rejected',{tool});return error('TOOL_ARGUMENT_INVALID','Arguments failed the declared schema.',{constraints:invalid});}
  if(tool==='runtime_task_state'){const all=Object.values(this.state.evidence),offset=args.offset??Math.max(0,all.length-12),limit=args.limit??12;return{...this.view(),evidence:all.slice(offset,offset+limit),evidencePage:{offset,total:all.length,nextOffset:offset+limit<all.length?offset+limit:null}};}if(tool==='runtime_task_update')return this.update(args);
  if(this.state.goal.state==='complete')return error('TASK_ALREADY_COMPLETE','The declared goal has passed native evidence checks. Return its summary. For new user work, start a new goal revision before using more tools.');
  const desc=this.descriptor(tool,args);
  if(tool==='mcp_call'){
   if(!desc.schema)return error('TOOL_DISCOVERY_REQUIRED','Discover this connector and its current tool schema first.');
    const unsupported=unsupportedSchemaErrors(desc.schema);if(unsupported.length){this.state.metrics.blocked++;this.noProgress(tool,'TOOL_SCHEMA_UNSUPPORTED','schema:'+args.connectorId+':'+args.toolName);this.audit('unsupported-contract',{tool,connectorId:args.connectorId,toolName:args.toolName});return error('TOOL_SCHEMA_UNSUPPORTED','This MCP contract requires unsupported validation constraints; no call was dispatched.',{constraints:unsupported});}
    const invalid=schemaErrors(args.arguments,desc.schema);if(invalid.length){this.state.metrics.blocked++;this.noProgress(tool,'TOOL_ARGUMENT_INVALID','parameter:'+args.connectorId+':'+args.toolName);this.audit('schema-rejected',{tool,connectorId:args.connectorId,toolName:args.toolName});return error('TOOL_ARGUMENT_INVALID','MCP arguments failed its current schema.',{constraints:invalid});}
  }
  const goalId=this.state.goal.id,revision=this.state.revision;
  const canonicalTool=desc.canonicalTool??tool,canonicalArgs=desc.canonicalArgs??args;
  const rewrap=value=>tool==='mcp_call'?{connectorId:args.connectorId,toolName:args.toolName,result:value}:value;
  const operationKey=hash([goalId,this.state.goal.revision,canonicalTool,canonicalArgs]);
  const prior=this.state.operations[operationKey];
  const unknown=Object.values(this.state.operations).find(op=>op.state==='unknown'&&op.tool===canonicalTool&&op.argsHash===hash(canonicalArgs));
  if(unknown)return error('OPERATION_RECONCILIATION_REQUIRED','A previous submission with these arguments has an unknown outcome; reconcile its native receipt first.',{operationId:unknown.id});
  if(desc.effect!=='read'&&desc.effect!=='interactive'&&prior){
   if(desc.effect!=='opaque'&&prior.state==='succeeded'&&(!prior.expiresAt||prior.expiresAt>this.now())){this.state.metrics.reused++;this.audit('operation-reused',{tool,operationId:prior.id});return rewrap(prior.resultRef?JSON.parse(readFileSync(join(this.results,prior.resultRef),'utf8')):clean(prior.result));}
   if(['pending','unknown'].includes(prior.state))return error('OPERATION_RECONCILIATION_REQUIRED','The previous submission may have taken effect. Read its native status/receipt before resubmitting.',{operationId:prior.id});
  }
  if(tool==='ask_user'){
   const reused={};let missing=false;
   for(const q of args.questions){const known=this.state.requirements['question:'+q.id];if(known?.confirmed&&known.contract===hash(q)&&known.scope===goalId)reused[q.id]=known.value;else missing=true;}
   if(!missing){this.state.metrics.reused++;this.audit('requirements-reused');return{answers:reused,answeredBy:'user',reusedPreviousAnswer:true};}
  }
  const blocked=Object.values(this.state.failures).find(f=>f.scope===this.failureScope(f,desc)&&['transient','permission','authentication','capability','business'].includes(f.category)&&f.condition===this.condition(f,desc)&&(!f.retryAt||f.retryAt>this.now()));
  if(blocked){this.noProgress(tool,blocked.code,hash([blocked.scope,blocked.category]));this.state.metrics.blocked++;this.audit('condition-blocked',{tool,category:blocked.category});return error('RECOVERY_CONDITION_UNCHANGED','A prerequisite has not changed. Reuse the known failure, obtain the missing condition, or use another valid capability.',{failure:blocked});}
  if(this.pending.has(operationKey))return this.pending.get(operationKey);
  const work=(async()=>{
    const operation={id:randomUUID(),tool:canonicalTool,state:'pending',goalId,revision,argsHash:hash(canonicalArgs),resource:desc.resource};
   if(desc.effect!=='read'&&desc.effect!=='interactive')this.state.operations[operationKey]=operation;
   this.audit('dispatch',{tool,operationId:operation.id});
   let result;
   for(let attempt=0;;attempt++){
    if(this.cancelled||revision!==this.state.revision){result=error('TASK_REVISION_CHANGED','The user or requirements changed before dispatch. Replan with the current checkpoint.');break;}
    try{this.state.metrics.executed++;result=await dispatch(args,operation.id);}
    catch(cause){result={error:cause.code??(desc.effect==='read'?'TOOL_INTERNAL_ERROR':'OPERATION_RESULT_UNKNOWN'),message:String(cause.message)};}
    if(result?.answers)this.learn(tool,args,result);
    const failure=failureOf(result);
    if(!failure||failure.category!=='transient'||desc.effect!=='read'||attempt>=GEOD_POLICY.transientRetries)break;
    const delay=Math.max(GEOD_POLICY.retryDelayMs*(2**attempt),failure.retryAfterMs);
    // Never shorten a server's requested cooldown, or hold a tool forever.
    if(delay>GEOD_POLICY.maxRetryDelayMs)break;
    this.state.metrics.retries++;await new Promise(resolve=>setTimeout(resolve,delay));
   }
   const failure=failureOf(result);
   if(failure){
    const scope=this.failureScope(failure,desc);
    const key=hash([scope,failure.category]),previous=this.state.failures[key];
    this.state.failures[key]={...failure,scope,condition:this.condition(failure,desc),attempts:(previous?.attempts??0)+1,recovery:ERROR_CLASSES[failure.category].recovery,retryAt:failure.category==='transient'?this.now()+Math.max(failure.retryAfterMs,GEOD_POLICY.cooldownMs):null};
    operation.state=failure.category==='unknownOutcome'?'unknown':'failed';operation.recovery=ERROR_CLASSES[failure.category].recovery;this.noProgress(tool,failure.code,key);
   }else if(result?.runtimePolicy){operation.state='failed';}
   else{
    operation.state='succeeded';operation.expiresAt=Date.parse(result?.expiresAt??result?.plan?.expiresAt??'')||null;
    if(desc.effect!=='read'&&desc.effect!=='interactive'){operation.resultRef=operationKey+'.json';const destination=join(this.results,operation.resultRef),temporary=destination+'.tmp';writeFileSync(temporary,JSON.stringify(unwrap(result)));renameSync(temporary,destination);}
    this.learn(tool,args,result);
    const evidenceHash=hash([desc.purpose,desc.resource,result]);
    const seen=Object.values(this.state.evidence).some(e=>e.fingerprint===evidenceHash);
    // Only adapter-defined result fields count as verified completion evidence.
    const verified=completionEvidence(canonicalTool,canonicalArgs,unwrap(result));
    const evidenceId=hash([goalId,evidenceHash]),nativeResult=unwrap(result);this.state.evidence[evidenceId]={id:evidenceId,goalId,tool,fingerprint:evidenceHash,resourceIds:[nativeResult?.jobId,nativeResult?.taskId].filter(Boolean),verified,summary:bounded(result,600),source:'tool-receipt'};
     this.registerResource(canonicalTool,nativeResult,evidenceId,verified);
    if(!seen){this.state.stagnation=0;}else if(desc.effect==='read'&&!desc.wait)this.noProgress(tool,'UNCHANGED_RESULT');
    for(const [key,f]of Object.entries(this.state.failures))if(f.scope===String(desc.conditionScope))delete this.state.failures[key];
   }
   this.audit('result',{tool,operationId:operation.id,state:operation.state});return clean(result);
  })();this.pending.set(operationKey,work);try{return await work;}finally{this.pending.delete(operationKey);}
 }
 learn(tool,args,result){
  if(tool==='mcp_call'&&GEOD_POLICY.nativeConnectors.includes(args.connectorId)){this.learn(args.toolName,args.arguments,unwrap(result));return;}
  if(['jobs_list','jobs_get','jobs_events'].includes(tool)){
   for(const job of result?.jobs??[result])if(job?.jobId&&job.planId&&job.state&&job.state!=='not_started')for(const op of Object.values(this.state.operations))if(op.state==='unknown'&&op.tool==='jobs_start'&&op.resource?.[0]===job.planId){op.state='succeeded';op.result={jobId:job.jobId,planId:job.planId,state:job.state,reconciled:true};delete op.recovery;}
  }
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
 cancel(){this.cancelled=true;if(this.state.run)this.state.run.state='cancelled';this.audit('cancel');}
 finish(status){if(this.state.run){this.state.run.state=status;this.state.run.completionRegistration={scope:'submitted-native-resources',resourceIds:this.state.run.resourceIds,complete:this.state.run.resourceIds.length>0&&this.state.run.resourceIds.every(id=>this.state.nativeResources[id]?.verified===true)};}this.cancelled=true;this.audit('run-finish');}
}

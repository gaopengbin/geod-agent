import type {BoundaryImport,StoredPlan} from './api';
import type {DisplayMessage} from './pending-generations';
import {humanCrsIntent,normalizeExportCrs} from './export-crs.ts';
import {inputOrigin} from './user-input-records.ts';

/** A narrow human instruction to change only the existing imagery plan's zoom. */
export function zoomRevision(text:string):number|null {
 const direct=text.split(/\n已附加边界：/)[0].trim();
 if(!/(?:\bz\s*\d|缩放|层级|级别|\bzoom\b)/i.test(direct))return null;
 const match=direct.match(/^(?:请|帮我)?\s*(?:只|仅)?\s*(?:(?:把)?(?:当前|刚才|上次|这份|这个)?(?:计划|任务|影像)?(?:的)?\s*)?(?:(?:缩放(?:级别)?|层级|级别|分辨率)\s*)?(?:改(?:成|为|到)|调整(?:成|为|到)|调到|降(?:到|为)|升(?:到|为))\s*(?:z\s*|zoom\s*)?(\d{1,2})(?:\s*级)?\s*(?:[，,；;]\s*(?:其他|其它|其余)(?:参数)?不变)?[。！!\s]*$/i)
  ??direct.match(/^(?:please\s+)?(?:change|set|adjust|lower|raise)\s+(?:the\s+)?zoom(?:\s+level)?\s+to\s+z?\s*(\d{1,2})(?:[,;]\s*(?:keep\s+)?(?:all\s+)?other\s+(?:parameters|settings)\s+unchanged)?[.!\s]*$/i);
 const zoom=match?Number(match[1]):NaN;return Number.isInteger(zoom)&&zoom>=0&&zoom<=22?zoom:null;
}
export interface InheritedImageryCrs {crs:string;resampling:'nearest'|'bilinear'|'cubic';planId:string}
interface RevisionRequest {messages:DisplayMessage[];userMessageId?:string;toolName:string;args:Record<string,unknown>;planIds:string[];activeBoundary:BoundaryImport|null}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const formats=(v:unknown)=>Array.isArray(v)&&v.every(x=>typeof x==='string')?[...new Set(v)].sort():null;

/** Trust an owned native plan, never an assistant's claim or a model-supplied CRS. */
async function revisionPlan(request:Omit<RevisionRequest,'toolName'|'args'>,load:(id:string)=>Promise<StoredPlan|null>) {
 const origin=inputOrigin(request.messages,request.userMessageId),index=request.messages.findIndex(m=>m.id===origin&&m.role==='user');
 if(index<0)return null;
 const human=request.messages[index],intent=humanCrsIntent(human.content),zoom=zoomRevision(human.content);
 if(zoom===null||intent.clear||intent.crs||intent.needsClarification)return null;
 // The latest actual planning record is the reference. Do not search older
 // unrelated plans merely because their parameters happen to match.
 const previous=[...request.messages.slice(0,index)].reverse().find(m=>m.role==='tool'&&['plan_imagery','plan_imagery_batch'].includes(m.toolName??'')&&m.details);
 if(!previous||previous.toolName!=='plan_imagery')return null;
 let record;try{record=JSON.parse(previous.details!);}catch{return null;}
 const id=record.result?.planId;
 if(typeof id!=='string'||!request.planIds.includes(id))return null;
 const stored=await load(id);if(!stored||stored.planId!==id)return null;
 const spec=stored.plan.spec;
 if(spec.kind!=='imagery')return null;
 return {stored,old:record.arguments,zoom};
}

/** Resolve a zoom-only clarification before the model has supplied new plan arguments. */
export async function revisionCrsForQuestions(request:Omit<RevisionRequest,'toolName'|'args'>,load:(id:string)=>Promise<StoredPlan|null>):Promise<InheritedImageryCrs|null> {
 const reference=await revisionPlan(request,load);if(!reference)return null;
 const {stored}=reference,spec=stored.plan.spec;
 if(request.activeBoundary&&(!same(request.activeBoundary.bounds,spec.bounds)||!same(request.activeBoundary.geometry,spec.boundary)))return null;
 const crs=typeof spec.exportOptions?.targetCrs==='string'?normalizeExportCrs(spec.exportOptions.targetCrs):null;
 return crs?{crs,resampling:spec.exportOptions?.resampling??'nearest',planId:stored.planId}:null;
}

export async function inheritedImageryCrs(request:RevisionRequest,load:(id:string)=>Promise<StoredPlan|null>):Promise<InheritedImageryCrs|null> {
 if(request.toolName!=='plan_imagery')return null;
 const reference=await revisionPlan(request,load);if(!reference)return null;
 const {stored,old,zoom}=reference,spec=stored.plan.spec,id=stored.planId;
 const levels=request.args.zoom!==undefined?[request.args.zoom]:request.args.zoomLevels??(request.args.zoomMin===request.args.zoomMax?[request.args.zoomMin]:null);
 if(!same(levels,[zoom]))return null;
 if(!old||spec.kind!=='imagery'||request.args.sourceId!==spec.sourceId||!same(formats(request.args.outputFormats),formats(spec.outputFormats)))return null;
 let matchingRange=false;
 if(typeof request.args.boundaryId==='string'){
  matchingRange=request.args.boundaryId===old.boundaryId;
  if(!matchingRange&&request.activeBoundary?.boundaryId===request.args.boundaryId)matchingRange=same(request.activeBoundary.bounds,spec.bounds)&&same(request.activeBoundary.geometry,spec.boundary);
 }else if(request.activeBoundary){matchingRange=same(request.activeBoundary.bounds,spec.bounds)&&same(request.activeBoundary.geometry,spec.boundary);}
 else matchingRange=!spec.boundary&&same(request.args.bounds,spec.bounds);
 if(!matchingRange)return null;
 const crs=typeof spec.exportOptions?.targetCrs==='string'?normalizeExportCrs(spec.exportOptions.targetCrs):null;
 return crs?{crs,resampling:spec.exportOptions?.resampling??'nearest',planId:id}:null;
}

export async function resolvedRevisionQuestions(messages:DisplayMessage[],planIds:string[],activeBoundary:BoundaryImport|null,load:(id:string)=>Promise<StoredPlan|null>):Promise<DisplayMessage[]> {
 const changes=new Map<string,InheritedImageryCrs>();
 for(const message of messages){const r=message.userInput;
  if(r?.status!=='pending'||!r.requestId.startsWith('crs-')||!r.toolCallId||!r.questions.length||!r.questions.every(q=>['export_crs','export_crs_scope'].includes(q.id)))continue;
  const tool=messages.find(m=>m.id===r.toolCallId&&m.toolName==='plan_imagery');if(!tool?.details)continue;
  let data;try{data=JSON.parse(tool.details);}catch{continue;}
  const choice=await inheritedImageryCrs({messages,userMessageId:r.userMessageId,toolName:'plan_imagery',args:data.arguments??data,planIds,activeBoundary},load);
  if(!choice)continue;
  // Preserve an unfinished, different human choice. A matching CRS draft is
  // retained as history; it neither changes the original plan nor sets a default.
  if(Object.values(r.draft?.drafts??{}).some(Boolean)||r.draft?.values.export_crs_scope)continue;
  const draftCrs=r.draft?.values.export_crs;
  if(draftCrs&&humanCrsIntent(draftCrs).crs!==choice.crs)continue;
  changes.set(message.id,choice);
 }
 if(!changes.size)return messages;
 return messages.map(message=>{const choice=changes.get(message.id);return choice?{...message,userInput:{...message.userInput!,status:'resolved' as const,reply:undefined,resolution:{kind:'existingPlanCrs' as const,...choice}}}:message;});
}

import type {TaskSpec} from './api';
import type {DisplayMessage} from './pending-generations';
import type {UserInputRecord} from './user-input-records';
import type {UserInputReply,UserInputQuestion} from './user-input';
import {humanCrsIntent,normalizeExportCrs,crsFromAnswers} from './export-crs.ts';
import {inputOrigin,userInputReplyText} from './user-input-records.ts';

type Args=Record<string,unknown>;
type Store=Pick<Storage,'getItem'|'setItem'>;
export interface PlanningContext {messages:DisplayMessage[];userMessageId?:string;isCurrent?:()=>boolean}
interface Conditions {targetCrs:string;outputFormats:string[]}
interface Choice extends Conditions {origin?:string;proof:string;args:Args}
export interface PlanningConflict {
  id:string;code:'OUTPUT_CRS_FORMAT_CONFLICT';message:string;origin?:string;userText:string;
  conditions:Conditions;requestFingerprint:string;conditionFingerprint:string;args:Args;spec:TaskSpec;deferred?:boolean;
}
interface State {version:1;active:PlanningConflict|null;accepted:Choice|null;history:PlanningConflict[];metrics:{nativeDispatches:number;reused:number};declared?:{targetCrs?:string;outputFormats?:string[]};taskOrigin?:string;observedUserId?:string}
const copy=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):v;
const fingerprint=async(v:unknown)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(stable(v)))))].map(n=>n.toString(16).padStart(2,'0')).join('');
const conditionKey=(v:Conditions)=>JSON.stringify([v.targetCrs,[...v.outputFormats].sort()]);
const conditionOf=(spec:TaskSpec):Conditions=>({targetCrs:normalizeExportCrs(spec.exportOptions?.targetCrs??'EPSG:3857')??'',outputFormats:[...new Set(spec.outputFormats)].sort()});
const SAME='暂不执行，保留原要求';
const nativeLabel=(_crs:string)=>`保留瓦片格式 · EPSG:3857`;
export const planningConflictKey=(account:string,conversation:string)=>`geod-agent-planning-conflicts-1:${encodeURIComponent(account)}:${encodeURIComponent(conversation)}`;
export const isPlanningOutputQuestion=(q:UserInputQuestion)=>!q.isSecret&&/(?:EPSG|坐标系|\bCRS\b).*(?:格式|瓦片|GeoTIFF|MBTiles|format)|(?:格式|瓦片|GeoTIFF|MBTiles|format).*(?:EPSG|坐标系|\bCRS\b)|(?:输出|成果|export|output).*(?:坐标系|\bCRS\b)/i.test(q.header+' '+q.question);
function explicitCrs(text:string){
  if(/如果|假如|是否|是什么|为什么|如何|能否|[?？]/.test(text)||/(?:不要|别|不能|不得|不)\s*(?:改(?:为|成)?|使用|选)?\s*(?:坐标系\s*)?EPSG|(?:不要|别|不能|不得)\s*改.{0,6}坐标/i.test(text)||!/^(?:请)?(?:改|换|使用|用|保持|保留|输出|这次|本次|EPSG|下载|获取|新任务|download|fetch)|其他.*不变/i.test(text.trim()))return null;
  return humanCrsIntent(text).crs;
}

function directFormat(text:string):string[]|null {
  const value=text.replace(/```[\s\S]*?```/g,'').replace(/[“"][^”"\n]*[”"]/g,'').split('\n已附加边界：')[0];
  if(/如果|假如|是否|[?？]/.test(value))return null;
  if(/^(?:GeoTIFF|MBTiles|GeoPackage|PNG|JPEG|原始瓦片目录|瓦片目录)$/i.test(value.trim()))return[/瓦片/.test(value)?'tiles':value.trim().toLowerCase()==='geopackage'?'gpkg':value.trim().toLowerCase()];
  const pattern=/(?:改(?:为|成|用)?|换(?:成|为)?|使用|输出为|保留)\s*(原始瓦片(?:目录)?|瓦片目录|GeoTIFF|MBTiles|GeoPackage|PNG|JPEG)/gi;
  const found=[...value.matchAll(pattern)].filter(m=>!/(?:不要|不能|不|别)\s*$/.test(value.slice(Math.max(0,m.index!-5),m.index)));
  if(!found.length)return null;
  const formats=found.map(m=>/瓦片/.test(m[1])?'tiles':m[1].toLowerCase()==='geopackage'?'gpkg':m[1].toLowerCase());
  return new Set(formats).size===1?[formats[0]]:null;
}
function synthetic(m:DisplayMessage,messages:DisplayMessage[]){return messages.some(x=>x.userInput?.reply&&x.userInput.status==='answered'&&userInputReplyText(x.userInput,x.userInput.reply)===m.content);}
function humanChange(conflict:PlanningConflict,ctx:PlanningContext):{conditions:Conditions;proof:string;origin?:string}|'new-task'|null {
  const start=ctx.messages.findIndex(m=>m.id===conflict.origin&&m.role==='user');
  let changed:ReturnType<typeof humanChange>=null,conditions=copy(conflict.conditions);
  for(const m of ctx.messages.slice(Math.max(0,start+1))){
    if(m.role!=='user'||synthetic(m,ctx.messages))continue;
    if(m.content.trim()===conflict.userText.trim())continue;
    const text=m.content.trim();
    if(/^(?:请)?(?:新(?:建|的)?任务|另一个任务|另外.*(?:下载|任务)|new task)/i.test(text)||/^(?:下载|获取|download\b|fetch\b)/i.test(text)&&!/(?:继续|刚才|原任务|同一任务|其他.*不变)/.test(text))return'new-task';
    const crs=explicitCrs(text),formats=directFormat(text);
    if(crs||formats){conditions={targetCrs:crs??conditions.targetCrs,outputFormats:formats??conditions.outputFormats};changed={conditions:copy(conditions),proof:m.id,origin:inputOrigin(ctx.messages,m.id)};}
  }
  return changed;
}
function overrideArgs(base:Args,conditions:Conditions,proposed:Args):Args {
  return {...copy(base),...copy(proposed),outputFormats:[...conditions.outputFormats],exportOptions:{...copy(base.exportOptions as Args??{}),...copy(proposed.exportOptions as Args??{}),targetCrs:conditions.targetCrs}};
}
export function conflictQuestions(conflict:PlanningConflict):UserInputQuestion[]{
  const tiled=conflict.conditions.outputFormats.filter(v=>['tiles','mbtiles','gpkg'].includes(v));
  return [{id:'planning_format_crs',header:'规划条件冲突',question:`已确认的 ${tiled.join(' / ')} 与 ${conflict.conditions.targetCrs} 不能同时成立。请选择明确修改哪项；图源、范围、级别及其余设置保留。`,options:[
    {label:nativeLabel(conflict.conditions.targetCrs),description:`保留已选瓦片容器，明确改用其原生坐标系；只修改本次任务。`},
    {label:`保留 ${conflict.conditions.targetCrs} · 改用 GeoTIFF`,description:'明确把本次输出改为可重投影的影像格式；容量与执行权限仍由原生层检查。'},
    {label:SAME,description:'两项都不改，停止本次规划；已有参数和任务记录保留。'},
  ]}];
}
export class PlanningConflicts {
  private pending=new Map<string,Promise<unknown>>();
  private store:Store;readonly key:string;
  constructor(store:Store,key:string){this.store=store;this.key=key;}
  view():State {
    const raw=this.store.getItem(this.key);if(!raw)return{version:1,active:null,accepted:null,history:[],metrics:{nativeDispatches:0,reused:0}};
    try{const v=JSON.parse(raw);if(v.version!==1||!Array.isArray(v.history)||!v.metrics)throw Error();return v;}
    catch{throw{code:'PLANNING_STATE_UNAVAILABLE',message:'规划冲突记录暂不可读，未丢弃已确认参数或重新规划；请恢复本机记录后继续。'};}
  }
  private save(v:State){this.store.setItem(this.key,JSON.stringify(v));}
  observeHuman(ctx:PlanningContext){
    const latest=ctx.messages.find(m=>m.id===ctx.userMessageId&&m.role==='user');if(!latest)return;
    let v=this.view();if(v.observedUserId===latest.id||synthetic(latest,ctx.messages))return;
    const text=latest.content.trim(),newRequest=/^(?:请)?(?:新(?:建|的)?任务|另一个任务|另外.*(?:下载|任务)|下载|获取|download\b|fetch\b)/i.test(text)&&!/(?:继续|刚才|原任务|同一任务|其他.*不变)/.test(text);
    const sameRequest=v.active&&v.active.userText.split('\n已附加边界：')[0].trim()===text.split('\n已附加边界：')[0].trim();
    if(newRequest&&v.observedUserId&&!sameRequest){if(v.active)v.history.push(v.active);v.active=null;v.accepted=null;v.declared=undefined;v.taskOrigin=latest.id;this.save(v);}
    try{this.before({},ctx);}catch(e){if(!e||typeof e!=='object'||!('planningConflict'in e))throw e;}
    v=this.view();v.observedUserId=latest.id;v.taskOrigin??=inputOrigin(ctx.messages,latest.id);
    if(v.accepted)v.declared={targetCrs:v.accepted.targetCrs,outputFormats:[...v.accepted.outputFormats]};
    else{
      const declaredRequest=newRequest||!v.taskOrigin||v.taskOrigin===latest.id;
      const crs=explicitCrs(text);
      let formats=directFormat(text);
      if(!formats&&declaredRequest&&!/[?？]|如果|是否|(?:不要|别|不能|不得|不使用).{0,6}原始瓦片/.test(text)&&/原始瓦片目录/.test(text.replace(/https?:\/\/\S+|```[\s\S]*?```|[“"][^”"\n]*[”"]/gi,'')))formats=['tiles'];
      if(crs||formats)v.declared={...v.declared,...(crs?{targetCrs:crs}:{}),...(formats?{outputFormats:formats}:{})};
    }
    this.save(v);
  }
  projection(){const v=this.view();const c=v.accepted??v.declared;return c&&(c.targetCrs||c.outputFormats?.length)?{taskOrigin:v.taskOrigin??v.accepted?.origin??'',...(c.targetCrs?{targetCrs:c.targetCrs}:{}),...(c.outputFormats?.length?{outputFormats:c.outputFormats}:{})}:null;}
  private cached(v:State):never {
    v.metrics.reused++;this.save(v);throw this.error(v.active!,true);
  }
  error(c:PlanningConflict,reused=false){return{code:c.code,message:c.message,planningConflict:{source:'resolved-native-planning',id:c.id,requestFingerprint:c.requestFingerprint,conditionFingerprint:c.conditionFingerprint,conditions:c.conditions,reused,questionSaved:true},requiresUserReview:true};}
  before(args:Args,ctx:PlanningContext):{args:Args;targetCrs?:string} {
    const v=this.view(),c=v.active;
    if(c){
      const change=humanChange(c,ctx);
      if(change==='new-task'){v.history.push(c);v.active=null;v.accepted=null;this.save(v);return{args};}
      if(change&&conditionKey(change.conditions)!==conditionKey(c.conditions)){
        v.accepted={...change.conditions,origin:change.origin,proof:change.proof,args:copy(c.args)};v.history.push(c);v.active=null;this.save(v);
      }else return this.cached(v);
    }
    const choice=v.accepted,latest=ctx.messages.find(m=>m.id===ctx.userMessageId&&m.role==='user'),origin=inputOrigin(ctx.messages,ctx.userMessageId);
    const continuation=latest&&/^(?:请)?(?:继续|重试|接着|恢复)|其他.*不变/i.test(latest.content)&&!/(?:新任务|另一个任务)/.test(latest.content);
    const amendment=latest&&(/^(?:请)?(?:改|换|保留|使用|EPSG)|其他.*不变/i.test(latest.content)||directFormat(latest.content)!==null||explicitCrs(latest.content)!==null);
    if(choice&&(choice.origin===origin||continuation||amendment)){
      if(latest&&latest.id!==choice.origin&&!synthetic(latest,ctx.messages)){
        const crs=explicitCrs(latest.content),formats=directFormat(latest.content);
        if(crs||formats){choice.targetCrs=crs??choice.targetCrs;choice.outputFormats=formats??choice.outputFormats;choice.proof=latest.id;}
        choice.origin=origin;this.save(v);
      }
      return{args:overrideArgs(choice.args,choice,args),targetCrs:choice.targetCrs};
    }
    if(v.declared){const conditions=v.declared;return{args:{...args,...(conditions.outputFormats?{outputFormats:conditions.outputFormats}:{}),...(conditions.targetCrs?{exportOptions:{...args.exportOptions as Args??{},targetCrs:conditions.targetCrs}}:{})},targetCrs:conditions.targetCrs};}
    return{args};
  }
  accept(record:UserInputRecord,reply:UserInputReply|null):'changed'|'deferred'|'unrecognized'|null {
    if(record.resolution?.kind!=='planningConflict'||!reply)return null;
    const v=this.view(),c=v.active;if(!c||c.id!==record.resolution.conflictId)throw{code:'PLANNING_QUESTION_STALE',message:'条件已发生变化，请使用当前规划确认卡；旧回答未覆盖新要求。'};
    const value=reply.answers.planning_format_crs?.answers[0];let conditions:Conditions|null=null;
    if(value===nativeLabel(c.conditions.targetCrs))conditions={targetCrs:'EPSG:3857',outputFormats:[...c.conditions.outputFormats]};
    else if(value===`保留 ${c.conditions.targetCrs} · 改用 GeoTIFF`)conditions={targetCrs:c.conditions.targetCrs,outputFormats:['geotiff']};
    else if(value&&value!==SAME){const crs=explicitCrs(value),formats=directFormat(value);if(crs||formats)conditions={targetCrs:crs??c.conditions.targetCrs,outputFormats:formats??c.conditions.outputFormats};}
    if(!conditions||conditionKey(conditions)===conditionKey(c.conditions)){c.deferred=true;this.save(v);return value===SAME?'deferred':'unrecognized';}
    v.accepted={...conditions,origin:c.origin,proof:'native-question:'+record.requestId,args:copy(c.args)};v.declared=conditions;v.taskOrigin??=c.origin;v.history.push(c);v.active=null;this.save(v);return'changed';
  }
  observeAnswer(record:UserInputRecord,reply:UserInputReply|null):boolean {
    if(!reply||record.resolution?.kind==='planningConflict')return false;
    const v=this.view();if(v.active&&v.active.origin!==record.userMessageId)return false;
    let crs=crsFromAnswers(record.questions,reply)?.crs,formats:string[]|null=null;
    for(const q of record.questions){
      if(!isPlanningOutputQuestion(q)&&!/(?:输出|保存|导出|瓦片|output|export).*(?:格式|format)/i.test(q.header+' '+q.question))continue;
      const answer=reply.answers[q.id]?.answers[0];if(!answer)continue;
      const option=q.options?.find(o=>o.label===answer),text=answer+' '+(option?.description??'');
      crs??=humanCrsIntent(text).crs??undefined;formats??=directFormat(answer);
    }
    if(!crs&&!formats)return false;
    const prior=v.accepted??v.declared??v.active?.conditions;
    const conditions={...(prior?.targetCrs?{targetCrs:prior.targetCrs}:{}),...(prior?.outputFormats?{outputFormats:prior.outputFormats}:{}),...(crs?{targetCrs:crs}:{}),...(formats?{outputFormats:formats}:{})};
    if(v.active&&conditions.targetCrs&&conditions.outputFormats&&conditionKey({targetCrs:conditions.targetCrs,outputFormats:conditions.outputFormats})===conditionKey(v.active.conditions))return false;
    v.declared=conditions;v.taskOrigin??=record.userMessageId;
    if(conditions.targetCrs&&conditions.outputFormats){
      v.accepted={targetCrs:conditions.targetCrs,outputFormats:conditions.outputFormats,origin:record.userMessageId,proof:'user-question:'+record.requestId,args:copy(v.active?.args??v.accepted?.args??{})};
      if(v.active){v.history.push(v.active);v.active=null;}
    }
    this.save(v);return true;
  }
  async execute<T>(args:Args,spec:TaskSpec,ctx:PlanningContext,dispatch:()=>Promise<T>):Promise<T> {
    const conditions=conditionOf(spec),key=conditionKey(conditions);
    if(this.pending.has(key))return this.pending.get(key)as Promise<T>;
    const work=(async()=>{
      const v=this.view();
      if(v.active)return this.cached(v);
      const known=v.history.find(c=>conditionKey(c.conditions)===key);
      const capture=async(message:string)=>{
        if(ctx.isCurrent&&!ctx.isCurrent())throw{code:'REPLAN_AFTER_USER_INPUT',message:'用户要求已更新，旧冲突未覆盖新要求。'};
        const {outputDirectory:_,...effective}=spec;
        const c:PlanningConflict={id:crypto.randomUUID(),code:'OUTPUT_CRS_FORMAT_CONFLICT',message,origin:inputOrigin(ctx.messages,ctx.userMessageId),userText:ctx.messages.find(m=>m.id===inputOrigin(ctx.messages,ctx.userMessageId))?.content??'',conditions,requestFingerprint:await fingerprint(effective),conditionFingerprint:await fingerprint(conditions),args:copy(args),spec:copy(spec)};
        // Store the saved range ID as well as its resolved geometry.
        if(spec.boundary&&!c.args.boundaryId)c.args.bounds=copy(spec.bounds);
        const current=this.view();current.active=c;this.save(current);throw this.error(c,!!known);
      };
      if(known){v.metrics.reused++;this.save(v);return capture(known.message);}
      v.metrics.nativeDispatches++;this.save(v);
      try{return await dispatch();}catch(cause){if(cause&&typeof cause==='object'&&'code'in cause&&cause.code==='OUTPUT_CRS_FORMAT_CONFLICT')return capture('message'in cause?String(cause.message):'已确认的输出格式与坐标系不能同时成立。');throw cause;}
    })();this.pending.set(key,work);try{return await work;}finally{this.pending.delete(key);}
  }
}

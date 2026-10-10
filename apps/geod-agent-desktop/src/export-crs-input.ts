import {humanCrsIntent,normalizeExportCrs} from './export-crs.ts';
import {answeredCrsChoice,inputOrigin} from './user-input-records.ts';
import type {DisplayMessage} from './pending-generations';
import type {UserInputQuestion,UserInputReply} from './user-input';
import type {InheritedImageryCrs} from './imagery-revision';

/** Continuations keep the original human instruction, including its explicit CRS. */
export function requestCrsIntent(messages:DisplayMessage[],userMessageId?:string){
 const latest=humanCrsIntent(messages.find(m=>m.id===userMessageId&&m.role==='user')?.content??'');
 if(latest.crs||latest.clear||latest.needsClarification)return latest;
 const origin=inputOrigin(messages,userMessageId);
 return origin!==userMessageId?humanCrsIntent(messages.find(m=>m.id===origin&&m.role==='user')?.content??''):latest;
}

export interface KnownCrsChoice {crs:string;session:boolean;source:'humanRequest'|'acceptedAnswer'|'existingPlan'|'conversationDefault';planId?:string}
export function knownCrsChoice(messages:DisplayMessage[],userMessageId:string|undefined,conversationDefault?:string|null,inherited?:InheritedImageryCrs|null):KnownCrsChoice|null {
 const intent=requestCrsIntent(messages,userMessageId);
 if(intent.clear)return null;
 if(intent.crs)return {crs:intent.crs,session:intent.session,source:'humanRequest'};
 const accepted=answeredCrsChoice(messages,userMessageId);
 if(accepted)return {crs:accepted.crs,session:accepted.session,source:'acceptedAnswer'};
 if(intent.needsClarification)return null;
 if(inherited)return {crs:inherited.crs,session:false,source:'existingPlan',planId:inherited.planId};
 const crs=conversationDefault?normalizeExportCrs(conversationDefault):null;
 return crs?{crs,session:true,source:'conversationDefault'}:null;
}

function crsQuestionKind(q:UserInputQuestion):'crs'|'scope'|null {
 if(q.isSecret)return null;
 const text=q.id+' '+q.header+' '+q.question;
 if(/(?:源|输入|原始|地图)(?:数据)?(?:坐标|投影)|(?:source|input|original|map)\s*(?:crs|coordinate|projection)/i.test(text))return null;
 // A bundled choice can include a CRS and still ask for an unknown provider,
 // resolution or format. Reusing the CRS must not answer the other requirements.
 if(/图源|影像源|下载范围|分辨率|缩放|格式|年份|时期|季节|provider|resolution|zoom|format|period|season/i.test(text))return null;
 // Questions about replacing plans or transformation methods remain separate decisions.
 if(/替换|覆盖|共存|删除|保留.*(?:计划|成果)|replace|overwrite|resampl|重采样|七参数|变换参数/i.test(text))return null;
 const scopeLabels=q.options?.map(o=>o.label)??[];
 if(/scope|应用范围|应用方式|apply_mode/i.test(text)){
  return /^export_crs_scope$/i.test(q.id)||scopeLabels.length>0&&scopeLabels.every(label=>/仅(?:本|这)(?:次|个|份)|本次任务|当前(?:会话|对话)默认|this (?:task|export|download)|conversation default|session default/i.test(label))?'scope':null;
 }
 return /坐标系|坐标参考|投影|西安\s*80|北京\s*54|xian[_ ]?(?:19)?80|\bcrs\b|coordinate.*system|projection|(?:target|output|export)[_ ]?crs/i.test(text)?'crs':null;
}

export const hasReusableCrsQuestion=(questions:UserInputQuestion[])=>questions.some(q=>crsQuestionKind(q)!==null);

/** Reuse established facts with provenance; never persist them as newly submitted human answers. */
export function reuseCrsQuestions(questions:UserInputQuestion[],choice:KnownCrsChoice|null){
 const reused:UserInputReply={answers:{}};
 const remaining=questions.filter(q=>{
  const kind=choice?crsQuestionKind(q):null;if(!kind)return true;
  reused.answers[q.id]={answers:[kind==='crs'?choice!.crs:choice!.session?'当前会话默认':'仅本次任务']};return false;
 });
 const knownFacts=Object.keys(reused.answers).length?{targetCrs:choice!.crs,scope:choice!.session?'conversation':'task',source:choice!.source,...(choice!.planId?{planId:choice!.planId}:{}),message:'沿用已明确的成果坐标系，不重复询问；没有新增或修改会话默认。'}:undefined;
 return {remaining,reused,knownFacts};
}

import catalog from '../../../contracts/crs-options.v1.json' with {type:'json'};
import type {UserInputQuestion} from './user-input';

interface CrsEntry {name:string;centralMeridian?:number}
export interface CrsOptionIssue {questionId:string;optionLabel:string;code:string;authorityName:string;claimedCentralMeridian:number;actualCentralMeridian:number}
const entries:Record<string,CrsEntry>=catalog.entries;

/** Check stated facts against a pinned EPSG/PROJ reference, without guessing
 * a projection, choosing an option, or treating unknown codes as invalid. */
export function crsOptionIssues(questions:UserInputQuestion[]):CrsOptionIssue[]{
 const issues:CrsOptionIssue[]=[];
 for(const question of questions){
  if(question.isSecret||!/坐标|投影|\bcrs\b|projection|coordinate/i.test(question.id+' '+question.header+' '+question.question))continue;
  for(const option of question.options??[]){
   const text=option.label+' '+option.description;
   const codes=[...new Set([...text.matchAll(/\bEPSG\s*:\s*(\d{1,5})\b/gi)].map(m=>String(Number(m[1]))))];
   if(codes.length!==1)continue; // Comparative options do not state one CRS.
   const entry=entries[codes[0]];if(entry?.centralMeridian===undefined)continue;
   for(const match of text.matchAll(/(?:\bCM\s*|中央经线\s*(?:为|是|[:：=])?\s*|central\s+meridian\s*(?:is|[:=])?\s*)([+-]?\d+(?:\.\d+)?)\s*(?:°|度)?\s*([EW东西])?/gi)){
    const claimed=match[2]?Math.abs(Number(match[1]))*(/W|西/i.test(match[2])?-1:1):Number(match[1]);
    if(Math.abs(claimed-entry.centralMeridian)<1e-7)continue;
    if(issues.some(i=>i.questionId===question.id&&i.optionLabel===option.label&&i.claimedCentralMeridian===claimed))continue;
    issues.push({questionId:question.id,optionLabel:option.label,code:'EPSG:'+codes[0],authorityName:entry.name,claimedCentralMeridian:claimed,actualCentralMeridian:entry.centralMeridian});
   }
  }
 }
 return issues;
}

/** The model receives actionable corrections; no question or answer is stored. */
export function crsQuestionConflict(questions:UserInputQuestion[]){
 const issues=crsOptionIssues(questions);
 return issues.length?{error:'CRS_OPTION_CONFLICT' as const,issues,reference:{authority:catalog.source.authority,version:catalog.source['EPSG.VERSION']},message:'选项中的 EPSG 编号与中央经线冲突，尚未向用户展示。请按参考名称修正编号或说明，再发起问答；不要替用户选择，也不要使用错误投影继续。'}:null;
}

export class CrsQuestionConflict extends Error {
 readonly code='CRS_OPTION_CONFLICT';
 constructor(conflict:NonNullable<ReturnType<typeof crsQuestionConflict>>){super(JSON.stringify(conflict));this.name='CrsQuestionConflict';}
}

export interface FeedbackResource {id?:string;state:string;verified?:boolean;active?:boolean}
export interface TaskFeedback {status:string;title:string;reason:string;progress:string;retained:string;next:string;canContinue:boolean;code:string;source:'native-runtime';completed:number;running:number}
export function taskReason(code?:string,english?:boolean):{reason:string;next:string;status:string;canContinue:boolean};
export function buildTaskFeedback(input?:{code?:string;resources?:FeedbackResource[];factsKnown?:boolean;unresolved?:number;english?:boolean}):TaskFeedback;
export function taskFeedbackText(feedback:TaskFeedback,english?:boolean):string;

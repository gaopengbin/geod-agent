import {createHash} from 'node:crypto';

export class SponsorError extends Error {
  constructor(status,code){super(code);this.status=status;this.code=code;}
}
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const protocols=['chatCompletions','responses','anthropic','gemini'];
function activityDate(value){
  if(value===undefined||value===null)return null;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('Invalid sponsored activity date');
  const [year,month,day,hour,minute,second]=value.match(/^([\d-]+)T([\d:]+)/)[0].split(/[-T:]/).map(Number);
  const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
  if(month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)throw new Error('Invalid sponsored activity date');
  return new Date(value).toISOString();
}
export function sponsorAvailability(provider,now=Date.now()){
  if(!provider.enabled)return 'disabled';
  if(provider.startsAt&&now<Date.parse(provider.startsAt))return 'scheduled';
  if(provider.endsAt&&now>=Date.parse(provider.endsAt))return 'ended';
  return 'active';
}
function endpoint(value,base=false){
  const url=new URL(value);
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(base&&local&&url.protocol==='http:')))throw new Error('Invalid sponsored provider address');
  return url.href.replace(/\/$/,'');
}

/** Operator-owned configuration. Never accept keys, addresses or audiences from a client. */
export function readSponsors(env){
  const input=JSON.parse(env.GEOD_AGENT_SPONSORS_JSON||'[]');
  if(!Array.isArray(input)||input.length>20)throw new Error('Invalid sponsored providers');
  const ids=new Set();
  return input.map(value=>{
    if(!value||typeof value!=='object'||!text(value.id,40)||!/^[a-z0-9][a-z0-9-]*$/.test(value.id)||ids.has(value.id)||!text(value.name,120)||!Array.isArray(value.allowedUsers)||!value.allowedUsers.length||value.allowedUsers.length>1000||!value.allowedUsers.every(id=>text(id,200))||!Array.isArray(value.models)||!value.models.length||value.models.length>20)throw new Error('Invalid sponsored provider declaration');
    ids.add(value.id);
    if(!/^[A-Z][A-Z0-9_]{0,79}$/.test(value.apiKeyEnv||'')||!text(env[value.apiKeyEnv],8192))throw new Error('Sponsored provider key is not configured');
    const apiKey=env[value.apiKeyEnv],upstreamBase=endpoint(value.baseUrl,true);
    const protocol=value.protocol??'chatCompletions';
    if(!protocols.includes(protocol))throw new Error('Invalid sponsored provider protocol');
    const startsAt=activityDate(value.startsAt),endsAt=activityDate(value.endsAt);
    if(startsAt&&endsAt&&Date.parse(startsAt)>=Date.parse(endsAt))throw new Error('Invalid sponsored activity interval');
    const models=value.models.map(model=>{
      if(!text(model.id,120)||!text(model.name,120)||!integer(model.contextWindow,16000,1000000)||!integer(model.maxOutputTokens,256,32768)||model.maxOutputTokens>=model.contextWindow||![null,undefined,'enabled','disabled','adaptive'].includes(model.thinking)||(model.thinking==='adaptive'&&protocol!=='anthropic')||(protocol==='anthropic'&&model.thinking==='enabled'&&model.maxOutputTokens<=1024)||!Array.isArray(model.inputModalities)||!model.inputModalities.includes('text')||model.inputModalities.some(part=>!['text','image'].includes(part))||new Set(model.inputModalities).size!==model.inputModalities.length)throw new Error('Invalid sponsored model capabilities');
      return {id:model.id,name:model.name,contextWindow:model.contextWindow,maxOutputTokens:model.maxOutputTokens,inputModalities:[...model.inputModalities],thinking:model.thinking??null};
    });
    if(new Set(models.map(model=>model.id)).size!==models.length)throw new Error('Duplicate sponsored models');
    const quotaMode=value.quotaMode??'observe';
    if(!['observe','enforced'].includes(quotaMode)||(quotaMode==='enforced'&&(!integer(value.perUserTokenLimit,1,1000000000)||!integer(value.totalTokenLimit,1,1000000000))))throw new Error('Invalid sponsored quota');
    const budgetPeriod=value.budgetPeriod??'lifetime';
    if(!['lifetime','month'].includes(budgetPeriod))throw new Error('Invalid sponsored budget period');
    if(value.enabled!==undefined&&typeof value.enabled!=='boolean')throw new Error('Invalid sponsored provider state');
    if(value.description!==undefined&&!text(value.description,1024))throw new Error('Invalid sponsored description');
    const website=value.website?endpoint(value.website):null;
    const policy={quotaEnforced:quotaMode==='enforced',perUserTokenLimit:quotaMode==='enforced'?value.perUserTokenLimit:null,totalTokenLimit:quotaMode==='enforced'?value.totalTokenLimit:null};
    // Preserve revisions of existing text/chat campaigns across this upgrade.
    const revision=createHash('sha256').update(JSON.stringify({id:value.id,name:value.name,upstreamBase,models,policy,enabled:value.enabled!==false,allowedUsers:value.allowedUsers,keyHash:createHash('sha256').update(apiKey).digest('hex'),...(protocol==='chatCompletions'?{}:{protocol}),...(startsAt||endsAt?{startsAt,endsAt}:{}),...(budgetPeriod==='month'?{budgetPeriod}:{})})).digest('hex');
    return {id:value.id,name:value.name,description:value.description??'',website,protocol,startsAt,endsAt,models,enabled:value.enabled!==false,allowedUsers:value.allowedUsers,revision,apiKey,upstreamBase,budgetPeriod,...policy};
  });
}
export function visibleSponsor(provider,userId){return provider.allowedUsers.includes('*')||provider.allowedUsers.includes(userId);}
export function sponsorCatalogue(providers,ledger,userId){
  return {sponsors:providers.filter(provider=>visibleSponsor(provider,userId)).map(provider=>({id:provider.id,name:provider.name,description:provider.description,website:provider.website,revision:provider.revision,enabled:provider.enabled,protocol:provider.protocol,startsAt:provider.startsAt,endsAt:provider.endsAt,models:provider.models,billingScope:'sponsored',usage:ledger.sponsorUsage(userId,provider)}))};
}
export function sponsorRoute(providers,input,userId,now=Date.now()){
  if(input==null)return null;
  if(typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['providerId','modelId','revision'].includes(key))||!text(input.providerId,40)||!text(input.modelId,120)||!text(input.revision,64))throw new SponsorError(400,'SPONSOR_INVALID');
  const provider=providers.find(provider=>provider.id===input.providerId);
  if(!provider||!visibleSponsor(provider,userId))throw new SponsorError(404,'SPONSOR_UNAVAILABLE');
  if(!provider.enabled)throw new SponsorError(409,'SPONSOR_DISABLED');
  const availability=sponsorAvailability(provider,now);
  if(availability==='scheduled')throw new SponsorError(409,'SPONSOR_NOT_STARTED');
  if(availability==='ended')throw new SponsorError(409,'SPONSOR_ENDED');
  if(provider.revision!==input.revision)throw new SponsorError(409,'SPONSOR_CHANGED');
  const model=provider.models.find(model=>model.id===input.modelId);
  if(!model)throw new SponsorError(409,'SPONSOR_MODEL_MISSING');
  return {provider,model};
}
/** UTF-8 text bytes conservatively bound text tokens; upstream context remains the upper bound. */
export function sponsorReservation(route,messages,tools){
  // Image tokenization varies by provider. A constrained campaign reserves the
  // model context bound instead of treating base64 bytes as actual token usage.
  if(messages.some(message=>Array.isArray(message.content)&&message.content.some(part=>part.type==='image_url')))return route.model.contextWindow+route.model.maxOutputTokens;
  return Math.min(route.model.contextWindow,Buffer.byteLength(JSON.stringify({messages,tools}),'utf8'))+route.model.maxOutputTokens;
}

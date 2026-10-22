import {sponsorRoute,sponsorAvailability} from './sponsors.mjs';

// This policy is owned by the operator. Client requests cannot enable a free
// campaign or supply the upstream key. Review time is a reminder, not a silent
// switch back to paid inference in the middle of a user's task.
export function readDefaultSponsor(env,providers){
  const id=env.GEOD_AGENT_DEFAULT_SPONSOR_ID;
  if(!id)return null;
  const provider=providers.find(p=>p.id===id);
  const modelId=env.GEOD_AGENT_DEFAULT_SPONSOR_MODEL||provider?.models[0]?.id;
  const reviewAt=env.GEOD_AGENT_DEFAULT_SPONSOR_REVIEW_AT;
  if(!provider||!provider.enabled||!provider.allowedUsers.includes('*')||provider.quotaEnforced||!provider.models.some(m=>m.id===modelId)||!reviewAt||!Number.isFinite(Date.parse(reviewAt)))throw Error('Default sponsor must be public, unlimited and have an explicit review time');
  return {providerId:id,modelId,reviewAt:new Date(reviewAt).toISOString()};
}
export function defaultSponsorRoute(config,userId){
  const policy=config.defaultSponsor;if(!policy)return null;
  const provider=config.sponsors.find(p=>p.id===policy.providerId);
  return sponsorRoute(config.sponsors,{providerId:policy.providerId,modelId:policy.modelId,revision:provider?.revision??'missing'},userId);
}
export function defaultSponsorInfo(config,userId){
  if(!config.defaultSponsor)return null;
  try{
    const route=defaultSponsorRoute(config,userId);
    if(sponsorAvailability(route.provider)!=='active')return null;
    return {providerId:route.provider.id,provider:route.provider.name,model:route.model.id,protocol:route.provider.protocol==='responses'?'responses':'geod-codex-v1',contextWindow:route.model.contextWindow,maxOutputTokens:route.model.maxOutputTokens,inputModalities:route.model.inputModalities,reasoning:route.model.thinking==='enabled',billingScope:'sponsored',quotaEnforced:false,reviewAt:config.defaultSponsor.reviewAt};
  }catch{return null;}
}

import {userProvidedUrl} from './agent-workflow.ts';
import {inputOrigin} from './user-input-records.ts';
import type {DisplayMessage,ExtensionProposal} from './pending-generations';
import type {McpConnector} from './api';
import {AMAP_MCP_URL,mcpProvider,providerSetupProposal,providerCredentialConfigured} from './mcp-provider-presets.ts';
export {AMAP_MCP_URL,AMAP_MCP_DOCS} from './mcp-provider-presets.ts';
/** Only a submitted selection grants its visible, exact endpoint. Drafts and other options grant nothing. */
export function userApprovedMcpUrl(messages:DisplayMessage[],userMessageId:string|undefined,url:string):boolean{
 if(!url||url.length>2048)return false;
 const origin=inputOrigin(messages,userMessageId);
 if(!origin)return false;
 const human=messages.find(m=>m.role==='user'&&m.id===userMessageId);
 if(human&&userProvidedUrl(human.content,url))return true;
 const original=messages.find(m=>m.role==='user'&&m.id===origin);
 if(original&&userProvidedUrl(original.content,url))return true;
 return messages.some(m=>{
  const r=m.userInput;if(r?.status!=='answered'||r.userMessageId!==origin||!r.reply)return false;
  return r.questions.some(q=>{
   if(q.isSecret)return false;
   const answer=r.reply!.answers[q.id]?.answers[0];if(!answer)return false;
   const selected=q.options?.find(o=>o.label===answer);
   return userProvidedUrl(selected?selected.label+' '+selected.description:answer,url);
  });
 });
}
export function amapSetupProposal(id:string):ExtensionProposal{
 return providerSetupProposal(AMAP_MCP_URL,id);
}
/** A settings-page change must update the old transcript card without copying credentials or claiming reachability. */
export function reconcileMcpProposals(messages:DisplayMessage[],connectors:McpConnector[]):DisplayMessage[]{
 let changed=false;
 const next=messages.map(m=>{
  const proposal=m.extensionProposal;if(proposal?.kind!=='mcp')return m;
  const found=connectors.find(c=>c.id===proposal.id||c.url===proposal.detail);if(!found)return m;
  if(found.enabled){changed=true;return {...m,content:`已启用 MCP · ${found.name}`,toolStatus:'success' as const,extensionProposal:undefined};}
  if(proposal.requiresKey&&providerCredentialConfigured(found.url,found)){
   changed=true;return {...m,content:`已保存 MCP · ${found.name}，尚未启用`,extensionProposal:{...proposal,id:found.id,name:found.name,requiresKey:false}};
  }
  return m;
 });return changed?next:messages;
}
/** Recover the previously rejected user selection as an actionable card; never perform a connection here. */
export function restoreMcpSetup(messages:DisplayMessage[]):DisplayMessage[]{
 let human:DisplayMessage|undefined;
 return messages.map(m=>{
  if(m.role==='user')human=m;
  if(m.extensionProposal||m.toolStatus==='success'||m.toolName!=='mcp_connect'||!m.details)return m;
  try{
   const data=JSON.parse(m.details);
   const url=data.arguments?.url,provider=mcpProvider(url);
   if(!provider||data.result?.error!=='MCP_URL_NOT_USER_PROVIDED'||!userApprovedMcpUrl(messages,human?.id,url))return m;
   return {...m,content:provider.name+' · 等待本机配置凭据',extensionProposal:providerSetupProposal(url,'setup-'+m.id)};
  }catch{return m;}
 });
}

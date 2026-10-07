import type {DisplayMessage} from './pending-generations';
import type {McpConnector} from './api';
import {userProvidedUrl} from './agent-workflow.ts';
import type {UserInputQuestion} from './user-input.ts';
/** Only a provider-address fact with one already-saved target can avoid a new question. */
export function knownSavedMcpAddress(questions:UserInputQuestion[],connectors:McpConnector[],humanText:string){
 if(questions.length!==1||/更换|换成|切换|另一个|不同|自建|replace|different|switch/i.test(humanText))return null;
 const q=questions[0];if(q.isSecret||!/(?:MCP|服务|server)/i.test(q.question)||!/(?:地址|endpoint|url)/i.test(q.question)||!q.options?.length)return null;
 const urls=q.options.map(o=>{try{const u=new URL(o.label);return /^https?:$/.test(u.protocol)?u:null;}catch{return null;}});
 if(urls.some(u=>!u)||new Set(urls.map(u=>u!.hostname)).size!==1)return null;
 const matched=connectors.filter(c=>q.options!.some(o=>userProvidedUrl(o.label,c.url)));
 if(matched.length!==1)return null;
 const c=matched[0];return {knownFacts:true,alreadyConfigured:true,connectorId:c.id,name:c.name,url:c.url,enabled:c.enabled,authenticationConfigured:!!(c.queryNames?.length||c.headerNames?.length||c.oauth),source:'nativeSavedConnector',message:'本机已经保存这个连接器的确切地址，无需用户重新选择地址。复用 connectorId 调用 mcp_connect 准备启用确认卡；不能据此自动启用。'};
}
/** Resolve only redundant address questions following an erroneous rejection of an already-saved URL.
 * This is a local fact correction, never a manufactured human answer or an enable approval. */
export function repairSavedMcpHistory(messages:DisplayMessage[],connectors:McpConnector[]):DisplayMessage[]{
 let changed=false,humanId:string|undefined;const failures=new Map<string,{index:number;connector:McpConnector}>();
 const next=messages.map((m,index)=>{
  if(m.role==='user')humanId=m.id;
  if(m.toolName==='mcp_connect'&&m.details){try{const d=JSON.parse(m.details);if(d.result?.error==='MCP_URL_NOT_USER_PROVIDED'&&typeof d.arguments?.url==='string'){
   const connector=connectors.find(c=>c.url===d.arguments.url&&/^https?:\/\//.test(c.url));if(connector&&humanId)failures.set(humanId,{index,connector});
  }}catch{} }
  const r=m.userInput,failed=r?.userMessageId?failures.get(r.userMessageId):undefined;
  if(!r||!failed||!['pending','cancelled'].includes(r.status)||r.questions.length!==1||r.reply||/更换|换成|切换|另一个|不同|自建|replace|different|switch/i.test(r.userText??''))return m;
  const q=r.questions[0];
  if(q.isSecret||!/(?:MCP|服务|server)/i.test(q.question)||!/(?:地址|endpoint|url)/i.test(q.question)||!q.options?.some(o=>userProvidedUrl(o.label+' '+o.description,failed.connector.url)))return m;
  changed=true;const {connector}=failed;
  return {...m,userInput:{...r,status:'resolved' as const,reply:undefined,draft:undefined,resolution:{kind:'existingMcp' as const,connectorId:connector.id,name:connector.name,url:connector.url}}};
 });
 // Make the most recent rejected saved target actionable, keeping its original diagnostic details.
 for(const {index,connector} of failures.values()){
  const m=next[index];if(m.extensionProposal||connector.enabled)continue;
  changed=true;next[index]={...m,content:`已保存 MCP · ${connector.name}，等待确认启用`,extensionProposal:{kind:'mcp',id:connector.id,name:connector.name,detail:connector.url,description:'复用本机保存的地址和认证配置。确认启用前会检查服务工具，不需要再次提供地址或 Key。'}};
 }
 return changed?next:messages;
}

import type {api as NativeApi,McpConnector,RegistryMcpItem} from './api';
import {mcpProvider,providerSetupProposal,providerCredentialConfigured} from './mcp-provider-presets.ts';
import type {ExtensionProposal} from './pending-generations';
const text=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():undefined;
export type McpTarget={item:RegistryMcpItem;connector?:McpConnector}|{error:string;message:string};
/** Saved account configuration and discovered IDs are authoritative; only NEW URLs need human provenance. */
export function resolveMcpTarget(args:Record<string,unknown>,saved:McpConnector[],candidates:Map<string,RegistryMcpItem>,approved:(url:string)=>boolean):McpTarget{
 const connectorId=text(args.connectorId),candidateId=text(args.candidateId),registryName=text(args.registryName),url=text(args.url);
 if(candidateId&&registryName&&candidateId!==registryName)return {error:'MCP_TARGET_CONFLICT',message:'candidateId 与 registryName 不一致，请使用返回的一个候选标识。'};
 const candidate=candidates.get(candidateId??registryName??'');
 if(candidate&&url&&url!==candidate.url)return {error:'MCP_TARGET_CONFLICT',message:'候选标识和 URL 不一致，未连接。'};
 if(connectorId){
  const connector=saved.find(c=>c.id===connectorId);
  if(!connector)return {error:'MCP_CANDIDATE_NOT_FOUND',message:'当前账号未找到此 connectorId。请读取 extensions_list 并使用返回的确切 connectorId，不需要再次询问用户地址。'};
  if(url&&url!==connector.url)return {error:'MCP_TARGET_CONFLICT',message:'connectorId 和 URL 指向不同连接器，未连接。'};
  if(candidate&&candidate.url!==connector.url)return {error:'MCP_TARGET_CONFLICT',message:'候选标识与已保存的 connectorId 不一致，未连接。'};
  return savedTarget(connector);
 }
 const fromUrl=url?saved.find(c=>c.url===url):undefined;
 if(fromUrl)return savedTarget(fromUrl);
 if(candidate){
  const connector=saved.find(c=>c.url===candidate.url);
  return connector?savedTarget(connector):{item:candidate};
 }
 if(url){
  if(url.length>2048||!approved(url))return {error:'MCP_URL_NOT_USER_PROVIDED',message:'此新地址尚未由用户提供或提交选项确认。已保存的连接器可使用 connectorId，无需重新询问地址。'};
  const name=text(args.name)??'用户提供的 MCP';return {item:{name,title:name,description:'用户在当前任务中确认的 MCP 地址',url}};
 }
 return {error:'MCP_CANDIDATE_NOT_FOUND',message:'请使用 extensions_list 返回的 connectorId，或 mcp_registry_search 返回的 candidateId / registryName。不要自行编写标识或再次询问已有连接器的地址。'};
}
function savedTarget(connector:McpConnector):McpTarget{
 if(!/^https?:\/\//.test(connector.url))return {error:'MCP_CONFIG_REVIEW_REQUIRED',message:'这是本机或内置连接器，请在连接器页面核对后启用。'};
 return {connector,item:{name:connector.name,title:connector.name,description:'当前账号已保存的 MCP 连接器',url:connector.url}};
}
export async function prepareMcpConnection(target:Exclude<McpTarget,{error:string}>,conversationId:string,callId:string,client:Pick<typeof NativeApi,'mcpAdd'|'mcpTools'>,existingSetup=false){
 let {connector}=target;const {item}=target;
 const provider=mcpProvider(item.url);
 if(provider&&!providerCredentialConfigured(item.url,connector))return {connected:false,requiresLocalConfiguration:true,message:`已确认 ${provider.name} 官方地址，等待用户在本机配置卡填写 ${provider.label}。不要重复查询目录、询问地址或在聊天中索取凭据。`,...(existingSetup?{existingConfigurationCard:true}:{extensionProposal:providerSetupProposal(item.url,connector?.id??'setup-'+callId)})};
 if(!connector)connector=(await client.mcpAdd(item.title.slice(0,80),item.url)).connectors.find(c=>c.url===item.url);
 if(!connector)return {error:'MCP_ADD_FAILED'};
 try{
  const list=await client.mcpTools(connector.id,conversationId);
  if(!list.tools.length)return {error:'MCP_NO_TOOLS',registered:true,enabled:connector.enabled,connectorId:connector.id};
  if(connector.enabled)return {registered:true,connected:true,enabled:true,connectorId:connector.id,tools:list.tools.map(t=>t.name)};
  return {registered:true,connected:true,enabled:false,connectorId:connector.id,requiresUserReview:true,extensionProposal:{kind:'mcp',id:connector.id,name:connector.name,description:item.description,detail:connector.url,toolNames:list.tools.slice(0,8).map(t=>t.name)} satisfies ExtensionProposal};
 }catch{
  return {error:'MCP_CONNECT_FAILED',registered:true,enabled:connector.enabled,connectorId:connector.id,message:'连接器仍已保存。工具发现失败，请检查服务与网络；如需更换凭据，可打开本机配置。未自动启用，也未删除已保存的 Key。',extensionProposal:{kind:'mcp',id:connector.id,name:connector.name,description:'工具发现失败，请检查服务与网络。已保存的认证信息会复用；仅需更换 Key 时打开本机配置。',detail:connector.url} satisfies ExtensionProposal};
 }
}

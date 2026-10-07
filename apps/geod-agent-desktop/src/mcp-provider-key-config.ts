import type {api} from './api';
import {mcpProvider,validateProviderCredential} from './mcp-provider-presets.ts';
export type CredentialClient=Pick<typeof api,'extensionsList'|'mcpQueryCredentialsSet'|'mcpAdd'|'mcpTools'>&{mcpHeaderCredentialsSet?:(id:string,headers:Record<string,string>)=>Promise<void>};
/** The credential only crosses the local/native adapter, never tool metadata or transcript. */
export async function configureProviderCredential(url:string,name:string,value:string,conversationId:string,client:CredentialClient){
 const provider=mcpProvider(url);if(!provider)throw new Error('不支持此服务的本机凭据表单。');
 const credential=validateProviderCredential(provider,value);
 let connector=(await client.extensionsList()).connectors.find(c=>c.url===url);
 const auth=provider.authentication==='queryKey'?{query:{key:credential}}:{headers:{Authorization:'Bearer '+credential}};
 if(connector){
  if(auth.query)await client.mcpQueryCredentialsSet(connector.id,auth.query);
  else{if(!client.mcpHeaderCredentialsSet)throw new Error('请更新应用后再保存 Token。');await client.mcpHeaderCredentialsSet(connector.id,auth.headers!);}
 }else connector=(await client.mcpAdd(name,url,auth)).connectors.find(c=>c.url===url);
 if(!connector)throw new Error('未能保存连接器，请重试。');
 const tools=await client.mcpTools(connector.id,conversationId);
 if(!tools.tools.length)throw new Error('服务没有返回可用工具，请检查凭据、权限和网络。');
 return {connector,tools};
}

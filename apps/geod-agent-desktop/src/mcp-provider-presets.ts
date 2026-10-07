import type {McpConnector} from './api';
import type {ExtensionProposal} from './pending-generations';
export const AMAP_MCP_URL='https://mcp.amap.com/mcp';
export const AMAP_MCP_DOCS='https://lbs.amap.com/api/mcp-server/create-project-and-key';
export const MAPBOX_MCP_URL='https://mcp.mapbox.com/mcp';
export const MAPBOX_MCP_DOCS='https://account.mapbox.com/access-tokens/';
export interface McpProvider{url:string;name:string;title:string;description:string;label:string;help:string;docs:string;maxLength:number;authentication:'queryKey'|'bearerToken'}
const providers:McpProvider[]=[
 {url:AMAP_MCP_URL,name:'高德地图 MCP',title:'连接高德地图 MCP',description:'填写高德开放平台的 Web 服务 Key，测试后可确认启用。',label:'Web 服务 Key',help:'Key 保存在本机凭据库，不发送给 AI。请使用“Web 服务”类型的 Key。',docs:AMAP_MCP_DOCS,maxLength:32,authentication:'queryKey'},
 {url:MAPBOX_MCP_URL,name:'Mapbox MCP',title:'连接 Mapbox MCP',description:'填写 Mapbox Access Token，测试后可确认启用。',label:'Access Token',help:'Token 保存在本机凭据库，仅发送给 Mapbox 官方服务，不发送给 AI。',docs:MAPBOX_MCP_DOCS,maxLength:4096,authentication:'bearerToken'},
];
export const mcpProvider=(url:string)=>providers.find(p=>p.url===url);
export function providerCredentialConfigured(url:string,connector:McpConnector|undefined){
 if(!connector)return false;
 if(url===AMAP_MCP_URL)return !!connector.queryNames?.includes('key');
 if(url===MAPBOX_MCP_URL)return !!(connector.oauth||connector.headerNames?.some(n=>n.toLowerCase()==='authorization')||connector.runtime?.bearerTokenEnvVar||Object.keys(connector.runtime?.envHttpHeaders??{}).some(n=>n.toLowerCase()==='authorization'));
 return false;
}
export function providerSetupProposal(url:string,id:string):ExtensionProposal{
 const provider=mcpProvider(url);if(!provider)throw new Error('不支持此服务的本机凭据表单。');
 return {kind:'mcp',id,name:provider.name,description:provider.description,detail:url,requiresKey:true};
}
export function validateProviderCredential(provider:McpProvider,value:string){
 const credential=value.trim();
 if(provider.authentication==='queryKey'&&!/^[a-f\d]{32}$/i.test(credential))throw new Error('请输入 32 位高德 Web 服务 Key。');
 if(provider.authentication==='bearerToken'&&(credential.length>provider.maxLength||!/^(?:pk|sk|tk)\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential)))throw new Error('请输入有效的 Mapbox Access Token。');
 return credential;
}

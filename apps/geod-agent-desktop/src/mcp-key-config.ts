import {AMAP_MCP_URL} from './mcp-onboarding.ts';
import type {api} from './api';
import {configureProviderCredential} from './mcp-provider-key-config.ts';
export async function configureMcpKey(name:string,key:string,conversationId:string,client:Pick<typeof api,'extensionsList'|'mcpQueryCredentialsSet'|'mcpAdd'|'mcpTools'>){
 return configureProviderCredential(AMAP_MCP_URL,name,key,conversationId,client);
}

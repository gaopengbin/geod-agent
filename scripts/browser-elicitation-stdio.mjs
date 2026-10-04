import{Server}from'../apps/geod-agent-desktop/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import{StdioServerTransport}from'../apps/geod-agent-desktop/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import{ListToolsRequestSchema,CallToolRequestSchema}from'../apps/geod-agent-desktop/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
import{randomUUID}from'node:crypto';
const server=new Server({name:'geod-browser-stdio-acceptance',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'browser_continue',description:'Native stdio browser flow acceptance',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}));
server.setRequestHandler(CallToolRequestSchema,async()=>{
  try{
    const id=randomUUID(),value=await server.elicitInput({mode:'url',message:'本地 stdio MCP 浏览器流程验收',url:`${process.env.GEOD_BROWSER_FIXTURE}/authorize/${id}`,elicitationId:id});
    if(value.action==='accept')await server.notification({method:'notifications/elicitation/complete',params:{elicitationId:id}});
    return{content:[{type:'text',text:JSON.stringify({transport:'stdio',action:value.action})}]};
  }catch(error){return{isError:true,content:[{type:'text',text:'MCP_USER_REQUIRED: '+error.message}]};}
});
await server.connect(new StdioServerTransport());

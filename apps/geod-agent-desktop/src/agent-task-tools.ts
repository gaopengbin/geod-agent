import {invoke} from "@tauri-apps/api/core";
import declared from "../src-tauri/codex-tools.json";
import type {McpToolList} from "./api";
export interface AgentTask {id:string;conversationId:string;name:string;status:string;readOnly:boolean;createdAt:string;updatedAt:string;runId:string;threadId:string|null;result:string|null;error:string|null;cancelRequested:boolean}
export interface AgentTaskDetails {task:AgentTask;files:{path:string;bytes:number}[];events:Record<string,unknown>[];execution:string}
export const AGENT_TASK_ID="builtin-agent-tasks",AGENT_TASK_FOCUS="geod-agent-task-focus";
const focusByConversation=new Map<string,string>();
export const pendingAgentFocus=(conversationId:string)=>focusByConversation.get(conversationId);
export const agentTasks={
 list:(conversationId:string)=>invoke<{tasks:AgentTask[]}>("agent_tasks_list",{conversationId}),
 get:(conversationId:string,taskId:string)=>invoke<AgentTaskDetails>("agent_tasks_get",{conversationId,taskId}),
 readFile:(conversationId:string,taskId:string,path:string)=>invoke<{path:string;text:string}>("agent_tasks_read_file",{conversationId,taskId,path}),
 cancel:(conversationId:string,taskId:string)=>invoke<AgentTask>("agent_tasks_cancel",{conversationId,taskId}),
};
export const agentTaskTools=():McpToolList=>({connectorId:AGENT_TASK_ID,name:"独立子任务 Agent",tools:declared.filter(t=>t.function.name.startsWith("agent_tasks_")).map(({function:t})=>({name:t.name,description:t.description,inputSchema:t.parameters}))});
export async function executeAgentTaskTool(conversationId:string,name:string,args:Record<string,unknown>,key:string){
 if(name==="agent_tasks_list")return agentTasks.list(conversationId);
 if(name==="agent_tasks_get")return agentTasks.get(conversationId,String(args.taskId));
 if(name==="agent_tasks_read_file")return agentTasks.readFile(conversationId,String(args.taskId),String(args.path));
 if(name==="agent_tasks_cancel")return agentTasks.cancel(conversationId,String(args.taskId));
 if(name!=="agent_tasks_spawn")return{error:"TOOL_NOT_ALLOWED"};
 const task=await invoke<AgentTask>("agent_tasks_spawn",{conversationId,idempotencyKey:key,draft:args});
 focusByConversation.set(conversationId,task.id);
 window.dispatchEvent(new CustomEvent(AGENT_TASK_FOCUS,{detail:{conversationId,taskId:task.id}}));return task;
}

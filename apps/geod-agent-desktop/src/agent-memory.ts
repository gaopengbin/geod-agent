import { invoke } from "@tauri-apps/api/core";
import declared from "../src-tauri/codex-tools.json";
import type { McpToolList } from "./api";
export interface MemoryEntry { id:string;scope:"account"|"workspace";title:string;content:string;enabled:boolean;revision:number;createdAt:string;updatedAt:string }
export interface MemoryPage { entries:MemoryEntry[];total:number;nextOffset:number|null }
export type MemoryDraft = Pick<MemoryEntry,"title"|"content"|"scope"|"enabled"> & {id?:string;expectedRevision?:number};
export const MEMORY_ID="builtin-agent-memory";
export const MEMORY_CHANGED="geod-agent-memory-changed";
export const memory={
  list:(conversationId:string,query?:string,offset?:number)=>invoke<MemoryPage>("agent_memory_list",{conversationId,query,offset}),
  save:(conversationId:string,draft:MemoryDraft)=>invoke<MemoryEntry>("agent_memory_save",{conversationId,draft}),
  remove:(conversationId:string,id:string,expectedRevision:number)=>invoke<{removed:boolean}>("agent_memory_remove",{conversationId,id,expectedRevision}),
};
export const memoryTools=():McpToolList=>({connectorId:MEMORY_ID,name:"偏好与记忆",tools:declared.filter(t=>t.function.name.startsWith("agent_memory_")).map(({function:t})=>({name:t.name,description:t.description,inputSchema:t.parameters}))});
export async function executeMemoryTool(conversationId:string,name:string,args:Record<string,unknown>){
  if(name==="agent_memory_list")return memory.list(conversationId,typeof args.query==="string"?args.query:undefined,typeof args.offset==="number"?args.offset:undefined);
  const result=name==="agent_memory_save"?await memory.save(conversationId,args as unknown as MemoryDraft):name==="agent_memory_remove"?await memory.remove(conversationId,String(args.id),Number(args.expectedRevision)):{error:"TOOL_NOT_ALLOWED"};
  window.dispatchEvent(new CustomEvent(MEMORY_CHANGED));return result;
}

import { invoke } from "@tauri-apps/api/core";
import declared from "../src-tauri/codex-tools.json";
import type { McpToolList } from "./api";
import { dataSchedules } from "./data-schedules";
const catalog = (connectorId:string, name:string, prefix:string):McpToolList => ({connectorId,name,tools:declared.filter(tool=>tool.function.name.startsWith(prefix)).map(({function:tool})=>({name:tool.name,description:tool.description,inputSchema:tool.parameters}))});
export const dataScheduleTools = () => catalog("builtin-data-schedules", "矢量与三维定时下载", "data_schedules_");
export const cacheTools = () => catalog("builtin-cache", "下载缓存核验", "cache_");
export async function executeDataScheduleTool(conversationId:string, name:string, args:Record<string,unknown>, executionId:string) {
  if (name === "data_schedules_create") return dataSchedules.create(conversationId,String(args.taskId),String(args.name),String(args.nextRunAt),typeof args.repeatSeconds === "number" ? args.repeatSeconds : null,executionId);
  if (name === "data_schedules_list") return {schedules:await dataSchedules.list(conversationId),runs:await dataSchedules.runs(conversationId)};
  if (name === "data_schedules_set_enabled") {
    if (!(await dataSchedules.list(conversationId)).some(s=>s.id===args.scheduleId)) throw new Error("定时任务不属于当前会话");
    return dataSchedules.setEnabled(String(args.scheduleId),args.enabled===true,typeof args.nextRunAt === "string" ? args.nextRunAt : undefined);
  }
  if (name === "data_schedules_cancel_run") {
    if (!(await dataSchedules.runs(conversationId)).some(run=>run.id===args.runId)) throw new Error("定时记录不属于当前会话");
    return dataSchedules.cancelRun(String(args.runId));
  }
  throw new Error("未知定时工具");
}
export async function executeCacheTool(name:string,args:Record<string,unknown>) {
  if (name === "cache_inventory") return invoke("cache_inventory");
  if (name === "cache_verify") return {operationId:await invoke<string>("cache_maintenance_start",{action:"verify"}),background:true};
  if (name === "cache_maintenance_status") return invoke(name,{operationId:String(args.operationId)});
  if (name === "cache_maintenance_cancel") {await invoke(name,{operationId:String(args.operationId)});return {cancelRequested:true};}
  throw new Error("未知缓存工具");
}

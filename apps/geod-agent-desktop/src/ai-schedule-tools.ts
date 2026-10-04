import declared from "../src-tauri/codex-tools.json";
import {api,type AgentMessage,type McpToolList} from "./api";
import {modelMessagesWithoutArtifactPaths} from "./model-artifacts";
export const AI_SCHEDULE_ID="builtin-ai-schedules";
export const aiScheduleTools=():McpToolList=>({connectorId:AI_SCHEDULE_ID,name:"AI 定时执行",tools:declared.filter(tool=>tool.function.name.startsWith("ai_schedules_")).map(({function:tool})=>({name:tool.name,description:tool.description,inputSchema:tool.parameters}))});
export async function executeAiScheduleTool(conversationId:string,name:string,args:Record<string,unknown>,key:string,history:AgentMessage[]=[]){
  if(name==="ai_schedules_create")return api.aiSchedulesCreate(conversationId,String(args.name),String(args.prompt),String(args.nextRunAt),typeof args.repeatSeconds==="number"?args.repeatSeconds:null,key,modelMessagesWithoutArtifactPaths(history));
  const overview=await api.aiSchedulesList(conversationId);
  if(name==="ai_schedules_list")return overview;
  if(name==="ai_schedules_set_enabled"){
    if(!overview.schedules.some(s=>s.scheduleId===args.scheduleId))return{error:"SCHEDULE_NOT_IN_CONVERSATION"};
    return api.aiSchedulesSetEnabled(String(args.scheduleId),args.enabled===true,typeof args.nextRunAt==="string"?args.nextRunAt:undefined);
  }
  if(!overview.runs.some(r=>r.runId===args.runId))return{error:"RUN_NOT_IN_CONVERSATION"};
  if(name==="ai_schedules_run_events")return api.aiSchedulesRunEvents(String(args.runId));
  if(name==="ai_schedules_cancel_run")return api.aiSchedulesCancelRun(String(args.runId));
  if(name==="ai_schedules_retry_run")return api.aiSchedulesRetryRun(String(args.runId));
  return{error:"TOOL_NOT_ALLOWED"};
}

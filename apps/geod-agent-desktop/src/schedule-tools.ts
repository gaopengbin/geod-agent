import declared from '../src-tauri/codex-tools.json';
import type { McpToolList } from './api';
export const SCHEDULE_CONNECTOR_ID='builtin-schedules';
export function scheduleTools():McpToolList {
 return {connectorId:SCHEDULE_CONNECTOR_ID,name:'本机定时任务 · local imagery schedules',tools:declared.filter(tool=>tool.function.name.startsWith('schedules_')).map(({function:tool})=>({name:tool.name,description:tool.description,inputSchema:tool.parameters}))};
}

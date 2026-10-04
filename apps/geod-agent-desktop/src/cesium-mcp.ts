import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateCesiumToolInput } from 'cesium-mcp-contracts';
import { CESIUM_ID, cesiumToolDefinitions } from './cesium-tool-definitions.ts';
import type { McpToolList } from './api';

export { CESIUM_ID, CESIUM_CONNECTOR } from './cesium-tool-definitions.ts';
const key = 'geod-cesium-mcp-enabled-1';
export function cesiumEnabled() { return localStorage.getItem(key) !== 'false'; }
export function setCesiumEnabled(enabled: boolean) { localStorage.setItem(key, String(enabled)); }
type Execute = (name: string, args: Record<string, unknown>) => Promise<unknown>;
let scene: { conversationId: string; execute: Execute } | null = null;
let view: { conversationId: string; execute: Execute } | null = null;
const hostTools = new Set(['getViewMode', 'setViewMode', 'closeScene']);

/** The workspace owns view switching; it stays callable when Cesium is hidden. */
export function attachCesiumView(conversationId: string, execute: Execute) {
  const owned = { conversationId, execute };
  view = owned;
  return () => { if (view === owned) view = null; };
}

/** Viewer ownership stays with React; the bridge is restricted to that conversation. */
export function attachCesium(conversationId: string, execute: Execute) {
  const owned = { conversationId, execute };
  scene = owned;
  return () => { if (scene === owned) scene = null; };
}

const server = new Server({ name: 'cesium-mcp', version: '1.146.0' }, { capabilities: { tools: {} } });
const client = new Client({ name: 'geod-agent-desktop', version: '0.1.0' });
// The conversation is carried inside the local MCP request metadata, never tool schema.
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: cesiumToolDefinitions }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request.params.name, args = request.params.arguments ?? {};
  const conversationId = request.params._meta?.conversationId;
  let result: unknown;
  if (!cesiumEnabled()) result = { success: false, error: 'CESIUM_DISABLED', message: '请启用 Cesium MCP' };
  else if (!cesiumToolDefinitions.some(tool => tool.name === name)) result = { success: false, error: 'UNKNOWN_SCENE_TOOL', availableTools: cesiumToolDefinitions.map(tool => tool.name) };
  else {
    const contractArgs = { ...args };
    if (name === 'loadTerrain') delete contractArgs.connectionId;
    const validation = validateCesiumToolInput(name, contractArgs);
    if (name === 'setViewMode' && args.mode !== '2d' && args.mode !== '3d') result = { success: false, error: 'INVALID_VIEW_MODE', message: 'mode 应为 2d 或 3d' };
    else if (name === 'loadTerrain' && args.connectionId !== undefined && (typeof args.connectionId !== 'string' || !args.connectionId)) result = { success: false, error: 'INVALID_TERRAIN_CONNECTION' };
    else if (validation.knownTool && !validation.valid) result = { success: false, error: 'INVALID_SCENE_ARGUMENTS', issues: validation.issues };
    else {
      const hostTool = hostTools.has(name);
      const owned = hostTool ? view : scene;
      if (!owned || owned.conversationId !== conversationId) result = name === 'getSceneState'
        ? { success: true, data: { opened: false, scene: 'Cesium', next: 'data_download_load(taskId)' } }
        : hostTool ? { success: false, error: 'VIEW_NOT_AVAILABLE', message: '当前对话地图工作区未打开' }
        : { success: false, error: 'SCENE_NOT_OPEN', message: '当前对话三维场景尚未打开，请先用 data_download_load 打开已完成的三维任务。' };
      else {
        try {
          result = await owned.execute(name, args);
          if (name === 'getSceneState' && view?.conversationId === conversationId && result && typeof result === 'object' && 'data' in result) {
            const state = await view.execute('getViewMode', {}) as { data?: { mode: string } };
            result = { ...result, data: { ...(result.data as object), viewMode: state.data?.mode, visible: state.data?.mode === '3d' } };
          }
          if ((hostTool ? view : scene) !== owned) result = { success: false, error: 'SCENE_SESSION_CHANGED', message: '三维场景或对话已切换' };
        } catch (cause) { result = { success: false, error: cause instanceof Error ? cause.message : String(cause) }; }
      }
    }
  }
  const failed = !!result && typeof result === 'object' && 'success' in result && result.success === false;
  return { isError: failed, content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
});
let ready: Promise<void> | null = null;
function connect() {
  if (!ready) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    ready = (async () => { await server.connect(serverTransport); await client.connect(clientTransport); })();
  }
  return ready;
}
// Schemas are discoverable even before opening a scene, so the AI can find its tools.
export async function cesiumTools(_conversationId: string): Promise<McpToolList> {
  await connect();
  return { connectorId: CESIUM_ID, name: 'Cesium MCP · 三维场景 / 相机 / 底图 / 图层 / 对象 · 3D viewer scene camera basemap globe', tools: (await client.listTools()).tools };
}
export async function cesiumCall(conversationId: string, name: string, args: Record<string, unknown>) {
  await connect();
  const result = await client.callTool({ name, arguments: args, _meta: { conversationId } });
  const content = result.content as { type: string; text?: string }[];
  const text = content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  try { return JSON.parse(text) as unknown; } catch { return { success: false, error: text || 'SCENE_TOOL_FAILED' }; }
}

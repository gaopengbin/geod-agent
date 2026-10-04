import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { registerOpenLayersDefinitions } from "./openlayers-tool-definitions";
import type { McpToolList } from "./api";

export const OPENLAYERS_ID = "builtin-openlayers-mcp";
export const OPENLAYERS_CONNECTOR = { id: OPENLAYERS_ID, name: "OpenLayers MCP", url: "当前对话地图", enabled: true, transport: "embedded" as const };
const ENABLED_KEY = "geod-openlayers-mcp-enabled-1";
export function openLayersEnabled() { return localStorage.getItem(ENABLED_KEY) !== "false"; }
export function setOpenLayersEnabled(value: boolean) { localStorage.setItem(ENABLED_KEY, String(value)); }
type Execute = (name: string, args: Record<string, unknown>) => Promise<unknown>;
let session: { conversationId: string; client: Client; ready: Promise<void> } | null = null;

/** Real MCP Client/Server messages use a local transport in the WebView. The
 * original browser bridge handles commands, and no background console is needed. */
export function attachOpenLayers(conversationId: string, execute: Execute) {
  const server = new McpServer({ name: "openlayers-mcp", version: "0.2.0" });
  const client = new Client({ name: "geod-agent-desktop", version: "0.1.0" });
  const invoke = async (name: string, args: Record<string, unknown>) => {
    try {
      const data = await execute(name, args);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    } catch (cause) {
      return { isError: true, content: [{ type: "text" as const, text: cause instanceof Error ? cause.message : String(cause) }] };
    }
  };
  registerOpenLayersDefinitions((name, description, schema) => {
    if (name === "addTileLayer") description += " 已在 GeoD 配置的图源优先使用 loadSource。";
    server.tool(name, description, schema, args => invoke(name, args));
  });
  server.tool("loadSource", "加载本机已配置的图源到当前对话地图。使用 sources_list 返回的 sourceId，无需用户手填地址。支持 XYZ/TMS 和 ImageServer。返回图层 ID 与实际加载状态；这是交互式地图预览。", {
    sourceId: z.string(), opacity: z.number().min(0).max(1).optional(),
  }, args => invoke("loadSource", args));
  server.tool("loadArtifact", "把已下载并核验的本地 GeoTIFF 成果加载到当前地图。使用 jobs_list/artifacts_inspect 返回的 jobId；本机解析文件路径，不需要模型读取本地文件或猜接口。可指定清单中的 assetId、图层名称、透明度和是否定位。读取实际 GeoTIFF 原始像素，返回图层 ID、数据尺寸和实际状态。", {
    jobId: z.string(), assetId: z.string().optional(), name: z.string().optional(),
    opacity: z.number().min(0).max(1).optional(), fit: z.boolean().optional(),
  }, args => invoke("loadArtifact", args));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const owned = { conversationId, client, ready: (async () => { await server.connect(serverTransport); await client.connect(clientTransport); })() };
  // A development StrictMode unmount may close a session during its handshake.
  // Callers still receive the rejection when awaiting ready.
  void owned.ready.catch(() => {});
  session = owned;
  return () => { if (session === owned) session = null; void client.close(); void server.close(); };
}

async function currentSession(conversationId: string, inspecting = false) {
  if (!inspecting && !openLayersEnabled()) throw new Error("OPENLAYERS_DISABLED: 请启用 OpenLayers MCP");
  const owned = session;
  if (!owned || owned.conversationId !== conversationId) throw new Error("MAP_NOT_READY: 当前对话地图尚未就绪");
  await owned.ready;
  if (session !== owned) throw new Error("MAP_SESSION_CHANGED: 对话已切换");
  return owned;
}
export async function openLayersTools(conversationId: string): Promise<McpToolList> {
  const owned = await currentSession(conversationId, true);
  const result = await owned.client.listTools();
  return { connectorId: OPENLAYERS_ID, name: "OpenLayers MCP · 当前对话地图", tools: result.tools };
}
export async function openLayersCall(conversationId: string, name: string, args: Record<string, unknown>) {
  const owned = await currentSession(conversationId);
  const { tools } = await owned.client.listTools();
  if (!tools.some(tool => tool.name === name)) return {
    error: "UNKNOWN_MAP_TOOL", connectorId: OPENLAYERS_ID, requestedTool: name,
    message: "工具名称不在当前地图 MCP 中，请使用已发现的准确名称和参数。",
    availableTools: tools.map(tool => tool.name), next: "extensions_list(query: OpenLayers)",
  };
  const result = await owned.client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).filter(item => item.type === "text").map(item => item.text).join("\n");
  if (result.isError) return { error: "MAP_TOOL_FAILED", message: text };
  try { return JSON.parse(text) as unknown; } catch { return { text }; }
}

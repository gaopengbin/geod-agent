import { invoke } from "@tauri-apps/api/core";
import type { McpToolList } from "./api";
import declared from "../src-tauri/codex-tools.json";
export const TILES3D_CONNECTION_ID = "builtin-tiles3d-connections";
export const TILES3D_CONNECTION_OPEN = "geod-tiles3d-connection-open";
export const tiles3dConnectionTools = ():McpToolList => ({connectorId:TILES3D_CONNECTION_ID,name:"三维服务连接",tools:declared.filter(t=>t.function.name.startsWith("tiles3d_connection")).map(({function:tool})=>({name:tool.name,description:tool.description,inputSchema:tool.parameters}))});
export function openTiles3dConnection(connectionId?:string) {window.dispatchEvent(new CustomEvent(TILES3D_CONNECTION_OPEN,{detail:{connectionId}}));}
export async function executeTiles3dConnectionTool(name:string,args:Record<string,unknown>) {
  if (name === "tiles3d_connections_list") return {connections:await invoke(name)};
  if (name === "tiles3d_connection_test") return invoke(name,{connectionId:String(args.connectionId)});
  if (name === "tiles3d_connection_prepare") {
    return invoke(name,{draft:{name:args.name,kind:args.kind,...(typeof args.tilesetUrl==="string"?{tilesetUrl:args.tilesetUrl}:{}),...(typeof args.assetId==="number"?{assetId:args.assetId}:{}),requiredHeaders:args.requiredHeaders??[]}});
  }
  throw new Error("未知三维连接工具");
}

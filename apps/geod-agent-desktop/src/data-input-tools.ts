import { api, type DataInputRequest, type DataConnectionResult, type DataConnectionDraft, type DataConnectionRequest, type BoundaryImport, type McpToolList } from "./api";
import type { SqlConnectionDraft, SqlConnectionResult } from "./api";
import sqlTools from "./sql-tools.json";
import selectionTools from "../../../packages/codex-protocol/data-selection-tools.json";

export const DATA_INPUT_ID = "builtin-data-input";
export function dataInputTools(): McpToolList {
  return { connectorId: DATA_INPUT_ID, name: "文件 / 在线数据 / 数据库", tools: [
    ...sqlTools,
    { name: "online_connections_list", description: "List saved online vector service connections by ID and name. Credentials stay native. Use online_services_discover before choosing a service layer.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "online_services_discover", description: "Discover actual WFS 1.0/1.1/2.0 capability layers, CRS and output formats, ArcGIS service layers/fields or OGC API Features collections. A WFS URL containing typeName/typeNames also returns DescribeFeatureType fields. Use one public url or saved onlineConnectionId. Use the returned actual layer name when reading a service. Does not import geometry.", inputSchema: { type: "object", properties: { url: {type:"string"}, onlineConnectionId: {type:"string"} }, additionalProperties:false } },
    { name: "data_connections_list", description: "List saved PostgreSQL/PostGIS connections by ID and name; no credentials. Use data_connection_connect to create a connection from the conversation.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "data_connection_connect", description: "Connect to PostgreSQL/PostGIS, test access, save a connection and discover actual tables and spatial layers. Supply a user-provided workspace-relative credentialFile (JSON with host, port, database, user, password, sslMode, optional name), or host/database/user with optional name/port/sslMode. A required password opens native authentication and the tool waits for completion; never ask for passwords in chat or read the credential file through shell tools. Returns a stable connection ID and actual tables and layers. Reuse existing connections when appropriate. Client TLS identities can be selected locally as PEM certificate/key pairs or PFX/P12 bundles. User-managed credentialFile can include base64 sslClientBundle and sslClientKeyPassword; never supply these secret fields as model arguments.", inputSchema: { type: "object", properties: { credentialFile: { type: "string" }, name: { type: "string" }, host: { type: "string" }, port: { type: "integer", minimum: 1, maximum: 65535 }, database: { type: "string" }, user: { type: "string" }, sslMode: { type: "string", enum: ["disable", "prefer", "require", "verify-ca", "verify-full"] } }, additionalProperties: false } },
    ...selectionTools,
  ] };
}
export async function readDataInput(conversationId: string, args: Record<string, unknown>) {
  const request: DataInputRequest = Object.fromEntries(["url", "relativePath", "connectionId", "onlineConnectionId", "bounds", "filters", "maxFeatures", "pageSize", "handle", "layer", "sourceCrs"].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
  return api.dataInputRead(conversationId, request);
}

export async function executeDataInputTool(conversationId: string, tool: string, args: Record<string, unknown>, handlers: { attach?: (boundary: BoundaryImport) => void | Promise<void>; authenticate?: (draft: Omit<DataConnectionDraft, "password">) => Promise<DataConnectionResult>; authenticateSql?: (draft:SqlConnectionDraft)=>Promise<SqlConnectionResult> } = {}) {
  if(tool === "sql_connections_list")return {connections:(await api.sqlConnectionsList()).connections.map(({id,name,kind})=>({id,name,kind,readOnly:true}))};
  if(tool === "sql_connection_connect"){
    let value=await api.sqlConnectionConnect(conversationId,args);
    if(["INPUT_AUTH_REQUIRED","INPUT_AUTH_CONFIG","INPUT_TLS_FAILED","INPUT_TLS_KEY_PASSWORD_REQUIRED","INPUT_TLS_KEY_PASSWORD_INCORRECT","INPUT_TLS_BUNDLE_PASSWORD_REQUIRED","INPUT_TLS_BUNDLE_OPEN_FAILED","INPUT_TLS_BUNDLE_INVALID","INPUT_TLS_INVALID"].includes(value.error?.code??"") && value.authentication && handlers.authenticateSql)value=await handlers.authenticateSql(value.authentication);
    const {authentication:_,...result}=value;
    return {...result,connection:value.connection?{id:value.connection.id,name:value.connection.name,kind:value.connection.kind,readOnly:true}:undefined};
  }
  if(tool === "sql_objects_search" || tool === "sql_query"){
    if(typeof args.connectionId !== "string")throw new Error("需要已保存的数据库连接");
    if(tool === "sql_query"){if(typeof args.sql !== "string")throw new Error("需要 SQL 查询");return api.sqlQuery(args.connectionId,args.sql);}
    const {connectionId,...request}=args;return api.sqlObjectsSearch(connectionId,request);
  }
  if (tool === "online_connections_list") return { connections: (await api.onlineConnectionsList()).map(({id,name})=>({id,name})) };
  if (tool === "online_services_discover") return api.onlineServicesDiscover(typeof args.url === "string" ? args.url : undefined,typeof args.onlineConnectionId === "string" ? args.onlineConnectionId : undefined);
  if (tool === "data_connections_list") return { connections: (await api.dataConnectionsList()).map(({ id, name, databaseType }) => ({ id, name, type: databaseType ?? "PostGIS", readOnly: true })) };
  if (tool === "data_connection_connect") {
    const request: DataConnectionRequest = Object.fromEntries(["credentialFile", "name", "host", "port", "database", "user", "sslMode"].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
    const value = await api.dataConnectionConnect(conversationId, request);
    if (["INPUT_AUTH_REQUIRED","INPUT_TLS_FAILED","INPUT_TLS_KEY_PASSWORD_REQUIRED","INPUT_TLS_KEY_PASSWORD_INCORRECT","INPUT_TLS_BUNDLE_PASSWORD_REQUIRED","INPUT_TLS_BUNDLE_OPEN_FAILED","INPUT_TLS_BUNDLE_INVALID","INPUT_TLS_INVALID"].includes(value.error?.code??'') && value.authentication && handlers.authenticate) return handlers.authenticate(value.authentication);
    const { authentication: _, ...result } = value;
    return result;
  }
  if (tool === "data_layer_inspect") {
    if (typeof args.connectionId !== "string" || typeof args.layer !== "string") return { error: { code: "INPUT_INVALID", message: "需要连接和图层" } };
    return api.dataLayerInspect(args.connectionId, args.layer, typeof args.limit === "number" ? args.limit : 5,Object.fromEntries(["filters","bounds","maxFeatures"].filter(k=>args[k]!==undefined).map(k=>[k,args[k]])));
  }
  if (tool === "data_input_read") {
    const result = await readDataInput(conversationId, args);
    const saved = result.boundary ? await api.boundariesSave(conversationId, result.boundary) : undefined;
    if (saved) await handlers.attach?.(saved);
    return { ...result, boundary: saved ? { boundaryId: saved.boundaryId, name: saved.name, bounds: saved.bounds, polygonCount: saved.polygonCount, attachedToDesktopPlan: true } : undefined };
  }
  return { error: "TOOL_NOT_FOUND" };
}

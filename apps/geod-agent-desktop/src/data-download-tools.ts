import declared from "../src-tauri/codex-tools.json";
import { api, type McpToolList } from "./api";
import { compactDataTask, dataDownloads, dataDownloadChanged, focusDataTask, previewDataTask } from "./data-downloads";
export const DATA_DOWNLOAD_ID = "builtin-data-downloads";
export function dataDownloadTools(): McpToolList { return { connectorId: DATA_DOWNLOAD_ID, name: "矢量与三维数据下载", tools: declared.filter(t => t.function.name.startsWith("data_download_")).map(({function:tool}) => ({name:tool.name,description:tool.description,inputSchema:tool.parameters})) }; }
export async function executeDataDownloadTool(conversationId: string, name: string, args: Record<string, unknown>, executionId: string,waitForApproval?:(check:()=>Promise<boolean>)=>Promise<void>) {
  const workspace = await api.workspaceGet(conversationId);
  if (name === "data_download_plan") {
    const kind = String(args.kind), title = typeof args.name === "string" ? args.name.trim() : "";
    if (!["mvt", "osm", "tiles3d", "online", "boundary"].includes(kind) || !title) throw new Error("请选择数据类型并提供明确的任务名称");
    const boundary = typeof args.boundaryId === "string" ? await api.boundariesGet(conversationId, args.boundaryId) : null;
    const bounds = boundary?.bounds ?? args.bounds;
    const sourceUrl = typeof args.sourceUrl === "string" ? args.sourceUrl : kind === "osm" ? "https://maps.mail.ru/osm/tools/overpass/api/interpreter" : undefined;
    const connectionId = typeof args.connectionId === "string" ? args.connectionId : undefined;
    const onlineConnectionId = typeof args.onlineConnectionId === "string" ? args.onlineConnectionId : undefined;
    if (kind !== "osm" && kind !== "boundary" && !sourceUrl && !(["tiles3d","mvt"].includes(kind) && connectionId) && !(kind === "online" && onlineConnectionId)) throw new Error("请提供实际数据服务地址或已保存的连接");
    const request = ["online","boundary"].includes(kind) ? {kind:"online",spec:{...(typeof args.sourceBoundaryId==="string"?{sourceBoundaryId:args.sourceBoundaryId}:{}),...(typeof args.dissolve==="boolean"?{dissolve:args.dissolve}:{}),...(sourceUrl?{sourceUrl}:{}),...(onlineConnectionId?{onlineConnectionId}:{}),...(bounds?{bounds}:{}),...(boundary?{boundary:boundary.geometry}:{}),...(typeof args.layer==="string"?{layer:args.layer}:{}),...(typeof args.sourceCrs==="string"?{sourceCrs:args.sourceCrs}:{}),...(typeof args.targetCrs==="string"?{targetCrs:args.targetCrs}:{}),maxFeatures:args.maxFeatures??10000,pageSize:args.pageSize??500,outputs:args.outputFormats??["geojson","gpkg"]}} : kind === "tiles3d" ? { kind, spec: { ...(sourceUrl ? { tilesetUrl: sourceUrl } : {}), ...(connectionId ? { connectionId } : {}), ...(bounds ? { bounds } : {}), ...(boundary ? { boundary: boundary.geometry } : {}) } } : {
      kind: "vector", spec: { ...(connectionId?{connectionId}:{}), source: kind === "mvt" ? { type: "mvt", id: "agent-mvt", name: title, urlTemplate: sourceUrl ?? "https://connection.invalid/{z}/{x}/{y}.pbf", scheme: "xyz", layers: args.layers ?? [] } : { type: "osm", id: "openstreetmap", name: title, endpoint: sourceUrl, tags: args.tags ?? [] },
        targetCrs: args.targetCrs, bounds, ...(boundary ? { boundary: boundary.geometry } : {}), zoomLevels: args.zoomLevels ?? [], outputs: args.outputFormats ?? ["geojson", "gpkg"], allowPartial: args.allowPartial ?? false }
    };
    const task = await dataDownloads.plan(conversationId, title, executionId, request);
    dataDownloadChanged(conversationId, task.id); focusDataTask(conversationId, task.id);
    return { ...compactDataTask(task), permission: workspace.permission, requiresPlanConfirmation: ["pending","failed","cancelled","interrupted"].includes(task.status) && workspace.permission !== "fullAccess", bounds, outputFormats: args.outputFormats ?? (kind === "tiles3d" ? ["3dtiles"] : ["geojson", "gpkg"]) };
  }
  if (name === "data_download_list") return { tasks: (await dataDownloads.list(conversationId)).map(compactDataTask) };
  const id = args.taskId;
  if (typeof id !== "string" || !id) throw new Error("请提供当前会话实际任务编号");
  if(name==="data_download_start"&&workspace.permission!=="fullAccess"&&waitForApproval){
    const planned=await dataDownloads.get(conversationId,id);
    if(planned.planHash!==args.planHash)throw new Error("计划参数已变化，请重新查看计划");
    focusDataTask(conversationId,id);
    await waitForApproval(async()=>{const current=await dataDownloads.get(conversationId,id);if(current.planHash!==planned.planHash||current.cleaned||current.status==="discarded")throw new Error("计划已变化或取消");return ["queued","downloading","verifying","completed","partial"].includes(current.status)||(current.updatedAt!==planned.updatedAt&&current.status!=="pending");});
    const task=await dataDownloads.get(conversationId,id);return compactDataTask(task);
  }
  if (name === "data_download_load") return previewDataTask(conversationId, await dataDownloads.get(conversationId, id));
  const task = name === "data_download_get" ? await dataDownloads.get(conversationId, id)
    : name === "data_download_start" ? await dataDownloads.start(conversationId, id, typeof args.planHash === "string" ? args.planHash : "")
    : name === "data_download_cancel" ? await dataDownloads.cancel(conversationId, id)
    : name === "data_download_discard" ? await dataDownloads.discard(conversationId, id)
    : name === "data_download_cleanup" ? await dataDownloads.cleanup(conversationId,id,args.action as 'clean'|'restore')
    : name === "data_download_inspect" ? await dataDownloads.inspect(conversationId, id) : null;
  if (!task) throw new Error("数据下载工具不存在");
  dataDownloadChanged(conversationId, task.id); return compactDataTask(task);
}

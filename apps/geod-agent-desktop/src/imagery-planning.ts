import { api, type BoundaryImport, type Bounds, type ExportOptions, type OutputFormat, type StoredPlan, type TaskSpec, type WorkspaceSettings } from "./api";

export function compactPlan(stored: StoredPlan, permission: WorkspaceSettings["permission"] = "confirmEach") {
  const plan = stored.plan;
  return { permission, requiresPlanConfirmation: permission !== "fullAccess", canStartWithoutPlanConfirmation: permission === "fullAccess", planId: stored.planId, planHash: plan.planHash, source: plan.sourceName, bounds: plan.spec.bounds, boundary: plan.spec.boundary ? `${plan.spec.boundary.polygons.length} 个面；GeoTIFF 按边界透明裁剪，MBTiles 保留整瓦片` : null, zoomLevels: plan.spec.zoomLevels, outputFormats: plan.spec.outputFormats, targetCrs: plan.spec.exportOptions?.targetCrs ?? "EPSG:3857", resampling: plan.spec.exportOptions?.resampling ?? "nearest", outputLocation: "当前本机工作区中的新文件夹，模型不可读取路径", totalTiles: plan.totalTiles, decodedRgbaBytes: plan.decodedRgbaBytes, requiredFreeDiskBytes: plan.requiredFreeDiskBytes, license: plan.license, attribution: plan.attribution, expiresAt: plan.expiresAt, execution: permission === "fullAccess" ? "可调用 jobs_start；本机将验证工作区完全访问授权及计划路径" : "需要用户点击聊天里的任务入口，在右侧任务面板确认" };
}

export interface ImageryPlanResult { plans: { stored: StoredPlan; rangeName?: string }[]; errors: { boundaryId?: string; name?: string; error: unknown }[] }
const invalid = (message: string): never => { throw { code: "INVALID_PLAN_ARGUMENTS", message }; };
const rangeTitle = (value: string) => value.replace(/\.(geojson|json)$/i, "").replace(/-AreaCity-\d{8}$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 70);

export function requestedZoomLevels(args: Record<string, unknown>, min: number, max: number): number[] {
  const selectors = [args.zoom !== undefined, args.zoomLevels !== undefined, args.zoomMin !== undefined || args.zoomMax !== undefined].filter(Boolean).length;
  if (selectors !== 1) return invalid("请使用 zoom、zoomLevels 或 zoomMin/zoomMax 中的一种指定缩放级别");
  let levels: unknown[];
  if (args.zoomLevels !== undefined) {
    if (!Array.isArray(args.zoomLevels) || !args.zoomLevels.length || args.zoomLevels.length > 23) return invalid("zoomLevels 需要 1–23 个有效级别");
    levels = args.zoomLevels;
  } else if (args.zoom !== undefined) levels = [args.zoom];
  else {
    if (typeof args.zoomMin !== "number" || typeof args.zoomMax !== "number" || !Number.isInteger(args.zoomMin) || !Number.isInteger(args.zoomMax) || args.zoomMin < min || args.zoomMax > max || args.zoomMin > args.zoomMax) return invalid("缩放区间需要有效的 zoomMin 和 zoomMax");
    levels = Array.from({ length: args.zoomMax - args.zoomMin + 1 }, (_, i) => (args.zoomMin as number) + i);
  }
  if (!levels.every(value => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max)) return invalid(`图源支持 Z${min}–Z${max}，请核对缩放级别`);
  return [...new Set(levels as number[])].sort((a, b) => a - b);
}

export function requestedExportOptions(value: unknown): ExportOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("exportOptions 必须为导出参数对象");
  const options = value as Record<string, unknown>;
  if (Object.keys(options).some(key => !["compression", "buildPyramid", "generateSidecars", "jpegQuality", "elevationEncoding", "targetCrs", "resampling"].includes(key))) return invalid("导出参数包含不支持的字段");
  if (options.elevationEncoding !== undefined && options.elevationEncoding !== "terrarium") return invalid("高程编码目前支持 Terrarium");
  if (options.compression !== undefined && !["none", "lzw", "deflate"].includes(String(options.compression))) return invalid("压缩支持 none、lzw、deflate");
  if (["buildPyramid", "generateSidecars"].some(key => options[key] !== undefined && typeof options[key] !== "boolean")) return invalid("金字塔和辅助文件选项必须为布尔值");
  if (options.jpegQuality !== undefined && (typeof options.jpegQuality !== "number" || !Number.isInteger(options.jpegQuality) || options.jpegQuality < 1 || options.jpegQuality > 100)) return invalid("JPEG 质量需要为 1–100 的整数");
  if (options.targetCrs !== undefined && typeof options.targetCrs !== "string") return invalid("目标坐标系需要 EPSG 编号");
  if (options.resampling !== undefined && !["nearest", "bilinear", "cubic"].includes(String(options.resampling))) return invalid("请选择有效的重采样方式");
  return { ...options } as ExportOptions;
}

/** Planning is native and deterministic. This module never starts downloads. */
export async function planImagery(args: Record<string, unknown>, conversationId: string, executionId: string, activeBoundary: BoundaryImport | null, batch = false): Promise<ImageryPlanResult> {
  const sources = await api.sourcesList();
  const source = sources.find(item => item.id === args.sourceId);
  const formats = args.outputFormats;
  if (!source || !Array.isArray(formats) || !formats.length || !formats.every(f => ["geotiff", "mbtiles", "png", "jpeg", "gpkg", "tiles"].includes(String(f)))) return invalid("请提供已注册图源、有效缩放和输出格式");
  const zoomLevels = requestedZoomLevels(args, source.minZoom, source.maxZoom);
  let exportOptions = requestedExportOptions(args.exportOptions);
  if (source.elevationEncoding) exportOptions = { ...exportOptions, elevationEncoding: source.elevationEncoding };
  if (args.overlaySourceIds !== undefined) {
    if (!Array.isArray(args.overlaySourceIds) || args.overlaySourceIds.length > 4 || !args.overlaySourceIds.every(id => typeof id === "string")) return invalid("注记需要最多四个已配置图源 ID");
    const refs = [...new Set(args.overlaySourceIds as string[])].map(id => {
      const overlay = sources.find(item => item.id === id);
      if (!overlay || id === source.id || overlay.tileSize !== source.tileSize || zoomLevels.some(z => z < overlay.minZoom || z > overlay.maxZoom)) return invalid("注记图源不存在，或瓦片大小、级别不匹配");
      return { sourceId: id, configRevision: overlay.configRevision };
    });
    exportOptions = { ...exportOptions, overlaySources: refs };
  }
  let ranges: (BoundaryImport | null)[];
  if (batch) {
    if (!Array.isArray(args.boundaryIds) || !args.boundaryIds.length || args.boundaryIds.length > 32 || !args.boundaryIds.every(id => typeof id === "string" && id)) return invalid("批量规划需要已保存范围的 boundaryIds");
    if (args.mode !== "merge" && args.mode !== "split") return invalid("请选择 merge 合并裁剪或 split 分区任务");
    const ids = [...new Set(args.boundaryIds as string[])];
    // Resolve every ID before creating any plans, preventing partial input loss.
    const resolved = await Promise.all(ids.map(id => api.boundariesGet(conversationId, id)));
    ranges = args.mode === "merge" ? [await api.boundariesCombine(conversationId, ids, typeof args.name === "string" ? args.name : resolved.map(r => rangeTitle(r.name)).join("、"))] : resolved;
  } else {
    if (args.boundaryId !== undefined && typeof args.boundaryId !== "string") return invalid("boundaryId 必须为范围编号");
    ranges = [typeof args.boundaryId === "string" ? await api.boundariesGet(conversationId, args.boundaryId) : activeBoundary];
  }
  const validBounds = Array.isArray(args.bounds) && args.bounds.length === 4 && args.bounds.every(v => typeof v === "number" && Number.isFinite(v));
  if (!ranges[0] && !validBounds) return invalid("请先导入或查询范围，或提供 bounds");
  const result: ImageryPlanResult = { plans: [], errors: [] };
  for (const range of ranges) {
    const toolExecutionId = batch ? `${executionId}:${args.mode}:${range?.boundaryId}` : executionId;
    try {
      let stored = await api.plansForToolExecution(toolExecutionId);
      if (!stored) {
        const directory = await api.outputDirectorySuggest(conversationId);
        const spec: TaskSpec = { schemaVersion: "0.1", kind: "imagery", sourceId: source.id, bounds: range?.bounds ?? args.bounds as Bounds,
          ...(range ? { boundary: range.geometry } : {}), zoomLevels, outputFormats: [...new Set(formats)] as OutputFormat[],
          ...(exportOptions ? { exportOptions } : {}),
          outputDirectory: range ? `${directory}-${rangeTitle(range.name)}` : directory,
          limits: { maxTiles: 1_000_000, maxDecodedRgbaBytes: 1024 ** 4 } };
        stored = await api.plansCreate(spec, toolExecutionId, conversationId);
      }
      result.plans.push({ stored, rangeName: range?.name });
    } catch (error) { result.errors.push({ boundaryId: range?.boundaryId, name: range?.name, error }); }
  }
  return result;
}

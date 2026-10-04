import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { TaskAction } from "./task-queue";
import type { TaskListEntry } from "./unified-task-queue-view";

export interface DataDownloadTask {
  id: string; conversationId: string; kind: "vector" | "tiles3d" | "online"; title: string; status: string; planHash: string;
  request: { kind: string; spec: Record<string, unknown> }; outputDir: string;
  progress: { phase: string; completed: number; total: number; bytes: number; cacheHits: number; failures: number } | null;
  manifest: Record<string, unknown> | null; error: string | null; createdAt: string; updatedAt: string;
}
export interface DataDownloadPreview { kind: "vector" | "tiles3d"; resourcePath: string; token: string; bounds?: number[]; featureCount?: number; truncated: boolean }
export interface DataPreviewEvent {
  conversationId: string; taskId: string; title: string; preview: DataDownloadPreview; url: string;
  resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void;
}
export const DATA_DOWNLOAD_CHANGED = "geod-data-download-changed";
export const DATA_DOWNLOAD_FOCUS = "geod-data-download-focus";
export const DATA_DOWNLOAD_PREVIEW = "geod-data-download-preview";
export function dataDownloadChanged(conversationId: string, taskId?: string) {
  window.dispatchEvent(new CustomEvent(DATA_DOWNLOAD_CHANGED, { detail: { conversationId, taskId } }));
}
export function focusDataTask(conversationId: string, taskId: string) {
  window.dispatchEvent(new CustomEvent(DATA_DOWNLOAD_FOCUS, { detail: { conversationId, taskId } }));
}
export const dataDownloads = {
  plan: (conversationId: string, title: string, idempotencyKey: string, request: unknown) => invoke<DataDownloadTask>("data_download_plan", { conversationId, title, idempotencyKey, request }),
  list: (conversationId: string) => invoke<DataDownloadTask[]>("data_download_list", { conversationId }),
  get: (conversationId: string, taskId: string) => invoke<DataDownloadTask>("data_download_get", { conversationId, taskId }),
  start: (conversationId: string, taskId: string, planHash: string, confirmed = false) => invoke<DataDownloadTask>(confirmed ? "data_download_start" : "data_download_start_auto", { conversationId, taskId, planHash, ...(confirmed ? { confirmed: true } : {}) }),
  cancel: (conversationId: string, taskId: string) => invoke<DataDownloadTask>("data_download_cancel", { conversationId, taskId }),
  discard: (conversationId: string, taskId: string) => invoke<DataDownloadTask>("data_download_discard", { conversationId, taskId }),
  inspect: (conversationId: string, taskId: string) => invoke<DataDownloadTask>("data_download_inspect", { conversationId, taskId }),
  preview: (conversationId: string, taskId: string) => invoke<DataDownloadPreview>("data_download_preview", { conversationId, taskId }),
};
export function dataTaskEntry(task: DataDownloadTask): TaskListEntry {
  const spec = task.request.spec, outputs = Array.isArray(spec.outputs) ? spec.outputs.map(v => String(v).toUpperCase()).join(" + ") : "3D Tiles";
  const progress = task.progress;
  const actions: TaskAction[] = task.status === "pending" ? ["start", "discard"] : ["queued", "downloading", "verifying"].includes(task.status) ? ["cancel"] : [];
  return { id: task.id, title: task.title, state: task.status, description: `${task.kind === "tiles3d" ? "三维" : "矢量"} · ${outputs}${progress?.total ? ` · ${progress.completed}/${progress.total}` : ""}`,
    tooltip: `${task.title} · ${new Date(task.createdAt).toLocaleString("zh-CN")}`, actions,
    progress: progress?.total ? progress.completed / progress.total : undefined };
}
export async function previewDataTask(conversationId: string, task: DataDownloadTask) {
  const preview = await dataDownloads.preview(conversationId, task.id);
  // Keep actual path separators: Cesium resolves child assets relative to the
  // entrypoint. convertFileSrc encodes '/' and would lose the bundle directory.
  const [token, ...segments] = preview.resourcePath.split("/");
  const url = `${convertFileSrc(token, "geod-data")}/${segments.map(encodeURIComponent).join("/")}`;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("预览加载超时，请查看地图后重试")), 60000);
    window.dispatchEvent(new CustomEvent<DataPreviewEvent>(DATA_DOWNLOAD_PREVIEW, { detail: { conversationId, taskId: task.id, title: task.title, preview, url,
      resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } } }));
  });
}
/** Compact model result; paths and large geometry remain in the native store. */
export function compactDataTask(task: DataDownloadTask) {
  const manifest = task.manifest;
  const files = manifest ? (Array.isArray(manifest.assets) ? manifest.assets : Array.isArray(manifest.resources) ? manifest.resources : []) as Record<string, unknown>[] : [];
  return { taskId: task.id, kind: task.kind, title: task.title, status: task.status, planHash: task.planHash, progress: task.progress, error: task.error,
    outputLocation: "当前工作区中的新目录", createdAt: task.createdAt, updatedAt: task.updatedAt,
    manifest: manifest ? { bounds: manifest.bounds, featureCount: manifest.featureCount, sourceFeatureCount:manifest.sourceFeatureCount, geometryTypes:manifest.geometryTypes, sourceLayer:manifest.sourceLayer, outputCrs:manifest.outputCrs, fields:Array.isArray(manifest.fields)?manifest.fields.slice(0,100):undefined, fieldsTruncated:Array.isArray(manifest.fields)&&manifest.fields.length>100, fieldEncodings:manifest.fieldEncodings&&typeof manifest.fieldEncodings==="object"?Object.fromEntries(Object.entries(manifest.fieldEncodings).slice(0,100)):undefined, quality: manifest.quality,
      failureCount: Array.isArray(manifest.failures) ? manifest.failures.length : undefined,
      warnings: Array.isArray(manifest.warnings) ? manifest.warnings.slice(0, 10) : [], dataTimestamp: manifest.dataTimestamp,
      fileCount: files.length, assets: files.slice(0, 20).map(asset => ({ kind: asset.kind, bytes: asset.bytes ?? asset.size, sha256: asset.sha256 })),
      assetsTruncated: files.length > 20 } : null };
}

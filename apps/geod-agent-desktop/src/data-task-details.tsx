import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useState } from "react";
import { Button } from "@/components/motion/button/base";
import { dataDownloads, dataDownloadChanged, previewDataTask, type DataDownloadTask } from "./data-downloads";
import { taskStateLabels } from "./unified-task-queue-view";
import { errorMessage } from "./app-error";
import { ChevronDown } from "./icons";
import { openTiles3dConnection } from "./data-connection-tools";

function resultNote(value: unknown) {
  const text = String(value);
  if (text.startsWith("GeoJSON and GeoPackage retain complete features")) return "GeoJSON 和 GeoPackage 保留与范围相交的完整要素，不切割几何；PBF 和 MBTiles 保留选中的完整瓦片。";
  if (text.startsWith("Vector tile exports preserve tile boundaries")) return "矢量瓦片保留原有分块与缓冲区，跨瓦片或层级的要素不会自动合并。";
  const preview = text.match(/^Preview contains the first (\d+) features; exported datasets contain all (\d+) features\./);
  if (preview) return `地图预览显示前 ${preview[1]} 个要素，导出文件包含全部 ${preview[2]} 个要素。`;
  return text;
}

const size = (n: number) => n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
export function DataTaskDetails({ task, view, permission }: { task: DataDownloadTask; view: "task" | "results" | "input"; permission?: string | null }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [checked, setChecked] = useState(false);
  const [parametersOpen, setParametersOpen] = useState(false), [notesOpen, setNotesOpen] = useState(false);
  const progress = task.progress, spec = task.request.spec, bounds = Array.isArray(spec.bounds) ? spec.bounds as number[] : null;
  const assets = (Array.isArray(task.manifest?.assets) ? task.manifest?.assets : Array.isArray(task.manifest?.resources) ? task.manifest?.resources : []) as Record<string, unknown>[];
  async function run(action: "start" | "cancel" | "discard" | "preview" | "inspect") {
    setBusy(true); setError("");
    try {
      if (action === "start") await dataDownloads.start(task.conversationId, task.id, task.planHash, true);
      if (action === "cancel") await dataDownloads.cancel(task.conversationId, task.id);
      if (action === "discard") await dataDownloads.discard(task.conversationId, task.id);
      if (action === "preview") await previewDataTask(task.conversationId, task);
      if (action === "inspect") await dataDownloads.inspect(task.conversationId, task.id);
      dataDownloadChanged(task.conversationId, task.id);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return <>
    <section className="task-overview"><div className="task-source"><h3>{task.title}</h3><span className={`state-pill state-${task.status}`}>{task.status === "pending" && permission === "fullAccess" ? t("待执行") : localize(taskStateLabels[task.status] ?? task.status)}</span></div><p className="task-subtitle">{task.kind === "tiles3d" ? t("3D Tiles · 离线三维数据") : t("矢量数据")}</p>
      {view === "task" && <>
        {progress && <div className="task-progress"><div className="task-progress-caption"><span>{progress.total ? t("{0} / {1} 个{2}", {"0": progress.completed, "1": progress.total, "2": task.kind==="online"?"要素":"资源"}) : task.kind==="online"&&!["completed","partial"].includes(task.status)?t("正在读取在线要素"):t("{0} 个{1}", {"0": progress.completed, "1": task.kind==="online"?"要素":"资源"})}</span><strong>{size(progress.bytes)}</strong></div>{progress.total > 0 && <div className="progress-track"><span style={{ width: `${Math.min(100, 100 * progress.completed / progress.total)}%` }} /></div>}</div>}
        {task.status === "pending" && <div className="task-plan-review">{permission !== "fullAccess" && <label className="check-row"><input type="checkbox" checked={checked} onChange={e => setChecked(e.target.checked)} /><span>{t("我已核对范围、数据来源与输出格式")}</span></label>}<div className="task-actions"><Button size="sm" disabled={busy || (permission !== "fullAccess" && !checked)} onClick={() => void run("start")}>{t("开始下载")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("discard")}>{t("丢弃")}</Button></div></div>}
        {["failed", "interrupted", "cancelled"].includes(task.status) && <div className="task-actions"><Button size="sm" variant="secondary" disabled={busy} onClick={() => void run("start")}>{t("重试")}</Button></div>}
        {["queued", "downloading", "verifying"].includes(task.status) && <div className="task-actions"><Button size="sm" variant="secondary" disabled={busy} onClick={() => void run("cancel")}>{t("取消任务")}</Button></div>}
        {["completed", "partial"].includes(task.status) && <div className="task-actions"><Button size="sm" variant="secondary" disabled={busy} onClick={() => void run("preview")}>{task.kind === "tiles3d" ? t("打开三维预览") : t("加载到地图")}</Button></div>}
        <section className="task-disclosure"><Button variant="ghost" size="sm" className="task-disclosure-trigger" aria-expanded={parametersOpen} onClick={() => setParametersOpen(!parametersOpen)}>{t("参数与保存位置")}<ChevronDown size={16} className={parametersOpen ? "is-open" : ""}/></Button>{parametersOpen && <div className="task-disclosure-content"><p className="task-full-path">{task.outputDir}</p><p>{task.kind !== "tiles3d" ? (Array.isArray(spec.outputs) ? spec.outputs.join(" · ") : "") : t("递归下载并校验关联资源")}</p>{typeof spec.connectionId === "string" && <Button size="sm" variant="ghost" onClick={() => openTiles3dConnection(spec.connectionId as string)}>{t("管理三维连接")}</Button>}</div>}</section>
      </>}
      {view === "results" && (assets.length ? <section className="task-artifacts"><div className="task-actions"><Button size="sm" variant="secondary" disabled={busy} onClick={() => void run("preview")}>{task.kind === "tiles3d" ? t("打开三维预览") : t("加载到地图")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("inspect")}>{t("核验文件")}</Button></div><p>{assets.length} {t(" 个成果文件")}</p>{assets.slice(0, 50).map((asset, i) => <div className="task-asset" key={i}><div><strong>{String(asset.kind ?? "文件")}</strong><span title={String(asset.path)}>{String(asset.path).split(/[\\/]/).at(-1)}</span></div><span>{size(Number(asset.size ?? asset.bytes ?? 0))}</span></div>)}{assets.length > 50 && <p className="task-empty">{t("完整文件列表见成果目录中的清单。")}</p>}</section> : <p className="task-empty">{t("任务完成后显示已校验的成果文件。")}</p>)}
      {view === "input" && <section className="task-input-summary"><h4>{t("输入范围")}</h4><p>{bounds ? bounds.map(v => v.toFixed(5)).join(", ") : t("数据集完整范围")}</p><p>WGS84 / EPSG:4326</p></section>}
    </section>
    {task.status === "partial" && <p className="warning-text">{t("部分资源未能获取，成果包含缺失内容。")}{task.progress?.failures ? t("缺失 {0} 个资源。", {"0": task.progress.failures}) : ""}</p>}
    {Array.isArray(task.manifest?.warnings) && task.manifest.warnings.length > 0 && <section className="task-disclosure"><Button variant="ghost" size="sm" className="task-disclosure-trigger" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>{t("成果说明 · ")}{task.manifest.warnings.length}<ChevronDown size={16} className={notesOpen ? "is-open" : ""}/></Button>{notesOpen && <div className="task-disclosure-content">{task.manifest.warnings.map((warning, i) => <p key={i}>{resultNote(warning)}</p>)}</div>}</section>}
    {(error || task.error) && <p className="warning-text" role="alert">{error || task.error}</p>}
    {(error || task.error) && typeof spec.connectionId === "string" && <Button size="sm" variant="outline" onClick={() => openTiles3dConnection(spec.connectionId as string)}>{t("检查连接与凭证")}</Button>}
  </>;
}

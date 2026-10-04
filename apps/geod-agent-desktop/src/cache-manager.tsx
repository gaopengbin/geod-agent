import { getLocale, t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/motion/button/base";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CircleAlert, FolderOpen, Loader2, RefreshCw, X } from "./icons";
import { errorMessage } from "./app-error";
import "./cache-manager.css";

interface CacheProgress { phase: string; total: number; checked: number; migrated: number; skipped: number; invalid: number; bytes: number; currentJob: string | null; warnings: string[] }
interface MaintenanceStatus { operationId: string; action: string; state: string; progress: CacheProgress; error: string | null; sourcePath: string; targetPath: string | null }
interface Inventory { directory: string; activeJobs: string[]; operation: MaintenanceStatus | null; inventory: { totalBytes: number; unreadableEntries: number; jobCaches: { jobId: string; tileCount: number; bytes: number }[]; sharedCaches: { revision: string; tileCount: number; bytes: number; expiredTiles: number }[] } }
interface Preflight { sourcePath: string; targetPath: string; fileCount: number; bytes: number; availableBytes: number; blockers: string[] }
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
const phaseLabel: Record<string, string> = { preparing: "准备中", migrating: "整理历史任务缓存", verifying: "核验缓存", relocating: "复制并核验文件", switching: "切换保存位置", completed: "已完成" };

/** Mounted from account settings. Closing the panel does not cancel the worker. */
export function CacheManager({ onClose }: { onClose: () => void }) {
  const [inventory, setInventory] = useState<Inventory | null>(null), [operation, setOperation] = useState<MaintenanceStatus | null>(null);
  const [loading, setLoading] = useState(true), [action, setAction] = useState(false), [error, setError] = useState("");
  const [target, setTarget] = useState(""), [preflight, setPreflight] = useState<Preflight | null>(null), [moveOpen, setMoveOpen] = useState(false);
  const running = operation?.state === "running";
  const refresh = useCallback(async () => {
    const result = await invoke<Inventory>("cache_inventory");
    setInventory(result); if (result.operation) setOperation(result.operation);
  }, []);
  useEffect(() => { void refresh().catch(cause => setError(errorMessage(cause))).finally(() => setLoading(false)); }, [refresh]);
  useEffect(() => {
    if (!operation || operation.state !== "running") return;
    let disposed = false, busy = false;
    const poll = async () => {
      if (busy) return; busy = true;
      try {
        const next = await invoke<MaintenanceStatus>("cache_maintenance_status", { operationId: operation.operationId });
        if (disposed) return; setOperation(next);
        if (next.state !== "running") { await refresh(); setPreflight(null); }
      } catch (cause) { if (!disposed) setError(errorMessage(cause)); } finally { busy = false; }
    };
    const timer = setInterval(() => void poll(), 750); void poll();
    return () => { disposed = true; clearInterval(timer); };
  }, [operation?.operationId, operation?.state, refresh]);
  async function run(kind: "verify" | "migrate" | "relocate") {
    if (running || action) return; setAction(true); setError("");
    try {
      const operationId = await invoke<string>(kind === "relocate" ? "cache_relocation_start" : "cache_maintenance_start", kind === "relocate" ? { targetPath: target } : { action: kind });
      setOperation(await invoke<MaintenanceStatus>("cache_maintenance_status", { operationId }));
    } catch (cause) { setError(errorMessage(cause)); } finally { setAction(false); }
  }
  async function checkTarget() {
    setAction(true); setError(""); setPreflight(null);
    try { setPreflight(await invoke<Preflight>("cache_relocation_preflight", { targetPath: target })); }
    catch (cause) { setError(errorMessage(cause)); } finally { setAction(false); }
  }
  async function chooseFolder() {
    try {
      const folder = await open({ directory: true, multiple: false, title: "选择缓存存放磁盘或父文件夹" });
      if (typeof folder === "string") { setTarget(`${folder.replace(/[\\/]$/, "")}${folder.includes("\\") ? "\\" : "/"}GeoD Agent Cache`); setPreflight(null); }
    } catch (cause) { setError(errorMessage(cause)); }
  }
  const data = inventory?.inventory;
  const canStart = !loading && !action && !running && !!inventory && !inventory.activeJobs.length;
  const progress = operation?.progress;
  return <Dialog.Root open onOpenChange={value => { if (!value) onClose(); }}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="dialog cache-manager">
    <div className="dialog-head"><div><Dialog.Title>{t("下载缓存")}</Dialog.Title><Dialog.Description>{t("复用已下载瓦片，减少重复请求。")}</Dialog.Description></div><Button size="icon" variant="ghost" aria-label={t("关闭缓存设置")} onClick={onClose}><X size={18} /></Button></div>
    <ScrollArea className="cache-manager-scroll"><div className="dialog-body cache-manager-body">
      {loading ? <p className="cache-helper"><Loader2 size={15} className="animate-spin" />{t("正在统计缓存…")}</p> : data && <>
        <dl className="cache-metrics"><div><dt>{t("磁盘占用")}</dt><dd>{size(data.totalBytes)}</dd></div><div><dt>{t("任务缓存")}</dt><dd>{data.jobCaches.length}<small>{t("个")}</small></dd></div><div><dt>{t("共享瓦片")}</dt><dd>{data.sharedCaches.reduce((n, row) => n + row.tileCount, 0).toLocaleString(getLocale())}<small>{t("张")}</small></dd></div></dl>
        <div className="cache-location"><span>{t("当前保存位置")}</span><p>{inventory.directory}</p><Button variant="ghost" size="sm" disabled={!canStart} onClick={() => setMoveOpen(value => !value)}>{t("更改位置")}</Button></div>
        <div className="cache-action-row"><div><strong>{t("检查完整性")}</strong><p>{t("核对文件大小、哈希和像素；不删除已有缓存。")}</p></div><Button size="sm" variant="outline" disabled={!canStart} onClick={() => void run("verify")}>{t("核验")}</Button></div>
        <div className="cache-action-row"><div><strong>{t("整理历史缓存")}</strong><p>{t("将可验证的历史瓦片加入对应图源的共享缓存。")}</p></div><Button size="sm" variant="outline" disabled={!canStart || !data.jobCaches.length} onClick={() => void run("migrate")}>{t("整理")}</Button></div>
        {data.sharedCaches.some(row => row.expiredTiles > 0) && <p className="cache-helper">{t("共享缓存超过 7 天会在正常下载时刷新；历史任务续传保留原瓦片。")}</p>}
        {data.unreadableEntries > 0 && <p className="warning-text">{t("有 ")}{data.unreadableEntries} {t(" 个缓存目录暂时不可读，可核验后查看记录。")}</p>}
      </>}
      {!!inventory?.activeJobs.length && <p className="cache-helper">{inventory.activeJobs.length} {t(" 个影像任务正在执行。维护和迁移将在暂停或完成后可用。")}</p>}
      {moveOpen && <section className="cache-relocation"><h3>{t("迁移缓存位置")}</h3><label className="field"><span className="field-label">{t("新的缓存目录")}</span><div className="cache-path-input"><input value={target} onChange={e => { setTarget(e.target.value); setPreflight(null); }} disabled={!canStart} placeholder={t("选择磁盘并指定新文件夹")} /><Button variant="ghost" size="icon" aria-label={t("选择缓存文件夹")} disabled={!canStart} onClick={() => void chooseFolder()}><FolderOpen size={16} /></Button></div><small>{t("将创建新目录，逐文件校验后切换；旧缓存保留在原位置。")}</small></label>
        {preflight && <div className="cache-preflight"><p>{preflight.fileCount.toLocaleString(getLocale())} {t(" 个文件 · ")}{size(preflight.bytes)}<br />{t("目标磁盘可用 ")}{size(preflight.availableBytes)}</p>{preflight.blockers.map(text => <p key={text} className="warning-text">{text}</p>)}</div>}
        <div className="cache-buttons"><Button variant="outline" size="sm" disabled={!canStart || !target.trim()} onClick={() => void checkTarget()}>{t("检查目标")}</Button><Button size="sm" disabled={!canStart || !preflight || preflight.blockers.length > 0} onClick={() => void run("relocate")}>{t("开始迁移")}</Button></div>
      </section>}
      {operation && progress && <section className="cache-operation" aria-live="polite"><div className="cache-operation-head"><strong>{running ? phaseLabel[progress.phase] ?? t("处理中") : operation.state === "completed" ? t("操作完成") : operation.state === "cancelled" ? t("已取消") : t("操作未完成")}</strong>{running && <Button variant="ghost" size="sm" disabled={progress.phase === "switching"} onClick={() => void invoke("cache_maintenance_cancel", { operationId: operation.operationId }).catch(cause => setError(errorMessage(cause)))}>{t("取消")}</Button>}</div>
        {running && <div className="progress-track"><span style={{ width: `${progress.total ? Math.min(100, progress.checked / progress.total * 100) : 0}%` }} /></div>}
        <p>{t("已核验 ")}{progress.checked.toLocaleString(getLocale())}{progress.total ? ` / ${progress.total.toLocaleString(getLocale())}` : ""} {t(" 项")}{progress.migrated ? t(" · 已写入 {0} 项", {"0": progress.migrated.toLocaleString(getLocale())}) : ""}{progress.invalid ? t(" · 异常 {0} 项", {"0": progress.invalid}) : ""}{progress.skipped ? t(" · 复用或跳过 {0} 项", {"0": progress.skipped}) : ""}</p>
        {operation.state === "completed" && operation.action === "relocate" && <p>{t("后续下载使用新目录。旧目录：")}<span className="cache-path">{operation.sourcePath}</span></p>}
        {operation.error && <p className="warning-text">{operation.error}</p>}
        {!!progress.warnings.length && <details><summary>{t("查看核验记录")}</summary>{progress.warnings.map((text, i) => <p className="cache-warning" key={i}>{text}</p>)}</details>}
      </section>}
      {error && <div className="error-box" role="alert"><CircleAlert size={16} />{localize(error)}</div>}
    </div></ScrollArea><div className="dialog-actions"><Button size="sm" variant="ghost" disabled={loading || action} onClick={() => { setError(""); void refresh().catch(cause => setError(errorMessage(cause))); }}><RefreshCw size={14} />{t("刷新")}</Button><Button variant="outline" onClick={onClose}>{running ? t("后台继续") : t("关闭")}</Button></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

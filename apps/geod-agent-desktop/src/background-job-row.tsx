import { getLocale, t } from "./i18n";
// i18n: presentation strings migrated
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Activity, CheckCircle2, ChevronDown, CircleAlert, Loader2 } from "./icons";
import { Button } from "@/components/motion/button/base";
import { backgroundRunning, backgroundStateLabels, type BackgroundSnapshot } from "./background-jobs";
import type { BackgroundJob } from "./pending-generations";
import { jobExecutionState } from "./job-runtime";

export function BackgroundJobRow({ task, title = task.sourceName, snapshot, onOpen }: { task: BackgroundJob; title?: string; snapshot?: BackgroundSnapshot; onOpen?: (jobId: string) => void }) {
  const [open, setOpen] = useState(false);
  const state = snapshot?.job ? jobExecutionState(snapshot.job, snapshot.workerActive) : undefined;
  const total = snapshot?.totalTiles ?? task.totalTiles;
  const completed = state === "completed" ? total : snapshot?.completedTiles;
  const percent = total && completed !== undefined ? Math.min(100, Math.round(completed / total * 100)) : null;
  const running = backgroundRunning(state);
  const attention = state === "failed" || state === "partial" || state === "interrupted" || !!snapshot?.connectionError;
  return <section className={`background-job-row ${running ? "is-running" : ""} ${attention ? "attention" : ""}`} aria-label={t("后台任务 {0}", {"0": title})}>
    <Button variant="ghost" size="sm" className="background-job-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="background-job-icon">{attention ? <CircleAlert size={17} /> : running || !state ? <Loader2 size={17} className="background-job-spin" /> : state === "completed" ? <CheckCircle2 size={17} /> : <Activity size={17} />}</span>
      <span className="background-job-title">{t("后台下载 · ")}{title}</span>
      <span className="background-job-state">{snapshot?.connectionError ? t("状态同步中断") : snapshot?.checkingCache && running ? t("检查缓存") : state ? backgroundStateLabels[state] : t("同步状态")}{percent !== null ? ` · ${percent}%` : ""}</span>
      <ChevronDown size={15} className={open ? "is-open" : ""} />
    </Button>
    <AnimatePresence initial={false}>{open && <motion.div className="background-job-details" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .25 }}>
      <div className="background-job-detail-content">
        <p>Z{task.zoomLevels.join(", ")} · {task.outputFormats.map(format => format === "geotiff" ? "GeoTIFF" : "MBTiles").join(" + ")}<span>{completed !== undefined ? t("{0} / {1} 瓦片", {"0": completed.toLocaleString(getLocale()), "1": total.toLocaleString(getLocale())}) : t("{0} 瓦片", {"0": total.toLocaleString(getLocale())})}</span></p>
        {percent !== null && <div className="progress-track" role="progressbar" aria-label={t("后台下载进度")} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>}
        <p className="background-job-hint">{snapshot?.connectionError ?? (state === "interrupted" ? t("执行进程已停止，可在任务面板恢复已有进度。") : state === "completed" ? t("下载和成果核验已完成。") : state === "failed" ? t("任务失败，可在任务面板查看错误并重试。") : state === "partial" ? t("部分成果已保存，请查看缺失瓦片。") : state === "cancelled" ? t("任务已取消。") : state === "paused" ? t("任务已暂停，可在任务面板恢复。") : t("本机在后台执行，你可以继续聊天。"))}</p>
        {snapshot?.events.at(-1)?.errorCode && <p className="background-job-hint">{snapshot.events.at(-1)?.errorCode}</p>}
        {onOpen && <Button variant="ghost" size="sm" onClick={() => onOpen(task.jobId)}>{t("查看任务")}</Button>}
      </div>
    </motion.div>}</AnimatePresence>
  </section>;
}

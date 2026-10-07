import { t, getLocale, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useState } from "react";
import { Button } from "@/components/motion/button/base";
import { ChevronDown } from "./icons";
import { UiTooltip } from "./ui-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { canTaskAction, taskEnded, type QueueTask, type TaskAction } from "./task-queue";
import type { WorkspaceSettings } from "./api";
import { errorMessage } from "./app-error";
import { TaskProgressBar, generatingArtifacts } from "./task-progress";

const taskStateLabels: Record<string, string> = { scheduled: "已设定时", pending: "待确认", discarded: "已丢弃", queued: "排队中", downloading: "下载中", paused: "已暂停", processing: "生成成果", verifying: "核验中", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
export function TaskQueueView({ tasks, selectedId, permission, working, externalErrors = false, focusPlanIds = [], onClearFocus, onSelect, onAction }: {
  tasks: QueueTask[]; selectedId?: string; permission?: WorkspaceSettings["permission"] | null; working: boolean;
  focusPlanIds?: string[]; onClearFocus?: () => void;
  externalErrors?: boolean;
  onSelect: (task: QueueTask) => void; onAction: (action: TaskAction, ids: string[]) => Promise<void>;
}) {
  const [history, setHistory] = useState(false);
  const [multi, setMulti] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  const [action, setAction] = useState<TaskAction | null>(null);
  const [error, setError] = useState("");
  const scoped = focusPlanIds.length ? tasks.filter(task => focusPlanIds.includes(task.stored.planId)) : tasks;
  const pending = scoped.filter(task => !taskEnded(task));
  const ended = scoped.filter(taskEnded);
  const visible = history ? ended : pending;
  const selection = scoped.filter(task => selected.includes(task.stored.planId));
  const eligible = (kind: TaskAction) => selection.filter(task => canTaskAction(task, kind)).map(task => task.stored.planId);
  const busy = working || action !== null;
  const selectionKey = selected.join("|");
  const selectedEnded = scoped.some(task => task.stored.planId === selectedId && taskEnded(task));
  const focusKey = focusPlanIds.join("|");
  useEffect(() => { setSelected([]); setMulti(false); setChecked(false); setError(""); }, [focusKey]);
  useEffect(() => { setChecked(false); }, [selectionKey, permission]);
  useEffect(() => {
    if (selectedId) setHistory(selectedEnded);
  }, [selectedId, selectedEnded]);
  async function run(kind: TaskAction) {
    setAction(kind); setError("");
    try { await onAction(kind, eligible(kind)); setSelected([]); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setAction(null); }
  }
  function toggle(id: string) { setSelected(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]); }
  return <section className="task-queue" aria-label={t("当前会话任务列表")} aria-busy={busy}>
    <div className="task-queue-heading"><strong>{focusPlanIds.length ? t("本轮任务") : t("任务列表")} <span>{scoped.length}</span></strong><div className="task-queue-heading-actions">{focusPlanIds.length > 0 && onClearFocus && <Button variant="ghost" size="sm" whileHover={undefined} whileTap={undefined} disabled={busy} onClick={onClearFocus}>{t("查看全部")}</Button>}<Button variant="ghost" size="sm" whileHover={undefined} whileTap={undefined} disabled={busy || !scoped.length} onClick={() => { setMulti(!multi); setSelected([]); setError(""); }}>{multi ? t("完成选择") : t("多选")}</Button></div></div>
    <div className="task-queue-tabs" role="tablist" aria-label={t("任务状态")}>
      <Button variant="ghost" size="sm" whileHover={undefined} whileTap={undefined} role="tab" aria-selected={!history} disabled={busy} onClick={() => { setHistory(false); setSelected([]); }}>{t("待处理 ")}{pending.length}</Button>
      <Button variant="ghost" size="sm" whileHover={undefined} whileTap={undefined} role="tab" aria-selected={history} disabled={busy} onClick={() => { setHistory(true); setSelected([]); }}>{t("已结束 ")}{ended.length}</Button>
    </div>
    {multi && visible.length > 0 && <label className="task-select-all check-row"><input type="checkbox" aria-label={t("全选当前列表")} disabled={busy} checked={visible.every(task => selected.includes(task.stored.planId))} onChange={event => setSelected(event.target.checked ? visible.map(task => task.stored.planId) : [])} /><span>{t("全选")}{selected.length > 0 ? t(" · 已选 {0} 项", {"0": selection.length}) : ""}</span></label>}
    <ScrollArea className="task-queue-area" viewportClassName="task-queue-list" viewportProps={{role:"tabpanel", "aria-label":history ? "已结束任务" : "待处理任务"}}>
      {!visible.length && <p className="task-queue-empty">{history ? t("暂无已结束的任务") : t("暂无待处理的任务")}</p>}
      {visible.map(task => <div key={task.stored.planId} className={`task-queue-row ${selectedId === task.stored.planId ? "is-selected" : ""}`}>
        {multi && <input className="task-row-checkbox" type="checkbox" aria-label={t("选择计划 {0}", {"0": scoped.length - scoped.indexOf(task)})} checked={selected.includes(task.stored.planId)} disabled={busy} onChange={() => toggle(task.stored.planId)} />}
        <UiTooltip content={t("{0} · {1} · 计划 {2} · {3}；范围 {4}", {"0": task.title ?? task.stored.plan.sourceName, "1": task.stored.plan.sourceName, "2": scoped.length - scoped.indexOf(task), "3": new Date(task.stored.plan.createdAt).toLocaleString(getLocale(), {hour12: false}), "4": task.stored.plan.spec.bounds.map(n => n.toFixed(4)).join(", ")})} side="left"><Button variant="ghost" size="sm" className="task-queue-select" whileHover={undefined} whileTap={undefined} aria-current={selectedId === task.stored.planId ? "true" : undefined} onClick={() => onSelect(task)}>
          <span className="task-queue-row-head"><span aria-hidden="true" className={`task-queue-state-dot state-${task.state}`} /><strong>{task.title ?? task.stored.plan.sourceName}</strong><span className={`task-queue-state state-${task.state}`}>{task.state === "pending" && permission === "fullAccess" ? t("待执行") : localize(taskStateLabels[task.state] ?? task.state)}</span></span>
          <span className="task-queue-row-meta"><span className="task-queue-row-description">Z{task.stored.plan.spec.zoomLevels.join(", ")} · {task.stored.plan.spec.outputFormats.map(outputFormatLabel).join(" + ")} · {task.completedTiles !== undefined ? `${task.completedTiles.toLocaleString(getLocale())}/` : ""}{task.stored.plan.totalTiles.toLocaleString(getLocale())} {t(" 瓦片")}</span><ChevronDown size={14}/></span>
          {task.job && !taskEnded(task) && (task.completedTiles !== undefined || generatingArtifacts(task.state)) && <TaskProgressBar className="task-queue-progress" state={task.state} percent={(task.completedTiles ?? 0) / Math.max(1, task.stored.plan.totalTiles) * 100}/>}
          {task.connectionError && <span className="task-queue-sync">{t("状态同步中…")}</span>}
        </Button></UiTooltip>
      </div>)}
    </ScrollArea>
    {multi && selection.length > 0 && <div className="task-batch-actions">
      {eligible("start").length > 0 && permission !== "fullAccess" && <label className="check-row"><input type="checkbox" disabled={busy} checked={checked} onChange={event => setChecked(event.target.checked)} /><span>{t("我已核对所选计划")}</span></label>}
      <div>{(["start", "discard", "cancel", "restore"] as TaskAction[]).map(kind => {
        const count = eligible(kind).length;
        if (!count) return null;
        return <Button key={kind} size="sm" variant={kind === "start" ? "primary" : "secondary"} disabled={busy || (kind === "start" && (!permission || (permission !== "fullAccess" && !checked)))} onClick={() => void run(kind)}>{action === kind && <span className="task-spinner"/>}{({start:"开始",discard:"丢弃",cancel:"取消任务",restore:"恢复计划"})[kind]} {count}</Button>;
      })}</div>
      {error && !externalErrors && <p className="warning-text" role="alert">{localize(error)}</p>}
    </div>}
  </section>;
}
import { outputFormatLabel } from "./output-formats";

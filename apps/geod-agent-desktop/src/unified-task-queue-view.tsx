import { getLocale, t as tr, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useState } from "react";
import { Button } from "@/components/motion/button/base";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown } from "./icons";
import { UiTooltip } from "./ui-tooltip";
import { errorMessage } from "./app-error";
import { canTaskAction, type QueueTask, type TaskAction } from "./task-queue";
import type { WorkspaceSettings } from "./api";
import { outputFormatLabel } from "./output-formats";

export interface TaskListEntry {
  id: string; title: string; state: string; description: string; tooltip?: string;
  progress?: number; actions: TaskAction[]; imagery?: QueueTask;
}
export const taskStateLabels: Record<string, string> = { scheduled: "已设定时", pending: "待确认", planned: "待确认", discarded: "已丢弃", queued: "排队中", downloading: "下载中", paused: "已暂停", processing: "处理中", verifying: "核验中", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
const ended = (task: TaskListEntry) => ["discarded", "completed", "partial", "cancelled"].includes(task.state);
function imageryEntry(task: QueueTask): TaskListEntry {
  const p = task.stored.plan;
  return { id: task.stored.planId, title: task.title ?? p.sourceName, state: task.state, imagery: task,
    description: `Z${p.spec.zoomLevels.join(", ")} · ${p.spec.outputFormats.map(outputFormatLabel).join(" + ")} · ${task.completedTiles === undefined ? "" : `${task.completedTiles.toLocaleString(getLocale())}/`}${p.totalTiles.toLocaleString(getLocale())} 瓦片`,
    tooltip: `${p.sourceName} · ${new Date(p.createdAt).toLocaleString(getLocale())} · ${p.spec.bounds.map(n => n.toFixed(4)).join(", ")}`,
    progress: task.job && task.completedTiles !== undefined ? task.completedTiles / Math.max(1, p.totalTiles) : undefined,
    actions: (["start", "discard", "cancel", "restore"] as TaskAction[]).filter(a => canTaskAction(task, a)) };
}

/** One queue for imagery, vector and 3D jobs; the domain records stay separate. */
export function UnifiedTaskQueueView({ tasks, additionalTasks = [], selectedId, permission, working, focusPlanIds = [], onClearFocus, onSelect, onAction, onAdditionalSelect, onAdditionalAction }: {
  tasks: QueueTask[]; additionalTasks?: TaskListEntry[]; selectedId?: string; permission?: WorkspaceSettings["permission"] | null; working: boolean;
  focusPlanIds?: string[]; onClearFocus?: () => void; onSelect: (task: QueueTask) => void; onAction: (action: TaskAction, ids: string[]) => Promise<void>;
  onAdditionalSelect?: (id: string) => void; onAdditionalAction?: (action: TaskAction, ids: string[]) => Promise<void>;
}) {
  const all = [...additionalTasks, ...tasks.map(imageryEntry)];
  const scoped = focusPlanIds.length ? all.filter(t => focusPlanIds.includes(t.id)) : all;
  const [history, setHistory] = useState(false), [multi, setMulti] = useState(false), [selected, setSelected] = useState<string[]>([]);
  const [checked, setChecked] = useState(false), [action, setAction] = useState<TaskAction | null>(null), [error, setError] = useState("");
  const pending = scoped.filter(t => !ended(t)), finished = scoped.filter(ended), visible = history ? finished : pending;
  const selection = scoped.filter(t => selected.includes(t.id)), busy = working || action !== null;
  const eligible = (a: TaskAction) => selection.filter(t => t.actions.includes(a));
  const selectedEnded = scoped.some(t => t.id === selectedId && ended(t));
  const focusKey = focusPlanIds.join("|"), selectionKey = selected.join("|");
  useEffect(() => { if (selectedId) setHistory(selectedEnded); }, [selectedId, selectedEnded]);
  useEffect(() => { setSelected([]); setChecked(false); setMulti(false); }, [focusKey]);
  useEffect(() => setChecked(false), [selectionKey, permission]);
  async function run(kind: TaskAction) {
    setAction(kind); setError("");
    const items = eligible(kind), errors: string[] = [];
    try {
      const imagery = items.filter(t => t.imagery).map(t => t.id), data = items.filter(t => !t.imagery).map(t => t.id);
      if (imagery.length) try { await onAction(kind, imagery); } catch (e) { errors.push(errorMessage(e)); }
      if (data.length) try { await onAdditionalAction?.(kind, data); } catch (e) { errors.push(errorMessage(e)); }
      if (!errors.length) setSelected([]); else setError(errors.join("；"));
    } finally { setAction(null); }
  }
  return <section className="task-queue" aria-label={tr("当前会话任务列表")} aria-busy={busy}>
    <div className="task-queue-heading"><strong>{focusPlanIds.length ? tr("本轮任务") : tr("任务列表")} <span>{scoped.length}</span></strong><div className="task-queue-heading-actions">{focusPlanIds.length > 0 && <Button variant="ghost" size="sm" disabled={busy} onClick={onClearFocus}>{tr("查看全部")}</Button>}<Button variant="ghost" size="sm" disabled={busy || !scoped.length} onClick={() => { setMulti(!multi); setSelected([]); setError(""); }}>{multi ? tr("完成选择") : tr("多选")}</Button></div></div>
    <div className="task-queue-tabs" role="tablist" aria-label={tr("任务状态")}>{[[false, "待处理", pending.length], [true, "已结束", finished.length]].map(([flag, label, count]) => <Button key={String(flag)} variant="ghost" size="sm" role="tab" aria-selected={history === flag} disabled={busy} onClick={() => { setHistory(flag as boolean); setSelected([]); }}>{localize(label)} {count}</Button>)}</div>
    {multi && visible.length > 0 && <label className="task-select-all check-row"><input type="checkbox" aria-label={tr("全选当前列表")} disabled={busy} checked={visible.every(t => selected.includes(t.id))} onChange={e => setSelected(e.target.checked ? visible.map(t => t.id) : [])} /><span>{tr("全选")}{selection.length ? tr(" · 已选 {0} 项", {"0": selection.length}) : ""}</span></label>}
    <ScrollArea className="task-queue-area" viewportClassName="task-queue-list" viewportProps={{ role: "tabpanel", "aria-label": history ? "已结束任务" : "待处理任务" }}>
      {!visible.length && <p className="task-queue-empty">{history ? tr("暂无已结束的任务") : tr("暂无待处理的任务")}</p>}
      {visible.map(t => <div key={t.id} className={`task-queue-row ${selectedId === t.id ? "is-selected" : ""}`}>
        {multi && <input className="task-row-checkbox" type="checkbox" aria-label={tr("选择 {0}", {"0": t.title})} checked={selected.includes(t.id)} disabled={busy} onChange={() => setSelected(v => v.includes(t.id) ? v.filter(id => id !== t.id) : [...v, t.id])} />}
        <UiTooltip content={t.tooltip ?? t.title} side="left"><Button variant="ghost" size="sm" className="task-queue-select" whileHover={undefined} whileTap={undefined} aria-current={selectedId === t.id ? "true" : undefined} onClick={() => t.imagery ? onSelect(t.imagery) : onAdditionalSelect?.(t.id)}>
          <span className="task-queue-row-head"><span aria-hidden="true" className={`task-queue-state-dot state-${t.state}`} /><strong>{t.title}</strong><span className={`task-queue-state state-${t.state}`}>{["pending", "planned"].includes(t.state) && permission === "fullAccess" ? tr("待执行") : localize(taskStateLabels[t.state] ?? t.state)}</span></span>
          <span className="task-queue-row-meta"><span className="task-queue-row-description">{localize(t.description)}</span><ChevronDown size={14} /></span>
          {!ended(t) && t.progress !== undefined && <span className="task-queue-progress"><span style={{ width: `${Math.min(100, Math.max(0, t.progress * 100))}%` }} /></span>}
          {t.imagery?.connectionError && <span className="task-queue-sync">{tr("状态同步中…")}</span>}
        </Button></UiTooltip>
      </div>)}
    </ScrollArea>
    {multi && selection.length > 0 && <div className="task-batch-actions">
      {eligible("start").length > 0 && permission !== "fullAccess" && <label className="check-row"><input type="checkbox" checked={checked} disabled={busy} onChange={e => setChecked(e.target.checked)} /><span>{tr("我已核对所选计划")}</span></label>}
      <div>{(["start", "discard", "cancel", "restore"] as TaskAction[]).map(kind => eligible(kind).length > 0 && <Button key={kind} size="sm" variant={kind === "start" ? "primary" : "secondary"} disabled={busy || (kind === "start" && (!permission || (permission !== "fullAccess" && !checked)))} onClick={() => void run(kind)}>{action === kind && <span className="task-spinner" />}{({ start: "开始", discard: "丢弃", cancel: "取消任务", restore: "恢复计划" })[kind]} {eligible(kind).length}</Button>)}</div>
      {error && <p className="warning-text" role="alert">{localize(error)}</p>}
    </div>}
  </section>;
}

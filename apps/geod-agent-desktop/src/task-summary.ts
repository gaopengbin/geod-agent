import type { WorkspaceSettings } from "./api";
import { taskEnded, type QueueTask } from "./task-queue.ts";

const labels: Record<string, string> = { pending: "待确认", discarded: "已丢弃", queued: "排队中", downloading: "下载中", paused: "已暂停", processing: "处理中", verifying: "核验中", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
export function summarizeTasks(tasks: QueueTask[], permission?: WorkspaceSettings["permission"] | null) {
  const counts = { pending: 0, running: 0, attention: 0, ended: 0 };
  const scheduledCount=tasks.filter(task=>task.state==='scheduled').length;
  for (const task of tasks) {
    if(task.state==='scheduled')continue;
    if (task.connectionError || ["paused", "failed", "partial", "interrupted"].includes(task.state)) counts.attention++;
    else if (task.state === "pending") counts.pending++;
    else if (["queued", "downloading", "processing", "verifying"].includes(task.state)) counts.running++;
    else counts.ended++;
  }
  const pending = permission === "fullAccess" ? "待执行" : "待确认";
  const parts = [counts.attention ? `需处理 ${counts.attention}` : "", counts.pending ? `${pending} ${counts.pending}` : "", counts.running ? `进行中 ${counts.running}` : "", scheduledCount?`已定时 ${scheduledCount}`:'', counts.ended ? `已结束 ${counts.ended}` : ""].filter(Boolean);
  const status = tasks.length === 1 ? tasks[0].connectionError ? "状态同步中断" : tasks[0].state==='scheduled'?'已设定时':tasks[0].state === "pending" ? pending : labels[tasks[0].state] ?? tasks[0].state : parts.join(" · ");
  return { counts, status, kind: counts.attention ? "attention" : counts.pending ? "pending" : counts.running ? "running" : scheduledCount ? "scheduled" : "ended" };
}

/** Prefer an unfinished member so opening a mixed batch exposes work still to do. */
export function taskGroupTarget(tasks: QueueTask[], planIds: string[], selectedId?: string) {
  const group = [...new Set(planIds)].flatMap(id => tasks.find(task => task.stored.planId === id) ?? []);
  const unfinished = group.filter(task => !taskEnded(task));
  return unfinished.find(task => task.stored.planId === selectedId) ?? unfinished[0] ?? group.find(task => task.stored.planId === selectedId) ?? group[0];
}

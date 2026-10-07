import type { Job, JobEvent, JobState } from "./api";
import type { DisplayMessage } from "./pending-generations";
import { tileProgressFacts } from "./job-runtime.ts";

/** Collapse earlier model polling chatter without deleting the persisted transcript. */
export function collapsePollingHistory(messages: DisplayMessage[]): DisplayMessage[] {
  const polling = (item?: DisplayMessage) => item?.role === "tool" && !item.backgroundJob && ["jobs_get", "jobs_events"].includes(item.toolName ?? "");
  const progress = (item?: DisplayMessage) => item?.role === "assistant" && item.phase === "progress" && !item.streaming;
  const compact: DisplayMessage[] = [];
  for (let index = 0; index < messages.length;) {
    if (!polling(messages[index]) && !(progress(messages[index]) && polling(messages[index + 1]))) {
      compact.push(messages[index++]); continue;
    }
    const start = index;
    while (polling(messages[index]) || (progress(messages[index]) && polling(messages[index + 1]))) index++;
    const trace = messages.slice(start, index);
    if (trace.filter(polling).length < 2) compact.push(...trace);
    else compact.push({ id: `monitor-history-${trace[0].id}`, role: "tool", content: `早前任务监控 · ${trace.length} 条记录`, monitorTrace: trace });
  }
  return compact;
}

const runningStates = new Set<JobState>(["queued", "downloading", "processing", "verifying"]);
const terminalStates = new Set<JobState>(["completed", "partial", "failed", "cancelled"]);
export const backgroundStateLabels: Record<JobState | "interrupted", string> = { queued: "排队中", downloading: "下载中", processing: "生成成果", verifying: "核验成果", completed: "已完成", partial: "部分完成", paused: "已暂停", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
export const backgroundRunning = (state?: JobState | "interrupted") => !!state && state !== "interrupted" && runningStates.has(state);

/** A running native job hands control back to the user instead of spending model rounds polling. */
export function backgroundHandoff(name: string, output: unknown): { jobId: string; planId: string; state: JobState } | null {
  if (!["jobs_start", "jobs_get", "jobs_events"].includes(name) || !output || typeof output !== "object") return null;
  const value = output as Record<string, unknown>;
  return !value.error && typeof value.jobId === "string" && typeof value.planId === "string" && backgroundRunning(value.state as JobState)
    ? { jobId: value.jobId, planId: value.planId, state: value.state as JobState } : null;
}

export interface BackgroundSnapshot { job: Job | null; workerActive?: boolean; completedTiles?: number; totalTiles?: number; checkingCache?: boolean; events: JobEvent[]; seq: number; connectionError?: string }
interface MonitorApi { jobsGet: (id: string) => Promise<Job | null>; jobsEvents: (id: string, seq: number) => Promise<JobEvent[]>; jobsActive?: () => Promise<string[]> }

/** Native ledger polling only. No model requests, message appends, or tool-round loop. */
export function createBackgroundMonitor(api: MonitorApi, ids: string[], onUpdate: (snapshots: Record<string, BackgroundSnapshot>) => void,
  onTerminal: (snapshot: BackgroundSnapshot) => void) {
  const snapshots: Record<string, BackgroundSnapshot> = {};
  let disposed = false;
  let polling = false;
  return {
    async poll() {
      if (disposed || polling) return;
      polling = true;
      try {
        const active = api.jobsActive ? await api.jobsActive().catch(() => null) : null;
        await Promise.all(ids.map(async id => {
          const previous = snapshots[id];
          if (previous?.job && ["completed", "partial", "cancelled"].includes(previous.job.state)) return;
          try {
            const job = await api.jobsGet(id);
            if (disposed) return;
            if (!job) throw new Error("JOB_NOT_FOUND");
            const events = await api.jobsEvents(id, previous?.seq ?? 0);
            if (disposed) return;
            const progress = tileProgressFacts(events, previous?.totalTiles ?? 0, previous);
            const snapshot: BackgroundSnapshot = { job, workerActive: active ? active.includes(id) : undefined, completedTiles: progress.completedTiles,
              totalTiles: progress.totalTiles || previous?.totalTiles, checkingCache: events.some(event => event.completedTiles !== undefined) ? progress.checkingCache : previous?.checkingCache,
              seq: events.at(-1)?.seq ?? previous?.seq ?? 0,
              events: [...(previous?.events ?? []), ...events].filter(event => event.completedTiles === undefined || event.errorCode).slice(-10) };
            snapshots[id] = snapshot;
            if (previous?.job && previous.job.state !== job.state && terminalStates.has(job.state)) onTerminal(snapshot);
          } catch {
            if (!disposed) snapshots[id] = { ...(previous ?? { job: null, events: [], seq: 0 }), connectionError: "状态同步暂时中断，正在重试；下载由本机后台执行。" };
          }
        }));
        if (!disposed) onUpdate({ ...snapshots });
      } finally { polling = false; }
    },
    dispose() { disposed = true; },
  };
}

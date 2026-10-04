import type { Job, StoredPlan } from "./api";
import { errorMessage } from "./app-error.ts";

export type TaskAction = "start" | "discard" | "cancel" | "restore";
type Store = Pick<Storage, "getItem" | "setItem">;
const PREFIX = "geod-agent-task-queue-1";
export const taskQueueKey = (account: string, conversation: string) => `${PREFIX}:${encodeURIComponent(account)}:${encodeURIComponent(conversation)}`;
export function discardedPlans(store: Pick<Storage, "getItem">, account: string | null, conversation: string): string[] {
  if (!account || !conversation) return [];
  const value: unknown = JSON.parse(store.getItem(taskQueueKey(account, conversation)) ?? "[]");
  if (!Array.isArray(value) || !value.every(id => typeof id === "string")) throw new Error("任务列表记录无法读取，请检查本机存储。");
  return value;
}
export function setPlanDiscarded(store: Store, account: string, conversation: string, planId: string, discarded: boolean) {
  const ids = new Set(discardedPlans(store, account, conversation));
  if (discarded) ids.add(planId); else ids.delete(planId);
  store.setItem(taskQueueKey(account, conversation), JSON.stringify([...ids]));
  if (typeof window !== "undefined") window.dispatchEvent(new Event("geod-task-queue-change"));
}
export function assertPlanAvailable(store: Pick<Storage, "getItem">, account: string | null, conversation: string, planId: string) {
  if (!account || !conversation) throw new Error("请先登录并选择会话。");
  if (discardedPlans(store, account, conversation).includes(planId)) throw new Error("PLAN_DISCARDED：用户已丢弃此计划。可由用户在任务历史中恢复，或按新的需求重新规划。");
}

// UI actions and model calls share this lock, so a discard cannot race a start.
const locks = new Map<string, Promise<unknown>>();
export async function withPlanTaskLock<T>(account: string, conversation: string, planId: string, operation: () => Promise<T>): Promise<T> {
  const key = `${taskQueueKey(account, conversation)}:${planId}`;
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  locks.set(key, next);
  try { return await next; }
  finally { if (locks.get(key) === next) locks.delete(key); }
}

export interface QueueTask {
  stored: StoredPlan;
  title?: string;
  job: Job | null;
  state: string;
  completedTiles?: number;
  workerActive?: boolean;
  connectionError?: string;
}
export function taskEnded(task: QueueTask) { return ["discarded", "completed", "partial", "cancelled"].includes(task.state); }
export function canTaskAction(task: QueueTask, action: TaskAction) {
  if (action === "start" || action === "discard") return !task.job && task.state === "pending";
  if (action === "restore") return !task.job && task.state === "discarded";
  return !!task.job && ["queued", "downloading", "paused"].includes(task.job.state);
}
export function buildTaskQueue(plans: StoredPlan[], jobs: Job[], activeIds: string[], discarded: string[], snapshots: Record<string, { job: Job | null; workerActive?: boolean; completedTiles?: number; connectionError?: string }> = {}): QueueTask[] {
  return [...plans].reverse().map(stored => {
    const found = jobs.filter(job => job.planId === stored.planId).reduce<Job | undefined>((latest, item) => !latest || item.version > latest.version ? item : latest, undefined);
    const snapshot = found ? snapshots[found.jobId] : undefined;
    const job = snapshot?.job && snapshot.job.version >= (found?.version ?? 0) ? snapshot.job : found ?? null;
    const workerActive = job ? snapshot?.job?.version === job.version && snapshot.workerActive !== undefined ? snapshot.workerActive : activeIds.includes(job.jobId) : undefined;
    const state = job ? workerActive === false && ["downloading", "processing", "verifying"].includes(job.state) ? "interrupted" : job.state : discarded.includes(stored.planId) ? "discarded" : "pending";
    return { stored, job, state, workerActive, connectionError: snapshot?.connectionError, completedTiles: job?.state === "completed" ? stored.plan.totalTiles : snapshot?.completedTiles };
  });
}

interface TaskApi {
  jobsForPlan: (id: string) => Promise<Job | null>;
  approvalsGrant: (id: string, hash: string) => Promise<{ approvalId: string }>;
  jobsStart: (id: string, hash: string, approvalId: string, key: string) => Promise<Job>;
  jobsStartAuto: (id: string, conversation: string, key: string) => Promise<Job>;
  jobsCancel: (id: string) => Promise<Job>;
}
export async function runTaskBatch(api: TaskApi, store: Store, account: string, conversation: string, plans: StoredPlan[], action: TaskAction, fullAccess = false) {
  const succeeded: { planId: string; job: Job | null }[] = [];
  const failed: { planId: string; message: string }[] = [];
  for (const stored of plans) {
    try {
      const job = await withPlanTaskLock(account, conversation, stored.planId, async () => {
        const existing = await api.jobsForPlan(stored.planId);
        if (action === "restore") {
          if (existing) throw new Error("计划已有作业，请查看作业状态。");
          setPlanDiscarded(store, account, conversation, stored.planId, false);
          return null;
        }
        if (action === "cancel") {
          if (!existing || !["queued", "downloading", "paused"].includes(existing.state)) throw new Error("当前状态不支持取消，请刷新任务。");
          return api.jobsCancel(existing.jobId);
        }
        assertPlanAvailable(store, account, conversation, stored.planId);
        if (existing) throw new Error("计划已有作业，请在任务列表查看，避免重复执行。");
        if (action === "discard") {
          setPlanDiscarded(store, account, conversation, stored.planId, true);
          return null;
        }
        if (fullAccess) return api.jobsStartAuto(stored.planId, conversation, crypto.randomUUID());
        const approval = await api.approvalsGrant(stored.planId, stored.plan.planHash);
        return api.jobsStart(stored.planId, stored.plan.planHash, approval.approvalId, crypto.randomUUID());
      });
      succeeded.push({ planId: stored.planId, job });
    } catch (cause) { failed.push({ planId: stored.planId, message: errorMessage(cause) }); }
  }
  return { succeeded, failed };
}

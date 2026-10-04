import type { Job, JobEvent, StoredPlan, WorkspaceSettings } from "./api";
import { jobStatusFacts } from "./job-runtime.ts";

interface JobStartApi {
  workspaceGet(conversationId: string): Promise<WorkspaceSettings>;
  jobsForPlan(planId: string): Promise<Job | null>;
  jobsActive(): Promise<string[]>;
  jobsStartAuto(planId: string, conversationId: string, idempotencyKey: string): Promise<Job>;
  jobsResume(jobId: string): Promise<Job>;
  jobsGet(jobId: string): Promise<Job | null>;
  jobsEvents(jobId: string, afterSeq: number): Promise<JobEvent[]>;
  plansGet(planId: string): Promise<StoredPlan | null>;
}

/** Start or resume the actual worker; a persisted job alone is not a running download. */
export async function startPlanJob(api: JobStartApi, planId: string, conversationId: string, executionId: string) {
  const workspace = await api.workspaceGet(conversationId);
  if (workspace.permission !== "fullAccess") return { error: "APPROVAL_REQUIRED" as const };

  const existing = await api.jobsForPlan(planId);
  const activeBefore = existing ? (await api.jobsActive()).includes(existing.jobId) : false;
  let job: Job;
  let operation: "started" | "resumed" | "already-running" | "already-finished";
  if (!existing) {
    job = await api.jobsStartAuto(planId, conversationId, executionId);
    operation = "started";
  } else if (activeBefore) {
    job = existing;
    operation = "already-running";
  } else if (["completed", "partial", "cancelled"].includes(existing.state)) {
    job = existing;
    operation = "already-finished";
  } else {
    job = await api.jobsResume(existing.jobId);
    operation = "resumed";
  }

  const [current, active, events, stored] = await Promise.all([
    api.jobsGet(job.jobId), api.jobsActive(), api.jobsEvents(job.jobId, 0), api.plansGet(planId),
  ]);
  job = current ?? job;
  const facts = jobStatusFacts(job, active.includes(job.jobId), events, stored?.plan.totalTiles ?? 0);
  return { job, result: { ...facts, operation, reused: existing !== null, resumed: operation === "resumed" } };
}

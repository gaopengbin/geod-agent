import type { Job, JobEvent, JobState } from "./api";

export function jobExecutionState(job: Pick<Job, "state">, workerActive?: boolean): JobState | "interrupted" {
  return workerActive === false && ["downloading", "processing", "verifying"].includes(job.state) ? "interrupted" : job.state;
}

export function tileProgressFacts(events: JobEvent[], totalTiles: number, previous?: { completedTiles?: number; progressRecordedAt?: string | null }) {
  const latest = [...events].reverse().find(event => event.completedTiles !== undefined);
  const highest = events.reduce<JobEvent | undefined>((best, event) => event.completedTiles !== undefined && (event.completedTiles >= (best?.completedTiles ?? -1)) ? event : best, undefined);
  const completed = highest?.completedTiles === undefined ? previous?.completedTiles : Math.max(highest.completedTiles, previous?.completedTiles ?? 0);
  return {
    completedTiles: completed,
    totalTiles: latest?.totalTiles ?? totalTiles,
    checkedTiles: latest?.completedTiles,
    checkingCache: completed !== undefined && latest?.completedTiles !== undefined && latest.completedTiles < completed,
    progressRecordedAt: highest?.completedTiles === completed ? highest?.occurredAt ?? null : previous?.progressRecordedAt ?? null,
  };
}

export function jobStatusFacts(job: Job, workerActive: boolean, events: JobEvent[], totalTiles: number) {
  const progress = tileProgressFacts(events, totalTiles);
  const total = progress.totalTiles;
  const completed = job.state === "completed" ? total : progress.completedTiles;
  return {
    jobId: job.jobId, planId: job.planId, state: jobExecutionState(job, workerActive), ledgerState: job.state,
    workerActive, version: job.version, completedTiles: completed ?? null, totalTiles: total,
    percent: completed !== undefined && total > 0 ? Math.round(completed / total * 100) : null,
    checkingCache: workerActive && job.state === "downloading" && progress.checkingCache,
    checkedTiles: progress.checkingCache ? progress.checkedTiles : null,
    progressRecordedAt: progress.progressRecordedAt, checkedAt: new Date().toISOString(),
    latestError: [...events].reverse().find(event => event.errorCode)?.errorCode ?? null,
    monitoring: "desktop-background",
  };
}

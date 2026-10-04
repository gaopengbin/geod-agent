import type { BackgroundSnapshot } from './background-jobs';

export interface DownloadEvent { event_id: string; attempt_id: string; occurred_at: string; state: string; duration: string; reason: string }
interface Attempt { id: string; state: string; started: number | null }
export interface DownloadTelemetryState { attempts: Record<string, Attempt>; queue: DownloadEvent[] }
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
const running = new Set(['queued', 'downloading', 'processing', 'verifying', 'paused']);
export function restoreDownloadState(value: unknown): DownloadTelemetryState | null {
  if (!value || typeof value !== 'object') return null;
  const saved = value as DownloadTelemetryState;
  if (!saved.attempts || typeof saved.attempts !== 'object' || !Array.isArray(saved.queue)) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const attempts: Record<string, Attempt> = Object.create(null);
  for (const [key, attempt] of Object.entries(saved.attempts).slice(-2000)) {
    if (attempt && uuid.test(attempt.id) && (terminal.has(attempt.state) || running.has(attempt.state)) &&
        (attempt.started === null || Number.isFinite(attempt.started))) attempts[key] = { id: attempt.id, state: attempt.state, started: attempt.started };
  }
  const queue: DownloadEvent[] = [];
  for (const event of saved.queue.slice(-100)) {
    if (event && uuid.test(event.event_id) && uuid.test(event.attempt_id) && (terminal.has(event.state) || event.state === 'started') &&
        ['unknown','under_10s','10-60s','1-5m','5-30m','30m+'].includes(event.duration) &&
        ['none','cancelled','network','auth','disk','permission','missing_tiles','unknown'].includes(event.reason) &&
        typeof event.occurred_at === 'string' && Number.isFinite(Date.parse(event.occurred_at))) {
      queue.push({ event_id: event.event_id, attempt_id: event.attempt_id, occurred_at: event.occurred_at, state: event.state, duration: event.duration, reason: event.reason });
    }
  }
  return { attempts, queue };
}
function duration(ms: number | null) { return ms === null || ms < 0 ? 'unknown' : ms < 10000 ? 'under_10s' : ms < 60000 ? '10-60s' : ms < 300000 ? '1-5m' : ms < 1800000 ? '5-30m' : '30m+'; }
function reason(state: string, code?: string) {
  if (state === 'cancelled') return 'cancelled';
  if (state === 'partial') return 'missing_tiles';
  if (state !== 'failed') return 'none';
  if (/DISK|SPACE/.test(code ?? '')) return 'disk';
  if (/AUTH|401|403/.test(code ?? '')) return 'auth';
  if (/PERMISSION/.test(code ?? '')) return 'permission';
  if (/NETWORK|TIMEOUT|CONNECT|HTTP/.test(code ?? '')) return 'network';
  return 'unknown';
}
/** Persist random attempt IDs and pending events locally; never serialize ledger job IDs to the network. */
export class DownloadTelemetry {
  state: DownloadTelemetryState;
  private since: number;
  private uuid: () => string;
  constructor(state: DownloadTelemetryState | null, since: number, uuid: () => string) {
    this.state = state ?? { attempts: {}, queue: [] }; this.since = since; this.uuid = uuid;
  }
  observe(snapshots: Record<string, BackgroundSnapshot>, now: number) {
    for (const [jobId, snapshot] of Object.entries(snapshots)) {
      const job = snapshot.job;
      if (!job || (!terminal.has(job.state) && !running.has(job.state))) continue;
      let attempt = this.state.attempts[jobId];
      const latest = [...snapshot.events].reverse().find(event => event.state === job.state);
      const at = Math.min(now, Date.parse(latest?.occurredAt ?? '') || now);
      const emit = (state: string) => this.state.queue.push({ event_id: this.uuid(), attempt_id: attempt!.id,
        occurred_at: new Date(at).toISOString(), state,
        duration: state === 'started' ? 'unknown' : duration(attempt!.started === null ? null : at - attempt!.started), reason: reason(state, latest?.errorCode) });
      if (!attempt) {
        const created = Date.parse(job.createdAt);
        attempt = { id: this.uuid(), state: job.state, started: created >= this.since ? created : null };
        this.state.attempts[jobId] = attempt;
        // Do not replay a historical terminal job when consent or monitoring starts.
        if (terminal.has(job.state) && !(created >= this.since)) continue;
        emit('started');
        if (terminal.has(job.state)) emit(job.state);
      } else if (attempt.state !== job.state) {
        if (terminal.has(attempt.state) && running.has(job.state)) {
          attempt = { id: this.uuid(), state: job.state, started: now };
          this.state.attempts[jobId] = attempt; emit('started');
        } else {
          const wasTerminal = terminal.has(attempt.state);
          attempt.state = job.state;
          if (!wasTerminal && terminal.has(job.state)) emit(job.state);
        }
      }
    }
    this.state.queue = this.state.queue.slice(-100);
    // Keep active jobs and bounded history. Terminal jobs seen again are baselined.
    const completedIds = Object.keys(this.state.attempts).filter(id => terminal.has(this.state.attempts[id].state));
    for (const id of completedIds.slice(0, Math.max(0, completedIds.length - 500))) delete this.state.attempts[id];
  }
  acknowledge(batch: DownloadEvent[]) { const ids = new Set(batch.map(event => event.event_id)); this.state.queue = this.state.queue.filter(event => !ids.has(event.event_id)); }
}

import { useEffect, useRef, useState } from 'react';
import { api, desktopAvailable } from './api';
import type { BackgroundSnapshot } from './background-jobs';
import { DownloadTelemetry, restoreDownloadState, type DownloadTelemetryState } from './download-telemetry';

const settingKey = 'geod-agent-download-telemetry-v1';
const queuePrefix = 'geod-agent-download-events-v1:';
function consent() { try { return localStorage.getItem(settingKey) === 'enabled'; } catch { return false; } }
function readState(key: string): DownloadTelemetryState | null {
  try { return restoreDownloadState(JSON.parse(localStorage.getItem(key) ?? 'null')); } catch { return null; }
}
function save(key: string, state: DownloadTelemetryState) { try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* Telemetry never blocks a job. */ } }
export function useDownloadTelemetry(accountId: string | null, snapshots: Record<string, BackgroundSnapshot>) {
  const [enabled, setEnabled] = useState(consent);
  const currentSnapshots = useRef(snapshots); currentSnapshots.current = snapshots;
  const collector = useRef<DownloadTelemetry | null>(null);
  useEffect(() => {
    if (!desktopAvailable || !accountId || !enabled) { collector.current = null; return; }
    const key = queuePrefix + accountId;
    const tracker = new DownloadTelemetry(readState(key), Date.now(), () => crypto.randomUUID());
    collector.current = tracker;
    let disposed = false, sending = false;
    const tick = async () => {
      if (disposed || !consent() || sending) return;
      tracker.observe(currentSnapshots.current, Date.now()); save(key, tracker.state);
      const batch = tracker.state.queue.slice(0, 20);
      if (!batch.length) return;
      sending = true;
      try { await api.agentEvents(accountId, batch); if (!disposed && consent()) { tracker.acknowledge(batch); save(key, tracker.state); } }
      catch { /* Retain stable IDs for idempotent retries. No raw error reporting. */ }
      finally { sending = false; }
    };
    const timer = window.setInterval(() => void tick(), 5000);
    void tick();
    return () => { disposed = true; clearInterval(timer); collector.current = null; };
  }, [accountId, enabled]);
  useEffect(() => { if (accountId && enabled && consent() && collector.current) { collector.current.observe(snapshots, Date.now()); save(queuePrefix + accountId, collector.current.state); } }, [accountId, enabled, snapshots]);
  const toggle = () => {
    const next = !enabled;
    try {
      localStorage.setItem(settingKey, next ? 'enabled' : 'disabled');
      if (!next) for (const key of Object.keys(localStorage)) if (key.startsWith(queuePrefix)) localStorage.removeItem(key);
    } catch { if (next) return; }
    setEnabled(next);
  };
  return { enabled, toggle };
}

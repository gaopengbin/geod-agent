import { useEffect, useState } from 'react';
import { desktopAvailable } from './api';
import { invoke } from '@tauri-apps/api/core';
import type { BackgroundSnapshot } from './background-jobs';

const settingKey = 'geod-agent-download-telemetry-v1';
const queuePrefix = 'geod-agent-download-events-v1:';
function consent() { try { return localStorage.getItem(settingKey) === 'enabled'; } catch { return false; } }
export function useDownloadTelemetry(accountId: string | null, _snapshots: Record<string, BackgroundSnapshot>) {
  const [enabled, setEnabled] = useState(consent);
  useEffect(() => {
    if (!desktopAvailable || !accountId) return;
    // Explicit existing opt-in migrates to the durable companion. No native
    // collector depends on this chat staying mounted or the WebView staying open.
    let stopped=false,done=false;
    const sync=()=>{if(!stopped&&!done)void invoke('download_telemetry_set',{enabled,accountId}).then(()=>{done=true;}).catch(()=>{});};
    sync();const retry=window.setInterval(sync,15000);
    return()=>{stopped=true;clearInterval(retry);};
  }, [accountId, enabled]);
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

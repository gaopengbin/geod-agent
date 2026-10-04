import { useEffect, useState } from "react";
import { api, desktopAvailable } from "./api";
import { createBackgroundMonitor, type BackgroundSnapshot } from "./background-jobs";

export function useBackgroundJobs(accountId: string | null, ids: string[], onTerminal: (snapshot: BackgroundSnapshot) => void) {
  const [owned, setOwned] = useState<{ accountId: string | null; key: string; snapshots: Record<string, BackgroundSnapshot> }>({ accountId: null, key: '', snapshots: {} });
  const key = [...new Set(ids)].sort().join(",");
  useEffect(() => {
    setOwned({ accountId, key, snapshots: {} });
    if (!desktopAvailable || !accountId || !key) return;
    const monitor = createBackgroundMonitor(api, key.split(","), snapshots => setOwned({ accountId, key, snapshots }), onTerminal);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      await monitor.poll();
      if (!stopped) timer = setTimeout(() => void refresh(), 2500);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); monitor.dispose(); };
  }, [accountId, key, onTerminal]);
  return owned.accountId === accountId && owned.key === key ? owned.snapshots : {};
}

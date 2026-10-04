import { localStateStore } from "./local-state";
import { useMemo, useSyncExternalStore } from "react";
import { taskQueueKey } from "./task-queue";

function subscribe(callback: () => void) {
  window.addEventListener("geod-task-queue-change", callback);
  window.addEventListener("storage", callback);
  return () => { window.removeEventListener("geod-task-queue-change", callback); window.removeEventListener("storage", callback); };
}
export function useDiscardedPlans(account: string | null, conversation: string) {
  const raw = useSyncExternalStore(subscribe, () => account && conversation ? localStateStore.getItem(taskQueueKey(account, conversation)) ?? "[]" : "[]");
  return useMemo(() => {
    try { const ids: unknown = JSON.parse(raw); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; }
    catch { return []; }
  }, [raw]);
}

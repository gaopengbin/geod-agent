import { localStateStore } from "./local-state";
import { useMemo, useSyncExternalStore } from "react";
import { planPresentationKey, readPlanPresentations, type PlanPresentations } from "./plan-presentation";

function subscribe(notify: () => void) {
  window.addEventListener("geod-plan-presentation-change", notify);
  window.addEventListener("storage", notify);
  return () => { window.removeEventListener("geod-plan-presentation-change", notify); window.removeEventListener("storage", notify); };
}
export function usePlanPresentations(account: string | null, conversation: string): PlanPresentations {
  const raw = useSyncExternalStore(subscribe, () => account && conversation ? localStateStore.getItem(planPresentationKey(account, conversation)) ?? "{}" : "{}", () => "{}");
  return useMemo(() => readPlanPresentations({ getItem: () => raw }, account, conversation), [raw, account, conversation]);
}

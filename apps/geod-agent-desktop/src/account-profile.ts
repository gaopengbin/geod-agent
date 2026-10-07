import { useCallback, useEffect, useRef, useState } from "react";
import { api, desktopAvailable, type AccountProfile, type AuthStatus } from "./api";

/** Account-scoped state; late responses cannot populate a different account. */
export function useAccountProfile(status: AuthStatus) {
  const accountId = status.state === "connected" ? status.userId : null;
  const [value, setValue] = useState<AccountProfile | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const owner = useRef<string | null>(null);
  const request = useRef(0);
  const pending = useRef(false);
  const checkedAt = useRef(0);
  const refresh = useCallback(async (force = false) => {
    const id = owner.current;
    if (!desktopAvailable || !id || pending.current || (!force && Date.now() - checkedAt.current < 30_000)) return;
    const sequence = ++request.current;
    pending.current = true;
    checkedAt.current = Date.now();
    try {
      const profile = await api.accountProfile(id);
      if (sequence === request.current && owner.current === id) {
        if (profile.accountId !== id) throw Error("ACCOUNT_CHANGED");
        setValue(profile); setFailure(null);
      }
    } catch {
      if (sequence === request.current && owner.current === id) setFailure(id);
    } finally {
      if (sequence === request.current) pending.current = false;
    }
  }, []);
  useEffect(() => {
    owner.current = accountId;
    ++request.current; pending.current = false; checkedAt.current = 0;
    setValue(null); setFailure(null);
    void refresh(true);
    const focused = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", focused);
    return () => {
      owner.current = null; ++request.current; pending.current = false;
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", focused);
    };
  }, [accountId, refresh]);
  return { profile: accountId && value?.accountId === accountId ? value : null, profileError: accountId !== null && failure === accountId, refreshProfile: refresh };
}

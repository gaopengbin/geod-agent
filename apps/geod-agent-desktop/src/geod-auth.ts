import { useCallback, useEffect, useRef, useState } from "react";
import { api, desktopAvailable, errorMessage, type AuthStatus } from "./api";
import { useAccountProfile } from "./account-profile";
import { AUTH_INVALIDATED } from "./auth-events";

const initialStatus: AuthStatus = { state: "unconfigured", userId: null, error: null };
export type GeoDAuth = ReturnType<typeof useGeoDAuth>;

/** One account controller shared by the login page and the mounted workspace. */
export function useGeoDAuth() {
  const [status, setStatus] = useState<AuthStatus>(initialStatus);
  const profile = useAccountProfile(status);
  const [ready, setReady] = useState(!desktopAvailable);
  const [busy, setBusy] = useState<"login" | "logout" | "refresh" | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const actionPending = useRef(false);
  const refreshPending = useRef(false);
  const epoch = useRef(0);

  const refresh = useCallback(async (manual = false) => {
    if (!desktopAvailable || actionPending.current || refreshPending.current) return;
    refreshPending.current = true;
    const current = epoch.current;
    if (manual) { setBusy("refresh"); setError(""); }
    try {
      const next = await api.authStatus();
      if (mounted.current && current === epoch.current) { setStatus(next); setError(""); }
    } catch (cause) {
      if (mounted.current && current === epoch.current) setError(errorMessage(cause));
    } finally {
      refreshPending.current = false;
      if (mounted.current && current === epoch.current) { setReady(true); if (manual) setBusy(null); }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (!desktopAvailable || status.state !== "waiting") return;
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => window.clearInterval(timer);
  }, [status.state, refresh]);
  useEffect(() => {
    if (!desktopAvailable) return;
    const invalidate = () => void refresh();
    const focus = () => { if (status.state === "connected") void refresh(); };
    window.addEventListener(AUTH_INVALIDATED, invalidate);
    window.addEventListener("focus", focus);
    const timer = status.state === "connected" ? window.setInterval(() => void refresh(), 30000) : undefined;
    return () => { window.removeEventListener(AUTH_INVALIDATED, invalidate); window.removeEventListener("focus", focus); if (timer !== undefined) window.clearInterval(timer); };
  }, [status.state, refresh]);

  const run = useCallback(async (action: "login" | "logout") => {
    if (!desktopAvailable || actionPending.current) return false;
    actionPending.current = true;
    const current = ++epoch.current;
    setBusy(action); setError("");
    try {
      const next = await (action === "login" ? api.authBegin() : api.authLogout());
      if (mounted.current && current === epoch.current) { setStatus(next); setReady(true); }
      return true;
    } catch (cause) {
      if (mounted.current && current === epoch.current) setError(errorMessage(cause));
      return false;
    } finally {
      actionPending.current = false;
      if (mounted.current && current === epoch.current) setBusy(null);
    }
  }, []);

  return { status, ...profile, ready, busy, error, refresh: () => refresh(true), begin: () => run("login"), logout: () => run("logout") };
}

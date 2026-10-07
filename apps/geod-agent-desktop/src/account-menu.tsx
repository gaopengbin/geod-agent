import { getLocale, t } from "./i18n";
// i18n: presentation strings migrated
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "@/components/motion/popover-morph";
import { Bot, ChartNoAxesColumn, ChevronDown, Globe2, HardDrive, LogOut, Moon, Network, RefreshCw, Server, Settings, Sun, Wallet } from "./icons";
import { BACKGROUND_OPEN } from "./background-dialog";
import { LANGUAGE_OPEN } from "./language-dialog";
import { PAYMENT_OPEN } from "./payment-dialog";
import { DESKTOP_SETTINGS_OPEN, DESKTOP_UPDATE_AVAILABLE, getAnnouncedDesktopUpdate } from "./desktop-settings-dialog";
import { api, type AccountProfile, type ModelUsage, type PaymentSnapshot } from "./api";
import { AccountAvatar } from "./account-avatar";
import { CREDITS_CHANGED, formatCredits } from "./credits";
import { useEffect, useRef, useState } from "react";

function tokens(value: number) {
  return `${(value / 1000).toLocaleString(getLocale(), { maximumFractionDigits: 1 })}K`;
}

export function AccountMenu({ open, onOpenChange, connected, userId, profile, profileError, onProfileRefresh, usage, busy, theme, onModels, onNetwork, onCache, onTheme, onLogout, telemetryEnabled, onTelemetry }: {
  open: boolean; onOpenChange: (value: boolean) => void; connected: boolean; userId: string | null; usage: ModelUsage | null;
  busy: boolean; theme: "light" | "dark"; onNetwork: () => void; onCache: () => void; onTheme: () => void; onLogout: () => void;
  telemetryEnabled: boolean; onTelemetry: () => void; onModels: () => void;
  profile: AccountProfile | null; profileError: boolean; onProfileRefresh: (force?: boolean) => Promise<void>;
}) {
  const currentProfile = connected && profile?.accountId === userId ? profile : null;
  useEffect(() => { if (open && connected) void onProfileRefresh(); }, [open, connected, onProfileRefresh]);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [credits, setCredits] = useState<{ accountId: string; snapshot: PaymentSnapshot } | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false), [creditsError, setCreditsError] = useState(false);
  useEffect(() => {
    if (!connected || !userId) { setCredits(null); setCreditsLoading(false); setCreditsError(false); return; }
    let disposed = false, pending = false;
    const refresh = async () => {
      if (pending) return; pending = true; setCreditsLoading(true); setCreditsError(false);
      try { const snapshot = await api.agentPaymentSnapshot(); if (!disposed) setCredits({ accountId: userId, snapshot }); }
      catch { if (!disposed) { setCredits(null); setCreditsError(true); } }
      finally { pending = false; if (!disposed) setCreditsLoading(false); }
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId: string | null; snapshot: PaymentSnapshot }>).detail;
      if (detail?.accountId === userId) { setCredits({ accountId: userId, snapshot: detail.snapshot }); setCreditsError(false); }
    };
    void refresh();
    const timer = open ? setInterval(() => { if (!document.hidden) void refresh(); }, 15_000) : null;
    window.addEventListener(CREDITS_CHANGED, changed);
    return () => { disposed = true; if (timer) clearInterval(timer); window.removeEventListener(CREDITS_CHANGED, changed); };
  }, [connected, userId, open, usage?.committedTokens, usage?.reservedTokens, usage?.pendingReconcile]);
  const snapshot = credits?.accountId === userId ? credits.snapshot : null;
  const unlimited = snapshot?.status.billingMode === "unlimited-test";
  const legacyQuota = snapshot?.status.billingMode === "token-quota";
  const balance = snapshot?.wallet?.availableNanoCny;
  const balanceLabel = unlimited ? "∞ Credits" : balance != null ? formatCredits(balance) : null;
  const [updateAvailable, setUpdateAvailable] = useState(() => Boolean(getAnnouncedDesktopUpdate()?.version));
  useEffect(() => {
    const changed = (event: Event) => setUpdateAvailable(Boolean((event as CustomEvent).detail?.version));
    window.addEventListener(DESKTOP_UPDATE_AVAILABLE, changed);
    return () => window.removeEventListener(DESKTOP_UPDATE_AVAILABLE, changed);
  }, []);
  const firstAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open || !keyboardOpen) return;
    const frame = requestAnimationFrame(() => {
      firstAction.current?.focus();
      setKeyboardOpen(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, keyboardOpen]);
  const action = (callback: () => void) => { onOpenChange(false); callback(); };
  return <div className="conversation-account"><MorphPopover open={open} onOpenChange={onOpenChange} className="account-menu-root">
    <MorphPopoverTrigger><button type="button" className="conversation-account-trigger" aria-label={t("账号与设置")} onClick={event => setKeyboardOpen(event.detail === 0 && !open)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setKeyboardOpen(true); onOpenChange(true); } }}>
      <AccountAvatar key={currentProfile?.accountId ?? "signed-out"} profile={currentProfile}/><span><strong title={currentProfile?.nickname ?? undefined}>{connected ? currentProfile?.nickname ?? t("GeoD 账号") : t("登录 GeoD")}</strong><small>{connected ? balanceLabel ?? t("账号与设置") : t("登录后使用 AI 能力")}</small></span><ChevronDown size={15}/>
    </button></MorphPopoverTrigger>
    <MorphPopoverContent side="top" align="start" radius={12} className="conversation-account-menu">
      <div className="account-menu-identity"><AccountAvatar key={currentProfile?.accountId ?? "signed-out"} profile={currentProfile}/><div><strong title={currentProfile?.nickname ?? undefined}>{connected ? currentProfile?.nickname ?? t("GeoD 账号") : t("未登录")}</strong><small title={currentProfile?.email ?? userId ?? undefined}>{currentProfile?.email ?? userId ?? t("登录以使用 AI 模型")}</small></div></div>
      {connected && profileError && <button type="button" className="account-profile-retry" onClick={() => void onProfileRefresh(true)}><RefreshCw size={16} aria-hidden="true"/>{t("重新同步头像与账号")}</button>}
      {connected && <div className="account-menu-usage"><span>{legacyQuota ? t("Token 配额") : t("AI Credits")}</span><strong>{creditsLoading && !snapshot ? t("查询中…") : legacyQuota && usage ? t("可用 {0} · 总额 {1}", {"0": tokens(usage.remainingTokens ?? 0), "1": tokens(usage.limitTokens ?? 0)}) : balanceLabel ?? t("额度暂不可用")}</strong>{unlimited && <small>{t("测试模式 · 不限额度")}</small>}{!legacyQuota && !unlimited && snapshot?.wallet?.reservedNanoCny && BigInt(snapshot.wallet.reservedNanoCny) > 0n && <small>{t("请求预留 {0}", { 0: formatCredits(snapshot.wallet.reservedNanoCny) })}</small>}{creditsError && <small>{t("读取失败，可在余额与订阅中刷新。")}</small>}{usage && <small>{t("累计模型用量 {0} tokens", { 0: tokens(usage.committedTokens) })}</small>}</div>}
      <button type="button" ref={firstAction} onClick={() => action(onModels)}><Bot size={16} aria-hidden="true"/>{t("模型与渠道")}</button>
      {connected&&<button type="button" onClick={()=>action(()=>window.dispatchEvent(new Event(PAYMENT_OPEN)))}><Wallet size={16} aria-hidden="true"/>{t('余额与订阅')}</button>}
      <button type="button" onClick={() => action(() => window.dispatchEvent(new Event(DESKTOP_SETTINGS_OPEN)))}><Settings size={16} aria-hidden="true"/>{t("应用设置")}{updateAvailable && <span className="account-update-badge">{t("有更新")}</span>}</button>
      <button type="button" onClick={() => action(onNetwork)}><Network size={16} aria-hidden="true"/>{t("网络与代理")}</button>
      <button type="button" onClick={() => action(onCache)}><HardDrive size={16} aria-hidden="true"/>{t("下载缓存")}</button>
      <button type="button" onClick={() => action(() => window.dispatchEvent(new Event(BACKGROUND_OPEN)))}><Server size={16} aria-hidden="true"/>{t("后台运行")}</button>
      <button type="button" onClick={() => action(() => window.dispatchEvent(new Event(LANGUAGE_OPEN)))}><Globe2 size={16} aria-hidden="true"/>{t("语言")}</button>
      <button type="button" onClick={() => action(onTheme)}>{theme === "light" ? <Moon size={16} aria-hidden="true"/> : <Sun size={16} aria-hidden="true"/>} {theme === "light" ? t("深色外观") : t("浅色外观")}</button>
      <button type="button" aria-pressed={telemetryEnabled} onClick={onTelemetry}><ChartNoAxesColumn size={16} aria-hidden="true"/>{t("下载使用统计：")}{telemetryEnabled ? t("已开启") : t("已关闭")}</button>
      <p className="account-menu-usage">{t("开启后，任务状态、耗时区间和错误类别会关联当前 GeoD 账号；不发送文件路径、坐标或对话内容，可随时关闭。")}</p>
      {connected && <button type="button" className="account-menu-logout" disabled={busy} onClick={() => action(onLogout)}><LogOut size={16} aria-hidden="true"/>{t("退出登录")}</button>}
    </MorphPopoverContent>
  </MorphPopover></div>;
}

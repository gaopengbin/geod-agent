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
import { UiTooltip } from "./ui-tooltip";
import type {DownloadDiagnostic} from './use-download-telemetry';

function tokens(value: number) {
  return `${(value / 1000).toLocaleString(getLocale(), { maximumFractionDigits: 1 })}K`;
}

export function AccountMenu({ open, onOpenChange, connected, userId, profile, profileError, onProfileRefresh, usage, busy, theme, onModels, onNetwork, onCache, onTheme, onLogout, telemetryEnabled, onTelemetry,telemetryDiagnostic,telemetryError=false,telemetryBusy=false, activityEnabled=false, onActivity }: {
  open: boolean; onOpenChange: (value: boolean) => void; connected: boolean; userId: string | null; usage: ModelUsage | null;
  busy: boolean; theme: "light" | "dark"; onNetwork: () => void; onCache: () => void; onTheme: () => void; onLogout: () => void;
  telemetryEnabled: boolean; onTelemetry: () => void; onModels: () => void;
  telemetryDiagnostic?:DownloadDiagnostic|null;telemetryError?:boolean;telemetryBusy?:boolean;
  activityEnabled?: boolean; onActivity?: () => void;
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
      <button type="button" aria-pressed={telemetryEnabled} disabled={!connected||telemetryBusy} onClick={onTelemetry}><ChartNoAxesColumn size={16} aria-hidden="true"/>{t("下载使用统计：")}{telemetryEnabled ? t("已开启") : t("已关闭")}</button>
      {telemetryEnabled&&!telemetryDiagnostic?.diagnosticsEnabled&&<p className="account-menu-usage">{t('仅基础下载结果，详细诊断未开启。')}</p>}<p className="account-menu-usage" role="status">{telemetryError?t('下载统计状态暂不可读，请稍后重试。'):telemetryDiagnostic?.reason==='consent_disabled'?t('未开启下载统计，下载结果不会上报。'):telemetryDiagnostic?.reason==='collector_unavailable'?t('采集器暂不可用，下载不受影响；请重启应用或联系支持。'):telemetryDiagnostic?.reason==='no_download_observed'?t('已开启，尚未观测到新的下载任务。'):telemetryDiagnostic?.reason==='queued'?t('有 {0} 条结果等待上报。',{'0':String(telemetryDiagnostic.queuedEvents)}):telemetryDiagnostic?.reason==='transport_auth'?t('结果已保留，请重新登录后继续上报。'):telemetryDiagnostic?.reason==='transport_network'?t('结果已保留，网络恢复后会继续上报。'):telemetryDiagnostic?.reason==='transport_schema'?t('结果已保留，统计服务需更新后继续上报。'):telemetryDiagnostic?.reason==='reported'?t('最近一次上报已确认。'):telemetryDiagnostic?t('结果已保留，上报暂未确认。'):t('正在读取下载统计状态…')}</p>
      <p className="account-menu-usage">{t("开启后，下载结果及脱敏图源、HTTP 状态、失败阶段、分盘空间数值会关联当前 GeoD 账号；不发送密钥、文件名、完整路径、坐标或对话，可随时关闭。")}</p>
      {connected&&onActivity&&<><UiTooltip side="right" content={t("自愿开启后，启动、自有渠道调用结果与可用 Token 用量会关联当前账号；不发送对话、模型名称、渠道地址或密钥。关闭会清除待上传记录，已发送的请求可能完成。下载统计单独控制。")}><button type="button" aria-pressed={activityEnabled} onClick={onActivity}><ChartNoAxesColumn size={16} aria-hidden="true"/>{t("Agent 使用统计：")}{activityEnabled?t("已开启"):t("已关闭")}</button></UiTooltip><p className="account-menu-usage">{t("自愿关联活跃、自有渠道用量及下载统计是否可用；不上传对话或密钥，下载结果仍由独立开关控制。")}</p></>}
      {connected && <button type="button" className="account-menu-logout" disabled={busy} onClick={() => action(onLogout)}><LogOut size={16} aria-hidden="true"/>{t("退出登录")}</button>}
    </MorphPopoverContent>
  </MorphPopover></div>;
}

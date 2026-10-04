import { useCallback, useEffect, useRef, useState } from "react";
import * as Select from "@radix-ui/react-select";
import { api, desktopAvailable, errorMessage } from "./api";
import { dataSchedules } from "./data-schedules";
import { AiSchedulePanel } from "./ai-schedule-panel";
import { Button } from "./components/motion/button/base";
import { ScrollArea } from "./components/ui/scroll-area";
import { PanelTabs } from "./panel-tabs";
import { UiTooltip } from "./ui-tooltip";
import { Bot, ChevronDown, ChevronRight, Clock3, Download, Loader2, Plus, RefreshCw, X } from "./icons";
import { getLocale, localize, t } from "./i18n";
import "./schedules-page.css";

interface Conversation { conversationId: string; title: string }
type Kind = "ai" | "imagery" | "data";
interface Entry { key: string; id: string; kind: Kind; conversationId: string; name: string; enabled: boolean; nextRunAt: string; repeatSeconds: number | null }
const kindName = (kind: Kind) => t({ ai: "AI 定时执行", imagery: "影像定时下载", data: "矢量与三维定时下载" }[kind]);
const date = (value: string) => new Date(value).toLocaleString(getLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const frequency = (seconds: number | null) => seconds === null ? t("仅一次") : seconds === 3600 ? t("每小时") : seconds === 86400 ? t("每天") : seconds === 604800 ? t("每周") : t("每 {0} 秒", { 0: seconds });

function ConversationSelect({ value, onChange, conversations, all = false, label }: { value: string; onChange: (id: string) => void; conversations: Conversation[]; all?: boolean; label: string }) {
  return <Select.Root value={value} onValueChange={onChange}>
    <Select.Trigger className="select-trigger schedules-conversation-select" aria-label={label}><Select.Value/><Select.Icon><ChevronDown size={15}/></Select.Icon></Select.Trigger>
    <Select.Portal><Select.Content className="select-content" position="popper" sideOffset={6} collisionPadding={8}><Select.Viewport>
      {all && <Select.Item className="select-item" value="all"><Select.ItemText>{t("全部会话")}</Select.ItemText></Select.Item>}
      {conversations.map(conversation => <Select.Item key={conversation.conversationId} className="select-item" value={conversation.conversationId} data-conversation-id={conversation.conversationId}><Select.ItemText>{conversation.title}</Select.ItemText></Select.Item>)}
    </Select.Viewport></Select.Content></Select.Portal>
  </Select.Root>;
}

/** One entrance for all three existing native schedulers; scheduling stays in the background runtime. */
export function SchedulesPage({ active, accountId, conversations, currentConversationId, onOpenConversation, onManageDownload }: {
  active: boolean; accountId: string | null; conversations: Conversation[]; currentConversationId: string;
  onOpenConversation: (id: string) => void; onManageDownload: (id: string) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "enabled" | "stopped">("all"), [scope, setScope] = useState("all");
  const [selected, setSelected] = useState<Entry | null>(null), [creating, setCreating] = useState(false), [createKind, setCreateKind] = useState<"ai" | "download">("ai");
  const [createConversation, setCreateConversation] = useState(""), [working, setWorking] = useState<string | null>(null);
  const revision = useRef(0), mutationScope = useRef(accountId); mutationScope.current = accountId;
  const ids = JSON.stringify([...new Set(conversations.map(conversation => conversation.conversationId))].sort());
  const refresh = useCallback(async () => {
    if (!active || !accountId || !desktopAvailable || mutationScope.current !== accountId) return;
    const request = ++revision.current, conversationIds: string[] = JSON.parse(ids), next: Entry[] = [], failures: string[] = [];
    setLoading(true); setError("");
    // Bound IPC/database concurrency; don't run one polling loop for each conversation.
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(3, conversationIds.length) }, async () => {
      while (cursor < conversationIds.length && revision.current === request) {
        const conversationId = conversationIds[cursor++];
        const results = await Promise.allSettled([api.aiSchedulesList(conversationId), api.schedulesList(conversationId), dataSchedules.list(conversationId)]);
        const [ai, imagery, data] = results;
        if (ai.status === "fulfilled") for (const schedule of ai.value.schedules) next.push({ ...schedule, id: schedule.scheduleId, key: `ai:${schedule.scheduleId}`, kind: "ai" });
        if (imagery.status === "fulfilled") for (const schedule of imagery.value) next.push({ ...schedule, id: schedule.scheduleId, key: `imagery:${schedule.scheduleId}`, kind: "imagery" });
        if (data.status === "fulfilled") for (const schedule of data.value) next.push({ ...schedule, key: `data:${schedule.id}`, kind: "data" });
        for (const result of results) if (result.status === "rejected") failures.push(errorMessage(result.reason));
      }
    }));
    if (revision.current !== request) return;
    setEntries(next.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.nextRunAt.localeCompare(b.nextRunAt) || a.name.localeCompare(b.name)));
    if (failures.length) setError(t("部分任务读取失败：{0}", { 0: [...new Set(failures)].join("；") }));
    setLoading(false);
  }, [active, accountId, ids]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 30_000);
    return () => { ++revision.current; clearInterval(timer); };
  }, [active, refresh]);
  useEffect(() => { setEntries([]); setSelected(null); setCreating(false); setScope("all"); setError(""); setWorking(null); setLoading(false); }, [accountId]);
  useEffect(() => { if (scope !== "all" && !conversations.some(conversation => conversation.conversationId === scope)) setScope("all"); }, [ids, scope, conversations]);

  async function toggle(entry: Entry) {
    if (working || !accountId) return;
    const owner = accountId; setWorking(entry.key); setError("");
    try {
      const next = !entry.enabled && !entry.repeatSeconds ? new Date(Date.now() + 300_000).toISOString() : undefined;
      if (entry.kind === "ai") await api.aiSchedulesSetEnabled(entry.id, !entry.enabled, next);
      else if (entry.kind === "imagery") await api.schedulesSetEnabled(entry.id, !entry.enabled, next);
      else await dataSchedules.setEnabled(entry.id, !entry.enabled, next);
      if (mutationScope.current === owner) await refresh();
    } catch (cause) { if (mutationScope.current === owner) setError(errorMessage(cause)); }
    finally { if (mutationScope.current === owner) setWorking(null); }
  }
  function create() {
    setCreateConversation(scope !== "all" ? scope : conversations.some(conversation => conversation.conversationId === currentConversationId) ? currentConversationId : conversations[0]?.conversationId ?? "");
    setCreateKind("ai"); setSelected(null); setCreating(true);
  }
  const scoped = entries.filter(entry => scope === "all" || entry.conversationId === scope);
  const visible = scoped.filter(entry => filter === "all" || (filter === "enabled" ? entry.enabled : !entry.enabled));
  const current = selected ? entries.find(entry => entry.key === selected.key) : null;
  return <section className="schedules-page" hidden={!active} aria-label={t("定时任务")}>
    <header className="schedules-page-head"><div><h1>{t("定时任务")}</h1><p>{t("统一管理各会话的 AI 执行与数据下载。")}</p></div><div className="schedules-page-actions">
      <UiTooltip content={t("刷新定时任务")}><Button variant="ghost" size="icon" aria-label={t("刷新定时任务")} disabled={loading || !accountId || !desktopAvailable} onClick={() => void refresh()}><RefreshCw size={17} className={loading ? "extension-spin" : ""}/></Button></UiTooltip>
      <Button variant="outline" disabled={!accountId || !desktopAvailable || !conversations.length} onClick={create}><Plus size={16}/>{t("新建任务")}</Button>
    </div></header>
    <div className="schedules-page-toolbar"><PanelTabs label={t("定时任务状态")} value={filter} items={[{ value: "all", label: t("全部 {0}", { 0: scoped.length }) }, { value: "enabled", label: t("已启用 {0}", { 0: scoped.filter(entry => entry.enabled).length }) }, { value: "stopped", label: t("已停止 {0}", { 0: scoped.filter(entry => !entry.enabled).length }) }]} onChange={setFilter}/><ConversationSelect value={scope} onChange={value => { setScope(value); setSelected(null); }} conversations={conversations} all label={t("筛选会话")}/></div>
    <ScrollArea className="schedules-page-scroll" viewportProps={{ "aria-label": t("定时任务列表") }}><div className={`schedules-page-body ${current ? "has-details" : ""}`}>
      {error && <p className="warning-text schedules-page-error" role="alert">{localize(error)}</p>}
      {creating && <section className="schedules-create"><div className="schedules-detail-head"><h2>{t("新建定时任务")}</h2><Button variant="ghost" size="icon" aria-label={t("关闭新建任务")} onClick={() => setCreating(false)}><X size={16}/></Button></div>
        <PanelTabs label={t("定时任务类型")} value={createKind} items={[{ value: "ai", label: t("AI 定时执行") }, { value: "download", label: t("定时下载") }]} onChange={setCreateKind}/>
        <label className="schedules-create-conversation"><span>{t("创建到会话")}</span><ConversationSelect value={createConversation} onChange={setCreateConversation} conversations={conversations} label={t("创建到会话")}/></label>
        {createKind === "ai" && createConversation ? <AiSchedulePanel key={`${accountId}:${createConversation}`} conversationId={createConversation} createOnly onChanged={() => { if (mutationScope.current !== accountId) return; setCreating(false); void refresh(); }}/> : <div className="schedules-download-create"><p>{t("选择会话中的影像、矢量或三维任务，按其范围和参数创建定时下载。")}</p><Button variant="secondary" disabled={!createConversation} onClick={() => onManageDownload(createConversation)}>{t("选择下载任务")}<ChevronRight size={15}/></Button></div>}
      </section>}
      <div className="schedules-page-list" aria-busy={loading}>
        {loading && !entries.length ? <div className="schedules-page-empty"><Loader2 className="extension-spin" size={22}/><p>{t("正在读取定时任务…")}</p></div> : visible.length ? visible.map(entry => <article key={entry.key} className={`schedules-row ${current?.key === entry.key ? "is-selected" : ""}`} data-schedule-id={entry.id}>
          <span className="schedules-row-icon">{entry.kind === "ai" ? <Bot size={19}/> : <Download size={19}/>}</span>
          <Button variant="ghost" className="schedules-row-title" whileHover={undefined} whileTap={undefined} onClick={() => { if (entry.kind === "ai") { setSelected(entry); setCreating(false); } else onManageDownload(entry.conversationId); }} aria-label={t("查看定时任务 {0}", { 0: entry.name })}><strong>{entry.name}</strong><span>{kindName(entry.kind)} · {conversations.find(conversation => conversation.conversationId === entry.conversationId)?.title ?? t("新对话")}</span></Button>
          <div className="schedules-row-time"><span>{entry.enabled ? date(entry.nextRunAt) : t("已停止")}</span><small>{frequency(entry.repeatSeconds)}</small></div>
          <UiTooltip content={entry.enabled ? t("暂停后续触发") : t("启用定时任务")}><Button variant="ghost" size="sm" disabled={!!working} aria-label={t("{0} {1}", { 0: entry.enabled ? t("暂停") : t("启用"), 1: entry.name })} onClick={() => void toggle(entry)}>{working === entry.key ? <Loader2 size={15} className="extension-spin"/> : entry.enabled ? t("暂停") : t("启用")}</Button></UiTooltip>
        </article>) : <div className="schedules-page-empty"><Clock3 size={28}/><h2>{!accountId ? t("登录后管理定时任务") : t("暂无匹配的定时任务")}</h2><p>{!accountId ? t("使用 GeoD 账号查看本机保存的定时任务。") : filter === "all" ? t("创建 AI 执行指令，或从下载任务设置定时获取数据。") : t("切换状态或会话筛选，查看其他任务。")}</p></div>}
        <p className="schedules-runtime-note">{t("关闭窗口后继续由本机后台执行；退出后台或关机后暂停。")}</p>
      </div>
      {current && <aside className="schedules-detail"><div className="schedules-detail-head"><h2>{current.name}</h2><Button variant="ghost" size="icon" aria-label={t("收起定时任务详情")} onClick={() => setSelected(null)}><X size={16}/></Button></div><Button variant="ghost" size="sm" className="schedules-origin" onClick={() => onOpenConversation(current.conversationId)}>{t("打开所属会话")}<ChevronRight size={14}/></Button><AiSchedulePanel key={current.key} conversationId={current.conversationId} scheduleId={current.id} onChanged={() => void refresh()}/></aside>}
    </div></ScrollArea>
  </section>;
}

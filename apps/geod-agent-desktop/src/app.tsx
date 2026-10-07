import { getLocale, t, useLocale } from "./i18n";
// i18n: presentation strings migrated
import { localStateStore, flushLocalState } from "./local-state";
import { CacheManager } from "./cache-manager";
import { BackgroundDialog, BACKGROUND_OPEN } from "./background-dialog";
import { LanguageDialog, LANGUAGE_OPEN } from "./language-dialog";
import { DesktopSettingsDialog, DESKTOP_SETTINGS_OPEN, announceDesktopUpdate } from "./desktop-settings-dialog";
import { MessageCenter } from "./message-center";
import {PaymentDialog,PAYMENT_OPEN} from './payment-dialog';
import { Tiles3dConnections } from "./tiles3d-connections";
import { TILES3D_CONNECTION_OPEN } from "./data-connection-tools";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { MapTrifold, Minus, Square, X } from "./icons";
import { Button } from "@/components/motion/button/base";
import { DataPreviewHost } from "./data-preview-host";
import { DATA_DOWNLOAD_FOCUS } from "./data-downloads";
import { BACKGROUND_COMMAND_FOCUS } from "./background-commands";
import { AGENT_TASK_FOCUS } from "./agent-task-tools";
import { SCHEDULE_FOCUS, consumeScheduleFocus } from "./schedule-navigation";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { UiTooltip } from "./ui-tooltip";
import { AgentPanel, type AgentMainView } from "./agent-panel";
import { useGeoDAuth } from "./geod-auth";
import { LoginScreen } from "./login-screen";
import { GeoDLogin } from "./geod-login";
import { AIChannelsPage } from "./ai-channels-page";
import { MapView } from "./openlayers-map-view";
import { SourcePage } from "./source-page";
import { NetworkDialog } from "./network-dialog";
import { TaskPanel } from "./task-panel";
import { useResizableWorkspace, WorkspaceControls, WorkspaceSidebarToggle } from "./resizable-workspace";
import { buildTaskQueue, runTaskBatch, type QueueTask, type TaskAction } from "./task-queue";
import { useDiscardedPlans } from "./use-task-queue";
import { usePlanPresentations } from "./use-plan-presentations";
import { taskGroupTarget } from "./task-summary";
import type { BackgroundSnapshot } from "./background-jobs";
import { api, desktopAvailable, errorMessage, type ArtifactPreview, type Job, type JobEvent, type Manifest, type PlanTileGrid, type StoredPlan, type SourceRegistrationDraft, type WorkspaceSettings, type ScheduleRun } from "./api";

const emptyTileGrids: PlanTileGrid[] = [];

export function App() {
  useLocale();
  const auth = useGeoDAuth();
  const loginRequired = !auth.ready || auth.status.state !== "connected";
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem("geod-agent-theme");
    return stored === "light" || stored === "dark" ? stored : "light";
  });
  const [plan, setPlan] = useState<StoredPlan | null>(null);
  const [conversationPlanIds, setConversationPlanIds] = useState<string[]>([]);
  const [conversationPlans, setConversationPlans] = useState<StoredPlan[]>([]);
  const [scheduledPlans,setScheduledPlans]=useState<StoredPlan[]>([]);
  const [scheduleTemplateIds,setScheduleTemplateIds]=useState<string[]>([]);
  const [scheduleTitles,setScheduleTitles]=useState<Record<string,string>>({});
  const [accountId, setAccountId] = useState<string | null>(null);
  const [taskSnapshots, setTaskSnapshots] = useState<Record<string, BackgroundSnapshot>>({});
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJobs, setActiveJobs] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [sourceDraft, setSourceDraft] = useState<SourceRegistrationDraft | null>(null);
  const [sourceReviewConversationId, setSourceReviewConversationId] = useState<string | null>(null);
  const [registeredSource, setRegisteredSource] = useState<{ eventId: string; conversationId: string; sourceId: string; displayName: string } | null>(null);
  const [cacheManagerOpen, setCacheManagerOpen] = useState(false);
  const [backgroundDialogOpen, setBackgroundDialogOpen] = useState(false);
  const [languageDialogOpen, setLanguageDialogOpen] = useState(false);
  const [desktopSettingsOpen, setDesktopSettingsOpen] = useState(false);
  const [paymentDialogOpen,setPaymentDialogOpen]=useState(false);
  const [tiles3dConnections, setTiles3dConnections] = useState<{ connectionId?: string } | null>(null);
  const [networkDialogOpen, setNetworkDialogOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [taskFocusIds, setTaskFocusIds] = useState<string[]>([]);
  const [emptyConversation, setEmptyConversation] = useState(true);
  const [manualMapOpen, setManualMapOpen] = useState(false);
  const [mainView, setMainView] = useState<AgentMainView>("conversation");
  const [mapConversationId, setMapConversationId] = useState("");
  const [workspaceState, setWorkspaceState] = useState<{ conversationId: string; permission: WorkspaceSettings["permission"] | null } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const failed = (event: Event) => setError(errorMessage((event as CustomEvent).detail));
    window.addEventListener("geod-state-storage-error", failed);
    return () => window.removeEventListener("geod-state-storage-error", failed);
  }, []);
  const focusedConversation = emptyConversation && !manualMapOpen;
  const layout = useResizableWorkspace(mainView !== "conversation" || focusedConversation ? "focus" : resultsOpen ? "tasks" : "map");
  useEffect(() => { setManualMapOpen(false); }, [mapConversationId]);
  useEffect(() => {
    const open = () => setBackgroundDialogOpen(true);
    window.addEventListener(BACKGROUND_OPEN, open);
    return () => window.removeEventListener(BACKGROUND_OPEN, open);
  }, []);
  const revealMap = () => { setManualMapOpen(true); setMainView("conversation"); layout.show("map"); };
  useEffect(() => {
    const open = () => setLanguageDialogOpen(true);
    window.addEventListener(LANGUAGE_OPEN, open);
    return () => window.removeEventListener(LANGUAGE_OPEN, open);
  }, []);
  useEffect(() => {
    const open = () => setDesktopSettingsOpen(true);
    window.addEventListener(DESKTOP_SETTINGS_OPEN, open);
    return () => window.removeEventListener(DESKTOP_SETTINGS_OPEN, open);
  }, []);
  useEffect(()=>{const open=()=>setPaymentDialogOpen(true);window.addEventListener(PAYMENT_OPEN,open);return()=>window.removeEventListener(PAYMENT_OPEN,open);},[]);
  useEffect(() => {
    if (!desktopAvailable) return;
    let disposed = false;
    void api.desktopSettings().then(async settings => {
      if (disposed || !settings.updateConfigured || !settings.automaticUpdateChecks) return;
      const last = settings.lastUpdateCheck ? new Date(settings.lastUpdateCheck).getTime() : 0;
      if (Number.isFinite(last) && Date.now() - last < 24 * 60 * 60 * 1000) return;
      const update = await api.desktopUpdateCheck();
      if (!disposed) announceDesktopUpdate(update);
    }).catch(() => { /* Manual checks display actionable errors in application settings. */ });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    const open = (event: Event) => setTiles3dConnections({ connectionId: (event as CustomEvent).detail?.connectionId });
    window.addEventListener(TILES3D_CONNECTION_OPEN, open);
    return () => window.removeEventListener(TILES3D_CONNECTION_OPEN, open);
  }, []);
  useEffect(() => {
    const focus = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.conversationId !== mapConversationId) return;
      setManualMapOpen(true); setResultsOpen(true); setTaskFocusIds([]); setMainView("conversation"); layout.show("tasks");
    };
    window.addEventListener(DATA_DOWNLOAD_FOCUS, focus);
    return () => window.removeEventListener(DATA_DOWNLOAD_FOCUS, focus);
  }, [mapConversationId, layout.show]);
  useEffect(() => { layout.show("conversation"); }, [mapConversationId, mainView]);
  useEffect(() => {
    const focus = (event: Event) => {
      if ((event as CustomEvent).detail?.conversationId !== mapConversationId) return;
      setResultsOpen(true); setTaskFocusIds([]); setMainView("conversation"); layout.show("tasks");
    };
    window.addEventListener(BACKGROUND_COMMAND_FOCUS, focus);
    window.addEventListener(AGENT_TASK_FOCUS, focus);
    return () => { window.removeEventListener(BACKGROUND_COMMAND_FOCUS, focus); window.removeEventListener(AGENT_TASK_FOCUS, focus); };
  }, [mapConversationId, layout.show]);
  useEffect(() => {
    const focus = () => {
      if (!consumeScheduleFocus(mapConversationId)) return;
      setManualMapOpen(true); setResultsOpen(true); setTaskFocusIds([]); setMainView("conversation"); layout.show("tasks");
    };
    window.addEventListener(SCHEDULE_FOCUS, focus); focus();
    return () => window.removeEventListener(SCHEDULE_FOCUS, focus);
  }, [mapConversationId, mainView, layout.show]);
  const busy = useRef(false);
  const eventSeq = useRef(0);
  const previewLoaded = useRef<string | null>(null);
  const conversationChoice = useRef(0);
  const selectedPlanId = useRef(plan?.planId);
  selectedPlanId.current = plan?.planId;
  const taskScope = useRef({ accountId, conversationId: mapConversationId });
  taskScope.current = { accountId, conversationId: mapConversationId };
  const discarded = useDiscardedPlans(accountId, mapConversationId);
  const presentations = usePlanPresentations(accountId, mapConversationId);
  useEffect(()=>{setScheduledPlans([]);setScheduleTitles({});setScheduleTemplateIds([]);if(!desktopAvailable||!accountId||!mapConversationId)return;let disposed=false,loading=false;async function load(){if(loading)return;loading=true;try{const [runs,schedules]=await Promise.all([api.schedulesRuns(mapConversationId),api.schedulesList(mapConversationId)]);const ids=[...new Set(runs.map(run=>run.planId).filter((id):id is string=>!!id))];const plans=await Promise.all(ids.map(id=>api.plansGet(id)));if(!disposed){setScheduleTemplateIds(schedules.map(s=>s.templatePlanId).filter((id):id is string=>!!id));setScheduledPlans(plans.filter((plan):plan is StoredPlan=>!!plan));setScheduleTitles(Object.fromEntries(runs.filter(run=>run.planId).map(run=>[run.planId!,`${schedules.find(schedule=>schedule.scheduleId===run.scheduleId)?.name??'定时影像'} · ${new Date(run.scheduledAt).toLocaleDateString(getLocale())}`])));void refreshJobs().catch(cause=>{if(!disposed)setError(errorMessage(cause));});}}catch(cause){if(!disposed)setError(errorMessage(cause));}finally{loading=false;}}void load();const timer=setInterval(()=>void load(),5000);return()=>{disposed=true;clearInterval(timer);};},[accountId,mapConversationId]);
  useEffect(() => { setTaskFocusIds([]); }, [accountId, mapConversationId]);
  function handleTitlebarMouseDown(event: MouseEvent<HTMLElement>) {
    if (!desktopAvailable || event.button !== 0 || (event.target as HTMLElement).closest("button, a, input, select, textarea, [role='button']")) return;
    const window = getCurrentWindow();
    void (event.detail === 2 ? window.toggleMaximize() : window.startDragging());
  }
  const refreshJobs = useCallback(async () => {
    const [list, active] = await Promise.all([api.jobsList(), api.jobsActive()]);
    setJobs(list);
    setActiveJobs(active);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem("geod-agent-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!desktopAvailable) return;
    Promise.all([api.jobsList(), api.jobsActive()])
      .then(([loadedJobs, active]) => { setJobs(loadedJobs); setActiveJobs(active); })
      .catch(cause => setError(errorMessage(cause)));
  }, []);

  useEffect(() => {
    if (!job || !desktopAvailable) return;
    let stopped = false;
    let polling = false;
    async function refresh() {
      if (polling) return;
      polling = true;
      try {
        const [fresh, freshEvents] = await Promise.all([api.jobsGet(job!.jobId), api.jobsEvents(job!.jobId, eventSeq.current)]);
        if (stopped || !fresh) return;
        setJob(fresh);
        if (freshEvents.length) {
          eventSeq.current = freshEvents.at(-1)!.seq;
          setEvents(current => [...current, ...freshEvents].slice(-500));
        }
        if ((fresh.state === "completed" || fresh.state === "partial") && previewLoaded.current !== fresh.jobId) {
          const [checked, image] = await Promise.all([api.artifactsInspect(fresh.jobId), api.artifactPreview(fresh.jobId)]);
          if (!stopped) {
            setManifest(checked);
            setPreview(image);
            previewLoaded.current = fresh.jobId;
          }
        }
        await refreshJobs();
      } catch (cause) { if (!stopped) setError(errorMessage(cause)); }
      finally { polling = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1800);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [job?.jobId, refreshJobs]);

  async function taskAction(action: TaskAction, ids: string[]) {
    if (busy.current) throw new Error("正在处理任务，请稍候。");
    const account = accountId, conversation = mapConversationId;
    if (!account || !conversation) throw new Error("请先登录并选择会话。");
    const targets = [...new Set(ids)].map(id => allPlans.find(item => item.planId === id));
    if (!targets.length || targets.some(item => !item)) throw new Error("计划不属于当前会话，请刷新任务列表。");
    busy.current = true; setWorking(true); setError("");
    const currentScope = () => taskScope.current.accountId === account && taskScope.current.conversationId === conversation;
    try {
      if(action==='discard'){const runs=await api.schedulesRuns(conversation);for(const run of runs.filter(run=>run.planId&&ids.includes(run.planId)&&!run.jobId&&!['succeeded','failed','cancelled'].includes(run.state)))await api.schedulesCancelRun(run.runId);}
      const result = await runTaskBatch(api, localStateStore, account, conversation, targets as StoredPlan[], action,
        workspaceState?.conversationId === conversation && workspaceState.permission === "fullAccess");
      await flushLocalState();
      await refreshJobs();
      const refreshedPlans = action === "start" ? await Promise.all(result.succeeded.map(item => api.plansGet(item.planId))) : [];
      if (currentScope()) {
        const refreshed = new Map(refreshedPlans.filter((item): item is StoredPlan => item !== null).map(item => [item.planId, item]));
        if (refreshed.size) {
          setConversationPlans(current => current.map(item => refreshed.get(item.planId) ?? item));
          setScheduledPlans(current => current.map(item => refreshed.get(item.planId) ?? item));
          setPlan(current => current ? refreshed.get(current.planId) ?? current : current);
        }
        const updated = result.succeeded.find(item => item.planId === selectedPlanId.current);
        if (updated?.job) { setJob(updated.job); setEvents([]); eventSeq.current = 0; setManifest(null); setPreview(null); previewLoaded.current = null; }
        const labels = { start: "已启动", discard: "已丢弃", cancel: "已请求取消", restore: "已恢复计划" };
        if (result.succeeded.length) setNotice(`${labels[action]} ${result.succeeded.length} 项${action === "cancel" ? "，后台将在当前瓦片请求结束后停止。" : "。"}`);
      }
      if (result.failed.length) throw new Error(result.failed.map(item => `${presentations[item.planId]?.title ?? conversationPlans.find(plan => plan.planId === item.planId)?.plan.sourceName ?? "计划"}：${item.message}`).join("\n"));
    } catch (cause) { if (currentScope()) setError(errorMessage(cause)); throw cause; }
    finally { busy.current = false; setWorking(false); }
  }
  const startJob = (stored: StoredPlan) => taskAction("start", [stored.planId]);
  const discardPlan = (stored: StoredPlan) => taskAction("discard", [stored.planId]);

  async function selectJob(item: Job) {
    setTaskFocusIds(current => current.includes(item.planId) ? current : []);
    const choice = ++conversationChoice.current;
    eventSeq.current = 0;
    setPlan(conversationPlans.find(stored => stored.planId === item.planId) ?? null);
    setError(""); setNotice(""); setManifest(null); setPreview(null); previewLoaded.current = null; setEvents([]); setJob(item); setResultsOpen(true);
    try {
      const stored = await api.plansGet(item.planId);
      if (choice === conversationChoice.current && stored) setPlan(stored);
    } catch (cause) { if (choice === conversationChoice.current) setError(errorMessage(cause)); }
  }

  function selectTask(task: QueueTask) {
    setResultsOpen(true);
    if (selectedPlanId.current === task.stored.planId) return;
    ++conversationChoice.current;
    eventSeq.current = 0; previewLoaded.current = null;
    setPlan(task.stored); setJob(task.job); setEvents([]); setManifest(null); setPreview(null); setError(""); setNotice(""); setResultsOpen(true);
  }
  async function openScheduleRun(run:ScheduleRun){if(!run.planId)return;const scope=taskScope.current;const [stored,existing]=await Promise.all([api.plansGet(run.planId),api.jobsForPlan(run.planId)]);if(!stored||taskScope.current.conversationId!==scope.conversationId||taskScope.current.accountId!==scope.accountId)return;selectTask({stored,job:existing,state:'pending',title:scheduleTitles[run.planId]??'定时影像'} as QueueTask);}

  function openTaskGroup(planIds: string[]) {
    const target = taskGroupTarget(tasks, planIds, selectedPlanId.current);
    if (!target) return;
    setTaskFocusIds(planIds.filter(id => conversationPlanIds.includes(id)));
    selectTask(target);
    layout.show("tasks");
  }

  async function selectConversationPlan(planIds: string[], conversationId: string) {
    const choice = ++conversationChoice.current;
    setMapConversationId(conversationId);
    setConversationPlanIds(planIds);
    setConversationPlans([]);
    setTaskFocusIds([]);
    const planId = planIds.at(-1);
    eventSeq.current = 0;
    setPlan(null); setJob(null); setManifest(null); setPreview(null); previewLoaded.current = null; setEvents([]); setNotice(""); setError("");
    if (!planId) { setResultsOpen(false); return; }
    try {
      const [storedPlans, existingJob] = await Promise.all([Promise.all(planIds.map(id => api.plansGet(id))), api.jobsForPlan(planId)]);
      if (choice !== conversationChoice.current) return;
      setConversationPlans(storedPlans.filter((item): item is StoredPlan => !!item));
      setPlan(storedPlans.at(-1) ?? null);
      setJob(existingJob);
      setResultsOpen(true);
      void refreshJobs().catch(cause => { if (choice === conversationChoice.current) setError(errorMessage(cause)); });
    } catch (cause) { if (choice === conversationChoice.current) setError(errorMessage(cause)); }
  }

  async function cancelJob() {
    if (!job) return;
    try { await taskAction("cancel", [job.planId]); } catch { /* taskAction exposes the actual failure. */ }
  }

  async function pauseJob() {
    if (!job || busy.current) return;
    const selected = job;
    busy.current = true; setWorking(true); setError("");
    try {
      const paused = await api.jobsPause(selected.jobId);
      if (selectedPlanId.current === selected.planId) {
        setJob(paused);
        setNotice("已请求暂停；当前瓦片完成后保存检查点，再停止下载。");
      }
      await refreshJobs();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }

  async function resumeJob() {
    if (!job || busy.current) return;
    const selected = job;
    const wasVerifying = job.state === "verifying";
    busy.current = true; setWorking(true); setError("");
    try {
      const resumed = await api.jobsResume(selected.jobId);
      if (selectedPlanId.current === selected.planId) {
        setJob(resumed);
        setNotice(wasVerifying ? resumed.state === "completed" ? "本机成果重新核验通过，作业已完成。" : resumed.state === "partial" ? "本机成果已核验，但仍有缺失瓦片；请查看成果清单。" : "成果核验未通过，请查看作业错误并检查输出文件。" : "已恢复作业；本机会核验瓦片检查点并只补取缺失瓦片。");
      }
      await refreshJobs();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }

  const allPlans=[...new Map([...conversationPlans,...scheduledPlans].map(plan=>[plan.planId,plan])).values()];
  const allPlanIds=allPlans.map(plan=>plan.planId);
  const conversationJobs = jobs.filter(item => allPlanIds.includes(item.planId));
  const queueJobs = job ? [...conversationJobs, job] : conversationJobs;
  const tasks = buildTaskQueue(allPlans, queueJobs, activeJobs, discarded, taskSnapshots).map(task => ({ ...task, title: presentations[task.stored.planId]?.title ?? scheduleTitles[task.stored.planId] ?? task.stored.plan.sourceName, ...(scheduleTemplateIds.includes(task.stored.planId)&&!task.job?{state: 'scheduled'}:{}) }));
  const latestProgress = [...events].reverse().find(event => event.completedTiles !== undefined && event.totalTiles);
  const mapCompletedTiles = job ? job.state === "completed" ? plan?.plan.totalTiles ?? 0 : latestProgress?.completedTiles ?? 0 : null;

  return <div className="app-shell">
    <header className="app-header custom-titlebar" onMouseDown={handleTitlebarMouseDown}>
      <div className="brand"><img src="/geod-symbol.png" alt="" /><strong>GeoD <span>Agent</span></strong></div>
      {!loginRequired && <WorkspaceSidebarToggle layout={layout}/>}
      {!loginRequired && focusedConversation && mainView === "conversation" && <Button variant="ghost" size="sm" className="empty-map-entry" onClick={revealMap}><MapTrifold size={16}/>{t("地图选范围")}</Button>}
      {!loginRequired && <WorkspaceControls layout={layout} focused={focusedConversation || mainView !== "conversation"} tasksOpen={resultsOpen} onTasksChange={setResultsOpen}/>}
      <div className="header-right">
        {desktopAvailable&&!loginRequired&&<MessageCenter accountId={accountId} desktop={desktopAvailable}/>}
        {!desktopAvailable && <UiTooltip content={t("浏览器仅用于界面预览，本机操作请使用桌面应用。")} side="bottom"><span className="preview-label">{t("界面预览")}</span></UiTooltip>}
        {desktopAvailable && <div className="window-controls">
          <UiTooltip content={t("最小化")} side="bottom"><button type="button" aria-label={t("最小化")} onClick={() => void getCurrentWindow().minimize()}><Minus size={16} /></button></UiTooltip>
          <UiTooltip content={t("最大化或还原")} side="bottom"><button type="button" aria-label={t("最大化或还原")} onClick={() => void getCurrentWindow().toggleMaximize()}><Square size={13} /></button></UiTooltip>
          <UiTooltip content={t("关闭窗口")} side="bottom"><button type="button" className="window-close" aria-label={t("关闭窗口")} onClick={() => void getCurrentWindow().close()}><X size={17} /></button></UiTooltip>
        </div>}
      </div>
    </header>
    {loginRequired && <LoginScreen theme={theme} onNetwork={() => setNetworkDialogOpen(true)} onLanguage={() => setLanguageDialogOpen(true)} onTheme={() => setTheme(current => current === "light" ? "dark" : "light")}><GeoDLogin auth={auth}/></LoginScreen>}
    <div hidden={loginRequired} ref={layout.ref} style={layout.style} {...layout.attributes} onKeyDown={event => { if (event.key === "Escape") layout.setSidebarExpanded(false); }} className={`workspace ai-workspace resizable-workspace ${layout.dragging ? "panels-resizing" : ""} ${mainView !== "conversation" ? "management-page" : ""} ${focusedConversation ? "new-chat" : ""} ${resultsOpen ? "results-open" : ""}`}>
      <AgentPanel auth={auth} onAccountChange={setAccountId} onBackgroundSnapshots={setTaskSnapshots} ledgerJobs={jobs} onOpenJob={item => void selectJob(item)} onWorkspaceChange={setWorkspaceState} onConversationChange={setMapConversationId} registeredSource={registeredSource} onOpenSources={(draft, originConversationId) => { setSourceDraft(draft ?? null); setSourceReviewConversationId(originConversationId ?? null); setMainView("sources"); }} onOpenNetwork={() => setNetworkDialogOpen(true)} onOpenCache={() => setCacheManagerOpen(true)} onToggleTheme={() => setTheme(current => current === "light" ? "dark" : "light")} onEmptyConversationChange={setEmptyConversation} mainView={mainView} onMainViewChange={view => { setMainView(view); if (view === "conversation") { setSourceDraft(null); setSourceReviewConversationId(null); } }} theme={theme} onSelectConversation={(planIds, conversationId) => void selectConversationPlan(planIds, conversationId)} conversationTasks={tasks} onTaskGroupSelect={openTaskGroup} selectedJob={job} onJobStarted={(started,originConversationId) => {
        if(taskScope.current.conversationId===originConversationId)void selectJob(started);
        void refreshJobs().catch(cause => setError(errorMessage(cause)));
      }} onPlanned={(created,originConversationId) => {
        if(taskScope.current.conversationId!==originConversationId)return;
        setTaskFocusIds([]);
        ++conversationChoice.current;
        setConversationPlans(current => current.some(item => item.planId === created.planId) ? current : [...current, created]);
        setConversationPlanIds(current => current.includes(created.planId) ? current : [...current, created.planId]);
        setPlan(created); setJob(null); setManifest(null); setPreview(null); previewLoaded.current = null; setEvents([]); setError("");
        setResultsOpen(true);
        setNotice("Agent 已生成计划。执行方式按当前工作区权限处理。");
      }} />
      <main className="map-column" hidden={focusedConversation}><MapView key={mapConversationId} conversationId={mapConversationId} bounds={plan?.plan.spec.bounds ?? null} boundary={plan?.plan.spec.boundary ?? null} tileGrids={plan?.plan.tileGrids ?? emptyTileGrids} completedTiles={mapCompletedTiles} preview={preview} missingTiles={manifest?.quality.missingTiles ?? 0} theme={theme} /><DataPreviewHost key={`data-${mapConversationId}`} conversationId={mapConversationId} onShowMap={revealMap}/></main>
      <aside id="agent-results" className="right-panel task-panel panel-scroll" aria-label={t("任务与成果")} hidden={focusedConversation || !resultsOpen}>
        <TaskPanel key={mapConversationId} conversationId={mapConversationId} onOpenScheduleRun={run=>void openScheduleRun(run).catch(cause=>setError(errorMessage(cause)))} tasks={tasks} focusPlanIds={taskFocusIds} onClearTaskFocus={() => setTaskFocusIds([])} onTaskSelect={selectTask} onTaskAction={taskAction} onStart={startJob} onDiscard={discardPlan} permission={workspaceState?.conversationId === mapConversationId ? workspaceState.permission : null} plan={plan} job={job} events={events} manifest={manifest} jobs={conversationJobs} activeJobs={activeJobs} working={working} error={error} notice={notice}
          onClose={() => { setResultsOpen(false); layout.show("conversation"); }} onClearError={() => setError("")} onClearNotice={() => setNotice("")}
          onRefresh={() => void refreshJobs().catch(cause => setError(errorMessage(cause)))}
          onSelect={item => void selectJob(item)} onResume={() => void resumeJob()} onPause={() => void pauseJob()} onCancel={() => void cancelJob()} />
      </aside>
      <SourcePage active={mainView === "sources"} draft={sourceDraft} reviewing={!!sourceReviewConversationId} onOpenConnections={() => setTiles3dConnections({})} onReturn={() => { setMainView("conversation"); setSourceDraft(null); setSourceReviewConversationId(null); }} onSaved={saved => {
        if (sourceReviewConversationId) {
          setMainView("conversation");
          setRegisteredSource({ eventId: crypto.randomUUID(), conversationId: sourceReviewConversationId, sourceId: saved.id, displayName: saved.displayName });
          setSourceDraft(null); setSourceReviewConversationId(null);
        }
        setNotice(`已登记图源：${saved.displayName}。`);
      }} />
      <AIChannelsPage active={mainView === "models"} accountId={accountId} onReturn={() => setMainView("conversation")}/>
      {layout.separators}
      {layout.sidebarExpanded && <button type="button" className="workspace-nav-scrim" aria-label={t("收起会话列表")} onClick={() => layout.setSidebarExpanded(false)}/>}
    </div>
    {cacheManagerOpen && <CacheManager onClose={() => setCacheManagerOpen(false)}/>}
    {backgroundDialogOpen && <BackgroundDialog onClose={() => setBackgroundDialogOpen(false)}/>}
    <LanguageDialog open={languageDialogOpen} onOpenChange={setLanguageDialogOpen}/>
    {desktopSettingsOpen && <DesktopSettingsDialog onClose={() => setDesktopSettingsOpen(false)}/>}
    {paymentDialogOpen&&<PaymentDialog key={accountId??'signed-out'} accountId={accountId} onClose={()=>setPaymentDialogOpen(false)}/>}
    {tiles3dConnections && <Tiles3dConnections initialConnectionId={tiles3dConnections.connectionId} onClose={() => setTiles3dConnections(null)}/>}
    {networkDialogOpen && <NetworkDialog onClose={() => setNetworkDialogOpen(false)} onSaved={status => setNotice(`网络连接方式已更新：${status.source}。`)} />}
  </div>;
}

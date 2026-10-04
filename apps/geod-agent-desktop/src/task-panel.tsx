import { getLocale, localize, t } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useState } from "react";
import { ChevronDown, CircleAlert, FileCheck2, RefreshCw, X } from "./icons";
import { Button } from "@/components/motion/button/base";
import { UiTooltip } from "./ui-tooltip";
import { displayPath } from "./path-display";
import { pendingPlanLabel } from "./agent-workflow";
import { desktopAvailable, type Job, type JobEvent, type Manifest, type StoredPlan, type WorkspaceSettings } from "./api";
import { jobExecutionState, tileProgressFacts } from "./job-runtime";
import { UnifiedTaskQueueView } from "./unified-task-queue-view";
import { DataTaskDetails } from "./data-task-details";
import { useDataDownloads } from "./use-data-downloads";
import { DATA_DOWNLOAD_FOCUS, dataTaskEntry } from "./data-downloads";
import { PlanReviewCard } from "./plan-review-card";
import { type QueueTask, type TaskAction } from "./task-queue";
import { PanelTabs } from "./panel-tabs";
import { SchedulePanel } from "./schedule-panel";
import { AiSchedulePanel } from "./ai-schedule-panel";
import { BackgroundCommandPanel } from "./background-command-panel";
import { BACKGROUND_COMMAND_FOCUS, pendingCommandFocus } from "./background-commands";
import { AgentTaskPanel } from "./agent-task-panel";
import { AGENT_TASK_FOCUS, pendingAgentFocus } from "./agent-task-tools";
import { DataSchedulePanel } from "./data-schedule-panel";
import { SCHEDULE_FOCUS, pendingScheduleFocus } from "./schedule-navigation";
import { ImageryRecoveryActions, presentImageryRecovery } from "./imagery-recovery";
import type { ScheduleRun } from "./api";

const states: Record<string, string> = { queued: "排队中", downloading: "下载中", paused: "已暂停", processing: "处理中", verifying: "核验中", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
const count = (n: number) => new Intl.NumberFormat("zh-CN").format(n);
const size = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${count(n)} B`;
const time = (s: string) => new Date(s).toLocaleString(getLocale(), { hour12: false });

// Tile checkpoints feed the live progress bar, not the user-facing activity history.
function taskMilestones(events: JobEvent[]) {
  const milestones: { event: JobEvent; label: string }[] = [];
  for (const event of events) {
    if (event.completedTiles !== undefined && !event.errorCode) continue;
    const previous = milestones.at(-1)?.event;
    if (previous?.state === event.state && previous.errorCode === event.errorCode) continue;
    const labels: Record<string, string> = {
      queued: previous?.state === "paused" ? "恢复任务" : previous?.state === "failed" ? "重试任务" : "任务已创建",
      downloading: "开始下载", paused: "暂停任务", processing: "处理影像", verifying: "核验成果",
      completed: "成果已核验", partial: "部分成果已保存", failed: "执行失败", cancelled: "取消任务",
    };
    milestones.push({ event, label: labels[event.state] ?? states[event.state] ?? event.state });
  }
  return milestones;
}

function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return <section className="task-disclosure">
    <Button variant="ghost" size="sm" whileHover={undefined} whileTap={undefined} className="task-disclosure-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>{localize(label)}<ChevronDown size={16} className={open ? "is-open" : ""} /></Button>
    {open && <div className="task-disclosure-content">{children}</div>}
  </section>;
}

export function TaskPanel({ conversationId, onOpenScheduleRun, plan: stored, permission, job, events, manifest, activeJobs, working, error, notice, onClose, onClearError, onClearNotice, onRefresh, onResume, onPause, onCancel, tasks, focusPlanIds, onClearTaskFocus, onTaskSelect, onTaskAction, onStart, onDiscard }: {
  conversationId?:string; onOpenScheduleRun?:(run:ScheduleRun)=>void;
  onClose?: () => void;
  permission?: WorkspaceSettings["permission"] | null;
  plan: StoredPlan | null; job: Job | null; events: JobEvent[]; manifest: Manifest | null; jobs?: Job[]; activeJobs: string[];
  working: boolean; error: string; notice: string; onClearError: () => void; onClearNotice: () => void;
  onRefresh: () => void; onSelect?: (job: Job) => void; onResume: () => void; onPause: () => void; onCancel: () => void;
  tasks: QueueTask[]; onTaskSelect: (task: QueueTask) => void; onTaskAction: (action: TaskAction, ids: string[]) => Promise<void>;
  focusPlanIds?: string[]; onClearTaskFocus?: () => void;
  onStart: (plan: StoredPlan) => Promise<void>; onDiscard: (plan: StoredPlan) => Promise<void>;
}) {
  const [view, setView] = useState<"task" | "results" | "input" | "schedule" | "commands" | "agents">(() => conversationId && pendingScheduleFocus(conversationId) ? "schedule" : conversationId && pendingAgentFocus(conversationId) ? "agents" : conversationId && pendingCommandFocus(conversationId) ? "commands" : "task");
  useEffect(() => {
    const focus = (event: Event) => { if ((event as CustomEvent).detail?.conversationId === conversationId) setView("commands"); };
    const agentFocus = (event: Event) => { if ((event as CustomEvent).detail?.conversationId === conversationId) setView("agents"); };
    const scheduleFocus = (event: Event) => { if ((event as CustomEvent).detail?.conversationId === conversationId) setView("schedule"); };
    window.addEventListener(BACKGROUND_COMMAND_FOCUS, focus);
    window.addEventListener(AGENT_TASK_FOCUS, agentFocus);
    window.addEventListener(SCHEDULE_FOCUS, scheduleFocus);
    return () => { window.removeEventListener(BACKGROUND_COMMAND_FOCUS, focus); window.removeEventListener(AGENT_TASK_FOCUS, agentFocus); window.removeEventListener(SCHEDULE_FOCUS, scheduleFocus); };
  }, [conversationId]);
  const data = useDataDownloads(conversationId);
  const [dataTaskId, setDataTaskId] = useState<string | null>(null);
  const dataTask = data.tasks.find(task => task.id === dataTaskId);
  useEffect(() => { setDataTaskId(null); }, [stored?.planId]);
  useEffect(() => { if (!stored && !dataTaskId && data.tasks.length) setDataTaskId(data.tasks[0].id); }, [stored, dataTaskId, data.tasks]);
  useEffect(() => {
    const focus = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.conversationId === conversationId) { setDataTaskId(detail.taskId); setView("task"); onClearTaskFocus?.(); data.refresh(); }
    };
    window.addEventListener(DATA_DOWNLOAD_FOCUS, focus);
    return () => window.removeEventListener(DATA_DOWNLOAD_FOCUS, focus);
  }, [conversationId, data.refresh, onClearTaskFocus]);
  const plan = stored?.plan;
  const title = tasks.find(task => task.stored.planId === stored?.planId)?.title ?? plan?.sourceName;
  const progress = tileProgressFacts(events, plan?.totalTiles ?? 0);
  const percent = job?.state === "completed" ? 100 : progress.totalTiles ? Math.min(100, 100 * (progress.completedTiles ?? 0) / progress.totalTiles) : 0;
  const running = !!job && activeJobs.includes(job.jobId);
  const executionState = job ? jobExecutionState(job, running) : null;
  const discarded = tasks.some(task => task.stored.planId === stored?.planId && task.state === "discarded");
  const scheduledTemplate = tasks.some(task => task.stored.planId === stored?.planId && task.state === "scheduled");
  const visibleNotice = notice && !notice.startsWith("任务已入账") && !notice.startsWith("Agent 已生成计划");
  const milestones = taskMilestones(events);
  return <>
    <div className="task-panel-heading"><h2>{t("任务与成果")}</h2><div className="task-heading-actions"><UiTooltip content={t("刷新任务")} side="left"><Button variant="ghost" size="icon" aria-label={t("刷新任务")} disabled={!desktopAvailable || working} onClick={() => { onRefresh(); data.refresh(); }}><RefreshCw size={17} /></Button></UiTooltip>{onClose && <UiTooltip content={t("收起任务与成果")} side="left"><Button variant="ghost" size="icon" aria-label={t("收起任务与成果")} onClick={onClose}><X size={16}/></Button></UiTooltip>}</div></div>
    {view !== 'schedule' && view !== 'commands' && view !== 'agents' && <UnifiedTaskQueueView tasks={tasks} additionalTasks={data.tasks.map(dataTaskEntry)} selectedId={dataTaskId ?? stored?.planId} permission={permission} working={working} focusPlanIds={focusPlanIds} onClearFocus={onClearTaskFocus} onSelect={task => { setDataTaskId(null); onTaskSelect(task); }} onAction={onTaskAction} onAdditionalSelect={id => { setDataTaskId(id); setView("task"); }} onAdditionalAction={data.action}/>}
    <PanelTabs label={t("选中任务视图")} value={view} onChange={setView} items={[{value:"task",label:"任务详情"},{value:"results",label:"成果"},{value:"input",label:"输入范围"},...(conversationId?[{value:"schedule" as const,label:"定时"},{value:"commands" as const,label:"后台命令"},{value:"agents" as const,label:"子任务"}]:[])]}/>
    <ScrollArea className="task-detail-area" viewportClassName="task-detail-scroll panel-scroll" viewportProps={{role:"tabpanel", "aria-label":{task:"任务详情",results:"成果",input:"输入范围",schedule:"定时任务",commands:"后台命令",agents:"独立子任务"}[view]}}>
    {error && <div className="task-feedback error-box" role="alert"><CircleAlert size={17} /><span>{localize(error)}</span><Button variant="ghost" size="icon" aria-label={t("关闭错误")} onClick={onClearError}><X size={16} /></Button></div>}
    {visibleNotice && <div className="task-feedback"><span>{localize(notice)}</span><Button variant="ghost" size="icon" aria-label={t("关闭提示")} onClick={onClearNotice}><X size={16} /></Button></div>}
    {data.error && <p className="warning-text" role="alert">{data.error}</p>}
    {view==='agents'&&conversationId?<AgentTaskPanel key={conversationId} conversationId={conversationId}/>:view==='commands'&&conversationId?<BackgroundCommandPanel key={conversationId} conversationId={conversationId} permission={permission}/>:view==='schedule'&&conversationId?<><AiSchedulePanel conversationId={conversationId}/><SchedulePanel conversationId={conversationId} plan={dataTask ? null : stored} title={title} onOpenRun={run=>{setView('task');onOpenScheduleRun?.(run);}} onChanged={onRefresh}/><DataSchedulePanel conversationId={conversationId} task={dataTask ?? null} onChanged={data.refresh}/></>:dataTask ? <DataTaskDetails key={dataTask.id} task={dataTask} view={view === "schedule" || view === "commands" || view === "agents" ? "task" : view} permission={permission}/> : !plan ? <p className="task-empty">{t("生成计划后，在这里查看任务进度和成果。")}</p> : <>
      <section className="task-overview">
        <div className="task-source"><h3>{title}</h3><span className={`state-pill state-${discarded ? "discarded" : executionState ?? "queued"}`}>{scheduledTemplate?t("定时模板"):discarded ? t("已丢弃") : executionState ? states[executionState] : pendingPlanLabel(permission)}</span></div>
        <p className="task-subtitle">{plan.sourceName}<span>·</span>Z{plan.spec.zoomLevels.join(", ")}<span>·</span>{plan.spec.outputFormats.map(outputFormatLabel).join(" + ")}</p>
        {view === "task" && <>
        {job && conversationId && <ImageryRecoveryActions conversationId={conversationId} job={job} workerActive={running} disabled={working} missingTiles={manifest?.quality.missingTiles} onPlanned={async result => { presentImageryRecovery(conversationId, result); if (result.permission === "fullAccess") await onStart(result.stored); }}/ >}
        {job && <div className="task-progress">
          <div className="task-progress-caption"><span>{progress.completedTiles !== undefined ? t("{0} / {1} 瓦片{2}", {"0": count(progress.completedTiles), "1": count(progress.totalTiles), "2": progress.checkingCache && running ? " · 检查缓存" : ""}) : job.state === "completed" ? t("文件已核验") : t("等待进度")}</span><strong>{Math.round(percent)}%</strong></div>
          <div className="progress-track" role="progressbar" aria-label={t("任务进度")} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${percent}%` }} /></div>
          {["queued", "downloading", "paused", "verifying", "failed"].includes(job.state) && <div className="task-actions">
            {!running && <Button variant="secondary" size="sm" disabled={working} onClick={onResume}>{job.state === "failed" ? t("重试") : job.state === "verifying" ? t("重新核验") : t("恢复")}</Button>}
            {["queued", "downloading"].includes(job.state) && running && <Button variant="secondary" size="sm" disabled={working} onClick={onPause}>{t("暂停")}</Button>}
            {!["failed", "verifying"].includes(job.state) && <Button variant="ghost" size="sm" disabled={working} onClick={onCancel}>{t("取消")}</Button>}
          </div>}
          {job.state === "downloading" && !running && <p className="warning-text">{t("下载已中断，可恢复已有进度。")}</p>}
        </div>}
        <dl className="task-facts"><div><dt>{t("瓦片数量")}</dt><dd>{count(plan.totalTiles)}</dd></div>{plan.requiredFreeDiskBytes ? <div><dt>{t("预留空间")}</dt><dd>{size(plan.requiredFreeDiskBytes)}</dd></div> : null}<div className="task-dimensions"><dt>{t("输出尺寸")}</dt><dd>{plan.tileGrids.map(g => `${g.pixelWidth} × ${g.pixelHeight}`).join(" / ")}</dd></div></dl>
        {!job && (scheduledTemplate?<div className="task-discarded"><p>{t("这是定时任务的范围和参数模板。到时会生成独立计划与成果目录。")}</p><Button variant="secondary" size="sm" onClick={()=>setView('schedule')}>{t("查看定时任务")}</Button></div>:discarded ? <div className="task-discarded"><p>{t("此计划已从待处理列表移出。")}</p><Button variant="secondary" size="sm" disabled={working} onClick={() => void onTaskAction("restore", [stored!.planId]).catch(() => {})}>{t("恢复计划")}</Button></div> : <PlanReviewCard key={stored!.planId} stored={stored!} compact externalErrors permission={permission} working={working} onStart={onStart} onDiscard={onDiscard}/>)}
        </>}
      </section>
      {view === "task" && job?.state === "failed" && events.at(-1)?.errorCode === "DISK_INSUFFICIENT" && <p className="disk-failure">{t("保存位置或缓存空间不足。释放空间后重试，可沿用已有瓦片。")}</p>}
      {view === "results" && (manifest ? <section className="task-artifacts"><div className="task-section-heading"><FileCheck2 size={18} /><h3>{t("成果文件")}</h3><span>{manifest.quality.status === "partial" ? t("部分完成") : t("已核验")}</span></div>{manifest.assets.map(asset => <div className="task-asset" key={asset.id}><div><strong>{asset.kind}</strong><UiTooltip content={displayPath(asset.path)} side="left"><span tabIndex={0}>{displayPath(asset.path).split(/[\\/]/).at(-1)}</span></UiTooltip></div><span>{size(asset.bytes)}</span></div>)}{manifest.quality.missingTiles > 0 && <p className="warning-text">{t("缺失 ")}{count(manifest.quality.missingTiles)} {t(" 个瓦片")}</p>}{manifest.quality.warnings.map((warning, index) => <p key={index} className="warning-text">{warning}</p>)}</section> : <p className="task-empty">{t("此任务尚无已核验的成果。完成后会显示文件和核验结果。")}</p>)}
      {view === "input" && <section className="task-input-summary"><h4>{t("裁剪范围")}</h4><dl className="task-detail-list"><div><dt>{t("类型")}</dt><dd>{plan.spec.boundary ? t("多边形 · {0} 个面", {"0": plan.spec.boundary.polygons.length}) : t("矩形范围")}</dd></div><div><dt>{t("坐标系")}</dt><dd>WGS84 / EPSG:4326</dd></div><div><dt>{t("范围")}</dt><dd>{plan.spec.bounds.map(n => n.toFixed(4)).join(", ")}</dd></div></dl><p>{plan.spec.boundary ? t("GeoTIFF、PNG 和 JPEG 按边界裁剪；瓦片容器保留源瓦片。") : t("按计划中的经纬度范围输出。")}</p></section>}
      {view === "task" && <><Disclosure label={t("参数与保存位置")}>
        <div className="task-output"><span>{t("保存位置")}</span><span className="task-full-path">{displayPath(plan.spec.outputDirectory)}</span></div>
        <dl className="task-detail-list"><div><dt>{t("范围")}</dt><dd>{plan.spec.bounds.map(n => n.toFixed(4)).join(", ")}</dd></div><div><dt>{t("解码量")}</dt><dd>{size(plan.decodedRgbaBytes)}</dd></div><div><dt>{t("许可")}</dt><dd>{plan.license || t("未提供")}</dd></div><div><dt>{t("署名")}</dt><dd>{plan.attribution}</dd></div><div><dt>{t("到期")}</dt><dd>{time(plan.expiresAt)}</dd></div><div><dt>{t("计划 ID")}</dt><dd>{stored!.planId}</dd></div><div><dt>SHA-256</dt><dd>{plan.planHash}</dd></div>{job && <div><dt>{t("作业 ID")}</dt><dd>{job.jobId}</dd></div>}</dl>
        {plan.spec.boundary && <p>{t("范围包含 ")}{plan.spec.boundary.polygons.length} {t(" 个面。GeoTIFF、PNG 和 JPEG 按边界裁剪；瓦片容器保留源瓦片。")}</p>}
      </Disclosure>
      {milestones.length > 0 && <Disclosure label={t("关键记录")}><div className="task-events">{milestones.slice(-20).map(({ event, label }) => <div key={event.seq}><span>{localize(label)}{event.errorCode ? ` · ${event.errorCode}` : ""}</span><time>{new Date(event.occurredAt).toLocaleTimeString(getLocale(), { hour12: false })}</time></div>)}</div></Disclosure>}</>}
    </>}
    </ScrollArea>
  </>;
}
import { ScrollArea } from "@/components/ui/scroll-area";
import { outputFormatLabel } from "./output-formats";

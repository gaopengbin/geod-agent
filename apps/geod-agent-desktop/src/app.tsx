import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowDownToLine, CheckCircle2, CircleAlert, FileCheck2, Globe2, Moon, PanelRightClose, PanelRightOpen, RefreshCw, ShieldCheck, Sun, X } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { AgentPanel } from "./agent-panel";
import { MapView } from "./map-view";
import { SourceDialog } from "./source-dialog";
import { api, desktopAvailable, errorMessage, type ArtifactPreview, type Job, type JobEvent, type Manifest, type PlanTileGrid, type SourceDescriptor, type StoredPlan } from "./api";

const stateName: Record<string, string> = { queued: "排队中", downloading: "下载中", paused: "已暂停", processing: "处理中", verifying: "核验中", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消" };
const count = (n: number) => new Intl.NumberFormat("zh-CN").format(n);
const size = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${count(n)} B`;
const time = (s: string) => new Date(s).toLocaleString("zh-CN", { hour12: false });
const emptyTileGrids: PlanTileGrid[] = [];

export function App() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem("geod-agent-theme");
    return stored === "light" || stored === "dark" ? stored : "light";
  });
  const [sources, setSources] = useState<SourceDescriptor[]>([]);
  const [plan, setPlan] = useState<StoredPlan | null>(null);
  const [approved, setApproved] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJobs, setActiveJobs] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const eventSeq = useRef(0);
  const previewLoaded = useRef<string | null>(null);
  const conversationChoice = useRef(0);
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
    Promise.all([api.sourcesList(), api.jobsList(), api.jobsActive()])
      .then(([loadedSources, loadedJobs, active]) => { setSources(loadedSources); setJobs(loadedJobs); setActiveJobs(active); })
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
        if (fresh.state === "completed" && previewLoaded.current !== fresh.jobId) {
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

  async function startJob() {
    if (!plan || !approved || busy.current) return;
    busy.current = true; setWorking(true); setError("");
    try {
      const existing = await api.jobsForPlan(plan.planId);
      if (existing) {
        eventSeq.current = 0;
        setJob(existing); setEvents([]); setManifest(null); setPreview(null); previewLoaded.current = null;
        setApproved(false);
        setNotice("该计划已有本机作业，已恢复其状态；不会重复下载。");
        await refreshJobs();
        return;
      }
      const approval = await api.approvalsGrant(plan.planId, plan.plan.planHash);
      const started = await api.jobsStart(plan.planId, plan.plan.planHash, approval.approvalId, crypto.randomUUID());
      eventSeq.current = 0;
      setJob(started); setEvents([]); setManifest(null); setPreview(null); previewLoaded.current = null;
      setNotice("任务已入账并开始执行。进度以本机记录为准。");
      await refreshJobs();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }

  async function selectJob(item: Job) {
    eventSeq.current = 0;
    setError(""); setNotice(""); setManifest(null); setPreview(null); previewLoaded.current = null; setEvents([]); setJob(item); setResultsOpen(true);
    try {
      const stored = await api.plansGet(item.planId);
      if (stored) { setPlan(stored); setApproved(false); }
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function selectConversationPlan(planId: string | null) {
    const choice = ++conversationChoice.current;
    eventSeq.current = 0;
    setPlan(null); setJob(null); setManifest(null); setPreview(null); previewLoaded.current = null; setEvents([]); setApproved(false); setNotice(""); setError("");
    if (!planId) { setResultsOpen(false); return; }
    try {
      const [stored, existingJob] = await Promise.all([api.plansGet(planId), api.jobsForPlan(planId)]);
      if (choice !== conversationChoice.current) return;
      setPlan(stored);
      setJob(existingJob);
      setResultsOpen(true);
    } catch (cause) { if (choice === conversationChoice.current) setError(errorMessage(cause)); }
  }

  async function cancelJob() {
    if (!job || busy.current) return;
    busy.current = true; setWorking(true); setError("");
    try {
      setJob(await api.jobsCancel(job.jobId));
      setNotice("已请求取消；当前瓦片请求结束后会停止，未发布的临时成果不会成为正式输出。");
      await refreshJobs();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }

  async function pauseJob() {
    if (!job || busy.current) return;
    busy.current = true; setWorking(true); setError("");
    try {
      setJob(await api.jobsPause(job.jobId));
      setNotice("已请求暂停；当前瓦片完成后保存检查点，再停止下载。");
      await refreshJobs();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }

  async function resumeJob() {
    if (!job || busy.current) return;
    busy.current = true; setWorking(true); setError("");
    try {
      setJob(await api.jobsResume(job.jobId));
      setNotice("已恢复作业；本机会核验瓦片检查点并只补取缺失瓦片。");
      await refreshJobs();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }

  const latestProgress = [...events].reverse().find(event => event.completedTiles !== undefined && event.totalTiles);
  const progressPercent = job?.state === "completed" ? 100 : latestProgress ? 100 * (latestProgress.completedTiles ?? 0) / (latestProgress.totalTiles ?? 1) : 0;
  const mapCompletedTiles = job ? job.state === "completed" ? plan?.plan.totalTiles ?? 0 : latestProgress?.completedTiles ?? 0 : null;

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><img src="/geod-symbol.png" alt="" /><div><strong>GeoD <span>Agent</span></strong><small>AI 影像任务工作台</small></div></div>
      <div className="header-right"><span className={`connection ${desktopAvailable ? "online" : "offline"}`}><i />{desktopAvailable ? "本地引擎已连接" : "浏览器预览"}</span><Button variant="ghost" size="icon" aria-label={theme === "light" ? "切换到暗色主题" : "切换到亮色主题"} title={theme === "light" ? "暗色主题" : "亮色主题"} onClick={() => setTheme(current => current === "light" ? "dark" : "light")}>{theme === "light" ? <Moon size={17} /> : <Sun size={17} />}</Button><Button variant="ghost" size="icon" aria-label={resultsOpen ? "收起成果页" : "展开成果页"} title={resultsOpen ? "收起成果页" : "展开成果页"} aria-expanded={resultsOpen} aria-controls="agent-results" onClick={() => setResultsOpen(current => !current)}>{resultsOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</Button><span className="version">ALPHA 0.1</span></div>
    </header>
    <div className={`workspace ai-workspace ${resultsOpen ? "results-open" : ""}`}>
      <AgentPanel onOpenSources={() => setSourceDialogOpen(true)} onSelectConversation={planId => void selectConversationPlan(planId)} onPlanned={created => {
        setPlan(created); setJob(null); setManifest(null); setPreview(null); previewLoaded.current = null; setEvents([]); setApproved(false); setError("");
        setResultsOpen(true);
        setNotice("Agent 已生成计划。请核对图源、范围、格式和本机保存路径，再确认下载。");
      }} />
      <main className="map-column"><MapView bounds={plan?.plan.spec.bounds ?? null} boundary={plan?.plan.spec.boundary ?? null} tileGrids={plan?.plan.tileGrids ?? emptyTileGrids} completedTiles={mapCompletedTiles} preview={preview} theme={theme} /><div className="map-footer"><div><span className="small-dot" />WGS84 / EPSG:4326</div><span>{preview ? "OSM 底图上叠加已校验影像；可缩放和平移。" : plan ? "蓝色格网是计划瓦片；绿色范围表示已读取，成果仍需核验。" : "OSM 底图显示计划范围；成果按真实坐标叠加。"}</span></div></main>
      <aside id="agent-results" className="right-panel panel-scroll" aria-label="成果页" hidden={!resultsOpen}>
        <div className="right-heading"><div><span className="eyebrow">MISSION CONTROL</span><h2>计划与执行</h2></div><Button variant="ghost" size="icon" aria-label="刷新任务" disabled={!desktopAvailable} onClick={() => void refreshJobs().catch(cause => setError(errorMessage(cause)))}><RefreshCw size={17} /></Button></div>
        {error && <div className="error-box"><CircleAlert size={17} />{error}<button type="button" onClick={() => setError("")} aria-label="关闭错误"><X size={14} /></button></div>}
        {notice && <div className="success-box"><CheckCircle2 size={17} />{notice}</div>}
        <div className="source-status"><ShieldCheck size={15} />{sources.length ? `已授权 ${sources.length} 个图源` : "尚无授权图源，请先在对话区登记"}</div>
        <section className="summary-card"><div className="card-kicker"><span className="live-indicator" />{job ? "作业计划" : plan ? "待确认计划" : "等待 Agent 计划"}</div><h3>{plan ? plan.plan.sourceName : "描述目标后生成计划"}</h3><p>{plan ? `${plan.plan.spec.bounds.map(n => n.toFixed(4)).join(" · ")} / Z${plan.plan.spec.zoomLevels.join(", ")}` : "GeoD Agent 会整理图源、范围和格式；这里展示确定性估算及保存位置。"}</p>{plan && <><div className="metric-grid"><div><strong>{count(plan.plan.totalTiles)}</strong><span>瓦片</span></div><div><strong>{plan.plan.tileGrids.map(g => `${g.pixelWidth} × ${g.pixelHeight}`).join(" / ")}</strong><span>输出像素</span></div><div><strong>{size(plan.plan.decodedRgbaBytes)}</strong><span>解码量</span></div></div><div className="plan-detail"><span>图源许可</span><strong>{plan.plan.license}</strong></div><div className="plan-detail"><span>署名</span><strong>{plan.plan.attribution}</strong></div><div className="plan-detail"><span>输出格式</span><strong>{plan.plan.spec.outputFormats.join(" + ")}</strong></div><div className="plan-detail"><span>本机保存位置</span><strong className="path-value">{plan.plan.spec.outputDirectory}</strong></div><div className="plan-detail"><span>到期时间</span><strong>{time(plan.plan.expiresAt)}</strong></div><div className="plan-hash">计划 SHA-256：{plan.plan.planHash.slice(0, 12)}…</div></>}</section>
        {plan?.plan.requiredFreeDiskBytes ? <div className="disk-budget"><span>建议预留空闲空间</span><strong>{size(plan.plan.requiredFreeDiskBytes)}</strong><small>执行前会检查保存位置和缓存位置；这是保守预算，实际文件大小可能不同。</small></div> : null}
        {plan?.plan.spec.boundary && <div className="boundary-plan-note"><Globe2 size={15} /><span>已按 {plan.plan.spec.boundary.polygons.length} 个面确定范围。GeoTIFF 和预览透明裁剪；MBTiles 保留完整源瓦片。</span></div>}
        {plan && !job && <section className="approval-card"><div className="approval-title"><ShieldCheck size={20} /><strong>计划确认</strong></div><p>核对 AI 提出的图源、范围、格式和自动建议的本机保存位置。确认后才会访问图源并写入文件。</p><label className="check-row"><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)} /><span>我已核对并同意执行此计划</span></label><Button className="wide-button" disabled={!approved || working || !desktopAvailable} onClick={startJob}><ArrowDownToLine size={17} />{working ? "正在启动…" : "确认并开始下载"}</Button></section>}
        {job && <section className="job-card"><div className="job-title"><div><span className="eyebrow">LOCAL EXECUTION</span><h3>作业 {job.jobId.slice(0, 8)}</h3></div><span className={`state-pill state-${job.state}`}>{stateName[job.state]}</span></div><div className="progress-track"><span style={{ width: `${progressPercent}%` }} /></div><p className="progress-caption">{latestProgress ? `${count(latestProgress.completedTiles ?? 0)} / ${count(latestProgress.totalTiles ?? 0)} 瓦片` : job.state === "completed" ? "文件与清单已核验" : "等待瓦片进度"} · {stateName[job.state]}</p><div className="event-list">{events.slice(-6).map(event => <div key={event.seq}><span className="event-dot" /><span>{stateName[event.state]}{event.completedTiles !== undefined ? ` · ${count(event.completedTiles)} / ${count(event.totalTiles ?? 0)} 瓦片` : ""}{event.errorCode ? ` · ${event.errorCode}` : ""}</span><time>{time(event.occurredAt)}</time></div>)}</div>{["queued", "downloading", "paused", "failed"].includes(job.state) && <div className="job-actions">{!activeJobs.includes(job.jobId) && <Button variant="secondary" size="sm" disabled={working} onClick={resumeJob}>{job.state === "failed" ? "重试作业" : "恢复作业"}</Button>}{["queued", "downloading"].includes(job.state) && activeJobs.includes(job.jobId) && <Button variant="secondary" size="sm" disabled={working} onClick={pauseJob}>暂停作业</Button>}{job.state !== "failed" && <Button variant="outline" size="sm" disabled={working} onClick={cancelJob}>取消作业</Button>}</div>}{job.state === "downloading" && !activeJobs.includes(job.jobId) && <p className="warning-text">应用中断后可恢复；会先检查本机已缓存瓦片。</p>}</section>}
        {job?.state === "failed" && events.at(-1)?.errorCode === "DISK_INSUFFICIENT" && <p className="disk-failure">保存位置或缓存位置空间不足。释放空间后点击“重试作业”，会沿用原计划和已有瓦片。</p>}
        {manifest && <section className="artifact-card"><div className="artifact-heading"><FileCheck2 size={19} /><strong>已核验成果</strong><span>{manifest.quality.status}</span></div><p>依据本机清单重新检查文件、尺寸与 SHA-256。</p>{manifest.assets.map(asset => <div className="asset-row" key={asset.id}><div><strong>{asset.kind}</strong><small>{asset.path}</small></div><span>{size(asset.bytes)}</span></div>)}<div className="plan-detail"><span>缺失瓦片</span><strong>{manifest.quality.missingTiles}</strong></div>{manifest.quality.warnings.map((warning, index) => <p key={index} className="warning-text">{warning}</p>)}</section>}
        <section className="history"><div className="history-head"><h3>最近任务</h3><span>{jobs.length}</span></div>{jobs.length ? jobs.slice(0, 6).map(item => <button type="button" className={`history-item ${job?.jobId === item.jobId ? "active" : ""}`} key={item.jobId} onClick={() => void selectJob(item)}><span className="history-icon"><Globe2 size={17} /></span><span><strong>{item.jobId.slice(0, 8)}</strong><small>{time(item.createdAt)}</small></span><em>{stateName[item.state]}</em></button>) : <div className="history-empty">尚无本地任务。确认 Agent 计划后会出现在这里。</div>}</section>
        <div className="left-note"><Activity size={15} />影像处理在本机执行。模型回复不代表任务完成，成果以上方核验状态为准。</div>
      </aside>
    </div>
    {sourceDialogOpen && <SourceDialog onClose={() => setSourceDialogOpen(false)} onSaved={saved => {
      setSources(current => [saved, ...current.filter(source => source.id !== saved.id)]);
      setSourceDialogOpen(false);
      setNotice(`已登记图源：${saved.displayName}。现在可以请 Agent 规划影像。`);
    }} />}
  </div>;
}

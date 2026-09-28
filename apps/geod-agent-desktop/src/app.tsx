import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Activity, ArrowDownToLine, ArrowRight, Bot, Check, CheckCircle2, CircleAlert, Database, FileCheck2, FolderOpen, Globe2, Layers3, MapPinned, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { AgentPanel } from "./agent-panel";
import { MapView } from "./map-view";
import { SourceDialog } from "./source-dialog";
import { api, desktopAvailable, errorMessage, type Bounds, type Job, type JobEvent, type Manifest, type OutputFormat, type SourceDescriptor, type StoredPlan, type TaskSpec } from "./api";

const initialBounds: Bounds = [116.25, 39.8, 116.55, 40.05];
const stateName: Record<string, string> = { queued: "排队中", downloading: "下载中", paused: "已暂停", processing: "处理中", verifying: "核验中", completed: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消" };
const count = (n: number) => new Intl.NumberFormat("zh-CN").format(n);
const size = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${count(n)} B`;
const time = (s: string) => new Date(s).toLocaleString("zh-CN", { hour12: false });
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span className="field-label">{label}</span>{children}</label>; }

export function App() {
  const [sources, setSources] = useState<SourceDescriptor[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [bounds, setBounds] = useState<Bounds>(initialBounds);
  const [zoom, setZoom] = useState(10);
  const [formats, setFormats] = useState<OutputFormat[]>(["geotiff", "mbtiles"]);
  const [directory, setDirectory] = useState("");
  const [plan, setPlan] = useState<StoredPlan | null>(null);
  const [approved, setApproved] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [activeJobs, setActiveJobs] = useState<string[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [dialog, setDialog] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const busy = useRef(false);
  const eventSeq = useRef(0);
  const source = sources.find(item => item.id === sourceId);
  const invalidate = () => { setPlan(null); setJob(null); setManifest(null); setApproved(false); setNotice(""); };
  const refreshJobs = useCallback(async () => { const [list, active] = await Promise.all([api.jobsList(), api.jobsActive()]); setJobs(list); setActiveJobs(active); }, []);

  useEffect(() => {
    if (!desktopAvailable) return;
    Promise.all([api.sourcesList(), api.jobsList(), api.jobsActive()]).then(([loadedSources, loadedJobs, active]) => { setSources(loadedSources); setSourceId(loadedSources[0]?.id ?? ""); setJobs(loadedJobs); setActiveJobs(active); }).catch(cause => setError(errorMessage(cause)));
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
        if (freshEvents.length) { eventSeq.current = freshEvents.at(-1)!.seq; setEvents(current => [...current, ...freshEvents].slice(-500)); }
        if (fresh.state === "completed") { const checked = await api.artifactsInspect(fresh.jobId); if (!stopped) setManifest(checked); }
        await refreshJobs();
      } catch (cause) { if (!stopped) setError(errorMessage(cause)); }
      finally { polling = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1800);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [job?.jobId, refreshJobs]);

  async function chooseDirectory() {
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择 GeoD Agent 成果的上级文件夹" });
      if (typeof selected === "string") {
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
        const separator = selected.includes("\\") ? "\\" : "/";
        setDirectory(`${selected.replace(/[\\/]$/, "")}${separator}GeoD-Agent-${stamp}-${crypto.randomUUID().slice(0, 6)}`);
        invalidate();
      }
    }
    catch (cause) { setError(errorMessage(cause)); }
  }
  async function createPlan() {
    if (busy.current) return;
    if (!sourceId || !directory || !formats.length) { setError("请选择图源、保存文件夹和至少一种格式。"); return; }
    if (bounds.some(n => !Number.isFinite(n)) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) { setError("范围必须满足西 < 东、南 < 北。"); return; }
    busy.current = true; setWorking(true); setError(""); setNotice("");
    const spec: TaskSpec = { schemaVersion: "0.1", kind: "imagery", sourceId, bounds, zoomLevels: [zoom], outputFormats: formats, outputDirectory: directory, limits: { maxTiles: 4096, maxDecodedRgbaBytes: 512 * 1024 * 1024 } };
    try { const created = await api.plansCreate(spec); setPlan(created); setJob(null); setApproved(false); setNotice("计划已生成，请核对右侧信息。"); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }
  async function startJob() {
    if (!plan || !approved || busy.current) return;
    busy.current = true; setWorking(true); setError("");
    try {
      const approval = await api.approvalsGrant(plan.planId, plan.plan.planHash);
      const started = await api.jobsStart(plan.planId, plan.plan.planHash, approval.approvalId, crypto.randomUUID());
      eventSeq.current = 0; setJob(started); setEvents([]); setManifest(null); setNotice("任务已入账并开始执行。进度以本机记录为准。"); await refreshJobs();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }
  async function selectJob(item: Job) {
    eventSeq.current = Math.max(0, item.version - 500); setError(""); setManifest(null); setEvents([]); setJob(item);
    try { const stored = await api.plansGet(item.planId); if (stored) { setPlan(stored); setApproved(false); } }
    catch (cause) { setError(errorMessage(cause)); }
  }
  async function cancelJob() {
    if (!job || busy.current) return;
    busy.current = true; setWorking(true); setError("");
    try { setJob(await api.jobsCancel(job.jobId)); setNotice("已请求取消；当前瓦片请求结束后会停止，未发布的临时成果不会成为正式输出。"); await refreshJobs(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }
  async function pauseJob() {
    if (!job || busy.current) return;
    busy.current = true; setWorking(true); setError("");
    try { setJob(await api.jobsPause(job.jobId)); setNotice("已请求暂停；当前瓦片完成后保存检查点，再停止下载。"); await refreshJobs(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }
  async function resumeJob() {
    if (!job || busy.current) return;
    busy.current = true; setWorking(true); setError("");
    try { const resumed = await api.jobsResume(job.jobId); setJob(resumed); setNotice("已恢复作业；本机会核验瓦片检查点并只补取缺失瓦片。"); await refreshJobs(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { busy.current = false; setWorking(false); }
  }
  function setCoordinate(index: number, value: string) { const next = [...bounds] as Bounds; next[index] = Number(value); setBounds(next); invalidate(); }
  function toggleFormat(format: OutputFormat) { setFormats(current => current.includes(format) ? current.filter(f => f !== format) : [...current, format]); invalidate(); }
  const latestProgress = [...events].reverse().find(event => event.completedTiles !== undefined && event.totalTiles);
  const progressPercent = job?.state === "completed" ? 100 : latestProgress ? 100 * (latestProgress.completedTiles ?? 0) / (latestProgress.totalTiles ?? 1) : 0;

  return <div className="app-shell">
    <header className="app-header"><div className="brand"><img src="/geod-symbol.png" alt="" /><div><strong>GeoD <span>Agent</span></strong><small>本地影像工作台</small></div></div><nav aria-label="工作区导航"><span className="nav-active"><MapPinned size={16} />工作区</span><button type="button" className="nav-agent" onClick={() => setAgentOpen(true)}><Bot size={16} />智能助手</button></nav><div className="header-right"><span className={`connection ${desktopAvailable ? "online" : "offline"}`}><i />{desktopAvailable ? "本地引擎已连接" : "浏览器预览"}</span><span className="version">ALPHA 0.1</span></div></header>
    <div className="workspace">
      <aside className="left-panel panel-scroll"><div className="panel-heading"><div><span className="eyebrow">NEW TASK</span><h1>创建影像任务</h1><p>规划范围，再确认具体下载计划。</p></div><div className="step-count">01 / 03</div></div>
        {!desktopAvailable && <div className="info-box"><CircleAlert size={17} />此页面为界面预览。实际图源、计划和下载请在桌面程序中操作。</div>}
        <section className="form-section"><div className="section-title"><span className="section-index">01</span><h2>数据来源</h2></div><Field label="授权图源"><select value={sourceId} disabled={!desktopAvailable || !sources.length} onChange={e => { setSourceId(e.target.value); invalidate(); }}><option value="">{sources.length ? "选择图源" : "尚未登记图源"}</option>{sources.map(s => <option key={s.id} value={s.id}>{s.displayName}</option>)}</select></Field>{source && <div className="source-meta"><ShieldCheck size={16} /><span>{source.license} · {source.scheme} · {source.tileSize}px<br /><em>{source.attribution}</em></span></div>}<Button variant="outline" size="sm" className="subtle-button" disabled={!desktopAvailable} onClick={() => setDialog(true)}><Plus size={15} />登记新图源</Button></section>
        <section className="form-section"><div className="section-title"><span className="section-index">02</span><h2>选择范围</h2></div><p className="section-help">地图拖框或输入 WGS84 经纬度。初始范围仅供试用。</p><div className="bounds-grid">{["西 W", "南 S", "东 E", "北 N"].map((label, i) => <Field key={label} label={label}><input type="number" step="0.000001" value={bounds[i]} onChange={e => setCoordinate(i, e.target.value)} /></Field>)}</div><Field label="缩放级别"><div className="range-line"><input type="range" min={source?.minZoom ?? 0} max={source?.maxZoom ?? 18} value={zoom} onChange={e => { setZoom(Number(e.target.value)); invalidate(); }} /><strong>Z{zoom}</strong></div></Field></section>
        <section className="form-section"><div className="section-title"><span className="section-index">03</span><h2>输出成果</h2></div><div className="format-row">{(["geotiff", "mbtiles"] as OutputFormat[]).map(format => <button className={`format-card ${formats.includes(format) ? "selected" : ""}`} key={format} type="button" onClick={() => toggleFormat(format)}>{format === "geotiff" ? <Layers3 size={19} /> : <Database size={19} />}<strong>{format === "geotiff" ? "GeoTIFF" : "MBTiles"}</strong><small>{format === "geotiff" ? "带坐标栅格" : "离线瓦片包"}</small><span className="format-check"><Check size={13} /></span></button>)}</div><Field label="保存位置"><button type="button" className="directory-picker" disabled={!desktopAvailable} onClick={chooseDirectory}><FolderOpen size={17} /><span>{directory || "选择成果的上级文件夹"}</span><ArrowRight size={16} /></button></Field><Button className="wide-button" disabled={!desktopAvailable || working || !sourceId || !directory || !formats.length} onClick={createPlan}>{working ? "正在生成…" : "生成下载计划"}<ArrowRight size={16} /></Button></section>
        <div className="left-note"><Activity size={15} />影像处理在本机执行。打开智能助手可登录 GeoD，查询图源与规划任务。</div>
      </aside>
      <main className="map-column"><MapView bounds={bounds} onBoundsChange={value => { setBounds(value); invalidate(); }} /><div className="map-footer"><div><span className="small-dot" />WGS84 / EPSG:4326</div><span>影像来自授权图源；地图仅显示经纬网与范围。</span></div></main>
      <aside className="right-panel panel-scroll"><div className="right-heading"><div><span className="eyebrow">MISSION CONTROL</span><h2>计划与执行</h2></div><Button variant="ghost" size="icon" aria-label="刷新任务" disabled={!desktopAvailable} onClick={() => void refreshJobs().catch(cause => setError(errorMessage(cause)))}><RefreshCw size={17} /></Button></div>
        {error && <div className="error-box"><CircleAlert size={17} />{error}<button type="button" onClick={() => setError("")} aria-label="关闭错误"><X size={14} /></button></div>}{notice && <div className="success-box"><CheckCircle2 size={17} />{notice}</div>}
        <section className="summary-card"><div className="card-kicker"><span className="live-indicator" />{plan ? "待确认计划" : "等待计划"}</div><h3>{plan ? plan.plan.sourceName : "先设置任务参数"}</h3><p>{plan ? `${plan.plan.spec.bounds.map(n => n.toFixed(4)).join(" · ")} / Z${plan.plan.spec.zoomLevels.join(", ")}` : "完成左侧设置后，这里显示实际瓦片数量、授权来源与保存路径。"}</p>{plan && <><div className="metric-grid"><div><strong>{count(plan.plan.totalTiles)}</strong><span>瓦片</span></div><div><strong>{plan.plan.tileGrids.map(g => `${g.pixelWidth} × ${g.pixelHeight}`).join(" / ")}</strong><span>输出像素</span></div><div><strong>{size(plan.plan.decodedRgbaBytes)}</strong><span>解码量</span></div></div><div className="plan-detail"><span>覆盖边界</span><strong>{plan.plan.tileGrids.map(g => g.actualBounds.map(n => n.toFixed(3)).join(", ")).join(" / ")}</strong></div><div className="plan-detail"><span>授权 / 署名</span><strong>{plan.plan.license} · {plan.plan.attribution}</strong></div><div className="plan-detail"><span>输出文件夹</span><strong className="path-value">{plan.plan.spec.outputDirectory}</strong></div><div className="plan-detail"><span>到期时间</span><strong>{time(plan.plan.expiresAt)}</strong></div><div className="plan-hash">计划 SHA-256：{plan.plan.planHash.slice(0, 12)}…</div></>}</section>
        {plan && !job && <section className="approval-card"><div className="approval-title"><ShieldCheck size={20} /><strong>下载确认</strong></div><p>请核对图源许可、范围、瓦片数量和本机输出位置。确认后才会访问图源并写入文件。</p><label className="check-row"><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} /><span>我已核对并同意执行此计划</span></label><Button className="wide-button" disabled={!approved || working || !desktopAvailable} onClick={startJob}><ArrowDownToLine size={17} />{working ? "正在启动…" : "确认并开始下载"}</Button></section>}
        {job && <section className="job-card"><div className="job-title"><div><span className="eyebrow">LOCAL EXECUTION</span><h3>作业 {job.jobId.slice(0, 8)}</h3></div><span className={`state-pill state-${job.state}`}>{stateName[job.state]}</span></div><div className="progress-track"><span style={{ width: `${progressPercent}%` }} /></div><p className="progress-caption">{latestProgress ? `${count(latestProgress.completedTiles ?? 0)} / ${count(latestProgress.totalTiles ?? 0)} 瓦片` : job.state === "completed" ? "文件与清单已核验" : "等待瓦片进度"} · {stateName[job.state]}</p><div className="event-list">{events.slice(-6).map(event => <div key={event.seq}><span className="event-dot" /><span>{stateName[event.state]}{event.completedTiles !== undefined ? ` · ${count(event.completedTiles)} / ${count(event.totalTiles ?? 0)} 瓦片` : ""}{event.errorCode ? ` · ${event.errorCode}` : ""}</span><time>{time(event.occurredAt)}</time></div>)}</div>{["queued", "downloading", "paused", "failed"].includes(job.state) && <div className="job-actions">{!activeJobs.includes(job.jobId) && <Button variant="secondary" size="sm" disabled={working} onClick={resumeJob}>{job.state === "failed" ? "重试作业" : "恢复作业"}</Button>}{["queued", "downloading"].includes(job.state) && activeJobs.includes(job.jobId) && <Button variant="secondary" size="sm" disabled={working} onClick={pauseJob}>暂停作业</Button>}{job.state !== "failed" && <Button variant="outline" size="sm" disabled={working} onClick={cancelJob}>取消作业</Button>}</div>}{job.state === "downloading" && !activeJobs.includes(job.jobId) && <p className="warning-text">应用中断后可恢复；会先检查本机已缓存瓦片。</p>}</section>}
        {manifest && <section className="artifact-card"><div className="artifact-heading"><FileCheck2 size={19} /><strong>已核验成果</strong><span>{manifest.quality.status}</span></div><p>依据本机清单重新检查文件、尺寸与 SHA-256。</p>{manifest.assets.map(asset => <div className="asset-row" key={asset.id}><div><strong>{asset.kind}</strong><small>{asset.path}</small></div><span>{size(asset.bytes)}</span></div>)}<div className="plan-detail"><span>缺失瓦片</span><strong>{manifest.quality.missingTiles}</strong></div>{manifest.quality.warnings.map((warning, i) => <p key={i} className="warning-text">{warning}</p>)}</section>}
        <section className="history"><div className="history-head"><h3>最近任务</h3><span>{jobs.length}</span></div>{jobs.length ? jobs.slice(0, 6).map(item => <button type="button" className={`history-item ${job?.jobId === item.jobId ? "active" : ""}`} key={item.jobId} onClick={() => void selectJob(item)}><span className="history-icon"><Globe2 size={17} /></span><span><strong>{item.jobId.slice(0, 8)}</strong><small>{time(item.createdAt)}</small></span><em>{stateName[item.state]}</em></button>) : <div className="history-empty">尚无本地任务。确认计划后会出现在这里。</div>}</section>
      </aside>
    </div>
    {dialog && <SourceDialog onClose={() => setDialog(false)} onSaved={saved => { setSources(current => [saved, ...current.filter(s => s.id !== saved.id)]); setSourceId(saved.id); setZoom(Math.max(saved.minZoom, Math.min(zoom, saved.maxZoom))); invalidate(); setDialog(false); setNotice(`已登记图源：${saved.displayName}`); }} />}
    {agentOpen && <AgentPanel directory={directory} onClose={() => setAgentOpen(false)} onPlanned={created => { setPlan(created); setJob(null); setManifest(null); setApproved(false); setSourceId(created.plan.spec.sourceId); setBounds(created.plan.spec.bounds); setZoom(created.plan.spec.zoomLevels[0]); setFormats(created.plan.spec.outputFormats); setNotice("智能助手已生成计划。请核对图源、范围和输出，再由你确认下载。"); }} />}
  </div>;
}

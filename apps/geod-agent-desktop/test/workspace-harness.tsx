// Isolated UI fixture: exercises real split handles and task rendering without starting downloads.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useResizableWorkspace } from "../src/resizable-workspace";
import { TaskPanel } from "../src/task-panel";
import { TooltipProvider } from "../src/ui-tooltip";
import { Button } from "../src/components/motion/button/base";
import jobTimeline from "./fixtures/job-timeline.json";
import type { StoredPlan, Job, JobEvent } from "../src/api";
import "../src/styles.css";
import "../src/theme.css";
import "../src/workspace.css";

const plan: StoredPlan = { planId: "layout-check-plan", plan: { spec: { schemaVersion: "0.1", kind: "imagery", sourceId: "esri-world-imagery", bounds: [115.42, 39.44, 117.51, 41.06], zoomLevels: [12], outputFormats: ["geotiff"], outputDirectory: "C:\\Users\\Administrator\\Documents\\GeoD Agent\\imagery-20260930-104613-a7660813", limits: { maxTiles: 1000, maxDecodedRgbaBytes: 1000000000 } }, sourceName: "Esri World Imagery", attribution: "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community", license: "", tileGrids: [{ zoom: 12, columns: 25, rows: 25, tileCount: 625, pixelWidth: 6400, pixelHeight: 6400, actualBounds: [115.42, 39.44, 117.51, 41.06] }], totalTiles: 625, decodedRgbaBytes: 163840000, requiredFreeDiskBytes: 692060160, createdAt: "2026-09-30T10:48:00Z", expiresAt: "2026-09-30T11:16:13Z", planHash: "9daad43b3592".repeat(5) } };
const job: Job = { jobId: "7919c9cd-layout-check", planId: plan.planId, approvalId: "fixture", planHash: plan.plan.planHash, state: "completed", version: 1, createdAt: plan.plan.createdAt };
function Harness() {
  const [tasks, setTasks] = useState(true);
  const [focus, setFocus] = useState(false);
  const layout = useResizableWorkspace(focus ? "focus" : tasks ? "tasks" : "map");
  return <TooltipProvider><div className="app-shell"><header className="app-header custom-titlebar"><div className="brand"><img src="/geod-symbol.png" alt=""/><strong>GeoD <span>Agent</span></strong></div><div style={{ display: "flex", gap: 8 }}><Button size="sm" variant="ghost" onClick={() => setFocus(!focus)}>新对话视图</Button><Button size="sm" variant="ghost" onClick={() => setTasks(!tasks)}>任务面板</Button></div></header><div ref={layout.ref} style={layout.style} className={`workspace ai-workspace resizable-workspace ${focus ? "new-chat" : ""} ${tasks ? "results-open" : ""} ${layout.dragging ? "panels-resizing" : ""}`}>
    <aside className="conversation-sidebar" style={{ padding: 16 }}><strong>新对话</strong><p>图源管理</p><p>技能与连接器</p><p>默认工作区</p></aside>
    <section className="agent-panel agent-primary"><div className="agent-header"><strong>下载天津影像</strong></div><div style={{ padding: 20, flex: 1 }}>已配置图源，开始执行下载。<p>可以在右侧查看任务进度和成果。</p></div><div className="agent-composer"><div className="geod-prompt-input" style={{ padding: 16, minHeight: 100 }}>描述需求、粘贴内容，或添加 GeoJSON 边界</div></div></section>
    {!focus && <main className="map-column" style={{ background: "var(--app-subtle)", display: "grid", placeItems: "center", color: "var(--app-faint-text)" }}>地图区域</main>}
    {!focus && tasks && <aside className="right-panel task-panel panel-scroll" aria-label="任务与成果"><TaskPanel tasks={[{stored:plan,job,state:job.state}]} onTaskSelect={() => {}} onTaskAction={async () => {}} onStart={async () => {}} onDiscard={async () => {}} plan={plan} job={job} events={jobTimeline as JobEvent[]} manifest={null} jobs={[job]} activeJobs={[job.jobId]} working={false} error="" notice="任务已入账并开始执行。进度以本机记录为准。" onClearError={() => {}} onClearNotice={() => {}} onRefresh={() => {}} onSelect={() => {}} onResume={() => {}} onPause={() => {}} onCancel={() => {}} /></aside>}
    {layout.separators}
  </div></div></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);

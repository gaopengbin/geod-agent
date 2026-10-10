// Isolated UI fixture: exercises real split handles and task rendering without starting downloads.
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useResizableWorkspace } from "../src/resizable-workspace";
import { TaskPanel } from "../src/task-panel";
import { TooltipProvider } from "../src/ui-tooltip";
import { Button } from "../src/components/motion/button/base";
import jobTimeline from "./fixtures/job-timeline.json";
import type { StoredPlan, Job, JobEvent } from "../src/api";
import { ChatTranscript } from "../src/chat-ui";
import type { DisplayMessage } from "../src/pending-generations";
import "../src/styles.css";
import "../src/theme.css";
import "../src/workspace.css";

const plan: StoredPlan = { planId: "layout-check-plan", plan: { spec: { schemaVersion: "0.1", kind: "imagery", sourceId: "esri-world-imagery", bounds: [115.42, 39.44, 117.51, 41.06], zoomLevels: [12], outputFormats: ["geotiff"], outputDirectory: "C:\\Users\\Administrator\\Documents\\GeoD Agent\\imagery-20260930-104613-a7660813", limits: { maxTiles: 1000, maxDecodedRgbaBytes: 1000000000 } }, sourceName: "Esri World Imagery", attribution: "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community", license: "", tileGrids: [{ zoom: 12, columns: 25, rows: 25, tileCount: 625, pixelWidth: 6400, pixelHeight: 6400, actualBounds: [115.42, 39.44, 117.51, 41.06] }], totalTiles: 625, decodedRgbaBytes: 163840000, requiredFreeDiskBytes: 692060160, createdAt: "2026-09-30T10:48:00Z", expiresAt: "2026-09-30T11:16:13Z", planHash: "9daad43b3592".repeat(5) } };
const job: Job = { jobId: "7919c9cd-layout-check", planId: plan.planId, approvalId: "fixture", planHash: plan.plan.planHash, state: "completed", version: 1, createdAt: plan.plan.createdAt };
const history: DisplayMessage[] = Array.from({length: 24}, (_, index) => [
  {id:`fixture-user-${index}`,role:"user" as const,content:`第 ${index+1} 轮影像需求`},
  {id:`fixture-assistant-${index}`,role:"assistant" as const,phase:"final" as const,content:`### 下载计划 ${index+1}\n\n这里是用于验证长对话布局的历史内容。\n\n|参数|值|\n|---|---|\n|坐标系|EPSG:4326|\n|图源|Esri World Imagery|\n|分辨率|Z18|\n\n${"保持原始像素取值，下载完成后裁剪并核验成果。".repeat(12)}`}
]).flat();
function StreamingTranscript() {
  const [chunks,setChunks]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>setChunks(n=>n+1),33);return()=>clearInterval(timer);},[]);
  const messages=useMemo(()=>[...history,{id:"fixture-stream",role:"assistant" as const,phase:"final" as const,streaming:true,content:`正在生成回复。${"继续检查影像范围与任务参数。".repeat(chunks%500+1)}`}], [chunks]);
  return <div data-stream-chunks={chunks} style={{display:"flex",flexDirection:"column",flex:1,minHeight:0}}><ChatTranscript conversationId="layout-stream-fixture" messages={messages} busy activity="正在思考…" onReviewSource={()=>{}} onApproveExtension={()=>{}}/></div>;
}
function Harness() {
  const renders=useRef(0); renders.current++;
  const streaming=new URLSearchParams(location.search).has("stream");
  const [tasks, setTasks] = useState(true);
  const [focus, setFocus] = useState(false);
  const layout = useResizableWorkspace(focus ? "focus" : tasks ? "tasks" : "map");
  return <TooltipProvider><div className="app-shell"><header className="app-header custom-titlebar"><div className="brand"><img src="/geod-symbol.png" alt=""/><strong>GeoD <span>Agent</span></strong></div><div style={{ display: "flex", gap: 8 }}><Button size="sm" variant="ghost" onClick={() => setFocus(!focus)}>新对话视图</Button><Button size="sm" variant="ghost" onClick={() => setTasks(!tasks)}>任务面板</Button></div></header><div ref={layout.ref} style={layout.style} {...layout.attributes} data-render-count={renders.current} className={`workspace ai-workspace resizable-workspace ${focus ? "new-chat" : ""} ${tasks ? "results-open" : ""} ${layout.dragging ? "panels-resizing" : ""}`}>
    <aside className="conversation-sidebar" style={{ padding: 16 }}><strong>新对话</strong><p>图源管理</p><p>技能与连接器</p><p>默认工作区</p></aside>
    <section className="agent-panel agent-primary"><div className="agent-header"><strong>下载天津影像</strong></div>{streaming?<StreamingTranscript/>:<div style={{ padding: 20, flex: 1 }}>已配置图源，开始执行下载。<p>可以在右侧查看任务进度和成果。</p></div>}<div className="agent-composer"><div className="geod-prompt-input" style={{ padding: 16, minHeight: 100 }}>描述需求、粘贴内容，或添加 GeoJSON 边界</div></div></section>
    {!focus && <main className="map-column" style={{ background: "var(--app-subtle)", display: "grid", placeItems: "center", color: "var(--app-faint-text)" }}>地图区域</main>}
    {!focus && tasks && <aside className="right-panel task-panel panel-scroll" aria-label="任务与成果"><TaskPanel tasks={[{stored:plan,job,state:job.state}]} onTaskSelect={() => {}} onTaskAction={async () => {}} onStart={async () => {}} onDiscard={async () => {}} plan={plan} job={job} events={jobTimeline as JobEvent[]} manifest={null} jobs={[job]} activeJobs={[job.jobId]} working={false} error="" notice="任务已入账并开始执行。进度以本机记录为准。" onClearError={() => {}} onClearNotice={() => {}} onRefresh={() => {}} onSelect={() => {}} onResume={() => {}} onPause={() => {}} onCancel={() => {}} /></aside>}
    {layout.separators}
  </div></div></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);

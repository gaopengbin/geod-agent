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
import { PromptInput } from "../src/components/agents/prompt-input";
import { MessageQueue } from "../src/message-queue";
import type { QueuedInput } from "../src/pending-generations";
import { turnOutcomeMessage } from "../src/turn-outcome";
import { ContextWindow } from "../src/context-window";
import { contextWindowUsage } from "../src/conversation-context";
import { ChevronDown, ShieldCheck } from "../src/icons";
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
  const [busy, setBusy] = useState(new URLSearchParams(location.search).has("busy"));
  const [queued, setQueued] = useState<QueuedInput[]>([]);
  const [paused, setPaused] = useState(false);
  const [rows, setRows] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState("");
  const layout = useResizableWorkspace(focus ? "focus" : tasks ? "tasks" : "map");
  return <TooltipProvider><div className="app-shell"><header className="app-header custom-titlebar"><div className="brand"><img src="/geod-symbol.png" alt=""/><strong>GeoD <span>Agent</span></strong></div><div style={{ display: "flex", gap: 8 }}><Button size="sm" variant="ghost" onClick={() => setFocus(!focus)}>新对话视图</Button><Button size="sm" variant="ghost" onClick={() => setTasks(!tasks)}>任务面板</Button></div></header><div ref={layout.ref} style={layout.style} {...layout.attributes} data-render-count={renders.current} className={`workspace ai-workspace resizable-workspace ${focus ? "new-chat" : ""} ${tasks ? "results-open" : ""} ${layout.dragging ? "panels-resizing" : ""}`}>
    <aside className="conversation-sidebar" style={{ padding: 16 }}><strong>新对话</strong><p>图源管理</p><p>技能与连接器</p><p>默认工作区</p></aside>
    <section className="agent-panel agent-primary">
      <div className="agent-header"><strong>布局验收 · 演示数据</strong></div>
      {streaming ? <StreamingTranscript/> : rows.length ? <ChatTranscript conversationId="queue-fixture" messages={rows} busy={busy} activity="正在处理…" onReviewSource={()=>{}} onApproveExtension={()=>{}} onContinueTurn={()=>setSubmitted('不应为主动停止提供继续按钮')}/> : <div style={{padding:20,flex:1}}>验证分割线和输入栏，不会调用模型或启动下载。<p role="status">{submitted}</p></div>}
      <MessageQueue items={queued} paused={paused} sendingId={null} onPausedChange={setPaused} onRemove={id=>setQueued(items=>items.filter(item=>item.id!==id))} onSendNow={item=>{setRows(old=>[...old,{id:item.id,role:'user',content:item.text}]);setQueued(items=>items.filter(row=>row.id!==item.id));}}/>
      <div className="agent-composer"><PromptInput className="geod-prompt-input" value={input} onValueChange={setInput} placeholder="描述需求，添加图片、数据网址或矢量范围" models={[{value:"luna",label:"社区赞助 · GPT-6 Luna · 赞助",shortLabel:"GPT-6 Luna · 赞助"}]} model="luna" actions={[{value:"data",label:"添加数据范围"}]} loading={busy} allowSteer loadingSubmitLabel="加入消息队列" onStop={()=>{setBusy(false);setPaused(true);setRows(old=>[...old,turnOutcomeMessage('stopped-fixture',{status:'interrupted',message:'已停止'})]);}} onSubmit={value=>{if(busy)setQueued(items=>[...items,{id:crypto.randomUUID(),text:value,createdAt:new Date().toISOString()}]);else setRows(old=>[...old,{id:crypto.randomUUID(),role:'user',content:value}]);setInput("");}} toolbarContent={<div className="composer-controls"><button type="button" className="composer-permission-trigger full-access" aria-label="工作区权限（布局演示）"><ShieldCheck size={16}/><span>完全访问</span><ChevronDown size={14}/></button><ContextWindow usage={contextWindowUsage([])} compressedBefore={false} lastInputTokens={null}/></div>}/></div>
    </section>
    {!focus && <main className="map-column" style={{ background: "var(--app-subtle)", color: "var(--app-faint-text)" }}>地图区域</main>}
    {!focus && tasks && <aside className="right-panel task-panel panel-scroll" aria-label="任务与成果"><TaskPanel tasks={[{stored:plan,job,state:job.state}]} onTaskSelect={() => {}} onTaskAction={async () => {}} onStart={async () => {}} onDiscard={async () => {}} plan={plan} job={job} events={jobTimeline as JobEvent[]} manifest={null} jobs={[job]} activeJobs={[job.jobId]} working={false} error="" notice="任务已入账并开始执行。进度以本机记录为准。" onClearError={() => {}} onClearNotice={() => {}} onRefresh={() => {}} onSelect={() => {}} onResume={() => {}} onPause={() => {}} onCancel={() => {}} /></aside>}
    {layout.separators}
  </div></div></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);

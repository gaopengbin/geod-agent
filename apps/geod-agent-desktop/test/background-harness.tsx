// Isolated transcript fixture. No model calls, native writes, or public tile downloads.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "../src/chat-ui";
import { TooltipProvider } from "../src/ui-tooltip";
import { Button } from "../src/components/motion/button/base";
import { PromptInput } from "../src/components/agents/prompt-input";
import type { BackgroundSnapshot } from "../src/background-jobs";
import type { DisplayMessage } from "../src/pending-generations";
import type { JobState } from "../src/api";
import "../src/styles.css";
import "../src/theme.css";

const messages: DisplayMessage[] = [
  { id: "user", role: "user", content: "下载北京影像并裁剪" },
  { id: "work", role: "assistant", phase: "progress", content: "已按北京市边界生成 Z12 / GeoTIFF 计划，现在启动下载。" },
  { id: "background", role: "tool", content: "后台下载 · Esri World Imagery", backgroundJob: { jobId: "fixture", planId: "fixture-plan", sourceName: "Esri World Imagery", totalTiles: 600, zoomLevels: [12], outputFormats: ["geotiff"] } },
  { id: "final", role: "assistant", phase: "final", content: "任务已转入本机后台执行，进度会在上方原位更新。你可以继续聊天。" },
];
function Harness() {
  const [state, setState] = useState<JobState>("downloading");
  const [completed, setCompleted] = useState(10);
  const [text, setText] = useState("");
  const [failure, setFailure] = useState(false);
  const [dark, setDark] = useState(false);
  useEffect(() => { document.documentElement.dataset.theme = dark ? "dark" : "light"; }, [dark]);
  useEffect(() => {
    if (state !== "downloading") return;
    const timer = setInterval(() => setCompleted(value => Math.min(590, value + 2)), 250);
    return () => clearInterval(timer);
  }, [state]);
  const snapshot: BackgroundSnapshot = { job: { jobId: "fixture", planId: "fixture-plan", state, version: 1, approvalId: "fixture", planHash: "fixture", createdAt: new Date().toISOString() }, completedTiles: completed, totalTiles: 600, seq: 1, events: [], ...(failure ? { connectionError: "状态同步暂时中断，正在重试；下载由本机后台执行。" } : {}) };
  return <TooltipProvider><div style={{ maxWidth: 680, height: "100dvh", margin: "auto", display: "flex", flexDirection: "column", background: "var(--app-surface)", color: "var(--app-text)" }}>
    <header style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 12 }}><Button variant="ghost" size="sm" onClick={() => { setState("downloading"); setCompleted(10); }}>下载中</Button><Button variant="ghost" size="sm" onClick={() => setState("completed")}>完成</Button><Button variant="ghost" size="sm" onClick={() => setState("failed")}>失败</Button><Button variant="ghost" size="sm" onClick={() => setFailure(!failure)}>同步中断</Button><Button variant="ghost" size="sm" onClick={() => setDark(!dark)}>切换主题</Button></header>
    <ChatTranscript conversationId="fixture" messages={messages} busy={false} activity="" backgroundJobs={{ fixture: snapshot }} onOpenJob={() => setText("已打开任务面板")} onReviewSource={() => {}} onApproveExtension={() => {}} />
    <div style={{ margin: 16 }}><PromptInput value={text} onValueChange={setText} placeholder="可以继续聊天" onSubmit={() => setText("")} /></div>
  </div></TooltipProvider>;
}
const harnessRoot = import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) import.meta.hot.data.root = harnessRoot;
harnessRoot.render(<Harness/>);

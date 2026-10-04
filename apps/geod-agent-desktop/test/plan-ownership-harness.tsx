// Isolated UI fixture: no model calls, native downloads, or user-chat storage writes.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/motion/button/base";
import { TooltipProvider } from "../src/ui-tooltip";
import { ChatTranscript } from "../src/chat-ui";
import { TranscriptTaskGroup } from "../src/transcript-plan-card";
import { TaskQueueView } from "../src/task-queue-view";
import { buildTaskQueue, type QueueTask } from "../src/task-queue";
import { inferPlanPresentations, planCardAnchors } from "../src/plan-presentation";
import type { DisplayMessage } from "../src/pending-generations";
import type { StoredPlan } from "../src/api";
import "../src/styles.css";
import "../src/theme.css";
import "../src/workspace.css";

function fixturePlan(id: string, bounds: [number, number, number, number], totalTiles: number, zoom: number): StoredPlan {
  return { planId: id, plan: { sourceName: "Esri World Imagery", totalTiles, attribution: "Esri", license: "", decodedRgbaBytes: 150 * 1024 ** 2,
    createdAt: "2026-10-01T08:00:00Z", expiresAt: "2030-01-01T00:00:00Z", planHash: id, tileGrids: [],
    spec: { schemaVersion: "0.1", kind: "imagery", sourceId: "esri", bounds, zoomLevels: [zoom], outputFormats: ["geotiff"],
      outputDirectory: `C:\\Users\\Administrator\\Documents\\GeoD Agent\\imagery-${id}`, limits: { maxTiles: 4096, maxDecodedRgbaBytes: 512 * 1024 ** 2 } } } };
}
const plans = [fixturePlan("henan", [110,31,116,36],1295,11), fixturePlan("zhumadian",[113,32,115,34],450,12)];
const tool = (id: string, name: string, result: unknown, turnId: string): DisplayMessage => ({ id, role: "tool", content: name === "plan_imagery" ? "计算影像计划 · 已完成" : "查询行政边界 · 已完成", toolName: name, toolStatus: "success", turnId, details: JSON.stringify({ arguments: {}, result }) });
const initial: DisplayMessage[] = [
  { id: "user-henan", role: "user", content: "下载河南的影像" },
  tool("boundary-henan", "mcp_call", { toolName: "lookup_boundary", result: { name: "河南省-AreaCity-20260403.geojson", bounds: plans[0].plan.spec.bounds, attachedToDesktopPlan: true } }, "turn-henan"),
  tool("plan-henan", "plan_imagery", { planId: "henan" }, "turn-henan"),
  { id: "answer-henan", role: "assistant", phase: "final", content: "河南省影像计划已生成，等待确认后开始下载。" },
];
const second: DisplayMessage[] = [
  { id: "user-zhumadian", role: "user", content: "我要下载驻马店以及周边市" },
  tool("boundary-zhumadian", "mcp_call", { toolName: "lookup_boundary", result: { name: "驻马店市", bounds: plans[1].plan.spec.bounds, attachedToDesktopPlan: true } }, "turn-zhumadian"),
  tool("plan-zhumadian", "plan_imagery", { planId: "zhumadian" }, "turn-zhumadian"),
  { id: "answer-zhumadian", role: "assistant", phase: "final", content: "驻马店市影像计划已生成。周边城市的范围可以继续补充。" },
];
function Preview() {
  const [phase, setPhase] = useState(0);
  const [theme, setTheme] = useState("dark");
  const [selected, setSelected] = useState("henan");
  const [focus, setFocus] = useState<string[]>([]);
  const [discarded, setDiscarded] = useState<string[]>([]);
  const messages = phase === 0 ? initial : phase === 1 ? [...initial, second[0]] : phase === 2 ? [...initial, ...second] : [...initial, ...second, { id: "user-third", role: "user" as const, content: "再加一个周口任务" }];
  const busy = phase === 1 || phase === 3;
  const presentations = Object.fromEntries(inferPlanPresentations(messages, plans).map(item => [item.planId, item]));
  const anchors = planCardAnchors(messages, presentations);
  const tasks = buildTaskQueue(phase < 2 ? plans.slice(0,1) : plans, [], [], discarded).map(task => ({ ...task, title: presentations[task.stored.planId]?.title }));
  const select = (task: QueueTask) => setSelected(task.stored.planId);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <TooltipProvider><div style={{ padding: 18, maxWidth: 1020, margin: "auto" }}>
    <div style={{ display: "flex", gap: 8, marginBottom: 16 }}><Button onClick={() => setPhase(1)}>发送驻马店请求</Button><Button onClick={() => setPhase(2)}>完成驻马店回答</Button><Button onClick={() => setPhase(3)}>发送第三条请求</Button><Button variant="secondary" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>切换主题</Button></div>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 20 }}>
      <section className="agent-panel" style={{ minWidth: 0, width: "100%", height: 820 }}>
        <ChatTranscript conversationId="isolated-ownership-fixture" messages={messages} busy={busy} activity="正在准备会话上下文…" onReviewSource={() => {}} onApproveExtension={() => {}}
          afterEntry={id => <TranscriptTaskGroup tasks={(anchors[id] ?? []).flatMap(planId => tasks.find(task => task.stored.planId === planId) ?? [])} permission="confirmEach" onOpen={ids => { setFocus(ids); setSelected(ids[0]); }}/>} />
      </section>
      <aside className="task-panel" style={{ minWidth: 0 }}><div className="task-panel-heading"><h2>任务与成果</h2></div><TaskQueueView tasks={tasks} focusPlanIds={focus} onClearFocus={() => setFocus([])} selectedId={selected} permission="confirmEach" working={false} onSelect={select} onAction={async (kind, ids) => { if (kind === "discard") setDiscarded(current => [...current, ...ids]); }}/><div className="task-overview"><div className="task-source"><h3>{presentations[selected]?.title}</h3></div><p className="task-subtitle">Esri World Imagery</p></div></aside>
    </div>
  </div></TooltipProvider>;
}
const root = import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
if (import.meta.hot) { import.meta.hot.data.root = root; import.meta.hot.accept(); }
root.render(<Preview/>);

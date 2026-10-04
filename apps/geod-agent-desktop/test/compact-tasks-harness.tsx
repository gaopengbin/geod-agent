// UI fixture only. Uses real components but never invokes native jobs, models or user storage.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../src/components/motion/button/base";
import { TooltipProvider } from "../src/ui-tooltip";
import { ChatTranscript } from "../src/chat-ui";
import { TranscriptTaskGroup } from "../src/transcript-plan-card";
import { TaskPanel } from "../src/task-panel";
import { buildTaskQueue, type TaskAction } from "../src/task-queue";
import { taskGroupTarget } from "../src/task-summary";
import { inferPlanPresentations, planCardAnchors } from "../src/plan-presentation";
import type { DisplayMessage } from "../src/pending-generations";
import type { Job, StoredPlan } from "../src/api";
import { errorMessage } from "../src/app-error";
import "../src/styles.css";
import "../src/theme.css";
import "../src/workspace.css";

const regions = ["驻马店市", "南阳市", "信阳市", "平顶山市", "漯河市", "周口市", "阜阳市", "亳州市"];
function plan(id: string, index: number): StoredPlan {
  return { planId: id, plan: { sourceName: "Esri World Imagery", totalTiles: 450, attribution: "Esri", license: "", decodedRgbaBytes: 120 * 1024 ** 2, requiredFreeDiskBytes: 480 * 1024 ** 2,
    createdAt: "2026-10-01T08:00:00Z", expiresAt: "2030-01-01T00:00:00Z", planHash: id, tileGrids: [{zoom:12,minX:0,minY:0,maxX:24,maxY:17,tileCount:450,pixelWidth:6400,pixelHeight:4608}],
    spec: { schemaVersion: "0.1", kind: "imagery", sourceId: "esri", bounds: [112 + index * .02, 32, 113 + index * .02, 33], zoomLevels: [12], outputFormats: ["geotiff"],
      outputDirectory: `C:\\Users\\Administrator\\Documents\\GeoD Agent\\imagery-${id}`, limits: { maxTiles: 4096, maxDecodedRgbaBytes: 512 * 1024 ** 2 } } } };
}
const tool = (id: string, name: string, result: unknown, turnId: string): DisplayMessage => ({id,role:"tool",toolName:name,toolStatus:"success",content:name==="plan_imagery"?"计算影像计划 · 450 瓦片":"查询行政边界 · 已完成",turnId,details:JSON.stringify({arguments:{},result})});
function Preview() {
  const [total, setTotal] = useState(8), [theme, setTheme] = useState("dark"), [narrow, setNarrow] = useState(false);
  const [open, setOpen] = useState(false), [selected, setSelected] = useState("henan"), [focus, setFocus] = useState<string[]>([]);
  const [discarded, setDiscarded] = useState<string[]>([]), [jobs, setJobs] = useState<Job[]>([]), [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(""), [failStart, setFailStart] = useState(false);
  const plans = [plan("henan", 40), ...Array.from({length:total}, (_,i)=>plan(`city-${i}`,i))];
  const messages: DisplayMessage[] = [{id:"u1",role:"user",content:"先生成河南影像计划"},
    tool("b-henan","mcp_call",{toolName:"lookup_boundary",result:{name:"河南省",bounds:plans[0].plan.spec.bounds,attachedToDesktopPlan:true}},"turn-henan"),
    tool("p-henan","plan_imagery",{planId:"henan"},"turn-henan"),
    {id:"a1",role:"assistant",phase:"final",content:"河南省影像计划已生成，可在任务列表中确认并开始下载。"},
    {id:"u2",role:"user",content:"再生成驻马店以及周边城市的批量计划"},
    ...plans.slice(1).flatMap((stored,i)=>[tool(`b-${i}`,"mcp_call",{toolName:"lookup_boundary",result:{name:i<8?regions[i]:`区域数据 ${i+1}`,bounds:stored.plan.spec.bounds,attachedToDesktopPlan:true}},"turn-batch"),tool(`p-${i}`,"plan_imagery",{planId:stored.planId},"turn-batch")]),
    {id:"a2",role:"assistant",phase:"final",content:"已生成这批区域的影像计划。你可以在任务列表中统一核对、批量启动，或丢弃其中的计划。"},
    {id:"u3",role:"user",content:"这些任务先放着，我还有其他需求"}];
  const presentations = Object.fromEntries(inferPlanPresentations(messages,plans).map(item=>[item.planId,item]));
  const anchors = planCardAnchors(messages,presentations);
  const tasks = buildTaskQueue(plans,jobs,jobs.map(job=>job.jobId),discarded).map(task=>({...task,title:presentations[task.stored.planId].title}));
  const current = tasks.find(task=>task.stored.planId===selected) ?? tasks[0];
  const openGroup = (ids: string[]) => { const target=taskGroupTarget(tasks,ids,selected); if(target){setFocus(ids);setSelected(target.stored.planId);setOpen(true);} };
  async function action(kind: TaskAction, ids: string[]) {
    setWorking(true); setError("");
    try {
      await new Promise(resolve=>window.setTimeout(resolve,400));
      if(kind==="start" && failStart) throw {code:"PLAN_STALE",message:"图源配置已经变化，请重新生成并核对计划"};
      if(kind==="discard") setDiscarded(current=>[...new Set([...current,...ids])]);
      if(kind==="restore") setDiscarded(current=>current.filter(id=>!ids.includes(id)));
      if(kind==="start") setJobs(current=>[...current,...ids.filter(id=>!current.some(job=>job.planId===id)).map(id=>({jobId:`job-${id}`,planId:id,state:"queued" as const,version:1,createdAt:"2026-10-01T08:00:00Z",approvalId:"fixture",planHash:id}))]);
      if(kind==="cancel") setJobs(current=>current.map(job=>ids.includes(job.planId)?{...job,state:"cancelled",version:job.version+1}:job));
      setNotice(`界面模拟：${kind} ${ids.length} 项`);
    } catch(cause) {setError(`${tasks.find(task=>task.stored.planId===ids[0])?.title ?? "计划"}：${errorMessage(cause)}`); throw cause;} finally { setWorking(false); }
  }
  useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
  return <TooltipProvider><div style={{padding:18,maxWidth:1000,margin:"auto"}}>
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}><Button variant="secondary" onClick={()=>{setTotal(total===8?32:8);setFocus([]);}}>切换 {total===8?32:8} 项任务</Button><Button variant="secondary" onClick={()=>setNarrow(!narrow)}>切换对话宽度</Button><Button variant="secondary" onClick={()=>setTheme(theme==="dark"?"light":"dark")}>切换主题</Button>{open&&<Button variant="secondary" onClick={()=>setOpen(false)}>收起任务面板</Button>}</div>
    <Button variant="secondary" onClick={()=>setFailStart(!failStart)}>模拟失败：{failStart?"开":"关"}</Button>
    <p style={{color:"var(--app-soft-text)",fontSize:14,margin:"12px 0"}}>界面复现 · 不执行真实下载</p>
    <div style={{display:"grid",gridTemplateColumns:open?`${narrow?320:580}px 320px`:`${narrow?320:580}px`,gap:20,alignItems:"start"}}>
      <section className="agent-panel" style={{minWidth:0,width:"100%",height:660}}><ChatTranscript conversationId="compact-fixture" messages={messages} busy={false} activity="" onReviewSource={()=>{}} onApproveExtension={()=>{}} afterEntry={id=><TranscriptTaskGroup tasks={(anchors[id]??[]).flatMap(planId=>tasks.find(task=>task.stored.planId===planId)??[])} permission="confirmEach" onOpen={openGroup}/>}/></section>
      {open&&<aside className="task-panel" style={{minWidth:0}}><TaskPanel tasks={tasks} focusPlanIds={focus} onClearTaskFocus={()=>setFocus([])} onTaskSelect={task=>setSelected(task.stored.planId)} onTaskAction={action} onStart={stored=>action("start",[stored.planId])} onDiscard={stored=>action("discard",[stored.planId])} permission="confirmEach" plan={current.stored} job={current.job} events={[]} manifest={null} activeJobs={jobs.map(job=>job.jobId)} working={working} error={error} notice={notice} onClearError={()=>setError("")} onClearNotice={()=>setNotice("")} onRefresh={()=>{}} onResume={()=>{}} onPause={()=>{}} onCancel={()=>void action("cancel",[selected])}/></aside>}
    </div>
  </div></TooltipProvider>;
}
const root=import.meta.hot?.data.root??createRoot(document.getElementById("root")!);
if(import.meta.hot){import.meta.hot.data.root=root;import.meta.hot.accept();}
root.render(<Preview/>);

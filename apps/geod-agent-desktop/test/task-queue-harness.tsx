// Component interaction fixture. Never invokes native jobs or modifies user chats.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../src/ui-tooltip";
import { Button } from "../src/components/motion/button/base";
import { TaskPanel } from "../src/task-panel";
import { PlanReviewCard } from "../src/plan-review-card";
import { buildTaskQueue, type QueueTask, type TaskAction } from "../src/task-queue";
import type { Job, StoredPlan } from "../src/api";
import "../src/styles.css";
import "../src/theme.css";
import "../src/workspace.css";

function fixturePlan(id: string, zoom: number, count: number): StoredPlan {
  return {planId:id,plan:{spec:{schemaVersion:"0.1",kind:"imagery",sourceId:"esri",bounds:[115.4,39.4,117.5,41.1],zoomLevels:[zoom],outputFormats:["geotiff"],outputDirectory:`C:\\Users\\Administrator\\Documents\\GeoD Agent\\imagery-${id}`,limits:{maxTiles:4096,maxDecodedRgbaBytes:512*1024*1024}},sourceName:"Esri World Imagery",attribution:"Esri",license:"",totalTiles:count,decodedRgbaBytes:150*1024**2,requiredFreeDiskBytes:634*1024**2,tileGrids:[{zoom,minX:0,minY:0,maxX:23,maxY:24,tileCount:count,pixelWidth:6144,pixelHeight:6400}],createdAt:`2026-10-01T08:0${id.at(-1)}:00Z`,expiresAt:"2030-01-01T00:00:00Z",planHash:`hash-${id}`}};
}
const plans=[fixturePlan("plan-1",11,1295),fixturePlan("plan-2",12,600),fixturePlan("plan-3",13,2400),fixturePlan("plan-4",12,600),fixturePlan("plan-5",10,320)];
const fixtureJob=(id:string,state:Job["state"]):Job=>({jobId:`job-${id}`,planId:id,state,version:1,createdAt:"2026-10-01T08:00:00Z",approvalId:"approval",planHash:`hash-${id}`});
function Preview() {
  const [theme,setTheme]=useState("dark");
  const [permission,setPermission]=useState<"confirmEach"|"fullAccess">("confirmEach");
  const [narrow,setNarrow]=useState(false);
  const [jobs,setJobs]=useState<Job[]>([fixtureJob("plan-4","downloading"),fixtureJob("plan-5","completed")]);
  const [discarded,setDiscarded]=useState<string[]>([]);
  const [selected,setSelected]=useState("plan-1");
  const [working,setWorking]=useState(false);
  const [notice,setNotice]=useState("");
  useEffect(()=>{document.documentElement.dataset.theme=theme;},[theme]);
  const active=jobs.filter(job=>job.state==="downloading"||job.state==="queued").map(job=>job.jobId);
  const tasks=buildTaskQueue(plans,jobs,active,discarded,{"job-plan-4":{job:jobs.find(job=>job.planId==="plan-4")??null,workerActive:true,completedTiles:448}});
  const current=tasks.find(task=>task.stored.planId===selected)!;
  async function action(kind:TaskAction,ids:string[]) {
    setWorking(true);setNotice("");
    await new Promise(resolve=>setTimeout(resolve,650));
    if(kind==="discard")setDiscarded(value=>[...value,...ids]);
    if(kind==="restore")setDiscarded(value=>value.filter(id=>!ids.includes(id)));
    if(kind==="start")setJobs(value=>[...value,...ids.map(id=>fixtureJob(id,"queued"))]);
    if(kind==="cancel")setJobs(value=>value.map(job=>ids.includes(job.planId)?{...job,state:"cancelled",version:job.version+1}:job));
    setNotice(`${kind} ${ids.length} 项（组件测试）`);setWorking(false);
  }
  const select=(task:QueueTask)=>setSelected(task.stored.planId);
  return <TooltipProvider><div style={{padding:24}}><div style={{display:"flex",gap:8,marginBottom:20}}><Button variant="secondary" onClick={()=>setTheme(value=>value==="dark"?"light":"dark")}>切换主题</Button><Button variant="secondary" onClick={()=>setNarrow(!narrow)}>切换窄面板</Button><Button variant="secondary" onClick={()=>setPermission(value=>value==="fullAccess"?"confirmEach":"fullAccess")}>切换权限</Button></div>
    <div style={{display:"flex",alignItems:"flex-start",gap:28}}><div style={{width:520}}><h2 style={{fontSize:16,marginBottom:14}}>对话中的计划</h2>{!current.job&&!discarded.includes(selected)?<PlanReviewCard key={selected} stored={current.stored} permission={permission} working={working} onStart={stored=>action("start",[stored.planId])} onDiscard={stored=>action("discard",[stored.planId])}/>:<p>此计划已移到任务列表。</p>}</div>
    <aside className="right-panel task-panel" style={{width:narrow?260:360,flex:"none",maxHeight:820,overflow:"auto",border:"1px solid var(--app-line)",borderRadius:10}}>
      <TaskPanel tasks={tasks} permission={permission} plan={current.stored} job={current.job} events={current.job?[{jobId:current.job.jobId,seq:1,state:current.job.state,occurredAt:"2026-10-01T08:00:00Z",completedTiles:448,totalTiles:600}]:[]} manifest={null} activeJobs={active} working={working} error="" notice={notice} onClearError={()=>{}} onClearNotice={()=>setNotice("")} onRefresh={()=>{}} onTaskSelect={select} onTaskAction={action} onStart={stored=>action("start",[stored.planId])} onDiscard={stored=>action("discard",[stored.planId])} onResume={()=>{}} onPause={()=>{}} onCancel={()=>void action("cancel",[selected])}/>
    </aside></div></div></TooltipProvider>;
}
const root = import.meta.hot?.data.root ?? createRoot(document.getElementById("root")!);
root.render(<Preview/>);
if (import.meta.hot) { import.meta.hot.data.root = root; import.meta.hot.accept(); }

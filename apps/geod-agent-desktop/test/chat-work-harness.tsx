// Isolated UI states: no model requests, workspace changes or native job operations.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatTranscript } from "../src/chat-ui";
import { TooltipProvider } from "../src/ui-tooltip";
import { Button } from "../src/components/motion/button/base";
import type { DisplayMessage } from "../src/pending-generations";
import "../src/styles.css";
import "../src/theme.css";

const work: DisplayMessage[] = [
  {id:"user", role:"user", content:"下载河南的影像"},
  {id:"think",turnId:"henan",role:"tool",itemType:"reasoning",content:"思考",toolStatus:"success",details:"用户要下载河南的影像。先检查工作区和已登记图源，再查询河南边界，生成下载计划。\n\n读取 `geod-source-creator` Skill，按当前工作区的权限继续处理。"},
  {id:"note1",turnId:"henan",role:"assistant",phase:"progress",content:"我先确认工作区、图源和可用 Skill，再制定河南的下载计划。"},
  {id:"workspace",turnId:"henan",role:"tool",toolStatus:"success",content:"检查工作区 · 默认工作区",details:JSON.stringify({arguments:{},result:{permission:"confirmEach",directory:"C:\\Users\\Administrator\\Documents\\GeoD Agent"}},null,2)},
  {id:"sources",turnId:"henan",role:"tool",toolStatus:"success",content:"检查已登记图源 · 2 个"},
  {id:"skill",turnId:"henan",role:"tool",toolStatus:"success",content:"读取 Skill · geod-source-creator",details:"查询边界并生成下载计划。"},
  {id:"note2",turnId:"henan",role:"assistant",phase:"progress",content:"先获取河南省边界，并查看图源创建 Skill 的操作约定。"},
  {id:"boundary",turnId:"henan",role:"tool",toolStatus:"success",content:"查询行政边界 · 河南省"},
  {id:"note3",turnId:"henan",role:"assistant",phase:"progress",content:"边界已附到当前对话。我先按 Z12 / GeoTIFF 计算计划容量。"},
  {id:"large",turnId:"henan",role:"tool",toolStatus:"attention",content:"计算影像计划 · 超出容量",details:JSON.stringify({arguments:{zoom:12},error:{code:"PLAN_RESOURCE_LIMIT",message:"超出计划容量，请降低缩放级别。"}},null,2)},
  {id:"note4",turnId:"henan",role:"assistant",phase:"progress",content:"Z12 超出计划容量，我降低缩放级别再试。"},
  {id:"cmd",turnId:"henan",role:"tool",itemType:"commandExecution",toolStatus:"success",content:"python inspect_boundary.py 河南省.geojson",details:"Polygon: 1\nCRS: EPSG:4326"},
  {id:"plan",turnId:"henan",role:"tool",toolStatus:"running",content:"计算影像计划 · Z10 / GeoTIFF",details:JSON.stringify({arguments:{zoom:10},result:{totalTiles:624,format:"geotiff"}},null,2)},
];
function Harness() {
 const [state,setState]=useState<"running"|"completed"|"stopped"|"streaming">("running");
 const [dark,setDark]=useState(false);
 const [width,setWidth]=useState(570);
 useEffect(()=>{document.documentElement.dataset.theme=dark?"dark":"light";},[dark]);
 const busy=state==="running"||state==="streaming";
 const rows=work.map(item=>item.id==="plan"?{...item,toolStatus:state==="running"?"running" as const:state==="stopped"?"attention" as const:"success" as const}:item);
 if(state==="completed"||state==="streaming")rows.push({id:"final",turnId:"henan",role:"assistant",phase:"final",streaming:state==="streaming",content:"已按河南省边界生成 **Z10 / GeoTIFF** 下载计划，共 **624 张瓦片**。确认计划后即可开始下载。"});
 return <TooltipProvider><main style={{width:"100%",maxWidth:width,height:"100dvh",margin:"auto",display:"flex",flexDirection:"column",background:"var(--app-surface)",color:"var(--app-text)"}}>
  <header style={{display:"flex",flexWrap:"wrap",gap:4,padding:10,borderBottom:"1px solid var(--app-line)"}}>
   <Button variant="ghost" size="sm" onClick={()=>setState("running")}>执行中</Button><Button variant="ghost" size="sm" onClick={()=>setState("streaming")}>最终回复流式</Button><Button variant="ghost" size="sm" onClick={()=>setState("completed")}>完成本轮</Button><Button variant="ghost" size="sm" onClick={()=>setState("stopped")}>停止本轮</Button><Button variant="ghost" size="sm" onClick={()=>setDark(!dark)}>切换主题</Button><Button variant="ghost" size="sm" onClick={()=>setWidth(width===570?360:570)}>切换窄屏</Button>
  </header>
  <ChatTranscript conversationId="work-harness" messages={rows} busy={busy} activeTurnId={busy?"henan":null} activity={state==="streaming"?"正在生成回复…":"正在计算影像计划…"} onReviewSource={()=>{}} onApproveExtension={()=>{}}/>
 </main></TooltipProvider>;
}
const root=import.meta.hot?.data.root??createRoot(document.getElementById("root")!);
if(import.meta.hot)import.meta.hot.data.root=root;
root.render(<Harness/>);

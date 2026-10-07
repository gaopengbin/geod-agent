// Isolated history recovery and explicit resume. No native or model operations.
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatTranscript} from '../src/chat-ui';
import {TooltipProvider} from '../src/ui-tooltip';
import {Button} from '../src/components/motion/button/base';
import {recoverTurnOutcome} from '../src/turn-outcome';
import type {DisplayMessage} from '../src/pending-generations';
import '../src/styles.css';import '../src/theme.css';import '../src/workspace.css';
const theme=new URLSearchParams(location.search).get('theme')??'light';document.documentElement.dataset.theme=theme;
const key='turn-outcome-fixture-'+theme;
const rows:DisplayMessage[]=[{id:'human',role:'user',content:'把沿途1公里范围内的影像下载'},{id:'question',role:'tool',turnId:'original',content:'补充需求',userInput:{requestId:'fixture',userMessageId:'human',status:'answered',createdAt:'2026-10-07',questions:[{id:'crs',header:'影像源 · 分辨率 · 坐标系',question:'采用哪种坐标系？'}],reply:{answers:{crs:{answers:['EPSG:4490']}}}}},{id:'reason',turnId:'original',role:'tool',itemType:'reasoning',toolStatus:'attention',streaming:false,content:'思考',details:'116.373334,39.960056\n\nLeg 3 ('}];
function Harness(){
 const [messages,setMessages]=useState<DisplayMessage[]>(()=>JSON.parse(localStorage.getItem(key)??'null')??rows),[busy,setBusy]=useState(false),[resumes,setResumes]=useState(0),[open,setOpen]=useState<string|null>(null);
 useEffect(()=>{let cancelled=false;void recoverTurnOutcome(messages,'fixture',{billingRunSnapshot:async()=>({status:'completed',conversationId:'fixture',generations:[{generationId:'generation'}]}),agentGenerationGet:async()=>({state:'settled',result:{content:null,toolCalls:[]}})}).then(notice=>{if(notice&&!cancelled)setMessages([...messages,notice]);});return()=>{cancelled=true;};},[messages]);
 useEffect(()=>{localStorage.setItem(key,JSON.stringify(messages));},[messages]);
 return <TooltipProvider><main style={{maxWidth:620,height:'100dvh',margin:'auto',display:'flex',flexDirection:'column',background:'var(--app-surface)',color:'var(--app-text)'}}>
  <header style={{padding:10}}><span data-testid="resume-count">{resumes}</span><Button variant="ghost" size="sm" data-testid="complete" onClick={()=>{setBusy(false);setMessages([...messages,{id:'final',turnId:'resume',role:'assistant',phase:'final',content:'已核对已有任务，可以继续规划。'}]);}}>完成测试回复</Button></header>
  <ChatTranscript conversationId="fixture" messages={messages} busy={busy} activeTurnId={busy?'resume':null} activity="正在继续处理…" onReviewSource={()=>{}} onApproveExtension={()=>{}} openInputId={open} onOpenInput={setOpen} onContinueTurn={()=>{setResumes(resumes+1);setBusy(true);setMessages([...messages,{id:'resume-user',role:'user',content:'继续刚才的任务'},{id:'resume-thinking',turnId:'resume',role:'tool',itemType:'reasoning',toolStatus:'running',content:'思考',details:'核对已有计划和已确认需求。'}]);}}/>
  <div className="agent-composer"><div className="geod-prompt-input" style={{padding:16,minHeight:90}}>描述需求，添加数据范围</div></div>
 </main></TooltipProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

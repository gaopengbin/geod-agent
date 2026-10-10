// Real transcript/task components with isolated data; no model calls or native operations.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatTranscript} from '../src/chat-ui';
import {TranscriptTaskGroup} from '../src/transcript-plan-card';
import {TaskPanel} from '../src/task-panel';
import {buildTaskQueue} from '../src/task-queue';
import {TooltipProvider} from '../src/ui-tooltip';
import {Button} from '../src/components/motion/button/base';
import type {StoredPlan,Job} from '../src/api';
import type {DisplayMessage} from '../src/pending-generations';
import {reduceCodexItems} from '../src/codex-items';
import '../src/styles.css';import '../src/theme.css';import '../src/workspace.css';

document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')??'dark';
const plans:StoredPlan[]=Array.from({length:13},(_,i)=>({planId:`plan-${i}`,plan:{sourceName:`故宫历史影像 ${2014+i}`,totalTiles:80,attribution:'Esri',license:'',decodedRgbaBytes:1024,requiredFreeDiskBytes:4096,createdAt:'2026-10-09',expiresAt:'2030-01-01',planHash:`hash-${i}`,tileGrids:[{zoom:17,minX:0,minY:0,maxX:9,maxY:7,tileCount:80,pixelWidth:2560,pixelHeight:2048}],spec:{schemaVersion:'0.1',kind:'imagery',sourceId:'esri',bounds:[116.39,39.9,116.4,39.92],zoomLevels:[17],outputFormats:['geotiff'],outputDirectory:`fixture/plan-${i}`,limits:{maxTiles:4096,maxDecodedRgbaBytes:512*1024**2}}}}));
const jobs:Job[]=plans.map((p,i)=>({jobId:`job-${i}`,planId:p.planId,state:'completed',version:1,createdAt:'2026-10-09',approvalId:'fixture',planHash:p.plan.planHash}));
const tasks=buildTaskQueue(plans,jobs,[],[]);
const question=(i:number,status:'pending'|'answered'):DisplayMessage=>({id:`question-${i}`,turnId:'run',role:'tool',content:'补充需求',userInput:{requestId:`request-${i}`,status,userMessageId:'human',createdAt:'2026-10-09',questions:[{id:`choice-${i}`,header:['范围 · 影像时期 · 分辨率','成果坐标系 · 应用范围','2014–16 · 输出格式'][i],question:'请选择这份成果的输出参数',options:[{label:'EPSG:4326',description:'已确认的坐标系'}]}],reply:status==='answered'?{answers:{[`choice-${i}`]:{answers:['EPSG:4326']}}}:undefined}});

function Harness(){
 const [stage,setStage]=useState<'waiting'|'answered'|'completed'>('completed');
 const [input,setInput]=useState<string|null>(null),[selected,setSelected]=useState(tasks[0]),[panel,setPanel]=useState(false);
 const rows:DisplayMessage[]=[{id:'human',role:'user',content:'下载故宫的历史影像'},
  {id:'think',turnId:'run',role:'tool',itemType:'reasoning',toolStatus:'success',content:'思考',details:'核对已确认的影像时期和输出参数。'},
  ...[0,1,2].map(i=>question(i,stage==='waiting'&&i===2?'pending':'answered')),
  ...Array.from({length:119},(_,i)=>({id:`op-${i}`,turnId:'run',role:'tool' as const,toolStatus:'success' as const,content:'检查历史影像版本'})),
  {id:'local',role:'tool',toolStatus:'success',content:'核对本机任务列表'},
  ...(stage==='completed'?[{id:'final',turnId:'run',role:'assistant' as const,phase:'final' as const,content:'13 项历史影像任务已完成。可以在右侧查看成果。'}]:[]),
  ...jobs.map((job,i)=>({id:`bg-${i}`,role:'tool' as const,content:'后台下载 · 故宫影像',backgroundJob:{jobId:job.jobId,planId:job.planId,sourceName:'故宫影像',totalTiles:80,zoomLevels:[17],outputFormats:['geotiff']}}))];
 return <TooltipProvider><main style={{maxWidth:1000,margin:'auto',color:'var(--app-text)',background:'var(--app-surface)'}}>
  <header style={{padding:8,display:'flex',gap:8}}>{(['waiting','answered','completed'] as const).map(s=><Button key={s} data-testid={s} variant="ghost" onClick={()=>{setStage(s);if(s==='waiting')setInput('question-2');}}>{s}</Button>)}</header>
  <div style={{display:'flex',minHeight:780}}>
   <section className="agent-panel" style={{width:panel?560:Math.min(560,innerWidth),minWidth:0,height:780}}><ChatTranscript conversationId="compact-repro" messages={rows} busy={stage!=='completed'} activeTurnId={stage==='completed'?null:'run'} activity={stage==='waiting'?'等待你的回复…':'正在继续处理…'} onReviewSource={()=>{}} onApproveExtension={()=>{}} openInputId={input} onOpenInput={setInput} onInputReply={async()=>{setStage('answered');setInput(null);}} afterEntry={id=>id==='final'?<TranscriptTaskGroup tasks={tasks} permission="confirmEach" onOpen={ids=>{setSelected(tasks.find(t=>t.stored.planId===ids[0])!);setPanel(true);}}/>:null}/></section>
   {panel&&<aside className="task-panel" data-testid="results-panel" style={{width:360,minWidth:0}}><TaskPanel tasks={tasks} focusPlanIds={plans.map(p=>p.planId)} onClearTaskFocus={()=>{}} onTaskSelect={setSelected} onTaskAction={async()=>{}} onStart={()=>{}} onDiscard={()=>{}} permission="confirmEach" plan={selected.stored} job={selected.job} events={[]} manifest={null} activeJobs={[]} working={false} error="" notice="" onClearError={()=>{}} onClearNotice={()=>{}} onRefresh={()=>{}} onResume={()=>{}} onPause={()=>{}} onCancel={()=>{}}/></aside>}
  </div>
 </main></TooltipProvider>;
}
const summaryText='已加载完成，并已核对实际状态。\n\n### 加载结果\n\n| 项目 | 值 |\n| --- | --- |\n| 名称 | Google 混合影像注记 |\n| 状态 | 已就绪，可见 |\n| 视图 | 二维地图 |\n\n可以继续调整底图或查看三维场景。';
let summaryRows:DisplayMessage[]=[{id:'load-human',role:'user',content:'加载混合地图'}];
summaryRows=reduceCodexItems(summaryRows,'load-run','item/completed',{item:{type:'agentMessage',id:'announce',phase:'commentary',text:'先核对图源，然后加载地图。'}});
summaryRows=reduceCodexItems(summaryRows,'load-run','item/started',{item:{type:'reasoning',id:'thinking',summary:['检查图源与当前视图。']}});
for(let i=0;i<7;i++)summaryRows=reduceCodexItems(summaryRows,'load-run','item/completed',{item:{type:'mcpToolCall',id:`map-tool-${i}`,server:'maps',tool:'loadSource',status:'completed',arguments:{sourceId:'google-hybrid'},result:{ready:true}}});
summaryRows=reduceCodexItems(summaryRows,'load-run','item/completed',{item:{type:'agentMessage',id:'summary',phase:'commentary',text:summaryText}});

function SummaryHarness(){
 const [completed,setCompleted]=useState(false);
 const rows=completed?reduceCodexItems(summaryRows,'load-run','turn/completed',{turn:{status:'completed',items:[]}}):summaryRows;
 return <TooltipProvider><main style={{width:'100%',maxWidth:520,margin:'auto',color:'var(--app-text)',background:'var(--app-surface)'}}>
  <header style={{display:'flex',padding:8,gap:8}}><Button data-testid="complete-reply" variant="ghost" onClick={()=>setCompleted(true)}>结束本轮</Button><Button data-testid="restart-reply" variant="ghost" onClick={()=>setCompleted(false)}>开始本轮</Button></header>
  <section className="agent-panel" style={{height:820,minWidth:0}}><ChatTranscript conversationId="summary-repro" messages={rows} busy={!completed} activeTurnId={completed?null:'load-run'} activity="正在生成回复…" onReviewSource={()=>{}} onApproveExtension={()=>{}}/></section>
 </main></TooltipProvider>;
}
function BusyHarness(){
 const rows:DisplayMessage[]=[{id:'original',role:'user',content:'看起来没有明显偏移'},
  {id:'actual-failure',turnId:'old',role:'tool',content:'模型输出达到本次上限',turnOutcome:{status:'incomplete',code:'MODEL_OUTPUT_LIMIT',message:'模型输出达到本次上限'}},
  ...[1,2,3].flatMap(i=>[{id:`retry-${i}`,role:'user' as const,content:'继续刚才的任务'},
   {id:`busy-${i}`,turnId:`rejected-${i}`,role:'tool' as const,content:'此会话正在处理上一轮请求',turnOutcome:{status:'failed' as const,message:'此会话正在处理上一轮请求'}}])];
 return <TooltipProvider><section className="agent-panel" style={{height:780,maxWidth:520,margin:'auto'}}><ChatTranscript conversationId="busy-repro" messages={rows} busy={false} activity="" onReviewSource={()=>{}} onApproveExtension={()=>{}} onContinueTurn={()=>{throw Error('Rejected requests cannot be continued');}}/></section></TooltipProvider>;
}
const fixture=new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(fixture.has('busy')?<BusyHarness/>:fixture.has('summary')?<SummaryHarness/>:<Harness/>);

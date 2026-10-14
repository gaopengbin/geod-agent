// Component-level event replay: no model requests, native tools or saved chats.
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatTranscript} from '../src/chat-ui';
import {Button} from '../src/components/motion/button/base';
import {TooltipProvider} from '../src/ui-tooltip';
import {reduceCodexItems} from '../src/codex-items';
import {aggregateTurnTokenUsage,turnUsageSources} from '../src/turn-token-usage';
import {setLanguagePreferences} from '../src/i18n';
import type {DisplayMessage} from '../src/pending-generations';
import '../src/styles.css';
import '../src/theme.css';
import '../src/workspace.css';

const params=new URLSearchParams(location.search);
setLanguagePreferences({language:'zh-CN'});
type Stage='thinking'|'exploration'|'command'|'reply'|'completed'|'stopped'|'error'|'approval';
const states:Record<Stage,string>={thinking:'开始思考',exploration:'读取资料',command:'执行命令',reply:'流式回复',completed:'完成本轮',stopped:'停止本轮',error:'执行失败',approval:'等待确认'};
const final='已按确认的范围生成 **故宫历史影像下载计划**。\n\n| 项目 | 参数 |\n| --- | --- |\n| 图源 | Esri Wayback |\n| 层级 | Z17 |\n| 格式 | GeoTIFF · EPSG:4326 |\n\n任务和成果可在右侧查看，确认计划后即可下载。';
const longFinal=final+'\n\n'+Array.from({length:32},(_,i)=>`界面回放记录 ${i+1}：已确认的参数会保留，长回复用于检验上翻历史时的滚动行为。`).join('\n\n');
function rowsFor(stage:Stage,text:string,long:boolean):DisplayMessage[]{
 const rows:DisplayMessage[]=[{id:'human',role:'user',content:'按已确认的参数下载故宫历史影像'}];
 let next=reduceCodexItems(rows,'fixture-run','item/completed',{item:{type:'agentMessage',id:'note-1',phase:'commentary',text:'我先读取已确认的参数和故宫边界，再核对影像计划。'}});
 const reasoning={type:'reasoning',id:'reasoning',summary:['核对已保存的图源、范围和输出参数。']};
 next=reduceCodexItems(next,'fixture-run',stage==='thinking'?'item/started':'item/completed',{item:reasoning});
 if(stage==='thinking')return next;
 next.push({id:'sources',turnId:'fixture-run',role:'tool',toolName:'sources_list',toolStatus:'success',content:'已登记图源 · Esri Wayback',details:JSON.stringify({arguments:{},result:{sources:[{name:'Esri Wayback',configured:true}]}},null,2)});
 next=reduceCodexItems(next,'fixture-run','item/completed',{item:{type:'commandExecution',id:'read',command:'python inspect_boundary.py --read-only boundary.geojson',commandActions:[{type:'read',command:'read boundary.geojson',path:'boundary.geojson',name:'boundary.geojson'}],status:'completed',aggregatedOutput:'Polygon: 1\nCRS: EPSG:4326\nBoundary: 故宫',exitCode:0,durationMs:360}});
 next=reduceCodexItems(next,'fixture-run','item/completed',{item:{type:'agentMessage',id:'note-2',phase:'commentary',text:'范围和参数已确认。现在检查计划与本机成果记录。'}});
 if(stage==='exploration')return next;
 const command={type:'commandExecution',id:'command',command:'python verify_plan.py --read-only',commandActions:[{type:'unknown',command:'python verify_plan.py --read-only'}],status:stage==='command'?'inProgress':stage==='error'?'failed':stage==='stopped'?'declined':'completed',aggregatedOutput:stage==='error'?'SOURCE_NETWORK: 图源连接超时，未自动重试。':stage==='command'?'检查范围…\n检查已确认参数…':long?Array.from({length:80},(_,i)=>`检查记录 ${i+1}：范围、坐标系和图源参数已核对。`).join('\n'):'范围一致\n坐标系一致\n计划检查通过',exitCode:stage==='command'?null:stage==='error'?1:stage==='stopped'?null:0,durationMs:stage==='command'?null:1240};
 next=reduceCodexItems(next,'fixture-run',stage==='command'?'item/started':'item/completed',{item:command});
 if(stage==='stopped'||stage==='error')next.push({id:'outcome',role:'tool',turnId:'fixture-run',content:'',turnOutcome:{status:stage==='stopped'?'interrupted':'failed',message:stage==='stopped'?'本轮回复已停止，已创建的任务保留。':'图源连接超时，请检查网络后重试。'}});
 if(stage==='approval')next.push({id:'question',turnId:'fixture-run',role:'tool',content:'确认参数',userInput:{requestId:'fixture-question',status:'pending',userMessageId:'human',createdAt:'2026-10-13T00:00:00Z',questions:[{id:'output',header:'输出参数',question:'这次输出使用什么格式？',options:[{label:'GeoTIFF',description:'保存带坐标信息的影像'},{label:'PNG',description:'仅保存预览图片'}]}]}});
 if(stage==='reply'||stage==='completed'){
  next=reduceCodexItems(next,'fixture-run',stage==='reply'?'item/started':'item/completed',{item:{type:'agentMessage',id:'final',phase:'final_answer',text:stage==='completed'?(long?longFinal:final):text}});
  if(stage==='completed'){
   const answer=next.at(-1)!;
   answer.modelReceipts=[{generationId:'fixture-receipt',state:'settled',inputTokens:1200,outputTokens:80,cachedInputTokens:600,reasoningTokens:0}];
   answer.tokenUsage=aggregateTurnTokenUsage(turnUsageSources(next)[answer.id],answer.modelReceipts);
  }
 }
 return next;
}
function Harness(){
 const [stage,setStage]=useState<Stage>((params.get('stage') as Stage)||'command');
 const [text,setText]=useState('');
 const [dark,setDark]=useState(params.get('theme')==='dark');
 const [narrow,setNarrow]=useState(params.has('narrow'));
 const [long,setLong]=useState(params.has('long'));
 const [question,setQuestion]=useState<string|null>(null);
 useEffect(()=>{document.documentElement.dataset.theme=dark?'dark':'light';},[dark]);
 useEffect(()=>{if(stage!=='reply')return;setText('');let n=0;const output=long?longFinal:final;const timer=setInterval(()=>{n+=7;setText(output.slice(0,n));if(n>=output.length)clearInterval(timer);},120);return()=>clearInterval(timer);},[stage,long]);
 const busy=['thinking','exploration','command','reply','approval'].includes(stage);
 const rows=rowsFor(stage,text,long);
 return <TooltipProvider><main style={{height:'100dvh',display:'flex',flexDirection:'column',background:'var(--app-frame)',color:'var(--app-text)'}}>
  <header style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:4,padding:'10px 14px',borderBottom:'1px solid var(--app-line)'}}><strong style={{fontSize:13,marginRight:12}}>本地界面回放 · 不调用模型</strong>{Object.entries(states).map(([value,label])=><Button key={value} variant="ghost" size="sm" data-testid={value} onClick={()=>setStage(value as Stage)}>{label}</Button>)}<Button variant="ghost" size="sm" data-testid="theme" onClick={()=>setDark(!dark)}>切换主题</Button><Button variant="ghost" size="sm" data-testid="narrow" onClick={()=>setNarrow(!narrow)}>切换窄屏</Button><Button variant="ghost" size="sm" data-testid="long" onClick={()=>setLong(!long)}>长输出</Button></header>
  <div className="resizable-workspace" style={{flex:1,minHeight:0,display:'flex',width:'100%',maxWidth:narrow?360:860,margin:'auto'}}><section className="agent-panel agent-primary" style={{width:'100%',border:0,boxShadow:'none'}}>
   <header className="agent-header"><strong>故宫历史影像</strong></header>
   <ChatTranscript conversationId="codex-ui-fixture" messages={rows} busy={busy} activeTurnId={busy?'fixture-run':null} activity={stage==='approval'?'等待你的回复…':stage==='exploration'?'正在核对计划…':'正在思考下一步…'} onReviewSource={()=>{}} onApproveExtension={()=>{}} openInputId={question} onOpenInput={setQuestion} onInputReply={async()=>{setQuestion(null);setStage('completed');}}/>
   <footer className="agent-composer"><div className="geod-prompt-input" style={{padding:18,fontSize:14,color:'var(--app-soft-text)'}}>描述需求，添加图片、数据网址或矢量范围</div></footer>
  </section></div>
 </main></TooltipProvider>;
}
const root=import.meta.hot?.data.root??createRoot(document.getElementById('root')!);
if(import.meta.hot)import.meta.hot.data.root=root;
root.render(<Harness/>);

// Isolated transcript states; no model calls, native tools or persisted user data.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatTranscript} from '../src/chat-ui';
import {Button} from '../src/components/motion/button/base';
import {TooltipProvider} from '../src/ui-tooltip';
import type {DisplayMessage} from '../src/pending-generations';
import {validatedInputReply} from '../src/user-input';
import '../src/styles.css';
import '../src/theme.css';
import '../src/workspace.css';

document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')??'light';
type State='thinking'|'waiting'|'tool'|'writing'|'new-turn'|'active-only'|'completed'|'stopped';
const labels: Record<State,string>={thinking:'正在思考下一步…',waiting:'等待你的回复…',tool:'正在计算影像计划…',writing:'正在生成回复…','new-turn':'正在等待模型响应…','active-only':'正在思考下一步…',completed:'',stopped:''};
const scrollFixture=new URLSearchParams(location.search).has('scroll');
const questions=[{id:'crs',header:'影像源 · 分辨率 · 坐标系',question:'输出使用哪种坐标系？',options:[{label:'EPSG:4490',description:'CGCS2000 经纬度'}]}];

function Harness(){
 const [state,setState]=useState<State>('thinking');
 const [openInputId,setOpenInputId]=useState<string|null>(null);
 const busy=!['completed','stopped','active-only'].includes(state);
 const activeTurnId=['completed','stopped'].includes(state)?null:state==='new-turn'?'continuation':'download';
 const rows:DisplayMessage[]=[
  {id:'human',role:'user',content:'把沿途1公里范围内的影像下载'},
  ...Array.from({length:11},(_,i)=>({id:'tool-'+i,turnId:'download',role:'tool' as const,content:'检查下载参数',toolStatus:'success' as const})),
  {id:'question',turnId:'download',role:'tool',content:'补充需求',userInput:{requestId:'fixture',status:state==='waiting'?'pending':'answered',userMessageId:'human',createdAt:'2026-10-07',questions,reply:state==='waiting'?undefined:{answers:{crs:{answers:['EPSG:4490']}}}}},
  {id:'reasoning',turnId:'download',role:'tool',itemType:'reasoning',content:'思考',toolStatus:['thinking','active-only','stopped'].includes(state)?'running':'success',details:new URLSearchParams(location.search).has('short')?'正在核对已确认的输出坐标系。':Array.from({length:100},(_,i)=>`正在整理路线第 ${i+1} 段及其覆盖范围。\n\n116.373334,39.960056 116.373063,39.957356 116.373050,39.956599`).join('\n\n')}
 ];
 if(state==='tool')rows.push({id:'current-tool',turnId:'download',role:'tool',content:'计算影像计划',toolStatus:'running'});
 if(state==='writing'||state==='completed')rows.push({id:'final',turnId:'download',role:'assistant',phase:'final',streaming:state==='writing',content:scrollFixture?Array.from({length:35},(_,i)=>`成果核验第 ${i+1} 行：已生成下载计划，请核对范围和输出参数。`).join('\n\n'):'已生成下载计划，请核对范围和输出参数。'});
 if(state==='new-turn')rows.push({id:'continuation-human',role:'user',content:'继续按已提交的选项处理'});
 return <TooltipProvider><main className="activity-fixture" style={{maxWidth:680,height:'100dvh',margin:'auto',display:'flex',flexDirection:'column',background:'var(--app-surface)',color:'var(--app-text)'}}>
  <header style={{display:'flex',flexWrap:'wrap',gap:4,padding:8}}>{(['thinking','waiting','tool','writing','new-turn','active-only','completed','stopped'] as State[]).map(value=><Button key={value} variant="ghost" size="sm" data-testid={value} onClick={()=>setState(value)}>{value}</Button>)}</header>
  <ChatTranscript conversationId="activity-fixture" messages={rows} busy={busy} activeTurnId={activeTurnId} activity={labels[state]} onReviewSource={()=>{}} onApproveExtension={()=>{}} openInputId={openInputId} onOpenInput={setOpenInputId} onInputReply={async(_id,value)=>{if(!validatedInputReply(questions,value))throw new Error('Invalid fixture answer');setState('thinking');setOpenInputId(null);}}/>
  <div className="agent-composer" data-testid="composer"><div className="geod-prompt-input" style={{padding:16,minHeight:90}}>描述需求，添加图片、数据网址或矢量范围</div></div>
 </main></TooltipProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

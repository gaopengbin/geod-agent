// Isolated controlled events. Uses product components, never contacts a model or downloads data.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatTranscript} from '../src/chat-ui';
import {PromptInput} from '../src/components/agents/prompt-input';
import {MessageQueue} from '../src/message-queue';
import {TooltipProvider} from '../src/ui-tooltip';
import {Button} from '../src/components/motion/button/base';
import {editQueuedInput,queueLocked,receiptQueuedInputs} from '../src/queued-inputs';
import {turnOutcomeMessage} from '../src/turn-outcome';
import type {DisplayMessage,QueuedInput} from '../src/pending-generations';
import '../src/styles.css';import '../src/theme.css';
const initial:DisplayMessage[]=[
 {id:'user',role:'user',content:'从示例数据库读取两个项目范围，下载影像并转成 COG，生成交付清单。',turnId:'demo'},
 {id:'progress',role:'assistant',phase:'progress',content:'已读取项目范围与坐标系，开始准备两份影像。下载与转换由本机执行。',turnId:'demo'},
 {id:'sql',role:'tool',toolName:'connections_query',toolStatus:'success',content:'查询项目范围 · 2 条记录',details:'数据库：示例数据库\n只读查询：SELECT project_id, name, geometry FROM projects\n返回：2 个项目范围',turnId:'demo'},
 {id:'download',role:'tool',toolName:'jobs_start',toolStatus:'success',content:'下载项目影像 · 2 个任务已创建',details:'项目 A · 25 张瓦片\n项目 B · 18 张瓦片\n任务状态以任务与成果中的本机记录为准。',turnId:'demo'},
 {id:'cog',role:'tool',toolName:'gdal_translate',toolStatus:'running',content:'转换 Cloud Optimized GeoTIFF',details:'格式：COG\n概览：AUTO\n压缩：DEFLATE',turnId:'demo'},
];
function Harness(){
 const [rows,setRows]=useState(initial),[busy,setBusy]=useState(true),[stopping,setStopping]=useState(false),[draft,setDraft]=useState(''),[paused,setPaused]=useState(false),[dark,setDark]=useState(false);
 const [items,setItems]=useState<QueuedInput[]>([{id:'q1',text:'交付清单请增加坐标系和文件大小。',createdAt:'now'},{id:'q2',text:'再生成一份项目成果说明，便于发给客户。',createdAt:'now'}]);
 const [sending,setSending]=useState<string|null>(null);
 function accept(item:QueuedInput){const request=`${item.id}:${item.revision??0}`;setItems(old=>old.map(row=>row.id===item.id?{...row,delivery:{state:'sending',clientRequestId:request,runId:'demo'}}:row));setSending(item.id);}
 function ack(){setItems(old=>{const item=old.find(i=>i.id===sending);if(!item)return old;setRows(rows=>[...rows,{id:`accepted-${item.id}`,turnId:'demo',role:'user',content:item.text}]);return receiptQueuedInputs(old,{state:'accepted',clientRequestId:item.delivery!.clientRequestId,runId:'demo'}).items;});setSending(null);}
 function complete(){setBusy(false);setStopping(false);setRows(old=>[...old.filter(row=>!row.connection).map(row=>row.toolStatus==='running'?{...row,toolStatus:'success' as const}:row),{id:'final',turnId:'demo',role:'assistant',phase:'final',content:'已完成两份 COG 与交付清单。\n\n- 项目 A：影像、COG、元数据\n- 项目 B：影像、COG、元数据\n- 交付清单：坐标系、文件大小与校验值',turnDurationMs:47200}]);}
 return <TooltipProvider><div data-theme={dark?'dark':'light'} className="app-shell" style={{height:'100dvh',background:'var(--app-bg)',color:'var(--app-text)'}}>
 <header className="app-header custom-titlebar"><div className="brand"><img src="/geod-symbol.png" alt=""/><strong>GeoD <span>Agent</span></strong></div><span style={{fontSize:12,color:'var(--app-muted-text)'}}>交互验收 · 示例事件</span><div style={{display:'flex',gap:4}}><Button size="sm" variant="ghost" onClick={()=>{setDark(!dark);document.documentElement.dataset.theme=dark?'light':'dark';}}>切换主题</Button><Button size="sm" variant="ghost" onClick={()=>setRows(old=>{const prior=old.find(r=>r.connection);return [...old.filter(r=>!r.connection),{id:'connection-demo',turnId:'demo',role:'tool',content:'',connection:{state:'reconnecting',attempt:(prior?.connection?.attempt??0)+1,details:'连接暂时中断，正在恢复原执行订阅。已保留部分回答、下载任务与审批记录。'}}];})}>模拟重连</Button><Button size="sm" variant="ghost" onClick={()=>{setRows(old=>[...old.filter(r=>!r.connection).map(row=>row.toolStatus==='running'?{...row,toolStatus:'stopped' as const}:row),turnOutcomeMessage('demo',{status:'interrupted',message:'已停止',durationMs:18200})]);setStopping(false);setBusy(false);setPaused(true);}}>确认停止</Button><Button size="sm" variant="ghost" onClick={ack} disabled={!sending}>确认送达</Button><Button size="sm" variant="ghost" onClick={complete}>完成</Button></div></header>
 <div style={{display:'flex',flex:1,minHeight:0}}><aside style={{width:210,padding:'24px 20px',background:'var(--app-subtle)',flexShrink:0}}><p>新对话</p><p>定时任务</p><p>图源管理</p><p>模型与渠道</p><p style={{marginTop:48,fontSize:12,color:'var(--app-muted-text)'}}>示例工作区</p><p>数据库项目交付</p></aside><main className="agent-panel" style={{flex:1,minWidth:0,maxWidth:920,margin:'0 auto',width:'100%'}}><div className="agent-header"><strong>数据库项目交付</strong></div><ChatTranscript conversationId="turn-ui-fixture" messages={rows} busy={busy} activeTurnId={busy?"demo":null} activity={stopping?'正在停止…':'正在处理…'} onReviewSource={()=>{}} onApproveExtension={()=>{}}/>
 <MessageQueue items={items} paused={paused} sendingId={sending} canSendNow={!stopping} onPausedChange={setPaused} onRemove={id=>setItems(old=>old.filter(i=>i.id!==id||queueLocked(i)))} onSendNow={accept} onEdit={(id,text)=>setItems(old=>old.map(i=>i.id===id?editQueuedInput(i,text):i))} onEditDraft={(id,text)=>setItems(old=>old.map(i=>i.id===id?{...i,editDraft:text}:i))} onMove={(id,offset)=>setItems(old=>{const next=[...old],from=next.findIndex(i=>i.id===id),to=from+offset;if(to<0||to>=next.length||queueLocked(next[from])||queueLocked(next[to]))return old;[next[from],next[to]]=[next[to],next[from]];return next;})} onCheck={()=>{}}/>
 <div className="agent-composer"><PromptInput value={draft} onValueChange={setDraft} className="geod-prompt-input" placeholder="描述需求，添加图片、数据网址或矢量范围" loading={busy} stopping={stopping} allowSteer loadingSubmitLabel="加入消息队列" model="luna" models={[{value:'luna',label:'GPT-6 Luna · 赞助'}]} onStop={()=>setStopping(true)} onSubmit={text=>{setItems(old=>[...old,{id:crypto.randomUUID(),text,createdAt:'now'}]);setDraft('');}}/></div></main></div></div></TooltipProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

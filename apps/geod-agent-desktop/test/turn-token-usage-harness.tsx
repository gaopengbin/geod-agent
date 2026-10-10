// Isolated transcript fixture: no actual model requests or wallet operations.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatTranscript } from '../src/chat-ui';
import { TooltipProvider } from '../src/ui-tooltip';
import { setLanguagePreferences } from '../src/i18n';
import type { DisplayMessage } from '../src/pending-generations';
import type { TurnTokenUsage } from '../src/turn-token-usage';
import '../src/styles.css';
import '../src/theme.css';

const query=new URLSearchParams(location.search);
setLanguagePreferences({language:query.get('locale')==='en'?'en':'zh-CN'});
document.documentElement.dataset.theme=query.get('theme')==='dark'?'dark':'light';
function Harness(){
 const state=query.get('state')??'complete';
 const initial:DisplayMessage[]=[{id:'user',role:'user',content:'请下载这个范围的影像。'},
  {id:'work',turnId:'run',role:'tool',itemType:'reasoning',content:'思考',toolStatus:state==='streaming'?'running':'success',details:'先核对图源和参数，再生成计划。'},
  {id:'progress',turnId:'run',role:'assistant',phase:'progress',content:'范围已核对，正在生成计划。'},
  state==='stopped'?{id:'answer',turnId:'run',role:'tool',content:'已停止',turnOutcome:{status:'interrupted',message:'本輪回复已停止。'}}:
   {id:'answer',turnId:'run',role:'assistant',phase:'final',streaming:state==='streaming',content:'已完成影像下载，成果已保存在工作区，可在右侧查看。'},
 ];
 const stored=localStorage.getItem(`usage-${state}`);
 if(stored)initial.at(-1)!.tokenUsage=JSON.parse(stored);
 const [messages,setMessages]=useState(initial);
 function save(id:string,tokenUsage:TurnTokenUsage){
  localStorage.setItem(`usage-${state}`,JSON.stringify(tokenUsage));
  setMessages(rows=>rows.map(item=>item.id===id?{...item,tokenUsage}:item));
 }
 return <TooltipProvider><main style={{width:'100%',maxWidth:570,height:'100dvh',margin:'auto',display:'flex',flexDirection:'column',background:'var(--app-surface)',color:'var(--app-text)'}}>
  <ChatTranscript conversationId="fixture" messages={messages} busy={state==='streaming'} activeTurnId={state==='streaming'?'run':null} activity="正在生成回复…" onReviewSource={()=>{}} onApproveExtension={()=>{}} onTokenUsage={save}/>
 </main></TooltipProvider>;
}
const root=import.meta.hot?.data.root??createRoot(document.getElementById('root')!);
if(import.meta.hot)import.meta.hot.data.root=root;
root.render(<Harness/>);

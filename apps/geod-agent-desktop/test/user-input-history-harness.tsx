import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ChatTranscript} from '../src/chat-ui';import type {DisplayMessage} from '../src/pending-generations';
import {validatedInputReply} from '../src/user-input';import type {UserInputRecord} from '../src/user-input-records';
import '../src/styles.css';import '../src/theme.css';import '../src/workspace.css';import '../src/codex-work.css';
const params=new URLSearchParams(location.search),theme=params.get('theme')??'dark';document.documentElement.dataset.theme=theme;
const key='geod-input-history-test-'+theme;
const record:UserInputRecord={requestId:'persistent-fixture',status:'pending',userMessageId:'human',createdAt:'2026-10-07',questions:[{id:'xian80_form',header:'西安80形式',question:'“西安80”采用哪种具体坐标形式？',options:[{label:'3度带 带号 2363',description:'EPSG:2363，坐标含带号前缀'},{label:'地理坐标 4610',description:'EPSG:4610，仅经纬度'}]},{id:'apply_mode',header:'应用方式',question:'这份成果与现有计划如何共存？',options:[{label:'两版都保留',description:'保留现有计划，另建一份西安80计划'},{label:'替换当前计划',description:'使用新的成果参数'}]}]};
function Harness(){
 const [messages,setMessages]=useState<DisplayMessage[]>(()=>JSON.parse(localStorage.getItem(key)??'null')??[{id:'human',role:'user',content:'给我一份西安80的坐标系的'},{id:'question',role:'tool',content:'补充需求',userInput:record}]);
 const [open,setOpen]=useState<string|null>(null),[chat,setChat]=useState('original');
 function update(next:DisplayMessage[]){setMessages(next);localStorage.setItem(key,JSON.stringify(next));}
 return <main style={{maxWidth:560,height:'90vh',margin:'20px auto',padding:'0 12px',display:'flex',flexDirection:'column'}}>
  <h2>会话问答持久化验证</h2><button data-testid="switch-chat" onClick={()=>setChat(chat==='original'?'other':'original')}>切换测试会话</button>
  <ChatTranscript conversationId={chat} messages={chat==='original'?messages:[]} busy={false} activity="" onReviewSource={()=>{}} onApproveExtension={()=>{}} openInputId={open} onOpenInput={setOpen} onInputReply={async(id,value)=>{
   const item=messages.find(m=>m.id===id)!,record=item.userInput!,reply=validatedInputReply(record.questions,value);
   update(messages.map(m=>m.id===id?{...m,userInput:{...record,status:reply?'answered':'cancelled',reply:reply??undefined,draft:undefined}}:m));setOpen(null);
  }} onInputDraft={(id,draft)=>{const old=messages.find(m=>m.id===id)?.userInput;if(old&&JSON.stringify(old.draft)!==JSON.stringify(draft))update(messages.map(m=>m.id===id?{...m,userInput:{...old,draft}}:m));}}/>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

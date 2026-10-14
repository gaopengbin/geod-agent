import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {ConversationRow} from '../src/conversation-manager';
import {ConversationSessions,conversationSessionSeed} from '../src/conversation-sessions';
import type {SavedChat} from '../src/pending-generations';
import {Button} from '../src/components/motion/button/base';
import '../src/styles.css';
import '../src/theme.css';
import '../src/workspace.css';
const base:SavedChat[]=[{conversationId:'a',title:'下载北京市影像',messages:[],display:[]},{conversationId:'b',title:'查看内置图源',messages:[],display:[],completedReplyId:'b-reply',readReplyId:''}];
function Harness(){
 const sessions=useRef(new ConversationSessions()).current;useSyncExternalStore(sessions.subscribe,sessions.getRevision,sessions.getRevision);
 const [active,setActive]=useState('a'),[theme,setTheme]=useState('light');const sequence=useRef(0);
 useEffect(()=>{document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme},[theme]);
 const a=sessions.get('fixture','a',()=>({...conversationSessionSeed(base[0]),busy:true}));
 const chats=base.map(chat=>({...chat,...sessions.get('fixture',chat.conversationId,()=>conversationSessionSeed(chat)).snapshot()}));
 const finish=()=>{a.completeReply('a-reply-'+(++sequence.current),active==='a');a.set('busy',false);};
 return <div className={`app ${theme==='light'?'light-theme':''}`} style={{minHeight:'100vh',display:'block'}}>
  <header style={{padding:'20px 24px',borderBottom:'1px solid var(--color-border)'}}><h1 style={{fontSize:18,margin:0}}>会话列表状态回放</h1><p style={{fontSize:13,color:'var(--color-muted-foreground)'}}>本地界面回放 · 不调用模型</p></header>
  <div style={{display:'flex',maxWidth:820,margin:'40px auto',border:'1px solid var(--color-border)',borderRadius:12,overflow:'hidden'}}>
   <aside style={{width:224,flexShrink:0,padding:12,background:'var(--app-sidebar-bg,var(--color-muted))'}} aria-label="会话列表">
    <p style={{fontSize:12,padding:'0 10px',color:'var(--color-muted-foreground)'}}>工作区 · geod</p>
    {chats.map(chat=><ConversationRow key={chat.conversationId} chat={chat} active={active===chat.conversationId} time="刚刚" running={sessions.get('fixture',chat.conversationId).get('busy',false)} onSelect={()=>{sessions.get('fixture',chat.conversationId).markRead();setActive(chat.conversationId)}} onAction={()=>{}}/>)}
   </aside>
   <main style={{padding:24,flex:1,minWidth:0}}><h2 style={{fontSize:16}}>{chats.find(c=>c.conversationId===active)?.title}</h2><p>{a.get('busy',false)?'AI 回复正在进行中':'AI 回复已结束'}</p><p style={{fontSize:13,color:'var(--color-muted-foreground)'}}>切换会话后点击“完成回复”，检查蓝点；打开原会话后蓝点应消失。</p>
    <div style={{display:'flex',flexWrap:'wrap',gap:8}}><Button onClick={()=>a.set('busy',true)}>开始回复</Button><Button onClick={finish}>完成回复</Button><Button variant="outline" onClick={()=>a.set('busy',false)}>失败或停止</Button><Button variant="ghost" onClick={()=>setTheme(t=>t==='light'?'dark':'light')}>切换主题</Button></div>
   </main>
  </div>
 </div>;
}
const root=createRoot(document.getElementById('root')!);root.render(<Harness/>);

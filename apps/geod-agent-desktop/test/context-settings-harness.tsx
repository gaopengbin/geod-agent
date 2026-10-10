// Isolated settings UI fixture. Native SQLite persistence is tested separately.
import {useState} from 'react';import {createRoot} from 'react-dom/client';
import {ContextSettingsPanel,ContextSettingsDialog,type ContextSettingsClient,type ContextPreferences} from '../src/context-settings';
import {Button} from '../src/components/motion/button/base';
import '../src/styles.css';import '../src/theme.css';import '../src/workspace.css';
const params=new URLSearchParams(location.search);document.documentElement.dataset.theme=params.get('theme')??'light';
const capacity=Number(params.get('capacity')??1000000);
const client:ContextSettingsClient={
 get:async (owner,conversation)=>{const p:ContextPreferences=JSON.parse(localStorage.getItem(`fixture-context-${owner}`)??'null')??{contextWindowTokens:null,autoCompactPercent:90};const effective=Math.min(p.contextWindowTokens??capacity,capacity);return {preferences:p,model:'Fixture model',modelContextWindow:capacity,maxOutputTokens:4096,effectiveContextWindow:effective,autoCompactTokenLimit:Math.min(Math.floor(effective*p.autoCompactPercent/100),effective-5120),spending:{budgetCredits:JSON.parse(localStorage.getItem(`fixture-budget-${owner}-${conversation}`)??'null'),spentCredits:37.25,recordedRequests:20,unknownRequests:0}};},
 set:async(owner,conversation,p,budget)=>{if(p.contextWindowTokens!==null&&p.contextWindowTokens<16000)throw Error('Invalid budget');localStorage.setItem(`fixture-context-${owner}`,JSON.stringify(p));localStorage.setItem(`fixture-budget-${owner}-${conversation}`,JSON.stringify(budget));return client.get(owner,conversation);},
};
function Harness(){const [owner,setOwner]=useState('alice'),[conversation,setConversation]=useState('first'),[open,setOpen]=useState(false);return <main className="ai-channels-page" style={{maxWidth:760,margin:'auto',padding:20,background:'var(--app-surface)',color:'var(--app-text)'}}>{params.has('dialog')?<><Button data-testid="open-settings" variant="outline" onClick={()=>setOpen(true)}>配置上下文</Button><ContextSettingsDialog open={open} onOpenChange={setOpen} accountId={owner} conversationId="fixture" client={client}/></>:<><Button data-testid="switch-account" variant="ghost" onClick={()=>setOwner(owner==='alice'?'bob':'alice')}>切换测试账号</Button><Button data-testid="switch-conversation" variant="ghost" onClick={()=>setConversation(conversation==='first'?'other':'first')}>切换测试会话</Button><ContextSettingsPanel accountId={owner} conversationId={conversation} client={client}/></>}</main>;}
createRoot(document.getElementById('root')!).render(<Harness/>);

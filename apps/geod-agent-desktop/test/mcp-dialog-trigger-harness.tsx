import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ChatTranscript} from '../src/chat-ui';
import {reconcileMcpProposals} from '../src/mcp-onboarding';
import {AMAP_MCP_URL, MAPBOX_MCP_URL, providerSetupProposal} from '../src/mcp-provider-presets';
import type {DisplayMessage} from '../src/pending-generations';
import '../src/styles.css';
import '../src/theme.css';
import '../src/workspace.css';
import '../src/codex-work.css';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'light';
const provider = params.get('provider') === 'mapbox' ? 'mapbox' : 'amap';
const url = provider === 'mapbox' ? MAPBOX_MCP_URL : AMAP_MCP_URL;
const storedMessages: DisplayMessage[] = [
  {id:'old-request', role:'user', content:'接入地图连接器'},
  {id:'old-setup', role:'tool', content:'等待本机配置凭据', extensionProposal:providerSetupProposal(url,'old-setup')},
  {id:'current-request', role:'user', content:'导出已经绘制的路线'}
];

function Harness() {
  const [busy, setBusy] = useState(true);
  const [chat, setChat] = useState('original');
  const [messages, setMessages] = useState(storedMessages);
  return <main style={{maxWidth:600, height:'90vh', margin:'20px auto', padding:'0 12px', display:'flex', flexDirection:'column'}}>
    <h2>历史 MCP 配置卡触发验证</h2>
    <div style={{display:'flex', gap:12, flexWrap:'wrap'}}>
      <button data-testid="toggle-busy" onClick={()=>setBusy(!busy)}>{busy?'结束当前任务':'开始无关任务'}</button>
      <button data-testid="switch-chat" onClick={()=>setChat(chat==='original'?'other':'original')}>切换测试会话</button>
      <button data-testid="configured" onClick={()=>setMessages(reconcileMcpProposals(messages,[{id:'saved-connector', name:'已配置地图服务', url, enabled:false, ...(provider==='mapbox'?{headerNames:['Authorization']}:{queryNames:['key']})}]))}>同步已保存凭据</button>
      <button data-testid="enabled" onClick={()=>setMessages(reconcileMcpProposals(messages,[{id:'saved-connector', name:'已配置地图服务', url, enabled:true}]))}>同步已启用状态</button>
    </div>
    <ChatTranscript conversationId={chat} messages={chat==='original'?messages:[]} busy={busy} activity="正在导出路线…" onReviewSource={()=>{}} onApproveExtension={()=>{}}/>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Harness/>);

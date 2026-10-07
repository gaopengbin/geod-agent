import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {McpKeyDialog} from '../src/mcp-key-dialog';import {amapSetupProposal,AMAP_MCP_URL} from '../src/mcp-onboarding';
import {MAPBOX_MCP_URL,providerSetupProposal} from '../src/mcp-provider-presets';
import '../src/styles.css';import '../src/theme.css';import '../src/workspace.css';
const params=new URLSearchParams(location.search);document.documentElement.dataset.theme=params.get('theme')??'light';
const mapbox=params.get('provider')==='mapbox',url=mapbox?MAPBOX_MCP_URL:AMAP_MCP_URL,credential=mapbox?'pk.test_payload.test_signature':'a'.repeat(32);
function Harness(){const [open,setOpen]=useState(false),[done,setDone]=useState(false),[attempt,setAttempt]=useState(0);
 return <main style={{padding:24}}><h1>本机 MCP 配置验证</h1><button onClick={()=>setOpen(true)}>配置并连接</button>{done&&<p role="status">测试通过，等待确认启用</p>}{open&&<McpKeyDialog proposal={mapbox?providerSetupProposal(url,'fixture'):amapSetupProposal('fixture')} conversationId="fixture" onClose={()=>setOpen(false)} onConnected={()=>setDone(true)} configure={async(_name,key)=>{setAttempt(attempt+1);if(attempt===0)throw new Error('测试连接失败，请检查凭据和网络');if(key!==credential)throw new Error('请输入测试凭据');return {connector:{id:'fixture-connector',name:mapbox?'Mapbox':'高德',url,enabled:false,...(mapbox?{headerNames:['Authorization']}:{queryNames:['key']})},tools:{connectorId:'fixture-connector',name:mapbox?'Mapbox':'高德',tools:[{name:mapbox?'directions_tool':'maps_geo',inputSchema:{}}]}};}}/>}</main>;
}createRoot(document.getElementById('root')!).render(<Harness/>);

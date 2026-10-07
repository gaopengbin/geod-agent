import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {GisInstallFlow,type GisInstallRequest} from '../src/gis-install-flow';
import {GisDependencyGate} from '../src/gis-dependencies';
import {GisInstallCard} from '../src/gis-install-card';
import {api,errorMessage,type GisInstallProgress} from '../src/api';
import {listen} from '@tauri-apps/api/event';
import '../src/styles.css';import '../src/theme.css';import '../src/workspace.css';import '../src/codex-work.css';
const params=new URLSearchParams(location.search),native=params.has('native');
const offer={id:'gis-raster-convert',name:'栅格转换',description:'',ready:false,enabled:false,downloadBytes:41820004,installedBytes:135072207,components:[]};
function Harness(){
  const [request,setRequest]=useState<GisInstallRequest|null>(null),[result,setResult]=useState<unknown>(null);
  const mounted=useRef(false),attempts=useRef(0),progress=useRef<(p:GisInstallProgress)=>void>(()=>{});
  document.documentElement.dataset.theme=params.get('theme')??'dark';
  const flow=useRef(new GisInstallFlow({change:setRequest,installed:()=>{},failure:e=>setResult({error:errorMessage(e)}),errorMessage,
    cancel:native?api.gisInstallCancel:async()=>{},
    subscribe:native?fn=>listen<GisInstallProgress>('geod:gis-install-progress',event=>fn(event.payload)):async fn=>{progress.current=fn;return()=>{};},
    install:async(id,requestId)=>{
      if(native)return api.gisSkillInstall(id,null,requestId);
      if(params.has('failure')&&attempts.current++===0)throw new Error('下载连接中断，请重试');
      for(const phase of ['downloading','verifying','installing'] as const){
        progress.current({featureId:id,requestId,phase,bytes:20910002,total:41820004});
        await new Promise<void>(resolve=>Object.assign(window,{gisInstallFixtureNext:resolve}));
      }
    },
  }));
  if(!mounted.current){mounted.current=true;queueMicrotask(async()=>{
    const gate=new GisDependencyGate();
    try{const ready=await gate.ensure(()=>native?api.gisInstallPrepare(offer.id):Promise.resolve(offer),value=>flow.current.ask(value,'按已选坐标系导出影像'));setResult({result:ready});}catch(e){setResult({error:errorMessage(e)});}
  });}
  return <main style={{maxWidth:540,margin:'32px auto',padding:16}}><h2>{native?'本机安装验证':'安装提示界面验证'}</h2>{request&&<GisInstallCard request={request} onInstall={()=>void flow.current.install()} onCancel={()=>flow.current.cancel()}/>} {result!==null&&<pre data-testid="reply">{JSON.stringify(result)}</pre>}</main>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

// Runs the production card and installer against the actual desktop IPC.
// A separate test surface preserves the user's current conversation and never starts a data download.
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api,errorMessage,type GisInstallProgress} from '../src/api';
import {GisInstallCard} from '../src/gis-install-card';
import {GisInstallFlow,type GisInstallRequest} from '../src/gis-install-flow';
import {GisDependencyGate} from '../src/gis-dependencies';
import {listen} from '@tauri-apps/api/event';
export async function mountNativeInstall(directory:string){
 const invoke=window.__TAURI_INTERNALS__.invoke;
 const offer=await api.gisInstallPrepare('gis-raster-convert');
 const conversationId=crypto.randomUUID();
 await invoke('workspace_set',{conversationId,directory,permission:'confirmEach'});
 await invoke('workspace_set_output_crs',{conversationId,crs:'EPSG:4490'});
 const sources=await api.sourcesList(),source=sources.find(s=>s.displayName==='Esri World Imagery');
 if(!source)throw new Error('Test imagery source missing');
 const spec={schemaVersion:'0.1',kind:'imagery',sourceId:source.id,bounds:[116.37,39.97,116.42,40.01],zoomLevels:[18],outputFormats:['geotiff'],outputDirectory:directory+'/after-install',exportOptions:{targetCrs:'EPSG:4490',compression:'none'},limits:{maxTiles:10000,maxDecodedRgbaBytes:2147483648}};
 const snapshot=JSON.stringify(spec),phases=new Set<string>();let beforeError:string|undefined;
 if(!offer.ready){try{await invoke('plans_create',{spec,conversationId,toolExecutionId:'gis-before-'+crypto.randomUUID()});}catch(e){beforeError=(e as {code:string}).code;}}
 const node=document.createElement('div');node.id='gis-install-native-test';Object.assign(node.style,{position:'fixed',zIndex:'10000',inset:'60px auto auto 50%',transform:'translateX(-50%)',width:'min(540px,calc(100vw - 32px))',background:'var(--app-surface)',borderRadius:'16px',padding:'16px',boxShadow:'0 8px 40px #0005'});document.body.append(node);
 let report:unknown=null;const root=createRoot(node);
 function View(){
  const [request,setRequest]=useState<GisInstallRequest|null>(null),[result,setResult]=useState<unknown>(null);
  useEffect(()=>{
   const flow=new GisInstallFlow({change:setRequest,installed:()=>{},failure:e=>setResult({error:errorMessage(e)}),errorMessage,cancel:api.gisInstallCancel,
    install:(id,requestId)=>api.gisSkillInstall(id,null,requestId),
    subscribe:fn=>listen<GisInstallProgress>('geod:gis-install-progress',event=>{phases.add(event.payload.phase);fn(event.payload);}),
   });
   const gate=new GisDependencyGate();
   Object.assign(node,{install:()=>flow.install(),cancel:()=>flow.cancel()});
   void gate.ensure(async()=>offer,value=>flow.ask(value,'按已选坐标系导出影像')).then(async state=>{
    if(state!=='ready'){report={state};setResult(report);return;}
    const stored=await invoke('plans_create',{spec,conversationId,toolExecutionId:'gis-after-'+crypto.randomUUID()}) as {planId:string;plan:{spec:{exportOptions:{targetCrs:string;compression:string};bounds:number[]};totalTiles:number}};
    const after=await api.gisInstallPrepare(offer.id),jobs=await invoke('jobs_for_plan',{planId:stored.planId});
    report={state,actualNativeIpc:true,downloadBytes:offer.downloadBytes,wasReady:offer.ready,beforeError,ready:after.ready,enabled:after.enabled,phases:[...phases],originalArgumentsPreserved:snapshot===JSON.stringify(spec),crs:stored.plan.spec.exportOptions.targetCrs,compression:stored.plan.spec.exportOptions.compression,bounds:stored.plan.spec.bounds,planId:stored.planId,totalTiles:stored.plan.totalTiles,downloadStarted:!!jobs};setResult(report);
   }).catch(e=>{report={error:errorMessage(e)};setResult(report);});
  },[]);
  return <><h3 style={{fontSize:15,margin:'0 0 12px'}}>本机 GIS 安装验证</h3>{request&&<GisInstallCard request={request} onInstall={()=>(node as unknown as {install:()=>void}).install()} onCancel={()=>(node as unknown as {cancel:()=>void}).cancel()}/>} {result!==null&&<pre data-testid="native-install-reply" style={{fontSize:12,whiteSpace:'pre-wrap'}}>{JSON.stringify(result)}</pre>}</>;
 }
 root.render(<View/>);
 Object.assign(window,{gisInstallTestReport:()=>report,gisInstallTestCleanup:()=>{root.unmount();node.remove();}});
 return {offer,beforeError};
}

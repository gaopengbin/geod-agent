import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {RtkOutputComponent} from '../src/rtk-output-component';
import {TooltipProvider} from '../src/ui-tooltip';
import '../src/styles.css';import '../src/theme.css';
const params=new URLSearchParams(location.search);document.documentElement.dataset.theme=params.get('theme')??'light';
const callbacks=new Map<number,(value:unknown)=>void>();let serial=0,finish:(value:unknown)=>void=()=>{},cancel:()=>void=()=>{},attempt=0;
const item={version:'0.40.0',supported:true,installed:false,ready:false,enabled:false,downloadBytes:3884282,installedBytes:8754176,activeRequestId:null as string|null,sourceUrl:'https://github.com/rtk-ai/rtk'};
Object.assign(window,{__TAURI_EVENT_PLUGIN_INTERNALS__:{unregisterListener:()=>{}},__TAURI_INTERNALS__:{transformCallback:(fn:(value:unknown)=>void)=>{callbacks.set(++serial,fn);return serial;},unregisterCallback:(id:number)=>callbacks.delete(id),invoke:async(command:string,args:Record<string,unknown>)=>{
 if(command==='rtk_status')return {...item};
 if(command==='plugin:event|listen')return 1;
 if(command==='plugin:event|unlisten')return;
 if(command==='rtk_install'){
  if(params.has('failure')&&attempt++===0)throw {code:'RTK_DOWNLOAD_FAILED',message:'组件下载失败，请重试或从本地安装'};
  item.activeRequestId=String(args.requestId);setTimeout(()=>callbacks.forEach(fn=>fn({payload:{requestId:args.requestId,phase:'downloading',bytes:1942141,total:3884282}})),30);
  return new Promise((resolve,reject)=>{finish=()=>{Object.assign(item,{activeRequestId:null,ready:true,installed:true,enabled:true,downloadBytes:0});resolve({...item});};cancel=()=>{item.activeRequestId=null;reject({code:'RTK_INSTALL_CANCELLED',message:'安装已取消，可稍后重试'});};});
 }
 if(command==='rtk_install_cancel'){cancel();return {cancelled:true};}
 if(command==='rtk_set_enabled'){item.enabled=!!args.value;return {...item};}
 throw new Error('Unexpected fixture operation: '+command);
}},rtkFixtureFinish:()=>finish({...item})});
function Harness(){const [visible,setVisible]=useState(true);Object.assign(window,{rtkFixtureShow:(value:boolean)=>setVisible(value)});return <TooltipProvider><main style={{padding:18}}>{visible&&<RtkOutputComponent active/>}</main></TooltipProvider>;}
createRoot(document.getElementById('root')!).render(<Harness/>);

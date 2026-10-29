import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {desktopAvailable} from './api';
const prefix='geod-agent-activity-consent-v1:';
function legacyPreference(account:string):boolean|null{
 try{const value=localStorage.getItem(prefix+account);return value==='disabled'?false:value==='enabled'?true:null;}catch{return null;}
}
export function useActivityTelemetry(accountId:string|null){
 const [enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const [ready,setReady]=useState(false);
 const owner=useRef(accountId);owner.current=accountId;
 const revision=useRef(0);
 useEffect(()=>{
  setEnabled(false);setBusy(false);setError(false);setReady(false);
  if(!desktopAvailable||!accountId)return;
  let disposed=false,pending=false;
  const sync=async()=>{
   if(disposed||pending)return;pending=true;const before=revision.current;
   try{
    // Read native state. Absence of a browser key is not an opt-out.
    const value=await invoke<{enabled:boolean}>('agent_activity_status',{accountId,legacyPreference:legacyPreference(accountId)});
    if(!disposed&&before===revision.current){setEnabled(value.enabled);setReady(true);setError(false);try{localStorage.removeItem(prefix+accountId);}catch{}}
   }catch{if(!disposed)setError(true);}finally{pending=false;}
  };
  void sync();const timer=window.setInterval(()=>void sync(),15000);
  return()=>{disposed=true;clearInterval(timer);};
 },[accountId]);
 const set=async(value:boolean)=>{
  if(!accountId||busy)return false;const account=accountId;revision.current++;setBusy(true);setError(false);
  try{await invoke('agent_activity_set',{accountId:account,enabled:value});if(owner.current===account){setEnabled(value);setReady(true);try{localStorage.removeItem(prefix+account);}catch{}return true;}return false;}
  catch{if(owner.current===account)setError(true);return false;}finally{if(owner.current===account)setBusy(false);}
 };
 const toggle=()=>set(!enabled);
 return {enabled,toggle,set,busy,error,ready};
}

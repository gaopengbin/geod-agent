import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktopAvailable } from './api';
const prefix='geod-agent-activity-consent-v1:';
function consent(accountId:string|null){try{return !!accountId&&localStorage.getItem(prefix+accountId)==='enabled';}catch{return false;}}
export function useActivityTelemetry(accountId:string|null){
  const [,refresh]=useState(0);const enabled=consent(accountId);
  useEffect(()=>{
    if(!desktopAvailable||!accountId)return;
    let stopped=false,done=false;
    const sync=()=>{if(!stopped&&!done)void invoke('agent_activity_set',{accountId,enabled}).then(()=>{done=true;}).catch(()=>{});};
    sync();const timer=window.setInterval(sync,15000);return()=>{stopped=true;clearInterval(timer);};
  },[accountId,enabled]);
  const toggle=()=>{if(!accountId)return;try{localStorage.setItem(prefix+accountId,enabled?'disabled':'enabled');refresh(n=>n+1);}catch{/* Remain disabled if consent cannot be saved. */}};
  return {enabled,toggle};
}

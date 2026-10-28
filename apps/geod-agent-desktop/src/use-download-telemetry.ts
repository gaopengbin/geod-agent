import { useEffect, useRef, useState } from 'react';
import { desktopAvailable } from './api';
import { invoke } from '@tauri-apps/api/core';
import type { BackgroundSnapshot } from './background-jobs';

export interface DownloadDiagnostic {
  enabled:boolean;hasConsentRecord:boolean;reason:string;queuedEvents:number;pendingObservations:number;observedAttempts:number;
  lastAttemptAt:string|null;lastDeliveryAt:string|null;lastErrorCategory:string|null;
}
const key=(account:string)=>`geod-agent-download-telemetry-v2:${account}`;
export function useDownloadTelemetry(accountId:string|null,_snapshots:Record<string,BackgroundSnapshot>) {
  const [enabled,setEnabled]=useState(false),[diagnostic,setDiagnostic]=useState<DownloadDiagnostic|null>(null),[error,setError]=useState(false),[busy,setBusy]=useState(false);
  const owner=useRef(accountId);owner.current=accountId;
  useEffect(()=>{
    setEnabled(false);setDiagnostic(null);setError(false);setBusy(false);
    if(!desktopAvailable||!accountId)return;
    let disposed=false,pending=false;
    const refresh=async()=>{
      if(disposed||pending)return;pending=true;
      try{
        const state=await invoke<DownloadDiagnostic>('download_telemetry_status',{accountId});
        if(!disposed){setEnabled(state.enabled);setDiagnostic(state);setError(false);try{localStorage.setItem(key(accountId),state.enabled?'enabled':'disabled');}catch{}}
      }catch{if(!disposed)setError(true);}finally{pending=false;}
    };
    // Native account-scoped consent is authoritative. A global preference from
    // another account must never silently opt this account into reporting.
    void refresh();const interval=setInterval(()=>void refresh(),10000);
    return()=>{disposed=true;clearInterval(interval);};
  },[accountId]);
  const toggle=async()=>{
    if(!accountId||busy)return;const account=accountId;setBusy(true);setError(false);
    try{
      await invoke('download_telemetry_set',{enabled:!enabled,accountId:account});
      const state=await invoke<DownloadDiagnostic>('download_telemetry_status',{accountId:account});
      if(owner.current===account){setEnabled(state.enabled);setDiagnostic(state);try{localStorage.setItem(key(account),state.enabled?'enabled':'disabled');}catch{}}
    }catch{if(owner.current===account)setError(true);}finally{if(owner.current===account)setBusy(false);}
  };
  return{enabled,toggle,diagnostic,error,busy};
}

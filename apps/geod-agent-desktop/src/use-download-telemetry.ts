import { useEffect, useRef, useState } from 'react';
import { desktopAvailable } from './api';
import { invoke } from '@tauri-apps/api/core';
import type { BackgroundSnapshot } from './background-jobs';

export interface DownloadDiagnostic {
  enabled:boolean;hasConsentRecord:boolean;reason:string;queuedEvents:number;pendingObservations:number;observedAttempts:number;
  lastAttemptAt:string|null;lastDeliveryAt:string|null;lastErrorCategory:string|null;
  diagnosticsEnabled?:boolean;needsConsentReview?:boolean;noticePending?:boolean;
}
const key=(account:string)=>`geod-agent-download-telemetry-v2:${account}`;
function legacyOptout(){try{return localStorage.getItem('geod-agent-download-telemetry-v1')==='disabled';}catch{return null;}}
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
        const state=await invoke<DownloadDiagnostic>('download_telemetry_status',{accountId,legacyOptout:legacyOptout()});
        if(!disposed){setEnabled(state.enabled);setDiagnostic(state);setError(false);try{localStorage.setItem(key(accountId),state.enabled?'enabled':'disabled');}catch{}}
      }catch{if(!disposed)setError(true);}finally{pending=false;}
    };
    // Native account-scoped consent is authoritative. A global preference from
    // another account must never silently opt this account into reporting.
    void refresh();const interval=setInterval(()=>void refresh(),10000);
    return()=>{disposed=true;clearInterval(interval);};
  },[accountId]);
  const setConsent=async(value:boolean,details:boolean)=>{
    if(!accountId||busy)return false;const account=accountId;setBusy(true);setError(false);
    try{
      await invoke('download_telemetry_set',{enabled:value,diagnostics:details,accountId:account});
      const state=await invoke<DownloadDiagnostic>('download_telemetry_status',{accountId:account});
      if(owner.current===account){setEnabled(state.enabled);setDiagnostic(state);try{localStorage.setItem(key(account),state.enabled?'enabled':'disabled');}catch{}return true;}
      return false;
    }catch{if(owner.current===account)setError(true);return false;}finally{if(owner.current===account)setBusy(false);}
  };
  const decide=(value:boolean)=>setConsent(value,value);
  const review=(value:boolean)=>setConsent(value||enabled,value);
  const toggle=()=>decide(!enabled);
  const acknowledge=async()=>{
    if(!accountId||busy)return;const account=accountId;setBusy(true);
    try{const state=await invoke<DownloadDiagnostic>('download_telemetry_acknowledge',{accountId:account});if(owner.current===account){setDiagnostic(state);setEnabled(state.enabled);setError(false);}}
    catch{if(owner.current===account)setError(true);}finally{if(owner.current===account)setBusy(false);}
  };
  return{enabled,toggle,decide,review,acknowledge,diagnostic,error,busy};
}

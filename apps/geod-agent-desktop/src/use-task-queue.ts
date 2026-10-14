import { localStateStore } from "./local-state";
import { useEffect, useState, useMemo, useSyncExternalStore } from "react";
import {api, desktopAvailable, type StoredPlan} from './api';
import { taskQueueKey } from "./task-queue";

function subscribe(callback: () => void) {
  window.addEventListener("geod-task-queue-change", callback);
  window.addEventListener("storage", callback);
  return () => { window.removeEventListener("geod-task-queue-change", callback); window.removeEventListener("storage", callback); };
}
export function useDiscardedPlans(account: string | null, conversation: string) {
  const raw = useSyncExternalStore(subscribe, () => account && conversation ? localStateStore.getItem(taskQueueKey(account, conversation)) ?? "[]" : "[]");
  return useMemo(() => {
    try { const ids: unknown = JSON.parse(raw); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []; }
    catch { return []; }
  }, [raw]);
}

export function useImageryTaskRecords(account:string|null,conversation:string) {
  const [records,setRecords]=useState<{stored:StoredPlan;recordState:string}[]>([]);
  const [error,setError]=useState('');
  useEffect(()=>{
    setRecords([]);setError('');
    if(!account||!conversation||!desktopAvailable)return;
    let disposed=false,loading=false;
    async function load(){if(loading)return;loading=true;try{const value=(await api.imageryTasksList(conversation)).map(({stored,recordState})=>({stored,recordState}));if(!disposed){setRecords(previous=>JSON.stringify(previous)===JSON.stringify(value)?previous:value);setError('');}}catch(e){if(!disposed)setError(String((e as {message?:string})?.message??e));}finally{loading=false;}}
    const changed=()=>void load();window.addEventListener('geod-task-queue-change',changed);void load();
    const timer=setInterval(changed,3000);
    return()=>{disposed=true;clearInterval(timer);window.removeEventListener('geod-task-queue-change',changed);};
  },[account,conversation]);
  return {records,error};
}

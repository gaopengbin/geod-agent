import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { DataSchedulePanel } from "../src/data-schedule-panel";
import { dataDownloads, type DataDownloadTask } from "../src/data-downloads";
import "../src/styles.css";
import "../src/theme.css";
const runtime=window as unknown as Record<string,unknown>;
runtime.__TAURI_INTERNALS__={invoke:async(command:string,args:unknown)=>{const response=await fetch("http://127.0.0.1:1421/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command,args})});const result=await response.json();if(result.error)throw result.error;return result.value;}};
const params=new URL(location.href).searchParams,conversationId=params.get("conversation")!,taskId=params.get("task")!;
document.documentElement.dataset.theme=params.get("theme")==="light"?"light":"dark";
function Harness(){const [task,setTask]=useState<DataDownloadTask|null>(null),[error,setError]=useState("");useEffect(()=>{void dataDownloads.get(conversationId,taskId).then(setTask).catch(e=>setError(JSON.stringify(e)));},[]);
return <main className="task-detail-scroll" style={{width:"min(420px, 100%)",minHeight:"100vh",boxSizing:"border-box",padding:20,background:"var(--background)",borderRight:"1px solid var(--border)"}}><h2 style={{fontSize:15,margin:"0 0 20px"}}>任务与成果 · 定时</h2>{error?<p role="alert">{error}</p>:<DataSchedulePanel conversationId={conversationId} task={task}/>}</main>;}
createRoot(document.getElementById("root")!).render(<Harness/>);

import {useState} from 'react';import {createRoot} from 'react-dom/client';
import {UnifiedTaskQueueView, type TaskListEntry} from '../src/unified-task-queue-view';import {TooltipProvider} from '../src/ui-tooltip';
import type {QueueTask,TaskAction} from '../src/task-queue';import type {StoredPlan,Job} from '../src/api';
import '../src/styles.css';import '../src/theme.css';import '../src/workspace.css';
document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')??'light';
const plan=(id:string):StoredPlan=>({planId:id,plan:{sourceName:'Esri World Imagery',createdAt:'2026-10-12T00:00:00Z',totalTiles:4,spec:{zoomLevels:[15],outputFormats:['geotiff'],bounds:[116,40,116.01,40.01]}}} as StoredPlan);
const job=(id:string,state:string):Job=>({jobId:'job-'+id,planId:id,state,version:1} as Job);
const initial:QueueTask[]=[{stored:plan('pending'),title:'未启动影像计划',job:null,state:'pending'},{stored:plan('failed'),title:'失败的影像任务',job:job('failed','failed'),state:'failed',workerActive:false},{stored:plan('done'),title:'故宫已完成影像',job:job('done','completed'),state:'completed',workerActive:false},{stored:plan('live'),title:'正在下载',job:job('live','downloading'),state:'downloading',workerActive:true}];
function Harness(){
 const [tasks,setTasks]=useState(initial),[data,setData]=useState<TaskListEntry[]>([{id:'vector',title:'矢量成果',state:'completed',description:'GeoPackage',actions:['clean']}]);
 const [selected,setSelected]=useState<string>(),[error,setError]=useState(false);
 const change=async(kind:TaskAction,ids:string[])=>{if(error)throw new Error('任务仍在停止中，请稍后清理');setTasks(v=>v.map(t=>ids.includes(t.stored.planId)?{...t,state:kind==='restore'?(t.job?.state??'pending'):'cleaned'}:t));};
 return <TooltipProvider><div style={{padding:20,width:360,maxWidth:'100vw'}}><button onClick={()=>setError(v=>!v)}>切换失败测试</button><aside className="task-panel" style={{border:'1px solid var(--app-line)',borderRadius:12}}><UnifiedTaskQueueView tasks={tasks} additionalTasks={data} selectedId={selected} working={false} permission="confirmEach" onSelect={t=>setSelected(t.stored.planId)} onAction={change} onAdditionalSelect={setSelected} onAdditionalAction={async(kind,ids)=>setData(v=>v.map(t=>ids.includes(t.id)?{...t,state:kind==='restore'?'completed':'cleaned',actions:kind==='restore'?['clean']:['restore']}:t))}/></aside></div></TooltipProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

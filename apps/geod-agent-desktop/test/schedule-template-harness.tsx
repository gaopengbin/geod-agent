import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, type StoredPlan } from '../src/api';
import { TaskPanel } from '../src/task-panel';
import { TooltipProvider } from '../src/ui-tooltip';
import { MapView } from '../src/openlayers-map-view';
import fixture from './schedule-template-fixture.json';
import 'ol/ol.css';
import '../src/styles.css';
import '../src/theme.css';
import '../src/workspace.css';
function Harness(){
 const [plan,setPlan]=useState<StoredPlan|null>(null),[scheduled,setScheduled]=useState(false),[error,setError]=useState('');
 async function refresh(){try{const [stored,schedules]=await Promise.all([api.plansGet(fixture.planId),api.schedulesList(fixture.conversationId)]);setPlan(stored);setScheduled(schedules.some(s=>s.templatePlanId===fixture.planId));}catch(e){setError(String(e));}}
 useEffect(()=>{document.documentElement.dataset.theme='dark';void refresh();},[]);
 const tasks=plan?[{stored:plan,job:null,state:scheduled?'scheduled':'pending',title:'文件范围影像 · 定时模板'}]:[];
 return <TooltipProvider><div style={{position:'fixed',inset:0,display:'flex',gap:12,padding:12,background:'var(--background)',color:'var(--foreground)'}}>
  <MapView conversationId={fixture.conversationId} bounds={plan?.plan.spec.bounds??null} boundary={plan?.plan.spec.boundary??null} tileGrids={[]} completedTiles={null} preview={null} missingTiles={0} theme="dark"/>
  <aside className="right-panel task-panel panel-scroll" style={{width:360,minWidth:360}}><TaskPanel conversationId={fixture.conversationId} plan={plan} permission="fullAccess" job={null} events={[]} manifest={null} activeJobs={[]} working={false} error={error} notice="" onClearError={()=>setError('')} onClearNotice={()=>{}} onRefresh={()=>void refresh()} onResume={()=>{}} onPause={()=>{}} onCancel={()=>{}} tasks={tasks} onTaskSelect={()=>{}} onTaskAction={async()=>{throw new Error('Read-only template verification');}} onStart={async()=>{throw new Error('Template must not offer immediate download');}} onDiscard={async()=>{throw new Error('Template must be managed through schedule');}} /></aside>
 </div></TooltipProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

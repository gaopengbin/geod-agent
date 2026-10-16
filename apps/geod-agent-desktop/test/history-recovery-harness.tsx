// Simulated missing records; real product component, no models, disk writes or downloads.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {HistoryRecovery} from '../src/history-recovery';
import {api} from '../src/api';
import {setLanguagePreferences} from '../src/i18n';
import type {HistoryInspection,PlanRecoveryProblem} from '../src/plan-reference-recovery';
import '../src/styles.css';import '../src/theme.css';
const query=new URLSearchParams(location.search),scenario=query.get('case')??'missing';
setLanguagePreferences({language:query.get('lang')==='en'?'en':'zh-CN'});
document.documentElement.dataset.theme=query.get('theme')??'light';
const calls={inspect:0,restore:0,workspace:0,folder:0,recheck:0,tasks:0};
Object.assign(window,{__historyCalls:calls});
const ids=Array.from({length:6},(_,i)=>'historical-plan-'+i);
const inspection:HistoryInspection={workspaceBound:scenario!=='workspace',workspaceAvailable:scenario!=='workspace',workspaceDirectory:scenario==='workspace'?null:'G:/项目资料/数据库影像交付/工作区',databasePath:'C:/Users/demo/AppData/Roaming/dev.geod-agent.desktop/agent-tasks.sqlite',actualDatabasePath:'C:/Users/demo/AppData/Roaming/dev.geod-agent.desktop/agent-tasks.sqlite',dataDirectoryRedirected:scenario==='redirected',recoverablePlanIds:['missing','backup-error','redirected'].includes(scenario)?ids:[]};
api.imageryHistoryInspect=async()=>{calls.inspect++;if(scenario==='storage-error')throw {code:'HISTORY_RECOVERY',message:'本机任务记录暂时无法读取，请检查磁盘和文件夹权限。'};return {...inspection};};
api.imageryHistoryRestore=async()=>{calls.restore++;if(scenario==='backup-error')throw {code:'HISTORY_RECOVERY',message:'备份校验失败，未使用这份备份。'};inspection.recoverablePlanIds=[];return {restored:ids,notFound:[],snapshotPath:'local verified snapshot'};};
api.workspaceSet=async(_id,directory,permission)=>{calls.workspace++;inspection.workspaceBound=true;inspection.workspaceAvailable=true;inspection.workspaceDirectory=directory;return {directory,permission};};
api.workspaceOpenDirectory=async()=>{calls.folder++;};
function Harness(){
  const [problem,setProblem]=useState<PlanRecoveryProblem|null>({count:6,codes:[scenario==='workspace'?'WORKSPACE_NOT_BOUND':scenario==='unowned'?'PLAN_NOT_OWNED':scenario==='wrong-workspace'?'WORKSPACE_DENIED':'PLAN_NOT_FOUND']});
  return <main style={{maxWidth:760,margin:'64px auto',padding:16}}><p style={{color:'var(--app-soft-text)',fontSize:12}}>本地交互验收 · 模拟缺失记录，不修改真实任务</p><HistoryRecovery conversationId="history-recovery-ui-fixture" planIds={ids} expectedDirectory="G:/项目资料/数据库影像交付/工作区" problem={problem} onRecheck={async()=>{calls.recheck++;if(scenario==='workspace'&&inspection.workspaceBound||scenario==='missing'&&calls.restore){setProblem(null);return null;}return problem;}} onTasks={()=>{calls.tasks++;}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

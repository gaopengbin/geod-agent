import {useState}from 'react';
import {createRoot}from 'react-dom/client';
import {ImageryDiskFailure}from '../src/imagery-disk-failure';
import {ImageryNetworkFailure}from '../src/imagery-network-failure';
import {api,type JobEvent,type StoredPlan}from '../src/api';
import '../src/styles.css';import '../src/theme.css';
const params=new URL(location.href).searchParams,scenario=params.get('scenario')??'cache';
document.documentElement.dataset.theme=params.get('theme')??'light';
let probes=0;api.mapPreviewTile=async()=>{probes++;document.body.dataset.probes=String(probes);return 'data:image/png;base64,fixture';};
const base:JobEvent={jobId:'fixture',seq:3,occurredAt:new Date().toISOString(),state:'failed',errorCode:'DISK_INSUFFICIENT'};
const report={volumes:[{locations:[{role:'workspace',path:'D:\\用户成果\\北京',requiredBytes:21_076_377_600}],requiredBytes:21_093_154_816,availableBytes:600_000_000_000,sufficient:true},{locations:[{role:'cache',path:'C:\\本地数据\\tile-cache',requiredBytes:22_393_651_200}],requiredBytes:22_410_428_416,availableBytes:5_000_000_000,sufficient:false}]};
const stored={plan:{tileGrids:[{zoom:12,xMin:3370,xMax:3371,yMin:1550,yMax:1551}],spec:{sourceId:'gaode-map'}}}as StoredPlan;
function Harness(){const[opened,setOpened]=useState(false);return <main className="task-panel" style={{width:'min(100%,420px)',margin:'24px auto',padding:16}}><p>Local fixture · {scenario}</p>{scenario==='403'?<ImageryNetworkFailure stored={stored} failure={{...base,errorCode:'SOURCE_UNAUTHORIZED',failureDiagnostic:{kind:'sourceAccess',httpStatus:403,host:'webrd01.is.autonavi.com',sourceId:'gaode-map',authenticationConfigured:false}}} onOpenNetwork={()=>setOpened(true)}/>:<ImageryDiskFailure event={scenario==='legacy'?base:{...base,failureDiagnostic:{kind:'storage',report}}} onManageCache={()=>setOpened(true)}/>}<div role="status">{opened?'settings callback received':''}</div></main>;}
createRoot(document.getElementById('root')!).render(<Harness/>);

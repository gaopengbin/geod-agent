import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {TooltipProvider} from '../src/ui-tooltip';
import '../src/styles.css';
import '../src/theme.css';
import '../src/workspace.css';
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw Error('Local test only');
const calls:unknown[]=[];
Object.assign(window,{isTauri:true,activityTestCalls:calls,__TAURI_INTERNALS__:{invoke:async(command:string,args?:unknown)=>{calls.push({command,args});if(command==='agent_activity_set')return args;if(command==='agent_payment_snapshot')return {status:{billingMode:'prepaid'},wallet:null};return {};}}});
const {AccountMenu}=await import('../src/account-menu');
const {useActivityTelemetry}=await import('../src/use-activity-telemetry');
const {setLanguagePreferences}=await import('../src/i18n');setLanguagePreferences({language:'zh-CN',replyLanguage:'auto'});
document.documentElement.dataset.theme='light';
function Preview(){
 const [owner,setOwner]=useState('test-A'),[open,setOpen]=useState(true);const activity=useActivityTelemetry(owner);const noop=()=>{};
 return <><button onClick={()=>setOwner(owner==='test-A'?'test-B':'test-A')}>Switch account</button><span data-owner>{owner}</span><div style={{position:'fixed',bottom:20,left:20,width:230}}><AccountMenu open={open} onOpenChange={setOpen} connected={true} userId={owner} profile={null} profileError={false} onProfileRefresh={async()=>{}} usage={null} busy={false} theme="light" onModels={noop} onNetwork={noop} onCache={noop} onTheme={noop} onLogout={noop} telemetryEnabled={false} onTelemetry={noop} activityEnabled={activity.enabled} onActivity={activity.toggle}/></div></>;
}
createRoot(document.getElementById('root')!).render(<TooltipProvider><Preview/></TooltipProvider>);

import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {TooltipProvider} from '../src/ui-tooltip';
import '../src/styles.css';
import '../src/theme.css';
import '../src/workspace.css';
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw Error('Local test only');
const calls:unknown[]=[];
const states=new Map<string,boolean>();
Object.assign(window,{isTauri:true,activityTestCalls:calls,__TAURI_INTERNALS__:{invoke:async(command:string,raw?:unknown)=>{const args=raw as {accountId:string;enabled:boolean;legacyPreference:boolean|null};calls.push({command,args});if(command==='agent_activity_status'){if(!states.has(args.accountId))states.set(args.accountId,args.legacyPreference!==false);return {enabled:states.get(args.accountId)};}if(command==='agent_activity_set'){states.set(args.accountId,args.enabled);return {enabled:args.enabled};}if(command==='agent_payment_snapshot')return {status:{billingMode:'prepaid'},wallet:null};return {};}}});
const {AccountMenu}=await import('../src/account-menu');
const {useActivityTelemetry}=await import('../src/use-activity-telemetry');
const {DownloadConsentNotice}=await import('../src/download-consent-notice');
const {setLanguagePreferences}=await import('../src/i18n');setLanguagePreferences({language:'zh-CN',replyLanguage:'auto'});
document.documentElement.dataset.theme='light';
function Preview(){
 const [owner,setOwner]=useState('test-A'),[open,setOpen]=useState(true),[notice,setNotice]=useState(true);const activity=useActivityTelemetry(owner);const noop=()=>{};
 return <><button onClick={()=>setOwner(owner==='test-A'?'test-B':'test-A')}>Switch account</button><span data-owner>{owner}</span>{notice&&<DownloadConsentNotice busy={activity.busy} downloadEnabled={true} activityEnabled={activity.ready?activity.enabled:null} onAcknowledge={async()=>{calls.push({command:'notice_ack'});setNotice(false);}} onDisable={async()=>{if(await activity.set(false))setNotice(false);}}/>}<div style={{position:'fixed',bottom:20,left:20,width:230}}><AccountMenu open={open} onOpenChange={setOpen} connected={true} userId={owner} profile={null} profileError={false} onProfileRefresh={async()=>{}} usage={null} busy={false} theme="light" onModels={noop} onNetwork={noop} onCache={noop} onTheme={noop} onLogout={noop} telemetryEnabled={true} onTelemetry={noop} activityEnabled={activity.enabled} activityReady={activity.ready} activityBusy={activity.busy} onActivity={activity.toggle}/></div></>;
}
createRoot(document.getElementById('root')!).render(<TooltipProvider><Preview/></TooltipProvider>);

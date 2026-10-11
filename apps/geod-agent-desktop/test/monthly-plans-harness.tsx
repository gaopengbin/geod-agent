import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {PaymentDialog} from '../src/payment-dialog';
import {TooltipProvider} from '../src/ui-tooltip';
import {Button} from '../src/components/motion/button/base';
import {getLocale,setLanguagePreferences,t,useLocale} from '../src/i18n';
import '../src/styles.css';
import '../src/theme.css';
import '../src/workspace.css';

// Vite-only isolated preview. No production credential or account is accessed.
if(!import.meta.env.DEV||location.hostname!=='127.0.0.1')throw new Error('Monthly harness is local-development only');
const preview=new URL(location.href).searchParams.get('preview')==='1';
if(!localStorage.getItem('geod-agent-language-v1'))setLanguagePreferences({language:'zh-CN',replyLanguage:'auto'});
document.documentElement.dataset.theme='dark';
Object.assign(window,{isTauri:true,__TAURI_INTERNALS__:{invoke:async(command:string,args?:Record<string,unknown>)=>{
 const origin='http://127.0.0.1:1437';let response;
 if(command==='agent_payment_snapshot')response=await fetch(origin+'/api/snapshot'+(preview?'?preview=1':''));
 else if(command==='agent_payment_action')response=await fetch(origin+'/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)});
 else throw new Error('Unknown isolated preview operation: '+command);
 const value=await response.json();if(!response.ok)throw new Error(value.error?.message??'Local preview request failed');
 if(value.previewCashierUrl)window.open(value.previewCashierUrl,'geod-monthly-cashier','width=620,height=700');
 return value;
}}});
function Harness(){useLocale();const [open,setOpen]=useState(true);return <TooltipProvider><main style={{padding:32}}><h1 style={{fontSize:20,fontWeight:600}}>GeoD Agent</h1><p style={{color:'var(--app-soft-text)'}}>{t('本机支付演练 · 无真实付款或退款')}</p><div style={{display:'flex',gap:8}}><Button variant="outline" onClick={()=>setOpen(true)}>{t('余额与订阅')}</Button><Button variant="outline" onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>{t('外观')}</Button><Button variant="outline" onClick={()=>setLanguagePreferences({language:getLocale()==='en'?'zh-CN':'en'})}>中文 / English</Button></div></main>{open&&<PaymentDialog accountId="monthly-preview-only" initialTab="plans" onClose={()=>setOpen(false)}/>}</TooltipProvider>;}
createRoot(document.getElementById('root')!).render(<Harness/>);

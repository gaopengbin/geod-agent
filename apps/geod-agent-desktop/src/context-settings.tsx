import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Button} from './components/motion/button/base';
import {api,desktopAvailable,errorMessage} from './api';
import {t,getLocale} from './i18n';
import * as Dialog from '@radix-ui/react-dialog';
import {ScrollArea} from './components/ui/scroll-area';

export interface ContextPreferences {contextWindowTokens:number|null;autoCompactPercent:number}
export interface Spending {budgetCredits:number|null;spentCredits:number;unknownRequests:number;recordedRequests:number}
export interface ContextSettingsView {preferences:ContextPreferences;model:string;modelContextWindow:number;maxOutputTokens:number;effectiveContextWindow?:number;autoCompactTokenLimit?:number;configurationError?:string;spending?:Spending}
export interface ContextSettingsClient {
 get:(accountId:string,conversationId:string)=>Promise<ContextSettingsView>;
 set:(accountId:string,conversationId:string,preferences:ContextPreferences,budgetCredits:number|null)=>Promise<ContextSettingsView>;
}
async function ensureContextRuntime(){
 const capabilities=await api.runtimeCapabilities();
 if(capabilities.contextSettings!==true||capabilities.executionSafety!==true)throw new Error(t('上下文设置已更新，请在当前任务结束后重新启动应用。'));
}
export const contextSettings:ContextSettingsClient={
 get:async(accountId,conversationId)=>{await ensureContextRuntime();return invoke('context_settings_get',{accountId,conversationId});},
 set:async(accountId,conversationId,preferences,budgetCredits)=>{await ensureContextRuntime();return invoke('context_settings_set',{accountId,conversationId,preferences,budgetCredits});},
};
const changed='geod:context-settings-changed';
export function ContextSettingsDialog({open,onOpenChange,accountId,conversationId,client=contextSettings}:{open:boolean;onOpenChange:(open:boolean)=>void;accountId:string|null;conversationId:string;client?:ContextSettingsClient}) {
 return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="permission-dialog-overlay"/><Dialog.Content className="permission-dialog context-settings-dialog"><Dialog.Title>{t('上下文设置')}</Dialog.Title><Dialog.Description>{t('设置上下文容量、自动压缩时机，以及当前会话累计费用预算。')}</Dialog.Description><ScrollArea className="context-settings-scroll"><ContextSettingsPanel heading={false} accountId={accountId} conversationId={conversationId} client={client}/></ScrollArea><div className="permission-dialog-actions"><Dialog.Close asChild><Button variant="outline">{t('关闭')}</Button></Dialog.Close></div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function ContextSettingsPanel({accountId,conversationId='default',client=contextSettings,heading=true}:{accountId:string|null;conversationId?:string;client?:ContextSettingsClient;heading?:boolean}) {
 const [view,setView]=useState<ContextSettingsView|null>(null),[draft,setDraft]=useState<ContextPreferences>({contextWindowTokens:null,autoCompactPercent:90});
 const [budget,setBudget]=useState<number|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const epoch=useRef(0);
 useEffect(()=>{
  const current=++epoch.current;setView(null);setError('');setNotice('');setBusy(false);
  if(!accountId)return;
  const reload=()=>void client.get(accountId,conversationId).then(value=>{if(epoch.current===current){setView(value);setDraft(value.preferences);setBudget(value.spending?.budgetCredits??null);setError(value.configurationError??'');}}).catch(cause=>{if(epoch.current===current)setError(errorMessage(cause));});
  if(desktopAvailable||client!==contextSettings)reload();
  window.addEventListener(changed,reload);window.addEventListener('geod:ai-channels-changed',reload);
  return()=>{++epoch.current;window.removeEventListener(changed,reload);window.removeEventListener('geod:ai-channels-changed',reload);};
 },[accountId,conversationId,client]);
 const valid=(draft.contextWindowTokens===null||Number.isInteger(draft.contextWindowTokens)&&draft.contextWindowTokens>=16000&&draft.contextWindowTokens<=4000000)
  &&Number.isInteger(draft.autoCompactPercent)&&draft.autoCompactPercent>=50&&draft.autoCompactPercent<=95
  &&(budget===null||Number.isInteger(budget)&&budget>=1&&budget<=100000000);
 const isChanged=!!view&&(JSON.stringify(draft)!==JSON.stringify(view.preferences)||budget!==(view.spending?.budgetCredits??null));
 const number=(value:number)=>value.toLocaleString(getLocale());
 async function save(preferences=draft,credits=budget) {
  if(!accountId||busy)return;const current=epoch.current;setBusy(true);setError('');setNotice('');
  try {const saved=await client.set(accountId,conversationId,preferences,credits);if(current!==epoch.current)return;setView(saved);setDraft(saved.preferences);setBudget(saved.spending?.budgetCredits??null);setNotice(t('已保存。上下文设置下轮生效，费用预算在下次请求前检查。'));window.dispatchEvent(new Event(changed));}
  catch(cause){if(current===epoch.current)setError(errorMessage(cause));}
  finally{if(current===epoch.current)setBusy(false);}
 }
 return <section className="ai-channel-form context-settings-panel" aria-label={t('上下文设置')}>
  {heading&&<h2>{t('上下文设置')}</h2>}
  <p>{t('上下文设置作用于此账号，下一轮对话生效；费用预算仅用于当前会话，在下一次模型请求前检查。')}</p>
  {!accountId?<p>{t('登录 GeoD 后配置上下文。')}</p>:<>
   {!view&&!error&&<p role="status">{t('正在读取模型上限…')}</p>}
   {view&&<><div className="ai-channel-fields">
    <label className="field"><span className="field-label">{t('上下文预算（Token）')}</span><input aria-label={t('上下文预算（Token）')} type="number" min={16000} max={4000000} step={1} disabled={busy} value={draft.contextWindowTokens??''} placeholder={t('自动：使用模型上限')} onChange={event=>setDraft({...draft,contextWindowTokens:event.target.value===''?null:Number(event.target.value)})}/><small>{t('留空自动使用当前模型上限；切换模型时不会超过渠道声明的容量。')}</small></label>
    <label className="field"><span className="field-label">{t('自动压缩阈值（%）')}</span><input aria-label={t('自动压缩阈值（%）')} type="number" min={50} max={95} step={1} disabled={busy} value={draft.autoCompactPercent} onChange={event=>setDraft({...draft,autoCompactPercent:Number(event.target.value)})}/><small>{t('范围 50–95%，默认 90%；同时为模型输出预留空间。')}</small></label>
    {view.spending&&<label className="field"><span className="field-label">{t('会话累计预算（Credits，可选）')}</span><input aria-label={t('会话累计预算（Credits，可选）')} type="number" min={1} max={100000000} step={1} disabled={busy} value={budget??''} placeholder={t('不设金额上限')} onChange={event=>setBudget(event.target.value===''?null:Number(event.target.value))}/><small>{t('仅用于当前会话，跨消息和重启累计。达到预算暂停确认；留空不设金额上限。每次结算后检查，单次请求可能超出预算。')}</small></label>}
   </div>
   <div className="context-settings-facts"><span>{t('当前模型')}：{view.model}</span><span>{t('模型上限')}：{number(view.modelContextWindow)} Token</span>{view.effectiveContextWindow!==undefined&&<span>{t('已生效预算')}：{number(view.effectiveContextWindow)} Token</span>}{view.autoCompactTokenLimit!==undefined&&<span>{t('自动压缩开始于')}：{number(view.autoCompactTokenLimit)} Token</span>}</div>
   {view.spending&&<div className="context-settings-facts"><span>{t('本会话已记录费用')}：{view.spending.spentCredits.toLocaleString(getLocale(),{maximumFractionDigits:2})} Credits</span><span>{t('已记录模型请求')}：{view.spending.recordedRequests}</span>{view.spending.unknownRequests>0&&<span>{t('费用待核对请求')}：{view.spending.unknownRequests}</span>}</div>}
   <p className="context-settings-hint">{t('有进展的任务持续执行；同一操作反复返回相同结果时暂停确认，不按固定请求次数截断。费用记录从启用此功能起累计；自有和赞助渠道不扣 GeoD Credits。')}</p>
   {draft.contextWindowTokens!==null&&draft.contextWindowTokens>view.modelContextWindow&&<p className="context-settings-hint">{t('所填预算高于当前模型上限，实际按模型上限运行。更大窗口需使用支持该容量的渠道或调整托管服务配置。')}</p>}
   {!valid&&<p role="alert" className="ai-channel-error">{t('预算需为 16,000–4,000,000 Token，阈值需为 50–95%。')} {t('会话预算需为 1–100,000,000 Credits，或留空。')}</p>}
   <div className="ai-channel-form-actions"><Button variant="outline" disabled={busy} onClick={()=>void save({contextWindowTokens:null,autoCompactPercent:90},null)}>{t('恢复自动')}</Button><Button disabled={busy||!valid||!isChanged} onClick={()=>void save()}>{t(busy?'正在保存…':'保存上下文设置')}</Button></div>
   </>}
  </>}
  {error&&<p className="ai-channel-error" role="alert">{error}</p>}{notice&&<p className="ai-channel-notice" role="status">{notice}</p>}
 </section>;
}

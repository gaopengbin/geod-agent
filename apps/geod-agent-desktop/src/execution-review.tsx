import {useState} from 'react';
import {Button} from './components/motion/button/base';
import {t,getLocale} from './i18n';
import {errorMessage} from './api';
import type {CodexRequest} from './codex-request';
import type {Spending} from './context-settings';
import {invoke} from '@tauri-apps/api/core';

export function ExecutionReviewCard({request,respond}:{request:CodexRequest;respond:(value:unknown)=>void|Promise<void>}){
 const [additional,setAdditional]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [spending,setSpending]=useState(request.params.spending as Spending),reason=request.params.reason;
 const budget=reason==='budget'||spending.budgetCredits!==null&&spending.spentCredits>=spending.budgetCredits,repeat=reason==='repeat';
 const verified=reason==='unknownCost'&&spending.unknownRequests===0&&!budget;
 const valid=!budget||Number.isInteger(Number(additional))&&Number(additional)>=1&&Number(additional)<=100000000;
 async function send(value:unknown){setBusy(true);setError('');try{await respond(value);}catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}}
 async function reconcile(){setBusy(true);setError('');try{setSpending(await invoke<Spending>('execution_spending_reconcile',{conversationId:request.params.conversationId}));}catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}}
 const number=(n:number)=>n.toLocaleString(getLocale(),{maximumFractionDigits:2});
 return <section className="codex-request-card execution-review-card" role="region" aria-label={t('执行已暂停，等待确认')}>
  <strong>{t(budget?'已达到会话预算':repeat?'操作反复返回相同结果':verified?'费用已核对':'部分费用尚待核对')}</strong>
  <p>{t(budget?'当前任务已暂停。追加会话预算后，从原来的执行位置继续。':repeat?'同样的操作已连续多次返回相同结果。你可以停止，也可以让 Agent 调整方法后继续。':verified?'费用已更新，可以继续原来的任务。':'有请求尚未返回确定费用，无法判断剩余预算。继续可能超出设置的预算。')}</p>
  {repeat&&typeof request.params.lastTool==='string'&&<small>{t('最近的操作')}：{request.params.lastTool}</small>}
  <div className="context-settings-facts"><span>{t('本会话已记录费用')}：{number(spending.spentCredits)} Credits</span>{spending.budgetCredits!==null&&<span>{t('会话累计预算')}：{number(spending.budgetCredits)} Credits</span>}{spending.unknownRequests>0&&<span>{t('费用待核对请求')}：{spending.unknownRequests}</span>}</div>
  {budget&&<label className="field"><span className="field-label">{t('追加预算（Credits）')}</span><input type="number" min={1} max={100000000} step={1} aria-label={t('追加预算（Credits）')} value={additional} disabled={busy} onChange={event=>setAdditional(event.target.value)}/><small>{t('增加当前会话总额度，不会重置已经记录的费用。')}</small></label>}
  <p className="context-settings-hint">{t('等待确认期间不发起新的模型请求，已完成的下载和成果会保留。')}</p>
  {error&&<p role="alert">{error}</p>}
  <div className="codex-request-actions">{spending.unknownRequests>0&&typeof request.params.conversationId==='string'&&<Button variant="outline" disabled={busy} onClick={()=>void reconcile()}>{t('核对费用')}</Button>}<Button variant="outline" disabled={busy||!valid} onClick={()=>void send({decision:'continue',...(budget?{additionalCredits:Number(additional)}:{})})}>{t(budget?'追加预算并继续':repeat?'调整方法继续':'确认继续')}</Button><Button variant="ghost" disabled={busy} onClick={()=>void send({decision:'stop'})}>{t('停止本次执行')}</Button></div>
 </section>;
}

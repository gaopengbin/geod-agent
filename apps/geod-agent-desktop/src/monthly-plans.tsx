import {useEffect,useState} from 'react';
import {Button} from '@/components/motion/button/base';
import type {MonthlyPlanPolicy,PaymentProduct} from './api';
import {formatCredits} from './credits';
import {getLocale,t} from './i18n';
import {ExternalLink} from './icons';

export function MonthlyPlans({products,policy,preview,fixture=false,busy,onBuy}:{products:PaymentProduct[];policy:MonthlyPlanPolicy;preview:boolean;fixture?:boolean;busy:boolean;onBuy:(product:PaymentProduct)=>void}){
 const [selected,setSelected]=useState(()=>products.find(p=>p.id==='agent-month-standard')?.id??products[0]?.id);
 useEffect(()=>{if(!products.some(p=>p.id===selected))setSelected(products[0]?.id);},[products,selected]);
 const product=products.find(p=>p.id===selected);
 const currency=(fen:number)=>new Intl.NumberFormat(getLocale(),{style:'currency',currency:'CNY',minimumFractionDigits:0,maximumFractionDigits:2}).format(fen/100);
 return <section className="monthly-plans" aria-label={t('月套餐')} data-policy-version={policy.version}>
  <div className="monthly-plans-heading"><div><h3>{t('选择月套餐')}</h3><p>{t('各档功能相同，按需要选择 AI 额度。')}</p></div>{preview&&<span className="monthly-plan-draft">{t('价格预览')}</span>}</div>
  <div className="monthly-plan-grid" role="group" aria-label={t('套餐档位')}>
   {products.map(p=><Button key={p.id} variant="outline" pressScale={1} className="monthly-plan-card" aria-pressed={selected===p.id} disabled={busy} onClick={()=>setSelected(p.id)} data-plan-id={p.id}>
    <span className="monthly-plan-name">{t(p.name)}</span>
    <span className="monthly-plan-price">{currency(p.priceFen)}<small>{t('/ {0} 天',{'0':policy.periodDays})}</small></span>
    <span className="monthly-plan-credits">{formatCredits(p.creditNanoCny)}</span>
   </Button>)}
  </div>
  <div className="monthly-plan-terms"><p>{t('手动续费，不自动扣款。购买后额度立即到账，已到账 Credits 不随套餐到期清零。')}</p><p>{t('已有体验额度和历史余额保留；模型按实际用量扣费，本机下载和处理不另收费。')}</p></div>
  {product&&<div className="monthly-plan-checkout"><div><span>{t('本次支付')}</span><strong>{currency(product.priceFen)}</strong></div><Button disabled={busy||preview} onClick={()=>onBuy(product)}><ExternalLink size={14}/>{preview?t('暂未开放'):fixture?t('演练购买'):t('支付宝购买')}</Button></div>}
  {preview&&<p className="payment-caption">{t('月套餐尚未开放，价格与权益确认后即可购买。')}</p>}
 </section>;
}

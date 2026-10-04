import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {save} from '@tauri-apps/plugin-dialog';
import {Button} from '@/components/motion/button/base';
import {api,errorMessage,type CreditHistoryKind,type CreditHistoryPage,type CreditHistoryQuery,type PaymentCharge,type PaymentSnapshot} from './api';
import {formatCredits,formatCreditRate} from './credits';
import {getLocale,localize,t} from './i18n';
import {ChevronLeft,ChevronRight,Download,Loader2} from './icons';
import {UiSelect} from './ui-select';

const pageSize=20;
const date=(value:number)=>new Date(value).toLocaleString(getLocale(),{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const tokens=(value:number)=>new Intl.NumberFormat(getLocale()).format(value);
const preciseCredit=(value:string)=>formatCredits(value,6);
function ChargeDetails({charge}:{charge:PaymentCharge}){
  return <><dl><div><dt>{t('输入 token')}</dt><dd>{tokens(charge.inputTokens)}</dd></div><div><dt>{t('其中缓存')}</dt><dd>{tokens(charge.cachedInputTokens)}</dd></div><div><dt>{t('输出 token')}</dt><dd>{tokens(charge.outputTokens)}</dd></div>{charge.reasoningTokens!=null&&<div><dt>{t('其中推理')}</dt><dd>{tokens(charge.reasoningTokens)}</dd></div>}</dl>
    {charge.ratesNanoPerToken&&<div className="payment-charge-rates">{t('每百万 token：未缓存输入 {0} · 缓存输入 {1} · 输出 {2}',{0:formatCreditRate(charge.ratesNanoPerToken.uncachedInput),1:formatCreditRate(charge.ratesNanoPerToken.cachedInput),2:formatCreditRate(charge.ratesNanoPerToken.output)})}</div>}
    <div className="payment-charge-version"><span>{t('费率版本')}</span><code>{charge.pricingVersion}</code></div></>;
}
export function CreditUsageHistory({refreshKey,onUnavailable}:{refreshKey:PaymentSnapshot;onUnavailable:()=>void}){
  const [kind,setKind]=useState<CreditHistoryKind>('usage'),[range,setRange]=useState('all');
  const [page,setPage]=useState<CreditHistoryPage|null>(null),[navigation,setNavigation]=useState<{cursors:(string|null)[];index:number}>({cursors:[null],index:0});
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[exporting,setExporting]=useState(false),[notice,setNotice]=useState('');
  const sequence=useRef(0),mounted=useRef(true),exportLock=useRef(false),root=useRef<HTMLDivElement>(null);
  const query=useMemo<CreditHistoryQuery>(()=>{
    const now=Date.now();
    return {kind,from:range==='all'?null:now-Number(range)*86_400_000,to:range==='all'?null:now+1};
  },[kind,range,refreshKey]);
  const load=useCallback(async(cursor:string|null,index:number,cursors:(string|null)[])=>{
    const serial=++sequence.current;setLoading(true);setError('');
    try{
      const result=await api.agentCreditHistory({...query,cursor,limit:pageSize});
      if(sequence.current!==serial)return;
      setPage(result);setNavigation({index,cursors});
      const viewport=root.current?.closest('.geod-scroll-viewport');if(viewport)viewport.scrollTop=0;
    }catch(cause){if(sequence.current===serial){
      if(cause&&typeof cause==='object'&&'code' in cause&&cause.code==='PAYMENT_HISTORY_UNAVAILABLE')onUnavailable();
      else setError(errorMessage(cause));
    }}
    finally{if(sequence.current===serial)setLoading(false);}
  },[query,onUnavailable]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setPage(null);setNotice('');void load(null,0,[null]);return()=>{++sequence.current;};},[load]);
  const exportRecords=async()=>{
    if(exportLock.current)return;exportLock.current=true;setExporting(true);setError('');setNotice('');
    try{
      const path=await save({title:t('导出 AI 用量'),defaultPath:`GeoD-AI-${kind}-${new Date().toISOString().slice(0,10)}.csv`,filters:[{name:'CSV',extensions:['csv']}]});
      if(!path||!mounted.current)return;
      const result=await api.agentCreditHistoryExport(query,path);
      if(mounted.current)setNotice(t('已导出 {0} 条记录',{0:result.records}));
    }catch(cause){if(mounted.current)setError(errorMessage(cause));}
    finally{exportLock.current=false;if(mounted.current)setExporting(false);}
  };
  const start=navigation.index*pageSize+1,end=navigation.index*pageSize+(page?.items.length??0);
  return <div className="credit-history" ref={root} aria-busy={loading}>
    <div className="credit-history-toolbar">
      <UiSelect value={kind} onValueChange={value=>setKind(value as CreditHistoryKind)} disabled={exporting} ariaLabel={t('用量状态')} options={[{value:'usage',label:t('已结算用量')},{value:'reservations',label:t('费用预留')}]}/>
      <UiSelect value={range} onValueChange={setRange} disabled={exporting} ariaLabel={t('用量时间范围')} options={[{value:'all',label:t('全部时间')},{value:'7',label:t('最近 7 天')},{value:'30',label:t('最近 30 天')},{value:'90',label:t('最近 90 天')}]}/>
      <Button className="credit-history-export" variant="outline" size="sm" disabled={exporting||loading||!page?.totalCount} onClick={()=>void exportRecords()}>{exporting?<Loader2 size={14} className="animate-spin"/>:<Download size={14}/>} {t('导出 CSV')}</Button>
    </div>
    <p className="payment-caption credit-history-scope">{t(kind==='usage'?'仅列出此钱包的模型费用，不包含自带 Key。':'预留金额会在用量核验后结算，未确认用量不会直接扣费。')}</p>
    <div className="credit-history-navigation"><span role="status">{page?.totalCount?t('第 {0}–{1} 条，共 {2} 条',{0:start,1:end,2:page.totalCount}):t('暂无记录')}</span>
      <div><Button variant="ghost" size="icon" aria-label={t('上一页用量')} disabled={loading||navigation.index===0} onClick={()=>void load(navigation.cursors[navigation.index-1],navigation.index-1,navigation.cursors)}><ChevronLeft size={16}/></Button>
      <Button variant="ghost" size="icon" aria-label={t('下一页用量')} disabled={loading||!page?.nextCursor} onClick={()=>{if(page?.nextCursor)void load(page.nextCursor,navigation.index+1,[...navigation.cursors.slice(0,navigation.index+1),page.nextCursor]);}}><ChevronRight size={16}/></Button></div>
    </div>
    {loading?<div className="credit-history-loading" role="status"><Loader2 size={16} className="animate-spin"/>{t('正在读取用量记录…')}</div>:
      error?<div className="credit-history-error"><p className="form-error" role="alert">{localize(error)}</p><Button size="sm" variant="outline" onClick={()=>void load(navigation.cursors[navigation.index],navigation.index,navigation.cursors)}>{t('重新查询')}</Button></div>:
      !page?.items.length?<p className="payment-empty">{t('所选范围内暂无用量记录')}</p>:<div className="credit-history-rows">{page.items.map(item=>{
        const charge='chargeNanoCny' in item?item:null;
        return <section className="payment-usage-row" key={item.generationId} data-charge-id={charge?item.generationId:undefined} data-reservation-id={charge?undefined:item.generationId}>
          <div className="payment-order-heading"><strong>{item.model??t('模型待核对')}</strong><b>{preciseCredit(charge?charge.chargeNanoCny:('maximumNanoCny' in item?item.maximumNanoCny:'0'))}</b></div>
          <div className="payment-order-meta"><time dateTime={new Date(item.createdAt).toISOString()}>{date(item.createdAt)}</time><span>{t(charge?'已结算':'待结算')}</span></div>
          <details className="payment-usage-details"><summary>{t('计费明细')}</summary>{charge&&<ChargeDetails charge={charge}/>}<code className="payment-generation-id">{item.generationId}</code></details>
        </section>;
      })}</div>}
    {notice&&<p className="payment-notice" role="status">{notice}</p>}
  </div>;
}

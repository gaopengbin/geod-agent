import {useCallback,useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {save} from '@tauri-apps/plugin-dialog';
import {Button} from '@/components/motion/button/base';
import {api,errorMessage,type PaymentHistoryKind,type PaymentHistoryPage,type PaymentHistoryQuery,type PaymentOrder,type PaymentRefund,type PaymentSnapshot} from './api';
import {getLocale,localize,t} from './i18n';
import {ChevronLeft,ChevronRight,Download,Loader2} from './icons';
import {UiSelect} from './ui-select';

const pageSize=20;
const date=(value:number)=>new Date(value).toLocaleString(getLocale(),{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const refundNames:Record<PaymentRefund['status'],string>={pending:'退款申请已保存',submitted:'退款处理中',uncertain:'退款待核对',refunded:'已退款'};
export function PaymentRefundRow({refund}:{refund:PaymentRefund}){
  return <section className="payment-order" data-refund-id={refund.refundId}>
    <div className="payment-order-heading"><strong>{t('退款')}</strong><span className={refund.status==='refunded'?'payment-order-success':''}>{t(refundNames[refund.status])}</span></div>
    <div className="payment-order-meta"><span>{refund.createdAt!=null?date(refund.createdAt):t('时间未提供')}</span><b>{new Intl.NumberFormat(getLocale(),{style:'currency',currency:'CNY'}).format(refund.amountFen/100)}</b></div>
    <details className="payment-usage-details"><summary>{t('退款明细')}</summary><div className="payment-refund-reference"><span>{t('原订单')}</span><code>{refund.orderId}</code><span>{t('退款单号')}</span><code>{refund.refundId}</code>{refund.updatedAt!=null&&<><span>{t('最近核对')}</span><span>{date(refund.updatedAt)}</span></>}</div></details>
  </section>;
}
export function PaymentHistory({refreshKey,onUnavailable,renderOrder}:{refreshKey:PaymentSnapshot;onUnavailable:()=>void;renderOrder:(order:PaymentOrder)=>ReactNode}){
  const [kind,setKind]=useState<PaymentHistoryKind>('orders'),[range,setRange]=useState('all');
  const [page,setPage]=useState<PaymentHistoryPage|null>(null),[navigation,setNavigation]=useState<{cursors:(string|null)[];index:number}>({cursors:[null],index:0});
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[exporting,setExporting]=useState(false),[exportCount,setExportCount]=useState<number|null>(null);
  const sequence=useRef(0),mounted=useRef(true),exportLock=useRef(false),root=useRef<HTMLDivElement>(null);
  const requested=useRef<{cursor:string|null;index:number;cursors:(string|null)[]}>({cursor:null,index:0,cursors:[null]});
  const query=useMemo<PaymentHistoryQuery>(()=>{const now=Date.now();return {kind,from:range==='all'?null:now-Number(range)*86_400_000,to:range==='all'?null:now+1};},[kind,range,refreshKey]);
  const load=useCallback(async(cursor:string|null,index:number,cursors:(string|null)[])=>{
    const serial=++sequence.current;requested.current={cursor,index,cursors};setLoading(true);setError('');
    try{
      const result=await api.agentPaymentHistory({...query,cursor,limit:pageSize});
      if(sequence.current!==serial)return;
      if(result.kind!==query.kind)throw new Error(t('支付记录响应无效，请重新查询'));
      setPage(result);setNavigation({index,cursors});
      const viewport=root.current?.closest('.geod-scroll-viewport');if(viewport)viewport.scrollTop=0;
    }catch(cause){if(sequence.current===serial){
      if(cause&&typeof cause==='object'&&'code' in cause&&cause.code==='PAYMENT_HISTORY_UNAVAILABLE')onUnavailable();
      else setError(errorMessage(cause));
    }}finally{if(sequence.current===serial)setLoading(false);}
  },[query,onUnavailable]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setPage(null);setExportCount(null);setNavigation({cursors:[null],index:0});void load(null,0,[null]);return()=>{++sequence.current;};},[load]);
  const exportRecords=async()=>{
    if(exportLock.current)return;exportLock.current=true;setExporting(true);setError('');setExportCount(null);
    try{
      const path=await save({title:t('导出支付记录'),defaultPath:`GeoD-${kind}-${new Date().toISOString().slice(0,10)}.csv`,filters:[{name:'CSV',extensions:['csv']}]});
      if(!path||!mounted.current)return;
      const result=await api.agentPaymentHistoryExport(query,path);
      if(mounted.current)setExportCount(result.records);
    }catch(cause){if(mounted.current)setError(errorMessage(cause));}
    finally{exportLock.current=false;if(mounted.current)setExporting(false);}
  };
  const start=navigation.index*pageSize+1,end=navigation.index*pageSize+(page?.items.length??0);
  return <div className="credit-history payment-history" ref={root} aria-busy={loading}>
    <div className="credit-history-toolbar">
      <UiSelect value={kind} onValueChange={value=>setKind(value as PaymentHistoryKind)} disabled={exporting} ariaLabel={t('支付记录类型')} options={[{value:'orders',label:t('订单')},{value:'refunds',label:t('退款')}]}/>
      <UiSelect value={range} onValueChange={setRange} disabled={exporting} ariaLabel={t('支付时间范围')} options={[{value:'all',label:t('全部时间')},{value:'7',label:t('最近 7 天')},{value:'30',label:t('最近 30 天')},{value:'90',label:t('最近 90 天')}]}/>
      <Button className="credit-history-export" variant="outline" size="sm" disabled={exporting||loading||!page?.totalCount} onClick={()=>void exportRecords()}>{exporting?<Loader2 size={14} className="animate-spin"/>:<Download size={14}/>} {t('导出 CSV')}</Button>
    </div>
    <p className="payment-caption credit-history-scope">{t('仅列出当前账号的订单和退款；状态以最近核对结果为准。')}</p>
    <div className="credit-history-navigation"><span role="status">{loading?t('正在读取支付记录…'):page?.totalCount?t('第 {0}–{1} 条，共 {2} 条',{0:start,1:end,2:page.totalCount}):t('暂无记录')}</span><div>
      <Button variant="ghost" size="icon" aria-label={t('上一页支付记录')} disabled={loading||navigation.index===0} onClick={()=>void load(navigation.cursors[navigation.index-1],navigation.index-1,navigation.cursors)}><ChevronLeft size={16}/></Button>
      <Button variant="ghost" size="icon" aria-label={t('下一页支付记录')} disabled={loading||!page?.nextCursor} onClick={()=>{if(page?.nextCursor)void load(page.nextCursor,navigation.index+1,[...navigation.cursors.slice(0,navigation.index+1),page.nextCursor]);}}><ChevronRight size={16}/></Button>
    </div></div>
    {loading?<div className="credit-history-loading" role="status"><Loader2 size={16} className="animate-spin"/>{t('正在读取支付记录…')}</div>:
      error?<div className="credit-history-error"><p className="form-error" role="alert">{localize(error)}</p><Button size="sm" variant="outline" onClick={()=>void load(requested.current.cursor,requested.current.index,requested.current.cursors)}>{t('重新查询')}</Button></div>:
      !page?.items.length?<p className="payment-empty">{t('所选范围内暂无支付记录')}</p>:<div className="payment-orders">{page.items.map(item=>'refundId' in item?<PaymentRefundRow refund={item} key={item.refundId}/>:renderOrder(item))}</div>}
    {exportCount!=null&&<p className="payment-notice" role="status">{t('已导出 {0} 条记录',{0:exportCount})}</p>}
  </div>;
}

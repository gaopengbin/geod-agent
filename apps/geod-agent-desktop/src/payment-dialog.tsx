import {useCallback,useEffect,useRef,useState} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {PanelTabs} from './panel-tabs';
import {ScrollArea} from '@/components/ui/scroll-area';
import {Button} from '@/components/motion/button/base';
import {api,errorMessage,type PaymentSnapshot,type PaymentOrder,type PaymentProduct} from './api';
import {getLocale,localize,t} from './i18n';
import {SPONSORED_CHANNELS_VISIBLE} from './ai-channels';
import {CREDITS_CHANGED,formatCredits,formatCreditRate} from './credits';
import {ExternalLink,Loader2,RefreshCw,Wallet,X} from './icons';
import './payment-dialog.css';

export const PAYMENT_OPEN='geod:payment-open';
const currency=(value:number)=>new Intl.NumberFormat(getLocale(),{style:'currency',currency:'CNY',maximumFractionDigits:2}).format(value);
const credit=formatCredits;
const preciseCredit=(value:string)=>formatCredits(value,6);
const tokens=(value:number)=>new Intl.NumberFormat(getLocale()).format(value);
const date=(value:number)=>new Date(value).toLocaleString(getLocale(),{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const names:Record<PaymentOrder['status'],string>={pending:'待支付',paid:'已到账','cancel-requested':'正在核对取消',closed:'已关闭','payment-review':'付款待复核',refunding:'退款待确认',refunded:'已退款'};
const completedPayments=new Set(['paid','closed','refunding','refunded']);
const productName=(product:PaymentProduct)=>product.kind==='topup'?credit(product.creditNanoCny):t('GeoD Agent 月订阅');

export function PaymentDialog({accountId,onClose}:{accountId:string|null;onClose:()=>void}){
  const [snapshot,setSnapshot]=useState<PaymentSnapshot|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[tab,setTab]=useState('balance');
  const [refundConfirm,setRefundConfirm]=useState<PaymentOrder|null>(null),[watchedOrder,setWatchedOrder]=useState<string|null>(null);
  const live=useRef(true),lock=useRef(false),refreshSerial=useRef(0),attempts=useRef(0);
  useEffect(()=>{live.current=true;return()=>{live.current=false;++refreshSerial.current;};},[]);
  const load=useCallback(async()=>{
    const serial=++refreshSerial.current;
    const current=await api.agentPaymentSnapshot();
    if(live.current&&serial===refreshSerial.current){setSnapshot(current);window.dispatchEvent(new CustomEvent(CREDITS_CHANGED,{detail:{accountId,snapshot:current}}));}
    return current;
  },[accountId]);
  useEffect(()=>{void load().catch(cause=>{if(live.current)setError(errorMessage(cause));}).finally(()=>{if(live.current)setLoading(false);});},[load]);
  const run=useCallback(async(action:()=>Promise<void>)=>{
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');
    try{await action();}catch(cause){if(live.current){setError(errorMessage(cause));try{await load();}catch{/* Keep the original action error; retry the same order. */}}}
    finally{lock.current=false;if(live.current)setBusy(false);}
  },[load]);
  const scope=`geod-agent-payment-requests-v1:${accountId??''}:${snapshot?.status.environment??''}:${snapshot?.status.pricingVersion??''}`;
  const checkout=async(orderId:string)=>{
    const result=await api.agentPaymentAction('checkout',{orderId});
    if(live.current){setTab('orders');setNotice(result.fixture?t('演练收银台已打开，不会真实扣款。'):t('收银台已打开，付款结果以查询为准。'));attempts.current=0;setWatchedOrder(orderId);}
    await load();
  };
  const buy=(product:PaymentProduct)=>run(async()=>{
    // Persist before sending. A lost response, close or restart retries this
    // exact request instead of silently creating another payment order.
    let requests:Record<string,{requestKey:string;orderId?:string}>={};
    const raw=localStorage.getItem(scope);if(raw)requests=JSON.parse(raw);
    const old=requests[product.id],known=old?.orderId?snapshot?.wallet?.orders.find(order=>order.orderId===old.orderId):null;
    if(known&&completedPayments.has(known.status))delete requests[product.id];
    const review=[...(known?[known]:[]),...(snapshot?.wallet?.orders??[])].find(order=>order.product.id===product.id&&['cancel-requested','payment-review'].includes(order.status));
    if(review){setTab('orders');throw new Error(t('这笔付款仍在核对中，请查询原订单后再下单。'));}
    const pending=snapshot?.wallet?.orders.find(order=>order.product.id===product.id&&order.status==='pending');
    if(pending){await checkout(pending.orderId);return;}
    const create=async(request:{requestKey:string;orderId?:string})=>{
      requests[product.id]=request;localStorage.setItem(scope,JSON.stringify(requests));
      const result=await api.agentPaymentAction('create',{productId:product.id,requestKey:request.requestKey});
      if(!result.orderId||!result.status)throw new Error(t('订单响应无效，请查询原订单。'));
      requests[product.id]={...request,orderId:result.orderId};localStorage.setItem(scope,JSON.stringify(requests));return result;
    };
    let created=await create(requests[product.id]??{requestKey:crypto.randomUUID()});
    // Older completed orders may be outside the recent history window. Only a
    // server-confirmed terminal payment permits this explicit new purchase.
    if(completedPayments.has(created.status!))created=await create({requestKey:crypto.randomUUID()});
    if(created.status!=='pending'){setTab('orders');throw new Error(t('这笔付款仍在核对中，请查询原订单后再下单。'));}
    await load();await checkout(created.orderId!);
  });
  const action=(order:PaymentOrder,kind:'refresh'|'cancel'|'refund')=>run(async()=>{
    if(kind==='refund')setRefundConfirm(null);
    const result=await api.agentPaymentAction(kind,{orderId:order.orderId});
    if(live.current){setRefundConfirm(null);setNotice(result.unconfirmed?t('付款结果尚未确认，原订单已保留。'):kind==='cancel'&&result.order?.status==='cancel-requested'?t('取消结果尚未确认，原订单已保留。'):kind==='refund'&&result.status!=='refunded'?t('退款结果尚未确认，已保留原退款请求。'):'');}
    await load();
  });
  // Brief, bounded reconciliation while this dialog is visible. Nothing keeps
  // the chat or a model turn occupied; closing immediately stops UI polling.
  useEffect(()=>{
    if(!watchedOrder)return;
    let disposed=false,timer:ReturnType<typeof setTimeout>;
    const check=async()=>{
      if(disposed||attempts.current>=10)return;
      if(document.visibilityState==='hidden'||lock.current){timer=setTimeout(check,3000);return;}
      attempts.current++;
      try{
        await api.agentPaymentAction('refresh',{orderId:watchedOrder});if(disposed)return;
        const current=await load();const order=current.wallet?.orders.find(item=>item.orderId===watchedOrder);
        if(order&&order.status!=='pending'){setWatchedOrder(null);setNotice(order.status==='paid'?t('订单已核验到账。'):'');return;}
      }catch{/* A transient result does not create a new order or imply closure. */}
      if(!disposed)timer=setTimeout(check,3000);
    };
    timer=setTimeout(check,3000);return()=>{disposed=true;clearTimeout(timer);};
  },[watchedOrder,load]);
  const wallet=snapshot?.wallet,mode=snapshot?.status.billingMode;
  return <Dialog.Root open onOpenChange={open=>{if(!open)onClose();}}><Dialog.Portal><Dialog.Overlay className="permission-dialog-overlay"/>
    <Dialog.Content className="permission-dialog payment-dialog" onCloseAutoFocus={event=>{event.preventDefault();document.querySelector<HTMLButtonElement>('.conversation-account-trigger')?.focus();}}>
      <div className="dialog-heading"><Dialog.Title><Wallet size={18}/>{t('余额与订阅')}</Dialog.Title><Dialog.Close asChild><Button variant="ghost" size="icon" aria-label={t('关闭')}><X size={17}/></Button></Dialog.Close></div>
      <Dialog.Description className="payment-description">{t('查看 Credits、订阅和支付记录。')}</Dialog.Description>
      {loading?<div className="payment-loading" role="status"><Loader2 size={17} className="animate-spin"/>{t('正在读取支付状态…')}</div>:snapshot&&<>
        {snapshot.status.fixture&&<div className="payment-fixture-note" role="status">{t('本机支付演练 · 无真实付款或退款')}</div>}
        {mode==='unlimited-test'&&<div className="payment-free-state"><strong>∞ Credits</strong><span>{t('测试模式 · 不限额度')}</span></div>}
        {!snapshot.status.checkoutEnabled&&mode!=='unlimited-test'&&<p className="payment-caption">{t('支付尚未开放，当前模型使用方式保持不变。')}</p>}
        <div className="payment-tabs">
          <div className="payment-tabs-heading"><PanelTabs label={t('余额与支付记录')} value={tab} onChange={setTab} items={[{value:'balance',label:t('余额与方案')},{value:'orders',label:t('支付记录')+((wallet?.orders.length??0)>0?` · ${wallet!.orders.length}`:'')},{value:'usage',label:t('AI 用量')}]}/><Button size="icon" variant="ghost" disabled={busy} aria-label={t('刷新支付状态')} onClick={()=>void run(async()=>{await load();})}><RefreshCw size={15}/></Button></div>
          <ScrollArea className="payment-scroll">
          <section role="tabpanel" aria-label={t('余额与方案')} hidden={tab!=='balance'} className="payment-content">
            {wallet&&<section className="payment-balances"><div><span>{t('可用 Credits')}</span><strong title={wallet.availableNanoCny!=null?preciseCredit(wallet.availableNanoCny):undefined}>{credit(wallet.availableNanoCny)}</strong></div><div><span>{t('请求预留')}</span><strong title={wallet.reservedNanoCny!=null?preciseCredit(wallet.reservedNanoCny):undefined}>{credit(wallet.reservedNanoCny)}</strong></div></section>}
            <p className="payment-credit-conversion">{t('1,000 Credits = ¥1 AI 计费余额。按实际模型用量扣除，Credits 不是 Token 数量。')}</p>
            {wallet?.frozenNanoCny&&BigInt(wallet.frozenNanoCny)>0n&&<p className="payment-frozen" role="status">{t('退款核对中 · 冻结余额 {0}',{'0':credit(wallet.frozenNanoCny)})}</p>}
            {wallet?.subscription&&<div className="payment-subscription"><strong>{t('月订阅')}</strong><span>{t('到期：{0}',{'0':new Date(wallet.subscription.expiresAt).toLocaleDateString(getLocale())})}</span></div>}
            <div className="payment-section-title"><h3>{snapshot.status.checkoutEnabled?t('充值与订阅'):t('方案预览')}</h3>{!snapshot.status.pricesApproved&&<span>{t('待确认方案')}</span>}</div>
            {snapshot.status.products.length>0?<div className="payment-products">{snapshot.status.products.map(product=><section key={product.id} className="payment-product"><div><strong>{productName(product)}</strong><span>{product.kind==='subscription'?t('{0} 天 · 含 {1}',{'0':product.days,'1':credit(product.creditNanoCny)}):t('按实际模型用量结算')}</span></div><b>{currency(product.priceFen/100)}</b><Button variant="outline" size="sm" disabled={busy||!snapshot.status.checkoutEnabled} onClick={()=>void buy(product)}>{!snapshot.status.checkoutEnabled?t('未开放'):snapshot.status.fixture?t('演练下单'):product.kind==='subscription'?t('订阅'):t('充值')}</Button></section>)}</div>:<p className="payment-caption">{t('收费方案确认后将在这里提供。')}</p>}
            <p className="payment-caption">{t(SPONSORED_CHANNELS_VISIBLE?'自带 Key 与赞助渠道不扣此余额；本机数据处理与下载不按模型用量计费。':'自带 Key 不扣此余额；本机数据处理与下载不按模型用量计费。')}</p>
          </section>
          <section role="tabpanel" aria-label={t('支付记录')} hidden={tab!=='orders'} className="payment-content">
            {!wallet?.orders.length?<p className="payment-empty">{t('暂无支付记录')}</p>:<div className="payment-orders">{wallet.orders.map(order=><section className="payment-order" key={order.orderId} data-order-id={order.orderId}><div className="payment-order-heading"><strong>{productName(order.product)}</strong><span className={order.status==='paid'||order.status==='refunded'?'payment-order-success':''}>{t(names[order.status]??'状态待核对')}</span></div><div className="payment-order-meta"><span>{new Date(order.createdAt).toLocaleString(getLocale(),{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span><b>{currency(order.priceFen/100)}</b></div><code title={order.orderId}>{order.orderId}</code>
              <div className="payment-order-actions">
                {order.status==='pending'&&<Button size="sm" disabled={busy||order.expiresAt<=Date.now()} onClick={()=>void run(()=>checkout(order.orderId))}><ExternalLink size={13}/>{t('继续支付')}</Button>}
                {['pending','cancel-requested','payment-review'].includes(order.status)&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>void action(order,'refresh')}>{t('查询付款')}</Button>}
                {order.status==='pending'&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void action(order,'cancel')}>{t('取消订单')}</Button>}
                {order.status==='cancel-requested'&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void action(order,'cancel')}>{t('核对取消')}</Button>}
                {order.status==='paid'&&order.product.kind==='topup'&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>setRefundConfirm(order)}>{t('申请退款')}</Button>}
                {order.status==='refunding'&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>void action(order,'refund')}>{t('核对退款')}</Button>}
              </div>
              {order.status==='payment-review'&&<p className="payment-caption">{t('已保存付款凭证，需复核后处理余额。')}</p>}
              {refundConfirm?.orderId===order.orderId&&<div className="payment-refund-confirm"><p>{t('将申请退回这笔尚未使用的余额 {0}。请求中会冻结此笔余额，结果以原订单核验为准。',{'0':currency(order.priceFen/100)})}</p><div><Button variant="outline" size="sm" disabled={busy} onClick={()=>setRefundConfirm(null)}>{t('返回')}</Button><Button size="sm" disabled={busy} onClick={()=>void action(order,'refund')}>{snapshot.status.fixture?t('演练退款'):t('确认申请退款')}</Button></div></div>}
            </section>)}</div>}
          </section>
          <section role="tabpanel" aria-label={t('AI 用量')} hidden={tab!=='usage'} className="payment-content">
            {mode==='unlimited-test'&&<p className="payment-caption">{t('当前测试不限额度，尚无钱包扣费记录。')}</p>}
            {!!wallet?.reservations?.length&&<div className="payment-usage-group"><h3>{t('费用预留')}<span>{wallet.reservationCount??wallet.reservations.length}</span></h3><p className="payment-caption">{t('预留金额会在用量核验后结算，未确认用量不会直接扣费。')}</p>{wallet.reservations.map(reservation=><section className="payment-usage-row" key={reservation.generationId} data-reservation-id={reservation.generationId}><div className="payment-order-heading"><strong>{reservation.model??t('模型待核对')}</strong><b>{preciseCredit(reservation.maximumNanoCny)}</b></div><div className="payment-order-meta"><span>{date(reservation.createdAt)}</span><span>{t('待结算')}</span></div><code title={reservation.generationId}>{reservation.generationId}</code></section>)}</div>}
            <div className="payment-usage-group"><h3>{t('已结算用量')}<span>{wallet?.chargeCount??wallet?.charges?.length??0}</span></h3>{!wallet?.charges?.length?<p className="payment-empty">{t('暂无 AI 扣费记录')}</p>:<>{(wallet.chargeCount??0)>wallet.charges.length&&<p className="payment-caption">{t('显示最近 {0} 次扣费，共 {1} 次。',{'0':wallet.charges.length,'1':wallet.chargeCount??wallet.charges.length})}</p>}{wallet.charges.map(charge=><section className="payment-usage-row" key={charge.generationId} data-charge-id={charge.generationId}><div className="payment-order-heading"><strong>{charge.model??t('模型待核对')}</strong><b>{preciseCredit(charge.chargeNanoCny)}</b></div><div className="payment-order-meta"><span>{date(charge.createdAt)}</span><span>{t('已结算')}</span></div><details className="payment-usage-details"><summary>{t('计费明细')}</summary><dl><div><dt>{t('输入 token')}</dt><dd>{tokens(charge.inputTokens)}</dd></div><div><dt>{t('其中缓存')}</dt><dd>{tokens(charge.cachedInputTokens)}</dd></div><div><dt>{t('输出 token')}</dt><dd>{tokens(charge.outputTokens)}</dd></div>{charge.reasoningTokens!=null&&<div><dt>{t('其中推理')}</dt><dd>{tokens(charge.reasoningTokens)}</dd></div>}</dl>{charge.ratesNanoPerToken&&<div className="payment-charge-rates"><span>{t('每百万 token：未缓存输入 {0} · 缓存输入 {1} · 输出 {2}',{'0':formatCreditRate(charge.ratesNanoPerToken.uncachedInput),'1':formatCreditRate(charge.ratesNanoPerToken.cachedInput),'2':formatCreditRate(charge.ratesNanoPerToken.output)})}</span></div>}<div className="payment-charge-version"><span>{t('费率版本')}</span><code title={charge.pricingVersion}>{charge.pricingVersion}</code></div><code className="payment-generation-id" title={charge.generationId}>{charge.generationId}</code></details></section>)}</> }</div>
            <p className="payment-caption">{t(SPONSORED_CHANNELS_VISIBLE?'仅列出此钱包的模型费用，不包含自带 Key 或赞助渠道。':'仅列出此钱包的模型费用，不包含自带 Key。')}</p>
          </section>
          </ScrollArea>
        </div>
      </>}
      {notice&&<p className="payment-notice" role="status">{notice}</p>}{error&&<p className="form-error" role="alert">{localize(error)}</p>}
      <div className="permission-dialog-actions">{busy&&<Loader2 size={16} className="animate-spin"/>}{error&&<Button variant="outline" size="sm" disabled={busy} onClick={()=>void run(async()=>{await load();})}>{t('重新查询')}</Button>}<Dialog.Close asChild><Button variant="outline" size="sm">{t('完成')}</Button></Dialog.Close></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

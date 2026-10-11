// Standalone loopback preview with generated signing keys and fake trades.
// No production accounts, merchant keys, payments or model requests are used.
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {fixture} from '../test/helpers/payment-fixture.mjs';
import {monthlyPlanDraft,monthlyPlanPolicy,monthlyPlanPreview} from '../monthly-plans.mjs';
import {pricingCandidate} from '../pricing-candidate.mjs';

if(process.env.GEOD_MONTHLY_PLAN_PREVIEW!=='1')throw new Error('Explicit local monthly preview opt-in required');
const port=Number(process.env.GEOD_MONTHLY_PLAN_PREVIEW_PORT??1437);
const f=await fixture({products:monthlyPlanDraft,welcomeCredit:{policyId:'monthly-preview-welcome',creditNanoCny:'20000000000',maxRecipients:100}});
f.ledger.grantWelcome('geod-alice');let serial=0;
const json=(res,status,data)=>res.writeHead(status,{'content-type':'application/json;charset=utf-8','cache-control':'no-store'}).end(JSON.stringify(data));
const html=(res,text)=>res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"}).end(text);
const input=async req=>{let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw new Error('Preview request too large');}return JSON.parse(body||'{}');};
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,`http://127.0.0.1:${port}`);
  res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:1436');res.setHeader('Vary','Origin');
  if(req.headers.origin&&req.headers.origin!=='http://127.0.0.1:1436'&&req.headers.origin!==`http://127.0.0.1:${port}`){json(res,403,{error:'Preview origin not allowed'});return;}
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Headers':'content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}).end();return;}
  if(req.method==='GET'&&url.pathname==='/api/snapshot'){
   const preview=url.searchParams.get('preview')==='1';
   json(res,200,{status:{candidate:true,checkoutEnabled:!preview,environment:'fixture',fixture:true,billingMode:'prepaid',pricingVersion:pricingCandidate.version,pricesApproved:false,paymentHistoryEnabled:false,creditHistoryEnabled:false,planPolicy:preview?null:monthlyPlanPolicy,planPreview:preview?monthlyPlanPreview:null,products:preview?[]:monthlyPlanDraft},wallet:f.ledger.summary('geod-alice')});return;
  }
  if(req.method==='POST'&&url.pathname==='/api/action'){
   const value=await input(req);let result;
   if(value.action==='create')result=await f.request('/v1/payments/orders',{method:'POST',value:{productId:value.productId,requestKey:value.requestKey}});
   else if(['checkout','refresh','cancel','refund'].includes(value.action))result=await f.request(`/v1/payments/orders/${value.orderId}/${value.action}`,{method:'POST',value:{}});
   else throw new Error('Unknown preview action');
   if(value.action==='checkout'&&result.status===200){
    const signed=await fetch(result.data.checkoutUrl);if(signed.status!==200)throw new Error('Generated-key checkout signature failed');
    result.data={opened:true,fixture:true,order:result.data.order,previewCashierUrl:`http://127.0.0.1:${port}/preview/cashier?orderId=${value.orderId}`};
   }
   json(res,result.status,result.data);return;
  }
  if(req.method==='GET'&&url.pathname==='/preview/cashier'){
   const order=f.ledger.order('geod-alice',url.searchParams.get('orderId'));const name=monthlyPlanDraft.find(p=>p.id===order.product.id).name;
   html(res,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本机套餐支付演练</title><style>body{font:15px/1.7 system-ui,'Microsoft YaHei',sans-serif;background:#f5f7fb;color:#172033;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:410px;padding:32px;border-radius:16px;background:white;box-shadow:0 10px 50px #18345112}h1{font-size:23px}strong{font-size:32px}button{font:inherit;border:0;border-radius:9px;padding:12px 20px;background:#2864ee;color:white;cursor:pointer}p{color:#5e697d}small{display:block;margin-top:16px;color:#7b8497}</style><main><h1>${name}</h1><strong>¥${(order.priceFen/100).toFixed(2)}</strong><p>本机支付演练，使用临时签名密钥。此页面不会真实付款，也不调用支付宝。</p><button id="confirm">模拟支付成功</button><small>确认后通过签名回调将演练 Credits 记入本机演练账本。</small><p id="status" role="status"></p></main><script>document.getElementById('confirm').onclick=async()=>{const b=document.getElementById('confirm');b.disabled=true;const r=await fetch('/api/simulate-paid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({orderId:${JSON.stringify(order.orderId)}})});if(r.ok){document.getElementById('status').textContent='演练到账成功，请返回套餐窗口。';window.close()}else{document.getElementById('status').textContent='演练失败，请重试';b.disabled=false}}</script></html>`);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/simulate-paid'){
   const value=await input(req);const order=f.ledger.order('geod-alice',value.orderId);
   if(!f.trades.has(order.orderId))f.trades.set(order.orderId,{out_trade_no:order.orderId,trade_no:'202610110000'+String(++serial).padStart(12,'0'),total_amount:(order.priceFen/100).toFixed(2),trade_status:'TRADE_SUCCESS'});
   const result=await f.request('/v1/payments/alipay/notify',{method:'POST',token:null,raw:f.notification(order)});if(result.status!==200||result.data!=='success')throw new Error('Generated-key callback failed');
   json(res,200,{fixture:true,paid:true});return;
  }
  if(req.method==='GET'&&url.pathname==='/api/health'){json(res,200,{product:'geod-agent-monthly-preview',fixture:true,realPayments:false,realModels:false,orders:f.ledger.summary('geod-alice').orderCount});return;}
  json(res,404,{error:'Preview route not found'});
 }catch(error){json(res,400,{error:{message:error.message}});}
});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
console.log(JSON.stringify({ready:true,fixture:true,realPayments:false,realModels:false,pid:process.pid,port}));
const stop=async()=>{await new Promise(resolve=>server.close(resolve));await f.close();process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);

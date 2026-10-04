// Explicit loopback-only native UI acceptance. Generated signing keys, fake
// trades and protocol fixture output never reach an external payment/model API.
import {fixture} from '../test/helpers/payment-fixture.mjs';
import {createGatewayServer,readConfig} from '../server.mjs';
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';

if(process.env.GEOD_PAYMENT_UI_FIXTURE!=='1')throw new Error('Explicit local payment fixture opt-in required');
const root=resolve(process.env.GEOD_PAYMENT_UI_ROOT??'artifacts/product-gaps-20261004/payments/native-ui');
const within=relative(resolve('artifacts'),root);if(!within||within.startsWith('..')||within.includes(':'))throw new Error('UI evidence must stay in project artifacts');
mkdirSync(root,{recursive:true});
const f=await fixture(),secret=randomBytes(32).toString('hex');
let modelCalls=0,serial=0,modelMode='ok',gateway;
const identity=createServer(async(req,res)=>{
  try{
    if(req.url!=='/api/geod/oauth/introspect'||req.headers.authorization!=='Bearer '+secret){res.writeHead(404).end();return;}
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1024){res.writeHead(413).end();return;}}
    const token=JSON.parse(raw).token;if(!/^[A-Za-z0-9_-]{43}$/.test(token??'')){res.writeHead(401).end();return;}
    // The existing authorized development gateway checks the genuine login;
    // this fixture never reads the user's token from files or the credential vault.
    const valid=await fetch('http://127.0.0.1:43123/api/agent/usage',{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(valid.status!==200){res.writeHead(401).end();return;}
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({active:{userId:'payment-native-test',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}}));
  }catch{res.writeHead(503).end();}
});
await new Promise(resolve=>identity.listen(0,'127.0.0.1',resolve));
const config={...readConfig({GEOD_AGENT_GATEWAY_SECRET:secret,GEOD_IDENTITY_ORIGIN:`http://127.0.0.1:${identity.address().port}`,DEEPSEEK_API_KEY:'generated-ui-fixture-only',
  DEEPSEEK_BASE_URL:'http://127.0.0.1:41001',GEOD_AGENT_DB_PATH:join(root,'fixture-model.sqlite'),GEOD_AGENT_QUOTA_MODE:'unlimited'}),
  payment:{gateway:f.config,billingMode:'enforced',dbPath:join(root,'fixture-payments.sqlite'),maxDailyFen:100000}};
const fetchImpl=async(url,options)=>{
  if(url.startsWith(config.identityOrigin+'/'))return fetch(url,options);
  if(url!=='http://127.0.0.1:41001/chat/completions')throw new Error('Fixture cannot make external provider calls');
  modelCalls++;
  if(modelMode==='lost')throw new Error('fixture provider response lost');
  if(modelMode==='reject')return Response.json({error:'fixture rejection'},{status:400});
  return Response.json({id:'generated-ui-model-fixture-'+modelCalls,model:'deepseek-flash',usage:{prompt_tokens:10000,completion_tokens:100,...(modelMode==='missing-cache'?{}:{prompt_cache_hit_tokens:8000})},choices:[{message:{role:'assistant',content:'本机模型协议演练，无真实模型输出。',tool_calls:[]}}]});
};
async function start(port=0){gateway=createGatewayServer(config,{fetchImpl});await new Promise(resolve=>gateway.listen(port,'127.0.0.1',resolve));return gateway.address().port;}
const port=await start(),statePath=join(root,'gateway-state.json'),controlPath=join(root,'gateway-control.json'),ackPath=join(root,'gateway-ack.json');
function state(stopped=false){writeFileSync(statePath,JSON.stringify({fixture:true,realPayments:false,realRefunds:false,realModels:false,pid:process.pid,port,ready:!stopped,stopped,modelCalls,providerCalls:f.calls,orders:f.trades.size,refunds:f.refunds.size},null,2));}
state();process.stdout.write('Local native payment fixture ready\n');
let last=null,stopping=false;
const timer=setInterval(async()=>{
  if(stopping||!existsControl())return;
  let command;try{command=JSON.parse(readFileSync(controlPath,'utf8'));}catch{return;}
  if(command.operationId===last)return;last=command.operationId;
  try{
    if(command.action==='paid'){
      if(!/^GDA[0-9a-f]{32}$/.test(command.orderId))throw new Error('Invalid fixture order');
      // Query the fixture-owned SQLite via its signed local protocol state;
      // amounts come from the ledger, never arbitrary control-file money.
      const Database=(await import('better-sqlite3')).default,db=new Database(config.payment.dbPath,{readonly:true});
      const row=db.prepare('SELECT * FROM geod_payment_orders WHERE id=?').get(command.orderId);db.close();if(!row)throw new Error('Missing fixture order');
      f.trades.set(row.id,{out_trade_no:row.id,trade_no:'202610050000'+String(++serial).padStart(12,'0'),total_amount:(row.amount_fen/100).toFixed(2),trade_status:'TRADE_SUCCESS'});
      // Send actual generated-key notification through the normal HTTP route.
      const order={orderId:row.id,priceFen:row.amount_fen};
      const notified=await fetch(`http://127.0.0.1:${port}/v1/payments/alipay/notify`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:f.notification(order)});
      if(await notified.text()!=='success')throw new Error('Fixture callback did not commit');
    }else if(command.action==='refundLost')f.refundMode='drop-responses';
    else if(command.action==='refundNormal')f.refundMode='normal';
    else if(command.action==='closeMode'){if(!['missing','normal'].includes(command.value))throw new Error('Invalid fixture close mode');f.closeMode=command.value;}
    else if(command.action==='modelMode'){if(!['ok','lost','reject','missing-cache'].includes(command.value))throw new Error('Invalid fixture model mode');modelMode=command.value;}
    else if(command.action==='snapshot'){}
    else if(command.action==='restart'){await new Promise(resolve=>gateway.close(resolve));await start(port);}
    else if(command.action==='stop'){stopping=true;clearInterval(timer);await new Promise(resolve=>gateway.close(resolve));await new Promise(resolve=>identity.close(resolve));await f.close();}
    else throw new Error('Unknown fixture action');
    state(stopping);writeFileSync(ackPath,JSON.stringify({operationId:command.operationId,passed:true,fixture:true,action:command.action}));
    if(stopping)process.exit(0);
  }catch(cause){writeFileSync(ackPath,JSON.stringify({operationId:command.operationId,passed:false,error:String(cause.message)}));}
},100);
function existsControl(){try{readFileSync(controlPath);return true;}catch{return false;}}

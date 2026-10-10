import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import Database from 'better-sqlite3';
import {createGatewayServer,readConfig} from '../server.mjs';
import {createPaymentLedgerCandidate} from '../payment-ledger-candidate.mjs';
import {readWelcomeCreditPolicy} from '../welcome-credit-policy.mjs';
import {fixture} from './helpers/payment-fixture.mjs';

async function host({credits='20000',quotaMode='enforced',contextWindow=128000,maxOutputTokens=256,maxRecipients='100'}={}){
  const root=mkdtempSync(join(tmpdir(),'geod-welcome-credit-'));
  const secret=randomBytes(32).toString('hex');
  const sessions=new Map(),deviceA=randomBytes(32).toString('base64url'),deviceB=randomBytes(32).toString('base64url'),other=randomBytes(32).toString('base64url');
  sessions.set(deviceA,{userId:'new-agent-account'});sessions.set(deviceB,{userId:'new-agent-account'});sessions.set(other,{userId:'another-account'});
  const environment={GEOD_AGENT_GATEWAY_SECRET:secret,DEEPSEEK_API_KEY:'isolated-protocol-fixture',GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:41000',
    DEEPSEEK_BASE_URL:'http://127.0.0.1:41001',GEOD_AGENT_DB_PATH:join(root,'model.sqlite'),GEOD_AGENT_QUOTA_MODE:quotaMode,
    GEOD_AGENT_CONTEXT_WINDOW:String(contextWindow),GEOD_AGENT_MAX_OUTPUT_TOKENS:String(maxOutputTokens),GEOD_AGENT_WELCOME_CREDITS:credits,GEOD_AGENT_WELCOME_MAX_RECIPIENTS:maxRecipients};
  let calls=0,upstream='ok',usage={prompt_tokens:10000,completion_tokens:100,prompt_cache_hit_tokens:8000},lastRequest;
  const fetchImpl=async(url,options)=>{
    if(url.endsWith('/api/geod/oauth/introspect')){
      const account=sessions.get(JSON.parse(options.body).token);
      return Response.json({active:account?{clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000,...account}:null});
    }
    assert(url.endsWith('/chat/completions'));++calls;
    lastRequest=JSON.parse(options.body);
    if(upstream==='lost')throw new Error('isolated response lost');
    if(upstream==='reject')return Response.json({error:'isolated rejection'},{status:400});
    if(lastRequest.stream)return new Response('data: '+JSON.stringify({id:'isolated-model-'+calls,model:'deepseek-flash',choices:[{delta:{content:'你好！有什么需要帮忙的？'}}]})+'\n\n'+'data: '+JSON.stringify({id:'isolated-model-'+calls,model:'deepseek-flash',usage,choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    return Response.json({id:'isolated-model-'+calls,model:'deepseek-flash',usage,
      choices:[{message:{role:'assistant',content:'Isolated model protocol response',tool_calls:[]}}]});
  };
  let server,base;
  async function start(){server=createGatewayServer(readConfig(environment),{fetchImpl});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;}
  async function stop(){await new Promise(resolve=>server.close(resolve));}
  await start();
  async function request(path,{method='GET',value,token=deviceA}={}){
    const res=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(value!==undefined?{body:JSON.stringify(value)}:{})});
    return {status:res.status,data:res.headers.get('content-type')?.includes('text/event-stream')?await res.text():await res.json()};
  }
  const generate=(generationId=randomUUID())=>request('/api/agent/generations',{method:'POST',value:{generationId,conversationId:'welcome-credit-check',messages:[{role:'user',content:'isolated welcome check'}]}});
  return {root,environment,sessions,deviceA,deviceB,other,request,generate,get calls(){return calls;},get lastRequest(){return lastRequest;},
    set upstream(value){upstream=value;},set usage(value){usage=value;},
    async restart(patch={}){await stop();Object.assign(environment,patch);await start();},
    async close(){if(server.listening)await stop();rmSync(root,{recursive:true,force:true});}};
}

test('new authenticated Agent wallets receive 20,000 Credits without opening checkout',async()=>{
  const h=await host();try{
    const status=(await h.request('/v1/payments/status')).data;
    assert.equal(status.billingMode,'prepaid');assert.equal(status.checkoutEnabled,false);assert.equal(status.welcomeCreditEnabled,true);assert.deepEqual(status.products,[]);
    const wallet=(await h.request('/v1/payments/wallet')).data;
    assert.equal(wallet.availableNanoCny,'20000000000');assert.equal(wallet.fixture,false);assert.equal(wallet.environment,'credits-only');
    assert.deepEqual(wallet.orders,[]);assert.equal(wallet.grants.length,1);assert.equal(wallet.grants[0].kind,'welcome');
    assert.equal(wallet.grants[0].creditNanoCny,'20000000000');assert.equal(h.calls,0);
    assert.equal((await h.request('/v1/payments/orders',{method:'POST',value:{requestKey:'no-cash',productId:'ai-credit-10'}})).status,409);
    assert.equal((await h.request('/v1/payments/alipay/notify',{method:'POST',value:{}})).status,409);
  }finally{await h.close();}
});

test('HTTP wallets report exhausted slots without issuing credit or calling the model',async()=>{
  const h=await host({maxRecipients:'1'});try{
    assert.equal((await h.request('/v1/payments/wallet')).data.grants.length,1);
    const denied=(await h.request('/v1/payments/wallet',{token:h.other})).data;
    assert.equal(denied.availableNanoCny,'0');assert.deepEqual(denied.grants,[]);
    assert.equal(denied.welcomeCreditDecision.state,'quota-exhausted');
    assert.deepEqual(denied.welcomeCreditStatus,{limit:1,issued:1,remaining:0,available:false});
    await h.restart();assert.equal((await h.request('/v1/payments/status',{token:h.other})).data.welcomeCreditStatus.remaining,0);
    const result=await h.request('/api/agent/generations',{method:'POST',token:h.other,value:{generationId:randomUUID(),conversationId:'quota-check',messages:[{role:'user',content:'isolated'}]}});
    assert.equal(result.status,409);assert.equal(h.calls,0);
    assert.equal((await h.request('/v1/payments/wallet',{token:h.deviceB})).data.grants.length,1);
  }finally{await h.close();}
});

test('concurrent sign-ins, another device and gateway restarts grant exactly once per account',async()=>{
  const h=await host();try{
    const reads=await Promise.all(Array.from({length:20},(_,i)=>h.request('/v1/payments/wallet',{token:i%2?h.deviceA:h.deviceB})));
    assert(reads.every(read=>read.data.availableNanoCny==='20000000000'&&read.data.grants.length===1));
    await h.restart();assert.equal((await h.request('/v1/payments/wallet',{token:h.deviceB})).data.availableNanoCny,'20000000000');
    const other=(await h.request('/v1/payments/wallet',{token:h.other})).data;assert.equal(other.grants.length,1);assert.equal(other.availableNanoCny,'20000000000');
    const db=new Database(h.environment.GEOD_AGENT_DB_PATH+'-credits.sqlite',{readonly:true});
    try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM geod_credit_grants').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM geod_credit_lots').get().n,2);}finally{db.close();}
  }finally{await h.close();}
});

test('only server-verified GeoD identity can receive credits; requests cannot choose recipient or amount',async()=>{
  const h=await host();try{
    assert.equal((await h.request('/v1/payments/wallet',{token:randomBytes(32).toString('base64url')})).status,401);
    h.sessions.set(h.other,{userId:'wrong-client',clientId:'other-app'});
    assert.equal((await h.request('/v1/payments/wallet',{token:h.other})).status,401);
    for(const patch of [{scope:'other:scope'},{expiresAt:null},{expiresAt:Date.now()-1},{userId:''}]){
      h.sessions.set(h.other,{userId:'invalid-account',...patch});
      assert.equal((await h.request('/v1/payments/wallet',{token:h.other})).status,401);
    }
    assert.equal((await h.request('/v1/payments/wallet',{token:'bad-token'})).status,401);
    const db=new Database(h.environment.GEOD_AGENT_DB_PATH+'-credits.sqlite',{readonly:true});
    try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM geod_credit_grants').get().n,0);}finally{db.close();}
    assert.equal((await h.request('/v1/payments/grants',{method:'POST',value:{accountId:'victim',creditNanoCny:'999999999999'}})).status,409);
    const wallet=(await h.request('/v1/payments/wallet?accountId=victim&credits=999999')).data;
    assert.equal(wallet.availableNanoCny,'20000000000');assert.equal(wallet.grants.length,1);
    const check=new Database(h.environment.GEOD_AGENT_DB_PATH+'-credits.sqlite',{readonly:true});
    try{assert.deepEqual(check.prepare('SELECT account FROM geod_credit_grants').all(),[{account:'new-agent-account'}]);}finally{check.close();}
  }finally{await h.close();}
});

test('gift credits fund hosted calls and settle trusted cache usage once across request replay and restart',async()=>{
  const h=await host();try{
    const id=randomUUID(),generated=await h.generate(id);assert.equal(generated.status,200);assert.equal(generated.data.billing.chargeNanoCny,'10240000');
    const wallet=(await h.request('/v1/payments/wallet')).data;
    assert.equal(wallet.availableNanoCny,'19989760000');assert.equal(wallet.grants[0].remainingNanoCny,'19989760000');assert.equal(wallet.chargeCount,1);assert.equal(wallet.reservedNanoCny,'0');
    assert.equal((await h.generate(id)).data.billing.replayed,true);assert.equal(h.calls,1);
    await h.restart();assert.equal((await h.request('/api/agent/generations/'+id)).data.billing.replayed,true);
    assert.equal((await h.request('/v1/payments/wallet')).data.availableNanoCny,'19989760000');assert.equal(h.calls,1);
  }finally{await h.close();}
});

test('580.37184 Credits funds a greeting even when the context capacity is one million tokens',async()=>{
  const h=await host({credits:'581',contextWindow:1000000,maxOutputTokens:8192});try{
    await h.request('/v1/payments/wallet');
    const database=new Database(join(h.root,'model.sqlite-credits.sqlite'));
    try{database.prepare('UPDATE geod_credit_lots SET remaining_nano=? WHERE account=?').run(580371840,'new-agent-account');}finally{database.close();}
    h.usage={prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:0};
    const id=randomUUID(),response=await h.request('/api/agent/codex/generations/stream',{method:'POST',value:{generationId:id,conversationId:'low-balance-greeting',request:{instructions:'Reply briefly to a greeting.',input:[{role:'user',content:'你好'}],tools:[]}}});
    assert.equal(response.status,200);assert.match(response.data,/你好/);assert.equal(h.calls,1);
    assert.equal(h.lastRequest.max_tokens,8192);
    const wallet=(await h.request('/v1/payments/wallet')).data;assert.equal(wallet.chargeCount,1);assert.equal(wallet.reservedNanoCny,'0');assert.equal(wallet.balanceNanoCny,'579651840');
  }finally{await h.close();}
});

test('low balance keeps normal upstream output capacity while unresolved holds survive restart',async()=>{
  const h=await host({credits:'50',contextWindow:1000000,maxOutputTokens:8192});try{
    h.upstream='lost';
    const id=randomUUID(),response=await h.request('/api/agent/codex/generations/stream',{method:'POST',value:{generationId:id,conversationId:'limited-output',maximumNanoCny:'1',maxOutputTokens:1000000,request:{instructions:'Keep the response brief.',max_output_tokens:1000000,input:[{role:'user',content:'你好'}],tools:[]}}});
    assert.equal(response.status,200);assert.equal(h.calls,1);assert.equal(h.lastRequest.max_tokens,8192);
    const wallet=(await h.request('/v1/payments/wallet')).data,reservation=wallet.reservations[0];assert.equal(wallet.reservationCount,1);
    assert.equal(reservation.requestBounds.maxOutputTokens,h.lastRequest.max_tokens);
    assert.equal(reservation.requestBounds.billingPolicy,'wallet-until-empty-v1');
    assert.equal(wallet.availableNanoCny,'0');assert.equal(wallet.reservedNanoCny,'50000000');
    await h.restart();assert.equal((await h.request('/v1/payments/wallet')).data.reservedNanoCny,wallet.reservedNanoCny);
  }finally{await h.close();}
});

test('an input estimate above the wallet still dispatches; concurrent outstanding holds cannot reuse funds',async()=>{
  const h=await host({credits:'50',contextWindow:1000000,maxOutputTokens:8192});try{
    const request={instructions:'Reply briefly.',input:[{role:'user',content:'x'.repeat(20000)}],tools:[]};
    const admitted=await h.request('/api/agent/codex/generations/stream',{method:'POST',value:{generationId:randomUUID(),conversationId:'large-input',request}});assert.equal(admitted.status,200);assert.equal(h.calls,1);
    assert.equal(h.lastRequest.max_tokens,8192);assert.equal((await h.request('/v1/payments/wallet')).data.reservationCount,0);
    h.upstream='lost';const small={instructions:'Reply briefly.',input:[{role:'user',content:'你好'}],tools:[]};
    const simultaneous=await Promise.all(Array.from({length:2},()=>h.request('/api/agent/codex/generations/stream',{method:'POST',value:{generationId:randomUUID(),conversationId:'concurrent-request',request:small}})));
    assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,409]);assert.equal(h.calls,2);
    assert.equal(simultaneous.find(r=>r.status===409).data.error,'BILLING_CREDIT_IN_USE');
    assert(BigInt((await h.request('/v1/payments/wallet')).data.availableNanoCny)>=0n);
  }finally{await h.close();}
});

test('the last positive balance dispatches, reaches zero without debt, and only then blocks the model',async()=>{
  const h=await host({credits:'100',contextWindow:16000});try{
    h.usage={prompt_tokens:16000,completion_tokens:2048,prompt_cache_hit_tokens:0};
    assert.equal((await h.generate()).data.billing.chargeNanoCny,'96768000');
    const last=await h.generate();assert.equal(last.status,200);assert.equal(last.data.billing.chargeNanoCny,'3232000');assert.equal(last.data.billing.quotedNanoCny,'96768000');assert.equal(last.data.billing.waivedNanoCny,'93536000');
    const denied=await h.generate();assert.equal(denied.status,409);assert.equal(denied.data.error,'BILLING_INSUFFICIENT_CREDIT');assert.equal(h.calls,2);
    const wallet=(await h.request('/v1/payments/wallet',{token:h.deviceB})).data;assert.equal(wallet.availableNanoCny,'0');assert.equal(wallet.reservedNanoCny,'0');assert.equal(wallet.grants.length,1);
    const charge=wallet.charges.find(charge=>charge.chargeNanoCny==='3232000');assert.equal(charge.waivedNanoCny,'93536000');
    await h.restart();assert.equal((await h.request('/v1/payments/wallet')).data.availableNanoCny,'0');
  }finally{await h.close();}
});

test('348.10096 Credits accepts a long real-task context despite a higher conservative input estimate',async()=>{
  const h=await host({credits:'349',contextWindow:1000000,maxOutputTokens:8192});try{
    await h.request('/v1/payments/wallet');
    const database=new Database(join(h.root,'model.sqlite-credits.sqlite'));
    try{database.prepare('UPDATE geod_credit_lots SET remaining_nano=? WHERE account=?').run(348100960,'new-agent-account');}finally{database.close();}
    h.usage={prompt_tokens:17394,completion_tokens:3121,prompt_cache_hit_tokens:12800};
    const response=await h.request('/api/agent/codex/generations/stream',{method:'POST',value:{generationId:randomUUID(),conversationId:'historical-imagery-task',request:{instructions:'Continue the geographic imagery workflow.',input:[{role:'user',content:'下载今年的历史影像\n'+'context '.repeat(15000)}],tools:[]}}});
    assert.equal(response.status,200);assert.equal(h.calls,1);assert.equal(h.lastRequest.max_tokens,8192);
    const wallet=(await h.request('/v1/payments/wallet')).data;
    assert.equal(wallet.balanceNanoCny,'278764960');assert.equal(wallet.reservedNanoCny,'0');assert.equal(wallet.charges[0].chargeNanoCny,'69336000');
  }finally{await h.close();}
});

test('even one nano-CNY admits a request and its capped settlement replays exactly once after restart',async()=>{
  const h=await host({credits:'1',maxOutputTokens:8192});try{
    await h.request('/v1/payments/wallet');
    const database=new Database(join(h.root,'model.sqlite-credits.sqlite'));
    try{database.prepare('UPDATE geod_credit_lots SET remaining_nano=1 WHERE account=?').run('new-agent-account');}finally{database.close();}
    h.usage={prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:0};
    const id=randomUUID(),response=await h.generate(id);assert.equal(response.status,200);assert.equal(response.data.billing.chargeNanoCny,'1');assert.equal(response.data.billing.waivedNanoCny,'719999');
    const wallet=(await h.request('/v1/payments/wallet')).data;assert.equal(wallet.balanceNanoCny,'0');assert.equal(wallet.chargeCount,1);assert.equal(wallet.reservationCount,0);
    await h.restart();const replay=await h.generate(id);assert.equal(replay.data.billing.replayed,true);assert.equal(replay.data.billing.chargeNanoCny,'1');assert.equal(replay.data.billing.waivedNanoCny,'719999');
    assert.equal((await h.generate()).status,409);assert.equal(h.calls,1);assert.equal((await h.request('/v1/payments/wallet')).data.chargeCount,1);
  }finally{await h.close();}
});

test('progressing work can make more than twelve requests and stops only at an empty wallet',async()=>{
  const h=await host({credits:'10'});try{
    h.usage={prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:0};
    for(let step=0;step<18;step++)assert.equal((await h.generate()).status,200);
    assert.equal(h.calls,18);const wallet=(await h.request('/v1/payments/wallet')).data;
    assert.equal(wallet.balanceNanoCny,'0');assert.equal(wallet.chargeCount,18);assert.equal(wallet.reservedNanoCny,'0');
    assert.equal((await h.generate()).status,409);assert.equal(h.calls,18);
  }finally{await h.close();}
});

test('a capped final debit cannot spend another in-flight request hold or leave a debt for later funding',async()=>{
  const f=await fixture();try{
    await f.makePaid();
    const database=new Database(join(f.root,'geod-payments.sqlite'));
    try{database.prepare('UPDATE geod_credit_lots SET remaining_nano=100000000 WHERE account=?').run('geod-alice');}finally{database.close();}
    const first={generationId:randomUUID(),model:'deepseek-flash',billingScope:'hosted',state:'reserved'},second={...first,generationId:randomUUID()};
    for(const generation of [first,second]){
      f.generations.set('geod-alice:'+generation.generationId,generation);
      await f.ledger.reserveGeneration('geod-alice',generation.generationId,null,{inputTokens:5000,maxOutputTokens:1000});
    }
    Object.assign(first,{state:'settled',inputTokens:25000,cachedInputTokens:0,outputTokens:100,reasoningTokens:0});
    const last=await f.ledger.settleGeneration('geod-alice',first.generationId);
    assert.equal(last.chargeNanoCny,'64000000');assert.equal(last.waivedNanoCny,'37600000');
    const held=f.ledger.summary('geod-alice');assert.equal(held.balanceNanoCny,'36000000');assert.equal(held.reservedNanoCny,'36000000');assert.equal(held.availableNanoCny,'0');
    Object.assign(second,{state:'settled',inputTokens:10000,cachedInputTokens:8000,outputTokens:100,reasoningTokens:0});
    assert.equal((await f.ledger.settleGeneration('geod-alice',second.generationId)).chargeNanoCny,'10240000');
    assert.equal(f.ledger.summary('geod-alice').availableNanoCny,'25760000');
    const third={...first,generationId:randomUUID(),state:'reserved'};f.generations.set('geod-alice:'+third.generationId,third);
    await f.ledger.reserveGeneration('geod-alice',third.generationId,null,{inputTokens:5000,maxOutputTokens:1000});
    third.state='failed';assert.equal((await f.ledger.settleGeneration('geod-alice',third.generationId)).state,'released');
    assert.equal(f.ledger.summary('geod-alice').availableNanoCny,'25760000');assert.equal(f.ledger.summary('geod-alice').reservationCount,0);
  }finally{await f.close();}
});

test('stopping new grants preserves existing gift wallets and continues model settlement',async()=>{
  const h=await host();try{
    await h.request('/v1/payments/wallet');await h.restart({GEOD_AGENT_WELCOME_CREDITS:'0'});
    const status=(await h.request('/v1/payments/status')).data;assert.equal(status.billingMode,'prepaid');assert.equal(status.welcomeCreditEnabled,false);
    assert.equal((await h.generate()).data.billing.chargeNanoCny,'10240000');
    assert.equal((await h.request('/v1/payments/wallet')).data.availableNanoCny,'19989760000');
    const other=(await h.request('/v1/payments/wallet',{token:h.other})).data;assert.equal(other.availableNanoCny,'0');assert.deepEqual(other.grants,[]);
  }finally{await h.close();}
});

test('lost provider responses retain gift reservations; confirmed rejections release them',async()=>{
  const h=await host();try{
    h.upstream='lost';const lost=await h.generate();assert.equal(lost.data.billing.state,'waiting-for-provider');
    const held=(await h.request('/v1/payments/wallet')).data;assert(BigInt(held.reservedNanoCny)>0n);assert.equal(held.balanceNanoCny,'20000000000');
    h.upstream='reject';assert.equal((await h.generate()).status,502);
    await h.restart();const wallet=(await h.request('/v1/payments/wallet')).data;assert.equal(wallet.reservedNanoCny,held.reservedNanoCny);assert.equal(wallet.balanceNanoCny,'20000000000');assert.equal(wallet.grants.length,1);
  }finally{await h.close();}
});

test('server policy validation retains unlimited testing and cannot silently change the same grant version',async()=>{
  assert.equal(readWelcomeCreditPolicy({}, {quotaEnforced:false}),null);
  assert.equal(readWelcomeCreditPolicy({GEOD_AGENT_WELCOME_CREDITS:'0'}, {quotaEnforced:true}),null);
  for(const value of ['-1','1.5','1e5','999999999','20,000',''])assert.throws(()=>readWelcomeCreditPolicy({GEOD_AGENT_WELCOME_CREDITS:value},{quotaEnforced:true}),{code:'WELCOME_CREDIT_CONFIG_INVALID'});
  assert.throws(()=>readWelcomeCreditPolicy({GEOD_AGENT_WELCOME_CREDITS:'20000'},{quotaEnforced:false}),{code:'WELCOME_CREDIT_CONFIG_INVALID'});
  const root=mkdtempSync(join(tmpdir(),'geod-welcome-policy-')),path=join(root,'wallet.sqlite');
  const options={loadGeneration:()=>null,welcomeCredit:{policyId:'welcome-v1',creditNanoCny:'20000000000'}};
  try{
    const first=createPaymentLedgerCandidate(path,options);first.grantWelcome('account');first.close();
    assert.throws(()=>createPaymentLedgerCandidate(path,{...options,welcomeCredit:{...options.welcomeCredit,creditNanoCny:'40000000000'}}),{code:'WELCOME_CREDIT_POLICY_CONFLICT'});
    const changed=createPaymentLedgerCandidate(path,{...options,welcomeCredit:{policyId:'welcome-v2',creditNanoCny:'40000000000'}});
    try{assert.equal(changed.grantWelcome('account').replayed,true);assert.equal(changed.summary('account').balanceNanoCny,'20000000000');assert.equal(changed.grantWelcome('new-account').creditNanoCny,'40000000000');}finally{changed.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('grant and wallet lot roll back together after a database failure',()=>{
  const root=mkdtempSync(join(tmpdir(),'geod-welcome-rollback-')),path=join(root,'wallet.sqlite');
  const ledger=createPaymentLedgerCandidate(path,{loadGeneration:()=>null,welcomeCredit:{policyId:'welcome-v1',creditNanoCny:'20000000000'}});
  const db=new Database(path);
  try{
    db.exec("CREATE TRIGGER reject_grant BEFORE INSERT ON geod_credit_grants BEGIN SELECT RAISE(ABORT,'isolated interruption'); END");
    assert.throws(()=>ledger.grantWelcome('new-account'));assert.equal(ledger.summary('new-account').balanceNanoCny,'0');assert.deepEqual(ledger.summary('new-account').grants,[]);
    db.exec('DROP TRIGGER reject_grant');assert.equal(ledger.grantWelcome('new-account').replayed,false);assert.equal(ledger.summary('new-account').balanceNanoCny,'20000000000');
  }finally{db.close();ledger.close();rmSync(root,{recursive:true,force:true});}
});

test('independent gateway processes race safely on the same persisted grant',async()=>{
  const root=mkdtempSync(join(tmpdir(),'geod-welcome-process-')),path=join(root,'wallet.sqlite');
  const init=createPaymentLedgerCandidate(path,{loadGeneration:()=>null,welcomeCredit:{policyId:'welcome-v1',creditNanoCny:'20000000000'}});init.close();
  try{
    const run=()=>new Promise((resolve,reject)=>{
      const child=fork(new URL('./helpers/welcome-credit-child.mjs',import.meta.url),[path],{stdio:['ignore','ignore','pipe','ipc']});
      let result,errors='';child.stderr.on('data',data=>{errors+=data;});child.on('message',message=>{result=message;});child.on('error',reject);child.on('exit',code=>code===0?resolve(result):reject(new Error(errors||'Grant child failed')));
    });
    const results=await Promise.all(Array.from({length:4},run));assert.equal(results.filter(result=>result.replayed===false).length,1);
    const ledger=createPaymentLedgerCandidate(path,{loadGeneration:()=>null,welcomeCredit:{policyId:'welcome-v1',creditNanoCny:'20000000000'}});
    try{assert.equal(ledger.summary('shared-account').balanceNanoCny,'20000000000');assert.equal(ledger.summary('shared-account').grants.length,1);}finally{ledger.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('existing funded wallets do not receive a first-user grant',async()=>{
  const f=await fixture();let ledger;
  try{
    await f.makePaid();
    ledger=createPaymentLedgerCandidate(join(f.root,'geod-payments.sqlite'),{...f.options,welcomeCredit:{policyId:'welcome-v1',creditNanoCny:'20000000000'}});
    assert.equal(ledger.grantWelcome('geod-alice').state,'existing-wallet');
    assert.equal(ledger.summary('geod-alice').balanceNanoCny,'10000000000');assert.deepEqual(ledger.summary('geod-alice').grants,[]);
  }finally{ledger?.close();await f.close();}
});

test('gifts survive adding checkout, spend before paid credit, and never become cash-refund orders',async()=>{
  const f=await fixture(),path=join(f.root,'gift-upgrade.sqlite'),welcomeCredit={policyId:'welcome-v1',creditNanoCny:'20000000000'};
  let ledger=createPaymentLedgerCandidate(path,{loadGeneration:f.options.loadGeneration,welcomeCredit});
  try{
    ledger.grantWelcome('gift-account');ledger.close();
    ledger=createPaymentLedgerCandidate(path,{...f.options,welcomeCredit});assert.equal(ledger.grantWelcome('gift-account').replayed,true);
    const order=ledger.createOrder('gift-account','paid-after-gift','ai-credit-10');
    f.trades.set(order.orderId,{out_trade_no:order.orderId,trade_no:'202610040000000000009999',total_amount:'10.00',trade_status:'TRADE_SUCCESS'});
    ledger.handleNotify(f.notification(order));
    const generation={generationId:'gift-first-generation',model:'deepseek-flash',billingScope:'hosted',state:'reserved'};
    f.generations.set('gift-account:'+generation.generationId,generation);
    await ledger.reserveGeneration('gift-account',generation.generationId,'1000000000');
    Object.assign(generation,{state:'settled',inputTokens:10000,cachedInputTokens:8000,outputTokens:100,reasoningTokens:0});
    assert.equal((await ledger.settleGeneration('gift-account',generation.generationId)).chargeNanoCny,'10240000');
    assert.equal(ledger.summary('gift-account').grants[0].remainingNanoCny,'19989760000');
    assert.equal((await ledger.refundOrder('gift-account',order.orderId)).status,'refunded');
    assert.equal(ledger.summary('gift-account').balanceNanoCny,'19989760000');
    await assert.rejects(ledger.refundOrder('gift-account','GDCW'+randomBytes(32).toString('hex')),{code:'PAYMENT_ORDER_NOT_FOUND'});
  }finally{ledger.close();await f.close();}
});

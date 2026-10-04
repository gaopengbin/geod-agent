import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createPaymentLedgerCandidate} from '../payment-ledger-candidate.mjs';
import {createPaymentCandidateHandler} from '../payment-http-candidate.mjs';
import {createGatewayServer,readConfig} from '../server.mjs';
import {csvField,decimalAmount} from '../credit-history.mjs';

async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'geod-credit-history-')),path=join(root,'credits.sqlite'),generations=new Map();
  let at=1_800_000_000_000,ledger;
  const options={welcomeCredit:{policyId:'isolated-history-v1',creditNanoCny:'20000000000'},loadGeneration:(account,id)=>generations.get(account+':'+id),now:()=>at};
  const open=()=>{ledger=createPaymentLedgerCandidate(path,options);for(const account of ['alice','bob'])ledger.grantWelcome(account);};open();
  const handler=()=>createPaymentCandidateHandler({ledger,authenticate:req=>req.headers.authorization==='Bearer isolated-alice'?'alice':req.headers.authorization==='Bearer isolated-bob'?'bob':null});
  const server=http.createServer((req,res)=>handler()(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const request=(route,{token='isolated-alice',method='GET'}={})=>fetch(origin+route,{method,headers:{authorization:token?'Bearer '+token:'','content-type':'application/json'}});
  async function generation(id,{account='alice',pending=false}={}){
    const value={generationId:id,state:'reserved',model:'deepseek-flash',billingScope:'hosted'};generations.set(account+':'+id,value);
    await ledger.reserveGeneration(account,id,'100000000');
    if(!pending){Object.assign(value,{state:'settled',inputTokens:10000,cachedInputTokens:8000,outputTokens:100,reasoningTokens:10});await ledger.settleGeneration(account,id);}
    return value;
  }
  return {root,path,request,generation,get ledger(){return ledger;},set at(value){at=value;},restart(){ledger.close();open();},async close(){await new Promise(resolve=>server.close(resolve));ledger.close();assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('geod-credit-history-'));rmSync(root,{recursive:true,force:true});}};
}

test('history exceeds 100 rows with timestamp ties, stable inserts and restart-safe account-bound cursors',async()=>{
  const f=await fixture();try{
    for(let i=0;i<137;i++)await f.generation('history-'+String(i).padStart(3,'0'));
    await f.generation('bob-private',{account:'bob'});
    assert.equal(f.ledger.summary('alice').charges.length,100);
    const first=f.ledger.history('alice','usage',{limit:20});assert.equal(first.totalCount,137);
    const ids=first.items.map(i=>i.generationId);
    f.at=1_799_000_000_000;await f.generation('later-insert-older-time');f.at=1_801_000_000_000;await f.generation('later-insert-newer-time');f.restart();
    let cursor=first.nextCursor;
    while(cursor){const page=f.ledger.history('alice','usage',{cursor,limit:20});assert.equal(page.totalCount,137);assert.equal(page.asOf,first.asOf);ids.push(...page.items.map(i=>i.generationId));cursor=page.nextCursor;}
    assert.equal(ids.length,137);assert.equal(new Set(ids).size,137);assert.deepEqual(ids,[...ids].sort().reverse());
    assert(!JSON.stringify(ids).includes('bob-private'));assert(!JSON.stringify(first).includes('alice'));
    assert.equal(f.ledger.history('alice','usage').totalCount,139);
  }finally{await f.close();}
});
test('date filters use inclusive start/exclusive end, and reservations show only unresolved holds',async()=>{
  const f=await fixture();try{
    for(const at of [100,200,300]){f.at=at;await f.generation('date-'+at);}
    assert.deepEqual(f.ledger.history('alice','usage',{from:200,to:300}).items.map(i=>i.generationId),['date-200']);
    f.at=250;const held=await f.generation('pending',{pending:true});const failed=await f.generation('failed',{pending:true});
    failed.state='failed';await f.ledger.settleGeneration('alice','failed');
    const page=f.ledger.history('alice','reservations',{from:200,to:300});assert.equal(page.totalCount,1);assert.equal(page.items[0].generationId,held.generationId);
    const exportData=f.ledger.statement('alice','reservations',{from:200,to:300});try{assert.equal(exportData.count,1);assert.match([...exportData.chunks()].join(''),/"reserved_credits"/);assert(![...exportData.chunks()].join('').includes('failed'));}finally{exportData.close();}
  }finally{await f.close();}
});
test('HTTP rejects cursor tampering, cross-account reuse and changed date or kind terms',async()=>{
  const f=await fixture();try{
    for(let i=0;i<3;i++)await f.generation('cursor-'+i);
    const first=await (await f.request('/v1/payments/history/usage?limit=1')).json(),cursor=encodeURIComponent(first.nextCursor);
    for(const [route,token] of [[`usage?cursor=${cursor}`,'isolated-bob'],[`reservations?cursor=${cursor}`,'isolated-alice'],[`usage?from=1&cursor=${cursor}`,'isolated-alice'],[`usage?cursor=x${cursor}`,'isolated-alice']]){
      const res=await f.request('/v1/payments/history/'+route,{token});assert.equal(res.status,400);assert.equal((await res.json()).error.code,'PAYMENT_HISTORY_INVALID');
    }
    for(const suffix of ['limit=0','limit=201','limit=1.5','from=NaN','from=-1','from=9007199254740992','from=300&to=200','to=0&from=0','limit=1&limit=2','account=bob','cursor=','filter=all']){
      assert.equal((await f.request('/v1/payments/history/usage?'+suffix)).status,400,suffix);
    }
    assert.equal((await f.request('/v1/payments/history/usage',{token:null})).status,401);
    assert.equal((await f.request('/v1/payments/history/usage/export.csv',{method:'POST'})).status,405);
    assert.equal((await f.request('/v1/payments/orders',{method:'POST'})).status,400);
  }finally{await f.close();}
});
test('CSV exports the full account-owned date range with exact Credits, original rates and a matching byte digest',async()=>{
  const f=await fixture();try{
    f.at=200;for(let i=0;i<107;i++)await f.generation('export-'+i);
    await f.generation('=SUM(1,2)');await f.generation('bob-hidden',{account:'bob'});f.at=100;await f.generation('out-of-range');
    const res=await f.request('/v1/payments/history/usage/export.csv?from=200&to=300'),data=Buffer.from(await res.arrayBuffer());
    assert.equal(res.status,200);assert.equal(res.headers.get('content-type'),'text/csv;charset=utf-8');assert.equal(res.headers.get('cache-control'),'no-store');
    assert.equal(res.headers.get('x-geod-record-count'),'108');assert.equal(Number(res.headers.get('content-length')),data.length);
    assert.equal(res.headers.get('x-geod-statement-sha256'),createHash('sha256').update(data).digest('hex'));
    const csv=data.toString('utf8');assert(csv.startsWith('\ufeff'));assert.equal(csv.split('\r\n').length,110);
    assert(csv.includes('"\'=SUM(1,2)"'));assert.match(csv.split('\r\n')[1],/"10.24","0.01024"/);assert.match(csv.split('\r\n')[1],/"4000","80","16000"/);
    assert(!csv.includes('bob-hidden'));assert(!csv.includes('out-of-range'));assert(!csv.includes('alice'));assert(!csv.includes('providerNanoCny'));
    assert.equal((await f.request('/v1/payments/history/usage/export.csv?cursor=any')).status,400);
  }finally{await f.close();}
});
test('an export holds its own consistent snapshot while writers continue and release does not leak readers',async()=>{
  const f=await fixture();try{
    await f.generation('before');const report=f.ledger.statement('alice','usage');
    try{await f.generation('during');const csv=[...report.chunks()].join('');assert.equal(report.count,1);assert(csv.includes('before'));assert(!csv.includes('during'));assert.equal(createHash('sha256').update(csv).digest('hex'),report.sha256);}finally{report.close();report.close();}
    const next=f.ledger.statement('alice','usage');try{assert.equal(next.count,2);}finally{next.close();}
  }finally{await f.close();}
});
test('spreadsheet cells escape formulas, delimiters, quotes and line breaks without rounding credit fractions',()=>{
  for(const value of ['=1+1',' +SUM(1,2)','-1','@SUM(A1)','\tformula','\nformula'])assert(csvField(value).startsWith('"\''));
  assert.equal(csvField('a,"b"\nc'),'"a,""b""\nc"');assert.equal(decimalAmount('1',6),'0.000001');assert.equal(decimalAmount('20000000000',6),'20000');
});
test('the real credit-only gateway advertises history, keeps authentication and checkout boundaries, and unlimited mode stays distinct',async()=>{
  const root=mkdtempSync(join(tmpdir(),'geod-credit-history-host-'));
  const base=readConfig({GEOD_AGENT_GATEWAY_SECRET:'a'.repeat(64),DEEPSEEK_API_KEY:'isolated',GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:41000',DEEPSEEK_BASE_URL:'http://127.0.0.1:41001',GEOD_AGENT_DB_PATH:join(root,'model.sqlite')});
  const fetchImpl=async()=>Response.json({active:{userId:'isolated-credit-history',clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60000}});
  for(const unlimited of [false,true]){
    const server=createGatewayServer({...base,dbPath:join(root,unlimited?'unlimited.sqlite':'wallet.sqlite'),...(unlimited?{quotaEnforced:false,welcomeCredit:null}:{})},{fetchImpl});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const origin=`http://127.0.0.1:${server.address().port}`,request=path=>fetch(origin+path,{headers:{authorization:'Bearer '+'a'.repeat(43)}});
      const status=await (await request('/v1/payments/status')).json();assert.equal(status.creditHistoryEnabled,!unlimited);assert.equal(status.checkoutEnabled,false);
      const res=await request('/v1/payments/history/usage');assert.equal(res.status,unlimited?404:200);
      if(!unlimited){const data=await res.json();assert.equal(data.totalCount,0);assert.equal((await request('/v1/payments/wallet')).status,200);}
    }finally{await new Promise(resolve=>server.close(resolve));}
  }
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert(basename(root).startsWith('geod-credit-history-host-'));rmSync(root,{recursive:true,force:true});
});

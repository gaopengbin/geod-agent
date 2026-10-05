// Local signed payment protocol fixtures only; no merchant or real money.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {fixture} from './helpers/payment-fixture.mjs';

test('full orders and refunds exceed the wallet window and cursors survive restart, ties and later inserts',async()=>{
  const f=await fixture({maxDailyFen:1_000_000});try{
    const ids=[],refundIds=[];
    for(let i=0;i<137;i++){
      const order=await f.makePaid();ids.push(order.orderId);
      const result=await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}});
      assert.equal(result.status,200);assert.equal(result.data.status,'refunded');refundIds.push(result.data.refundId);
    }
    const privateOrder=await f.request('/v1/payments/orders',{method:'POST',value:{requestKey:'bob-private',productId:'ai-credit-10'},token:f.bobToken});
    assert.equal(privateOrder.status,201);
    const wallet=f.ledger.summary('geod-alice');assert.equal(wallet.orders.length,100);assert.equal(wallet.orderCount,137);assert.equal(wallet.refunds.length,100);assert.equal(wallet.refundCount,137);
    const first={orders:f.ledger.history('geod-alice','orders',{limit:20}),refunds:f.ledger.history('geod-alice','refunds',{limit:20})};
    f.clock-=86_400_000;const late=await f.makePaid();await f.request(`/v1/payments/orders/${late.orderId}/refund`,{method:'POST',value:{}});f.restart();
    for(const kind of ['orders','refunds']){
      const key=kind==='orders'?'orderId':'refundId',all=first[kind].items.map(i=>i[key]);let cursor=first[kind].nextCursor;
      while(cursor){const page=f.ledger.history('geod-alice',kind,{cursor,limit:20});assert.equal(page.totalCount,137);assert.equal(page.asOf,first[kind].asOf);all.push(...page.items.map(i=>i[key]));cursor=page.nextCursor;}
      assert.equal(new Set(all).size,137);assert.deepEqual(all,(kind==='orders'?ids:refundIds).sort().reverse());
      assert(!JSON.stringify(first[kind]).includes('geod-alice'));assert(!all.includes(privateOrder.data.orderId));assert(!all.includes(late.orderId));
      assert.equal(f.ledger.history('geod-alice',kind).totalCount,138);
    }
    assert(f.calls.every(call=>call.appSignatureValid));
  }finally{await f.close();}
});

test('cash HTTP history remains account-bound, authenticated and read-only with strict date and cursor contracts',async()=>{
  const f=await fixture();try{
    const start=f.clock;
    for(let i=0;i<3;i++){const order=await f.makePaid();await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}});f.clock+=100;}
    const before=f.ledger.summary('geod-alice'),calls=f.calls.length;
    for(const kind of ['orders','refunds']){
      const one=await f.request(`/v1/payments/history/${kind}?from=${start+100}&to=${start+200}`);assert.equal(one.status,200);assert.equal(one.data.totalCount,1);assert.equal(one.data.items[0].createdAt,start+100);
      const first=await f.request(`/v1/payments/history/${kind}?limit=1`),cursor=encodeURIComponent(first.data.nextCursor);
      for(const [route,token] of [[`${kind}?cursor=${cursor}`,f.bobToken],[`${kind==='orders'?'refunds':'orders'}?cursor=${cursor}`,f.aliceToken],[`usage?cursor=${cursor}`,f.aliceToken],[`${kind}?from=1&cursor=${cursor}`,f.aliceToken],[`${kind}?cursor=x${cursor}`,f.aliceToken]]){
        const res=await f.request('/v1/payments/history/'+route,{token});assert.equal(res.status,400);assert.equal(res.data.error.code,'PAYMENT_HISTORY_INVALID');
      }
      for(const suffix of ['limit=0','limit=201','limit=1&limit=2','account=geod-bob','from=-1','to=0&from=0','status=refunded','cursor='])assert.equal((await f.request(`/v1/payments/history/${kind}?${suffix}`)).status,400,suffix);
      assert.equal((await f.request(`/v1/payments/history/${kind}`,{token:null})).status,401);
      assert.equal((await f.request(`/v1/payments/history/${kind}/export.csv`,{method:'POST'})).status,405);
      assert.equal((await f.request(`/v1/payments/history/${kind}/export.csv?limit=1`)).status,400);
      assert.equal((await f.request(`/v1/payments/history/${kind}`,{token:f.bobToken})).data.totalCount,0);
    }
    assert.deepEqual(f.ledger.summary('geod-alice'),before);assert.equal(f.calls.length,calls,'Reads never call the cash provider');
  }finally{await f.close();}
});

test('cash CSV holds one WAL snapshot with exact fen, safe cells, dates and no provider identifiers',async()=>{
  const f=await fixture();try{
    const order=await f.makePaid();await f.request(`/v1/payments/orders/${order.orderId}/refund`,{method:'POST',value:{}});
    const writer=new Database(join(f.root,'geod-payments.sqlite'));
    try{
      const product={...order.product,name:'=SUM(1,2)'};
      writer.prepare('UPDATE geod_payment_orders SET product=?,amount_fen=1,credit_nano=10000000 WHERE id=?').run(JSON.stringify(product),order.orderId);
      writer.prepare('UPDATE geod_cash_refunds SET amount_fen=1 WHERE order_id=?').run(order.orderId);
      for(const kind of ['orders','refunds']){
        const report=f.ledger.statement('geod-alice',kind);
        try{
          writer.prepare(`UPDATE ${kind==='orders'?'geod_payment_orders':'geod_cash_refunds'} SET status='uncertain' WHERE account=?`).run('geod-alice');
          const csv=[...report.chunks()].join('');assert.equal(report.count,1);assert(csv.startsWith('\ufeff'));assert.match(csv,/"1","0.01"/);assert(csv.includes('"refunded"'));assert(!csv.includes('uncertain'));
          assert.equal(createHash('sha256').update(csv).digest('hex'),report.sha256);assert.equal(Buffer.byteLength(csv),report.bytes);
          assert(!csv.includes('geod-alice'));assert(!csv.includes('trade_no'));assert(!csv.includes('request_key'));assert(!csv.includes('seller_id'));
          if(kind==='orders'){assert(csv.includes('"\'=SUM(1,2)"'));assert.match(csv,/"10","refunded"/);}
          else{assert(csv.includes('created_at_utc'));assert(csv.includes('updated_at_utc'));}
        }finally{report.close();report.close();}
      }
    }finally{writer.close();}
  }finally{await f.close();}
});

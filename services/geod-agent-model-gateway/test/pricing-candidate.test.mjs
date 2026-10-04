import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settledQuote,createPricingPreview,pricingCandidate } from '../pricing-candidate.mjs';
const generation={generationId:'request-1',model:'deepseek-flash',state:'settled',inputTokens:1000000,cachedInputTokens:900000,outputTokens:10000,reasoningTokens:8000};
test('Cache and reasoning counters are subsets, amounts have no minimum call charge',()=>{
 assert.equal(pricingCandidate.active,false);const quote=settledQuote(generation,'offPeak');assert.equal(quote.providerNanoCny,'158000000');assert.equal(quote.retailNanoCny,'632000000');
 assert.equal(settledQuote({...generation,inputTokens:1,cachedInputTokens:1,outputTokens:0,reasoningTokens:0},'peak').retailNanoCny,'80');
 assert.equal(settledQuote({...generation,cachedInputTokens:null},'peak').status,'unpriced');assert.equal(settledQuote({...generation,state:'failed'},'peak').status,'unpriced');
 assert.throws(()=>settledQuote({...generation,cachedInputTokens:1000001},'peak'));assert.throws(()=>settledQuote(generation,'guess'));
});
test('Local preview survives restart, settles once and refunds a failed whole task once',()=>{
 const root=mkdtempSync(join(tmpdir(),'geod-pricing-test-')),path=join(root,'preview.sqlite');let store=createPricingPreview(path);
 try{store.credit('account',10000000000n);store.settle('account','task',generation,'peak');store.close();store=createPricingPreview(path);
  assert.equal(store.settle('account','task',generation,'peak').replayed,true);assert.equal(store.balance('account'),'9368000000');
  assert.throws(()=>store.settle('account','other-task',generation,'peak'));assert.equal(store.refundFailedTask('account','task','failed').refundNanoCny,'632000000');assert.equal(store.refundFailedTask('account','task','failed').refundNanoCny,'0');assert.equal(store.balance('account'),'10000000000');assert.equal(store.receipts('account')[0].provider_nano,316000000);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

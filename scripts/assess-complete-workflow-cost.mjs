// Full real-model tasks, checked against native gateway settlements. No payment activation.
import { readFileSync,writeFileSync,mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { settledQuote,pricingCandidate,createPricingPreview,cny } from '../services/geod-agent-model-gateway/pricing-candidate.mjs';
const base=new URL('../docs/implementation/evidence/',import.meta.url);
const settlements=JSON.parse(readFileSync(new URL('local-gateway-usage-2026-10-02.json',base),'utf8')).records;
const ledger=new Map(settlements.map(row=>[row.generation_id,row]));
const files=['batch-agent-model-2026-10-02.json','gpkg-agent-download-2026-10-02.json','postgis-agent-download-2026-10-02.json','online-agent-download-2026-10-02.json','failed-agent-download-2026-10-02.json'];
const previewPath=join(mkdtempSync(join(tmpdir(),'geod-billing-preview-')),'preview.sqlite');
const preview=createPricingPreview(previewPath);preview.credit('local-trial',10000000000n);
const scenarios=[];
for(const file of files){
 const record=JSON.parse(readFileSync(new URL(file,base),'utf8'));
 const generations=[...new Map(record.generations.map(g=>[g.generationId,g])).values()];
 let off=0n,peak=0n,coldPeak=0n,retail=0n,input=0,cache=0,output=0;
 for(const g of generations){
  const saved=ledger.get(g.generationId);assert(saved,'Missing actual settlement');assert.equal(saved.state,'settled');assert.equal(saved.input_tokens,g.inputTokens);assert.equal(saved.output_tokens,g.outputTokens);assert.equal(saved.cached_input_tokens,g.result.usage.cachedInputTokens);
  const usage={...g,cachedInputTokens:saved.cached_input_tokens,reasoningTokens:saved.reasoning_tokens};
  const offQuote=settledQuote(usage,'offPeak'),peakQuote=settledQuote(usage,'peak'),coldQuote=settledQuote({...usage,cachedInputTokens:0},'peak');assert.equal(offQuote.status,'priced');
  off+=BigInt(offQuote.providerNanoCny);peak+=BigInt(peakQuote.providerNanoCny);coldPeak+=BigInt(coldQuote.providerNanoCny);retail+=BigInt(offQuote.retailNanoCny);
  input+=g.inputTokens;cache+=usage.cachedInputTokens;output+=g.outputTokens;
  preview.settle('local-trial',file,usage,'offPeak');assert.equal(preview.settle('local-trial',file,usage,'offPeak').replayed,true);
 }
 let refunded=0n;
 if(record.declaredLocalFaultFixture){
  assert.equal(record.expectedFailureVerified,true);assert.equal(record.jobs.length,1);assert.equal(record.jobs[0].state,'failed');
  const failedEvent=record.jobFacts[0].events.find(event=>event.state==='failed'||event.code==='SOURCE_TEMPORARY'||event.errorCode==='SOURCE_TEMPORARY');
  assert(failedEvent,'Native terminal failure evidence required');
  refunded=BigInt(preview.refundFailedTask('local-trial',file,record.jobs[0].state).refundNanoCny);assert.equal(refunded,retail);
  assert.equal(preview.refundFailedTask('local-trial',file,'failed').refundNanoCny,'0');
 }
 const first=generations[0],last=generations.at(-1);
 scenarios.push({scenario:file,acceptancePass:record.pass,taskOutcome:record.declaredLocalFaultFixture?'failed':'completed',declaredLocalFaultFixture:!!record.declaredLocalFaultFixture,modelRequests:generations.length,inputTokens:input,cachedInputTokens:cache,outputTokens:output,cacheRate:cache/input,modelSeconds:(Date.parse(last.updatedAt)-Date.parse(first.createdAt))/1000,estimatedOffPeakCny:cny(off),estimatedPeakCny:cny(peak),allCacheMissPeakStressCny:cny(coldPeak),candidateRetailBeforeRefundCny:cny(retail),refundCny:cny(refunded),candidateRetailCny:cny(retail-refunded),nativeJobs:record.jobs.map(job=>({jobId:job.jobId,state:job.state})),toolCalls:record.trace.length,toolFailures:record.trace.filter(t=>t.output?.error||t.output?.result?.error).map(t=>({tool:t.name,error:t.output.error??t.output.result.error}))});
}
const previewReport={active:preview.active,creditedCny:10,balanceCny:cny(preview.balance('local-trial')),receiptCount:preview.receipts('local-trial').length,duplicateCharges:0,databasePath:previewPath};preview.close();
const report={date:'2026-10-02',candidateVersion:pricingCandidate.version,priceSource:pricingCandidate.priceSource,subscriptionCandidate:{monthlyCny:29,includedAiCreditCny:10},retailRatesCnyPerMillion:{cachedInput:.08,uncachedInput:4,output:16},scenarios,preview:previewReport,outcomeEvidence:{normalCompleted:4,normalTested:4,intentionalFaultDetected:1,intentionalFaultTested:1,productionFailureRate:null},limits:['Provider cost is an estimate using public rates, not an invoice. Both peak and off-peak shown; no holiday calendar assumption.','Four successful small tasks and warm shared model prefix; not a representative failure rate or production p95.','Intentional HTTP503 failure is separate from normal task samples; never report it as a 20% production failure rate.','Failed whole-task AI credit refunded once using native terminal failure evidence; supplier cost retained.','No production payment, quota or wallet changes. Local conversion, download and scheduler monitoring do not consume model tokens.']};
writeFileSync(new URL('complete-workflow-cost-2026-10-02.json',base),JSON.stringify(report,null,2));
console.log(JSON.stringify({scenarios:scenarios.map(({scenario,modelRequests,estimatedOffPeakCny,estimatedPeakCny,allCacheMissPeakStressCny,candidateRetailCny})=>({scenario,modelRequests,estimatedOffPeakCny,estimatedPeakCny,allCacheMissPeakStressCny,candidateRetailCny})),preview:previewReport},null,2));

// Isolated test process. Configuration and generated fixture keys arrive over
// stdin, never through argv, environment variables or a persisted key file.
import {createInterface} from 'node:readline';
import {createAlipayPaymentCandidate} from '../../alipay-payment-candidate.mjs';
import {createPaymentLedgerCandidate} from '../../payment-ledger-candidate.mjs';
let ledger;const generations=new Map();
for await(const line of createInterface({input:process.stdin})){
  const request=JSON.parse(line);
  try{
    let result;
    if(request.method==='initialize'){
      if(request.config.environment!=='fixture')throw new Error('Only isolated fixture configuration is accepted');
      const gateway=createAlipayPaymentCandidate(request.config);
      ledger=createPaymentLedgerCandidate(request.path,{gateway,maxDailyFen:100000,loadGeneration:async(account,id)=>generations.get(account+':'+id)});
      result={ready:true,pid:process.pid};
    }else if(request.method==='generation'){
      generations.set(request.account+':'+request.generation.generationId,request.generation);result={stored:true};
    }else if(request.method==='wallet')result=ledger.summary(request.account);
    else if(request.method==='reserve')result=await ledger.reserveGeneration(request.account,request.generationId,request.maximum);
    else if(request.method==='settle')result=await ledger.settleGeneration(request.account,request.generationId);
    else if(request.method==='refund')result=await ledger.refundOrder(request.account,request.orderId);
    else throw new Error('Unknown fixture command');
    process.stdout.write(JSON.stringify({id:request.id,result})+'\n');
  }catch(error){process.stdout.write(JSON.stringify({id:request.id,error:{code:error.code??'FIXTURE_ERROR',message:error.code?error.message:'Fixture operation failed'}})+'\n');}
}
ledger?.close();

// Explicit operator repair for historic unusable model responses. Provider
// usage remains unknown; this is a customer waiver, never invented zero usage.
import Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export function waiveUnusableResults(db,{userId,generationIds,operator,evidence,apply=false}){
 if(typeof userId!=='string'||!Array.isArray(generationIds)||!generationIds.length||generationIds.length>100||new Set(generationIds).size!==generationIds.length||!generationIds.every(id=>typeof id==='string'&&id.length<160)||typeof operator!=='string'||operator.length<2||typeof evidence!=='string'||evidence.length<32||evidence.length>2000)throw Error('Explicit account, generation IDs, operator and review evidence required');
 return db.transaction(()=>{
  const results=[];
  for(const id of generationIds){
   const row=db.prepare('SELECT * FROM model_generations WHERE user_id=? AND generation_id=?').get(userId,id);
   if(!row)throw Error('Generation not found');
   const replay=row.state==='failed'&&row.error_code==='UNUSABLE_RESULT_WAIVED';
   if(!replay&&(row.state!=='pending_reconcile'||!['UPSTREAM_INVALID_TOOL','UPSTREAM_MALFORMED'].includes(row.error_code)||row.response_ciphertext))throw Error('Only undispatched unusable protocol results can be waived');
   if(db.prepare('SELECT 1 FROM wallet.geod_credit_charges WHERE account=? AND generation_id=?').get(userId,id))throw Error('Charged generations need a separate reviewed refund');
   const hold=db.prepare('SELECT state,maximum_nano FROM wallet.geod_credit_reservations WHERE account=? AND generation_id=?').get(userId,id);
   if(hold&&!['reserved','released'].includes(hold.state))throw Error('Unexpected wallet reservation state');
   if(apply){
    const now=new Date().toISOString();
    if(!replay){
     db.prepare("UPDATE model_generations SET state='failed',error_code='UNUSABLE_RESULT_WAIVED',updated_at=? WHERE user_id=? AND generation_id=?").run(now,userId,id);
     if(!db.prepare("SELECT 1 FROM usage_ledger WHERE user_id=? AND generation_id=? AND kind='release'").get(userId,id))db.prepare("INSERT INTO usage_ledger VALUES(?,?,?,'release',?,?)").run(randomUUID(),userId,id,-row.reserved_tokens,now);
     db.prepare("INSERT INTO reconciliation_audit VALUES(?,?,?,'waive_unusable_result',?,?,?)").run(randomUUID(),userId,id,JSON.stringify({evidence,originalError:row.error_code,providerUsage:'unknown',customerCharge:0}),operator,now);
    }
    db.prepare("UPDATE wallet.geod_credit_reservations SET state='released' WHERE account=? AND generation_id=? AND state='reserved'").run(userId,id);
   }
   results.push({generationId:id,replayed:replay,previousError:row.error_code,customerCharge:0,providerUsage:'unknown',holdNanoCny:hold?.maximum_nano??0,reservationState:apply?'released':hold?.state??null});
  }
  return {applied:apply,results};
 }).immediate();
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const decision=JSON.parse(readFileSync(0,'utf8'));const model=resolve(decision.modelDb),wallet=resolve(decision.walletDb),db=new Database(model);
 try{
  db.prepare('ATTACH DATABASE ? AS wallet').run(wallet);
  if(decision.apply){
   if(!decision.backupDirectory)throw Error('Backup directory required');
   const backup=resolve(decision.backupDirectory);mkdirSync(backup,{recursive:true});
   if(existsSync(resolve(backup,'agent-model.sqlite'))||existsSync(resolve(backup,'credits.sqlite')))throw Error('Use a new backup directory; existing evidence is never overwritten');
   await db.backup(resolve(backup,'agent-model.sqlite'));
   const w=new Database(wallet,{readonly:true});try{await w.backup(resolve(backup,'credits.sqlite'));}finally{w.close();}
  }
  console.log(JSON.stringify(waiveUnusableResults(db,decision)));
 }finally{db.close();}
}

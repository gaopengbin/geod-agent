// Local operator report only: never publishes account identifiers through the API.
import Database from 'better-sqlite3';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readWelcomeRecipientLimit} from './welcome-credit-policy.mjs';
import {csvField,decimalAmount} from './credit-history.mjs';

export function welcomeCreditReport(path,{limit=100}={}){
  limit=readWelcomeRecipientLimit(limit);
  const db=new Database(resolve(path),{readonly:true,fileMustExist:true});
  try{
    db.pragma('query_only = ON');db.exec('BEGIN');
    const grants=db.prepare(`SELECT g.account,g.policy_id AS policyId,g.lot_id AS grantId,g.amount_nano AS amount,
      l.remaining_nano AS remaining,g.created_at AS createdAt FROM geod_credit_grants g
      JOIN geod_credit_lots l ON l.id=g.lot_id WHERE g.kind='welcome' ORDER BY g.created_at,g.account`).all()
      .map(r=>({...r,amount:String(r.amount),remaining:String(r.remaining),credits:decimalAmount(r.amount,6),createdAtUtc:new Date(r.createdAt).toISOString()}));
    const decisions=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='geod_welcome_decisions'").get()
      ?db.prepare(`SELECT account,policy_id AS policyId,state,amount_nano AS amount,recipient_limit AS recipientLimit,
        issued_count AS issuedCount,created_at AS createdAt FROM geod_welcome_decisions ORDER BY created_at,account,state`).all()
        .map(r=>({...r,amount:String(r.amount),credits:decimalAmount(r.amount,6),createdAtUtc:new Date(r.createdAt).toISOString()})):[];
    return {limit,issued:grants.length,remaining:Math.max(0,limit-grants.length),grants,decisions};
  }finally{if(db.inTransaction)db.exec('ROLLBACK');db.close();}
}
export function welcomeCreditCsv(report){
  const rows=report.decisions.length?report.decisions:report.grants.map(g=>({...g,state:'granted',recipientLimit:null,issuedCount:null}));
  return '\ufeff'+[['account','policy_id','state','credits','recipient_limit','issued_count','created_at_utc'],
    ...rows.map(r=>[r.account,r.policyId,r.state,r.credits,r.recipientLimit??'',r.issuedCount??'',r.createdAtUtc])]
    .map(row=>row.map(csvField).join(',')).join('\r\n')+'\r\n';
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const [path,...options]=process.argv.slice(2);
  if(!path||options.some(x=>!['--csv'].includes(x)))throw new Error('Usage: node welcome-credit-report.mjs <wallet.sqlite> [--csv]');
  const report=welcomeCreditReport(path,{limit:process.env.GEOD_AGENT_WELCOME_MAX_RECIPIENTS??100});
  process.stdout.write(options.includes('--csv')?welcomeCreditCsv(report):JSON.stringify(report,null,2)+'\n');
}

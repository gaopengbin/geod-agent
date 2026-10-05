// Executed with Docker --network none; imports only the extracted release files.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {cpSync,mkdirSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

for(const kind of ['old','new']){
 const target='/tmp/gateway-'+kind;mkdirSync(target);
 const unpack=spawnSync('tar',['-xzf','/inputs/'+kind+'.tar.gz','-C',target]);
 assert.equal(unpack.status,0,'The verified release archive must unpack');
}
const service=kind=>'/tmp/gateway-'+kind+'/services/geod-agent-model-gateway/';
const Database=createRequire(pathToFileURL(service('new')+'package.json'))('better-sqlite3');
const data='/tmp/migration-data';mkdirSync(data);
for(const name of ['agent-model.sqlite','agent-model.sqlite-credits.sqlite'])cpSync('/inputs/snapshots/'+name,data+'/'+name);
const names=['agent-model.sqlite','agent-model.sqlite-credits.sqlite'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const encode=value=>Buffer.isBuffer(value)?{binarySha256:hash(value)}:value;

function snapshot(){
 const result={};
 for(const name of names){
  const db=new Database(data+'/'+name,{readonly:true});
  assert.equal(db.pragma('quick_check',{simple:true}),'ok');
  const tables={};
  for(const {name:table} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()){
   const columns=db.prepare('PRAGMA table_info('+quote(table)+')').all().map(c=>c.name);
   const rows=db.prepare('SELECT * FROM '+quote(table)).raw().all().map(row=>JSON.stringify(row.map(encode))).sort();
   tables[table]={columns,rows};
  }
  result[name]=tables;db.close();
 }
 return result;
}
const before=snapshot();
const credits=new Database(data+'/agent-model.sqlite-credits.sqlite',{readonly:true});
const accounts=credits.prepare('SELECT DISTINCT account FROM geod_credit_grants').all();
assert.equal(accounts.length,1,'Select the existing granted account without creating a new one');
const account=accounts[0].account;
const grantCount=credits.prepare('SELECT COUNT(*) n FROM geod_credit_grants').get().n;
const amount=String(credits.prepare('SELECT SUM(remaining_nano) n FROM geod_credit_lots WHERE account=?').get(account).n);
const usageCount=credits.prepare('SELECT COUNT(*) n FROM geod_credit_charges WHERE account=?').get(account).n;
const reservationCount=credits.prepare("SELECT COUNT(*) n FROM geod_credit_reservations WHERE account=? AND state='reserved'").get(account).n;
credits.close();
const token=randomBytes(32).toString('base64url');let identityRequests=0;
const fixtureFetch=async(url,options)=>{
 assert(url.endsWith('/api/geod/oauth/introspect'),'Model and provider calls are forbidden in migration checks');
 identityRequests++;
 const active=JSON.parse(options.body).token===token?{userId:account,clientId:'geod-agent-desktop',scope:'geod:agent',expiresAt:Date.now()+60_000}:null;
 return Response.json({active});
};
const stages=[];

function verifyPreserved(label){
 const changes={};
 for(const name of names){
  const db=new Database(data+'/'+name,{readonly:true});assert.equal(db.pragma('quick_check',{simple:true}),'ok');
  changes[name]={};
  for(const [table,spec] of Object.entries(before[name])){
   const columns=db.prepare('PRAGMA table_info('+quote(table)+')').all().map(row=>row.name);
   assert(spec.columns.every(c=>columns.includes(c)),'Legacy columns must survive '+label);
   const rows=db.prepare('SELECT '+spec.columns.map(quote).join(',')+' FROM '+quote(table)).raw().all().map(row=>JSON.stringify(row.map(encode))).sort();
   const added=rows.length-spec.rows.length;
   if(table==='geod_payment_meta'){
    for(const old of spec.rows)assert(rows.includes(old),'Original payment metadata must survive '+label);
    const extra=rows.filter(row=>!spec.rows.includes(row));
    assert.equal(extra.length,1,'Only one history cursor key may be added');
    const [key,value]=JSON.parse(extra[0]);
    assert(key==='credit-history-cursor-key'&&/^[0-9a-f]{64}$/.test(value),'No other payment metadata may be added');
   }else{
    assert.equal(hash(JSON.stringify(rows)),hash(JSON.stringify(spec.rows)),
      'All original rows and multiplicities must remain unchanged in '+table+' during '+label);
   }
   changes[name][table]={originalRows:spec.rows.length,retained:true,addedRows:added};
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM '+quote(name===names[0]?'model_generations':'geod_credit_grants')).get().n,
      before[name][name===names[0]?'model_generations':'geod_credit_grants'].rows.length);
  db.close();
 }
 return changes;
}

for(const [label,kind] of [['upgrade','new'],['rollback','old'],['upgrade-again','new']]){
 const {createGatewayServer,readConfig}=await import(pathToFileURL(service(kind)+'server.mjs'));
 const config=readConfig({GEOD_AGENT_GATEWAY_SECRET:randomBytes(32).toString('hex'),DEEPSEEK_API_KEY:'fixture-never-sent',
  GEOD_IDENTITY_ORIGIN:'http://127.0.0.1:1',GEOD_AGENT_DB_PATH:data+'/agent-model.sqlite',GEOD_AGENT_TOKEN_LIMIT:'200000',
  GEOD_AGENT_QUOTA_MODE:'enforced',GEOD_AGENT_WELCOME_CREDITS:'20000',GEOD_AGENT_WELCOME_POLICY_ID:'geod-agent-welcome-v1'});
 const server=createGatewayServer(config,{fetchImpl:fixtureFetch});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 const request=(path,authenticated=true)=>fetch(origin+path,{headers:authenticated?{authorization:'Bearer '+token}:{}});
 try{
  const status=await (await request('/v1/payments/status')).json();assert.equal(status.checkoutEnabled,false);
  for(let repeat=0;repeat<3;repeat++){
   const wallet=await (await request('/v1/payments/wallet')).json();
   assert.equal(wallet.balanceNanoCny,amount,'Credits must retain the original post-settlement balance');
   assert.equal(wallet.charges.length,usageCount);assert.equal(wallet.reservations.length,reservationCount);
  }
  const counts={usage:usageCount,reservations:reservationCount,orders:0,refunds:0},exports={};
  if(kind==='new'){
   assert.equal(status.creditHistoryEnabled,true);assert.equal(status.paymentHistoryEnabled,true);
   for(const [type,count] of Object.entries(counts)){
    const route='/v1/payments/history/'+type;
    const response=await request(route+'?limit=20');assert.equal(response.status,200);
    const page=await response.json();assert.equal(page.totalCount,count);assert.equal(page.items.length,count);
    assert.equal((await request(route,false)).status,401);
    const csv=await request(route+'/export.csv'),bytes=Buffer.from(await csv.arrayBuffer());
    assert.equal(csv.status,200);assert.equal(Number(csv.headers.get('x-geod-record-count')),count);
    assert.equal(Number(csv.headers.get('content-length')),bytes.length);assert.equal(csv.headers.get('x-geod-statement-sha256'),hash(bytes));
    assert(bytes.toString('utf8').startsWith('\ufeff'));assert(!bytes.toString('utf8').includes(account));
    exports[type]={records:count,bytes:bytes.length,sha256:hash(bytes)};
   }
  }else{
   const unavailable=await request('/v1/payments/history/usage');
   assert([404,409].includes(unavailable.status),'Old gateway must honestly refuse newer history routes');
  }
  stages.push({name:label,release:kind==='new'?'0.2.2':'0.2.1',cashEnabled:false,exports});
 }finally{
  server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));
 }
 stages.at(-1).preservation=verifyPreserved(label);
}
const final=snapshot();
assert.equal(final[names[1]].geod_credit_grants.rows.length,grantCount);
console.log(JSON.stringify({passed:true,actualExtractedArchives:true,stages,originalGrants:grantCount,
 retainedModelRequests:before[names[0]].model_generations.rows.length,retainedTokenEntries:before[names[0]].usage_ledger.rows.length,
 originalCashRows:before[names[1]].geod_payment_orders.rows.length,
 welcomeGrantRepeated:false,balancePreserved:true,legacyRowsPreserved:true,productionModified:false,
 identityRequests,identityAdapter:'local fixture over existing account in private snapshot',
 originalEncryptedResultsReplayed:false,productionEncryptionSecretUsed:false,publicNetworkUsed:false,realFundsUsed:false}));

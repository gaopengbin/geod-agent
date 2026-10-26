import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

test('native provider worker consumes rejection bodies and preserves safe diagnostics without response text',async()=>{
 const base=await realpath(tmpdir()),dir=await realpath(await mkdtemp(join(base,'geod-provider-worker-')));
 assert.equal(dirname(dir),base);assert(basename(dir).startsWith('geod-provider-worker-'));
 let child;
 try{
  await copyFile(new URL('../src-tauri/provider-worker.mjs',import.meta.url),join(dir,'provider-worker.mjs'));
  const protocol=new URL('../../../packages/codex-protocol/',import.meta.url);
  for(const name of await readdir(protocol))if(name.endsWith('.mjs')&&!name.endsWith('.test.mjs'))await copyFile(new URL(name,protocol),join(dir,name));
  child=spawn(process.execPath,[join(dir,'provider-worker.mjs')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const lines=createInterface({input:child.stdout});let stderr='';child.stderr.on('data',b=>stderr+=b);
  const result=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('worker timed out')),5000);
   lines.on('line',line=>{const value=JSON.parse(line);if(value.type==='http'){
    send({type:'headers',status:402,contentType:'application/json',safeHeaders:{'x-request-id':'req_native_402'}});
    send({type:'chunk',data:Buffer.from(JSON.stringify({error:{code:'pre_consume_token_quota_failed',message:'token quota pre-consume failed; private response text'}})).toString('base64')});send({type:'end'});
   }else if(value.type==='failed'){clearTimeout(timer);resolve(value);}});
   child.on('exit',code=>{if(code) {clearTimeout(timer);reject(Error(stderr||'worker exited'));}});
  });
  send({type:'start',generationId:'qa-generation',snapshot:{id:'qa',protocol:'responses',baseUrl:'https://example.test/v1',model:'qa-model',credentialRef:'native',contextWindow:128000,maxOutputTokens:8192},request:{input:[{role:'user',content:'private request text'}],tools:[]}});
  const failed=await result;
  assert.equal(failed.status,402);assert.equal(failed.diagnostic.requestId,'req_native_402');
  assert.equal(failed.diagnostic.bodyFormat,'json');assert.equal(failed.diagnostic.billing.issue,'precharge_rejected');
  assert.equal(failed.diagnostic.billing.scope,'api_key');
  assert(!JSON.stringify(failed).includes('private'));assert(!JSON.stringify(failed).includes('native-managed'));
 }finally{child?.kill();await rm(dir,{recursive:true,force:true});}
});

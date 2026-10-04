import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';

const root=resolve('artifacts/product-gaps-20261004/user-verification');
const home=join(root,`probe-${randomUUID()}`);
mkdirSync(home,{recursive:true});
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('CODEX_')&&!key.startsWith('GEOD_')));
const child=spawn(resolve('apps/geod-agent-desktop/src-tauri/resources/codex/codex.exe'),['app-server','--stdio'],{
  cwd:home,env:{...environment,CODEX_HOME:home,CODEX_SQLITE_HOME:join(home,'sqlite')},windowsHide:true,stdio:['pipe','pipe','pipe']
});
let id=0;
const pending=new Map();
createInterface({input:child.stdout}).on('line',line=>{
  let value;try{value=JSON.parse(line);}catch{return;}
  if(value.id!==undefined&&!value.method){const callback=pending.get(value.id);if(callback){pending.delete(value.id);callback(value);}}
});
child.stderr.resume();
const rpc=(method,params)=>new Promise((resolve,reject)=>{
  const requestId=++id;
  const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`${method} timed out`));},15000);
  pending.set(requestId,value=>{clearTimeout(timer);resolve(value);});
  child.stdin.write(JSON.stringify({id:requestId,method,params})+'\n');
});
try{
  const initialize=await rpc('initialize',{clientInfo:{name:'geod_user_verification_probe',version:'0.2.0'},capabilities:{experimentalApi:true}});
  if(initialize.error)throw new Error(initialize.error.message);
  child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
  const status=await rpc('userVerification/status',{});
  // Readiness only: never enroll, delete credentials, or prompt Windows Hello.
  const result={at:new Date().toISOString(),binary:'Codex 0.159.2',initialize:initialize.result,status:status.result??null,error:status.error??null,readinessOnly:true};
  writeFileSync(join(root,'actual-platform-status.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{
  child.stdin.end();
  await Promise.race([new Promise(resolve=>child.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,3000))]);
  if(child.exitCode===null)child.kill();
}

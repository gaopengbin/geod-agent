/** Real stdio MCP process for cwd/environment/deadline acceptance. */
import fs from 'node:fs';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
const context=JSON.parse(fs.readFileSync('context.json','utf8'));
const audit=event=>fs.appendFileSync(process.env.QA_AUDIT_FILE,JSON.stringify({...event,pid:process.pid,at:Date.now()})+'\n');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tools=['read_context','slow_read','excluded','outside'].map(name=>({name,description:name==='read_context'?'Read the actual installed plugin context and native runtime evidence':'Acceptance fixture tool',inputSchema:{type:'object',properties:{},additionalProperties:false}}));
audit({type:'started',cwd:process.cwd()});
readline.createInterface({input:process.stdin}).on('line',async line=>{
 let request;try{request=JSON.parse(line);}catch{return;}
 audit({type:'request',method:request.method,tool:request.params?.name});
 if(request.id===undefined)return;
 let result;
 if(request.method==='initialize'){
  await sleep(Number(process.env.QA_INIT_DELAY??0));
  result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'geod-runtime-stdio-qa',version:'1.0.0'}};
 }else if(request.method==='tools/list'){
  await sleep(Number(process.env.QA_LIST_DELAY??0));result={tools};
 }else if(request.method==='tools/call'){
  if(request.params.name==='slow_read')await sleep(650);
  result={content:[{type:'text',text:JSON.stringify({marker:context.marker,cwd:process.cwd(),inheritedVariable:Boolean(process.env.USERNAME)&&createHash('sha256').update(process.env.USERNAME).digest('hex')===context.expectedUserHash,explicitEnvOverride:process.env.TEMP===context.expectedTemp,bridgeVisible:Boolean(process.env.GEOD_CODEX_BRIDGE_TOKEN)})}]};
 }else result={};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});

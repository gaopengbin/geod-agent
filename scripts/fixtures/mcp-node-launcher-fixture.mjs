#!/usr/bin/env node
/** Actual offline npm-bin MCP fixture, including one owned Node descendant. */
import fs from 'node:fs';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
const context=JSON.parse(fs.readFileSync(process.env.QA_CONTEXT_FILE,'utf8'));
const audit=event=>fs.appendFileSync(process.env.QA_AUDIT_FILE,JSON.stringify({...event,pid:process.pid,at:Date.now()})+'\n');
const child=spawn('node',['-e','console.log(JSON.stringify({execPath:process.execPath,nodeVersion:process.version,pid:process.pid}));setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore'],windowsHide:true});
const descendant=await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',data=>resolve(JSON.parse(data.toString())));});
const evidence={marker:context.marker,execPath:process.execPath,nodeVersion:process.version,argv:process.argv.slice(2),cwd:process.cwd(),descendant,bridgeVisible:Boolean(process.env.GEOD_CODEX_BRIDGE_TOKEN)};
audit({type:'started',...evidence});
const tools=[{name:'read_context',description:'Read actual application-local Node/npm launch and independent context evidence',inputSchema:{type:'object',properties:{},additionalProperties:false}}];
readline.createInterface({input:process.stdin}).on('line',line=>{
 let request;try{request=JSON.parse(line);}catch{return;}
 audit({type:'request',method:request.method,tool:request.params?.name});if(request.id===undefined)return;
 const result=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'geod-node-launcher-qa',version:'1.0.0'}}:request.method==='tools/list'?{tools}:request.method==='tools/call'?{content:[{type:'text',text:JSON.stringify(evidence)}]}:{};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});

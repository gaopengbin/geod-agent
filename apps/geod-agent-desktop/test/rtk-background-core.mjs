// Real standalone background command, real scheduled Core turn, fixture provider.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {join,resolve} from 'node:path';
import {createHost} from '../src-tauri/codex-host.mjs';
const output=resolve('../../artifacts/rtk-20261007');mkdirSync(output,{recursive:true});
const root=mkdtempSync(join(output,'background-')),binary=join(root,'binary'),workspace=join(root,'workspace');mkdirSync(binary);mkdirSync(workspace);mkdirSync(join(workspace,'src'));
const p=JSON.parse(readFileSync(resolve('../../vendor/rtk-runtime.json'),'utf8'));
execFileSync('python',['-X','utf8',resolve('src-tauri/src/rtk_extract.py'),resolve('../../.dev-cache/rtk-0.40.0.zip'),binary,p.executableMember,String(p.executableBytes),p.executableSha256],{windowsHide:true});
const profile=join(root,'profile');for(const dir of ['','temp','appdata','localappdata'])mkdirSync(join(profile,dir),{recursive:true});const settingsFile=join(root,'settings.json');writeFileSync(settingsFile,'{"enabled":true}');
for(let file=0;file<6;file++)writeFileSync(join(workspace,'src',`file${file}.txt`),Array.from({length:40},(_,i)=>`background_match_${i}: actual background output line with deliberately long text`).join('\n'));
const command=['rg','-n','background_match','src'],codex=resolve('src-tauri/resources/codex/codex.exe');
const captured=await new Promise((resolveResult,reject)=>{
 const child=spawn(process.execPath,[resolve('src-tauri/managed-command-host.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',done=false;
 const timer=setTimeout(()=>{child.kill();reject(new Error('Background fixture timed out'));},60000);
 createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);
  if(value.type==='output'){const text=Buffer.from(value.deltaBase64??'','base64').toString('utf8');if(value.stream==='stdout')stdout+=text;else stderr+=text;}
  if(value.type==='done'){done=true;clearTimeout(timer);child.stdin.end();resolveResult({value,stdout,stderr});}
 });
 child.on('error',reject);child.on('exit',()=>{clearTimeout(timer);if(!done)reject(new Error('Background fixture exited'));});child.stderr.resume();
 child.stdin.write(JSON.stringify({type:'start',codex,home:join(root,'command-home'),workspace,cwd:workspace,id:'rtk-background-fixture',command,timeoutMs:30000})+'\n');
});
assert.equal(captured.value.result?.exitCode,0,JSON.stringify(captured.value));
const record={command,status:'completed',exitCode:0,stdout:captured.stdout||captured.value.result.stdout,stderr:captured.stderr||captured.value.result.stderr||'',outputTruncated:false,planHash:'fixture-plan-hash'};
assert(record.stdout?.includes('background_match_39'));writeFileSync(join(root,'original-record.json'),JSON.stringify(record,null,2));
let listener,round=0;const requests=[];
const host=await createHost({codex,home:join(root,'home'),toolsFile:resolve('src-tauri/codex-tools.json'),capabilities:{model:'deepseek-flash',contextWindow:128000,inputModalities:['text']},receive:fn=>{listener=fn;return()=>{};},emit:event=>{
 if(event.type==='model'){requests.push(event.request);const first=++round===1;listener({type:'response',requestId:event.requestId,value:{state:'settled',generationId:event.generationId,inputTokens:20,outputTokens:20,result:{content:first?null:'后台任务检查完成。',toolCalls:first?[{id:'bg_get',type:'function',function:{name:'mcp_call',arguments:JSON.stringify({connectorId:'builtin-background-commands',toolName:'background_command_get',arguments:{commandId:'rtk-background-fixture'}})}}]:[],finishReason:first?'tool_calls':'stop'}}});}
 if(event.type==='tool'){assert.equal(event.tool,'mcp_call');assert.equal(event.arguments.connectorId,'builtin-background-commands');listener({type:'response',requestId:event.requestId,value:{result:{connectorId:'builtin-background-commands',toolName:'background_command_get',result:record}}});}
}});
try{
 const result=await host.turn({conversationId:'rtk-background-fixture',workspace,background:true,permission:'fullAccess',input:'读取已经执行完毕的后台命令结果。',history:[],rtkOutput:{executable:join(binary,'rtk.exe'),sha256:p.executableSha256,settingsFile,profile}});
 assert.equal(result.status,'completed');assert.equal(round,2);const outputItem=requests[1].input.find(i=>i.call_id==='bg_get'&&i.type==='function_call_output');assert(outputItem);
 const summarized=JSON.parse(outputItem.output).result;assert(summarized.stdoutSummarized);assert.equal(summarized.exitCode,record.exitCode);assert.deepEqual(summarized.command,command);assert.equal(summarized.stderr,record.stderr);
 const sessions=join(root,'home','sessions'),rollout=readdirSync(sessions,{recursive:true}).find(n=>String(n).endsWith('.jsonl'));const rows=readFileSync(join(sessions,rollout),'utf8').trim().split('\n').map(line=>JSON.parse(line));const raw=rows.find(r=>r.type==='response_item'&&r.payload.call_id==='bg_get'&&r.payload.type==='function_call_output')?.payload.output;
 assert.equal(JSON.parse(raw).result.stdout,record.stdout);assert.equal(JSON.parse(readFileSync(join(root,'original-record.json'),'utf8')).stdout,record.stdout);
 const report={passed:true,realStandaloneCommand:true,realScheduledCoreTurn:true,realRtk:true,rawRecordPreserved:true,argvPreserved:true,stderrPreserved:true,exitCode:0,originalChars:record.stdout.length,summaryChars:summarized.stdout.length,characterReductionPercent:Math.round(1000*(1-summarized.stdout.length/record.stdout.length))/10,paidModelCalls:0};writeFileSync(join(output,'background-core-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await host.close();}

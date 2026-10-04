/** Actual local MCP process for lifecycle acceptance; no model responses here. */
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const log=process.env.QA_MCP_LOG,controlFile=process.env.QA_MCP_CONTROL;
if(!log||!controlFile)throw new Error('QA fixture paths are required');
const record=value=>fs.appendFileSync(log,JSON.stringify({...value,pid:process.pid,at:new Date().toISOString()})+'\n');
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
record({type:'started',descendantPid:descendant.pid,execPath:process.execPath,bridgeVisible:Boolean(process.env.GEOD_CODEX_BRIDGE_TOKEN)});
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
createInterface({input:process.stdin}).on('line',async line=>{
 let message;try{message=JSON.parse(line);}catch{return;}
 if(message.id===undefined)return;
 if(message.method==='initialize'){reply(message.id,{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'actual-native-hook-fixture',version:'1.0.0'}});return;}
 if(message.method==='tools/list'){reply(message.id,{tools:[{name:'record_hook',description:'Record a real lifecycle event and return its actual context',inputSchema:{type:'object',properties:{event:{type:'string'},cwd:{type:'string'},prompt:{type:'string'},toolInput:{type:'object'},nested:{type:'object'}},required:['event','cwd']},annotations:{readOnlyHint:true}}]});return;}
 if(message.method==='tools/call'){
  const args=message.params.arguments,control=JSON.parse(fs.readFileSync(controlFile,'utf8'));
  record({type:'called',tool:message.params.name,arguments:args});
  if(message.params.name!=='record_hook'){reply(message.id,{isError:true,content:[{type:'text',text:'Unknown fixture tool'}]});return;}
  if(control.mode==='require-user'){
   reply(message.id,{isError:true,content:[{type:'text',text:'MCP_USER_REQUIRED: Actual fixture requires foreground authorization'}]});return;
  }
  if(control.mode==='slow'&&args.event==='UserPromptSubmit')await new Promise(resolve=>setTimeout(resolve,5000));
  const output=['SessionStart','UserPromptSubmit'].includes(args.event)?{hookSpecificOutput:{hookEventName:args.event,additionalContext:'Actual native MCP automation marker: '+control.marker+'. Read this actual tool result when asked for the verification marker.'}}:{};
  reply(message.id,{content:[{type:'text',text:JSON.stringify(output)}]});record({type:'completed',event:args.event});return;
 }
 reply(message.id,{});
});

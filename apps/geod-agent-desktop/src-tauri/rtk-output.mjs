// Only filter captured stdout. Never execute, rewrite, or approve a command.
import {spawn} from 'node:child_process';
import {readFile,stat,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,basename,resolve} from 'node:path';

export const RTK_OUTPUT_POLICY='Successful supported command outputs may be summarized locally by RTK before reaching the model. A summary is marked explicitly; original captured stdout, stderr, command arguments, truncation markers and exit codes remain in the local execution history. Failed commands, structured data and unsupported output remain unchanged. Do not assume omitted details; use the original local log or a narrower command when exact output is required. RTK does not reduce model-generated reasoning and does not change usage accounting.';
const MAX_BYTES=1_000_000,MIN_CHARS=600;
function json(text){try{return JSON.parse(text);}catch{return null;}}
export function filterFor(command){
  let value=Array.isArray(command)?command.join(' '):String(command??'');
  // Simple shell wrappers are recognized without evaluating their contents.
  value=value.replace(/^\s*(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:(?:-NoProfile|-NonInteractive)\s+)*-(?:Command|c)\s+/i,'').replace(/^\s*(?:cmd(?:\.exe)?)\s+\/c\s+/i,'');
  value=value.trim().replace(/^(?:"([^"]*)"|'([^']*)')$/,(_,a,b)=>a??b);
  if(/[;&|\n\r`]|\$\(/.test(value))return null;
  const tokens=value.match(/"[^"]*"|'[^']*'|\S+/g)?.map(t=>t.replace(/^['"]|['"]$/g,''))??[];
  const program=basename(tokens[0]??'').replace(/\.exe$/i,'').toLowerCase();
  if(program==='git'){
    // Only accept flags with known arity before the subcommand.
    let i=1;while(i<tokens.length&&tokens[i].startsWith('-')){if(tokens[i]==='-C')i+=2;else if(tokens[i]==='--no-pager')i++;else return null;}
    return {status:'git-status',diff:'git-diff',log:'git-log'}[tokens[i]]??null;
  }
  if(program==='rg'||program==='grep')return tokens.includes('--json')?null:'grep';
  if(program==='fd'||program==='find'&&process.platform!=='win32')return 'find';
  if(program==='cargo'&&tokens[1]==='test')return 'cargo-test';
  if(program==='pytest'||program==='python'&&tokens[1]==='-m'&&tokens[2]==='pytest')return 'pytest';
  if(program==='go'&&tokens[1]==='test')return 'go-test';
  if(program==='go'&&tokens[1]==='build')return 'go-build';
  if(program==='tsc'||program==='npx'&&tokens[1]==='tsc')return 'tsc';
  if(program==='mypy')return 'mypy';
  if(program==='ruff'&&['check','format'].includes(tokens[1]))return 'ruff-'+tokens[1];
  if(program==='prettier'||program==='npx'&&tokens[1]==='prettier')return 'prettier';
  return null;
}
async function validRuntime(runtime){
  if(!runtime?.executable||!runtime.settingsFile||!runtime.profile||!/^[a-f0-9]{64}$/.test(runtime.sha256??''))return false;
  try{
    if(json(await readFile(runtime.settingsFile,'utf8'))?.enabled!==true)return false;
    for(const path of [runtime.executable,runtime.settingsFile,runtime.profile]){
      const info=await lstat(path);if(info.isSymbolicLink())return false;
      if(resolve(await realpath(path)).toLowerCase()!==resolve(path).toLowerCase())return false;
    }
    if(!(await stat(runtime.executable)).isFile())return false;
    return createHash('sha256').update(await readFile(runtime.executable)).digest('hex')===runtime.sha256;
  }catch{return false;}
}
function pipe(runtime,filter,input){return new Promise(resolveResult=>{
  const environment={};for(const name of ['SYSTEMROOT','WINDIR'])if(process.env[name])environment[name]=process.env[name];
  Object.assign(environment,{HOME:runtime.profile,USERPROFILE:runtime.profile,APPDATA:join(runtime.profile,'appdata'),LOCALAPPDATA:join(runtime.profile,'localappdata'),TEMP:join(runtime.profile,'temp'),TMP:join(runtime.profile,'temp'),XDG_CONFIG_HOME:join(runtime.profile,'config'),XDG_DATA_HOME:join(runtime.profile,'data'),XDG_STATE_HOME:join(runtime.profile,'state')});
  let child;try{child=spawn(runtime.executable,['pipe','--filter',filter],{cwd:runtime.profile,env:environment,windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});}catch{resolveResult(null);return;}
  let stdout='',bytes=0,settled=false;
  const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolveResult(value);};
  const timer=setTimeout(()=>{child.kill();finish(null);},1500);timer.unref?.();
  child.stdout.setEncoding('utf8');child.on('error',()=>finish(null));child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>MAX_BYTES){child.kill();finish(null);}else stdout+=chunk;});
  child.stderr.resume();child.stdin.on('error',()=>{});child.on('close',code=>finish(code===0?stdout:null));child.stdin.end(input);
});}
export function createOutputCompactor(runtime){
  const cache=new Map();
  async function compact(stdout,command,exitCode){
    const filter=filterFor(command);if(exitCode!==0||typeof stdout!=='string'||stdout.length<MIN_CHARS||Buffer.byteLength(stdout)>MAX_BYTES||!filter||/^\s*[\[{]/.test(stdout)||json(stdout)!==null)return stdout;
    if(!await validRuntime(runtime))return stdout;
    const key=createHash('sha256').update(filter+'\0'+stdout).digest('hex');if(cache.has(key))return cache.get(key);
    let filtered=await pipe(runtime,filter,stdout);if(!filtered?.trim()||filtered.length>=stdout.length)return stdout;
    const warnings=stdout.split(/\r?\n/).filter(line=>/\b(?:warn(?:ing)?|error|fatal|panic|failed|deprecated)\b|警告|错误|失败/i.test(line));
    const missing=warnings.filter(line=>!filtered.includes(line));if(missing.length)filtered+='\nPreserved diagnostics:\n'+missing.join('\n');
    const result=`[RTK summary: ${filter}; original stdout retained in local execution history]\n${filtered}`;
    if(result.length>=stdout.length)return stdout;
    if(cache.size>=64)cache.delete(cache.keys().next().value);cache.set(key,result);return result;
  }
  async function record(value){
    if(!value||typeof value!=='object')return value;
    if(Array.isArray(value.command)&&typeof value.stdout==='string'&&value.exitCode===0&&['completed','succeeded'].includes(value.status)){
      const stdout=await compact(value.stdout,value.command,value.exitCode);
      return stdout===value.stdout?value:{...value,stdout,stdoutSummarized:true,stdoutOriginalChars:value.stdout.length};
    }
    // Known GeoD dynamic tool result envelope. No generic recursive JSON mutation.
    if(value.result&&typeof value.result==='object'){const next=await record(value.result);return next===value.result?value:{...value,result:next};}
    return value;
  }
  async function request(value){
    if(!runtime||!Array.isArray(value?.input))return value;
    const calls=new Map(),sessions=new Map();let changed=false;const input=[];
    for(const item of value.input){
      if(['function_call','custom_tool_call'].includes(item.type))calls.set(item.call_id,{name:item.name?.split('.').at(-1),args:json(item.arguments??item.input)??{}});
      if(!['function_call_output','custom_tool_call_output'].includes(item.type)||typeof item.output!=='string'){input.push(item);continue;}
      const call=calls.get(item.call_id);let output=item.output;
      if(call&&['exec_command','write_stdin'].includes(call.name)){
        const running=output.match(/Process running with session ID (\d+)/i);
        const command=call.name==='exec_command'?call.args.cmd:sessions.get(Number(call.args.session_id));
        if(running&&command)sessions.set(Number(running[1]),command);
        const completed=output.match(/Process exited with code (\d+)/i),marker=/^(?:Final output|Output):\r?\n/m.exec(output);
        if(completed&&marker&&command){const end=marker.index+marker[0].length;output=output.slice(0,end)+await compact(output.slice(end),command,Number(completed[1]));}
      }else if(call&&(['background_command_get','background_command_start','background_command_stop'].includes(call.name)||call.name==='mcp_call'&&call.args.connectorId==='builtin-background-commands'&&['background_command_get','background_command_start','background_command_stop'].includes(call.args.toolName))){
        const parsed=json(output);if(parsed){const next=await record(parsed);if(next!==parsed)output=JSON.stringify(next);}
      }
      if(output!==item.output){changed=true;input.push({...item,output});}else input.push(item);
    }
    return changed?{...value,input}:value;
  }
  return {compact,record,request};
}

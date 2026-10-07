import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createOutputCompactor,filterFor} from '../src-tauri/rtk-output.mjs';

const artifacts=resolve('../../artifacts/rtk-20261007');mkdirSync(artifacts,{recursive:true});
const catalog=JSON.parse(readFileSync(resolve('../../vendor/rtk-runtime.json'),'utf8'));
const archive=resolve('../../.dev-cache/rtk-0.40.0.zip');
assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'),catalog.sha256);
const root=mkdtempSync(join(artifacts,'fixture-')),extracted=join(root,'binary');mkdirSync(extracted);
execFileSync('python',['-X','utf8',resolve('src-tauri/src/rtk_extract.py'),archive,extracted,catalog.executableMember,String(catalog.executableBytes),catalog.executableSha256],{windowsHide:true});
const runtime={executable:join(extracted,'rtk.exe'),sha256:catalog.executableSha256,settingsFile:join(root,'settings.json'),profile:join(root,'profile')};
for(const p of ['','temp','appdata','localappdata'])mkdirSync(join(runtime.profile,p),{recursive:true});
const stdout=Array.from({length:150},(_,i)=>`src/file${Math.floor(i/25)}.ts:${i+1}: export const value${i} = 'a fairly long matching source code line for ${i}';`).join('\n')+'\nwarning: fixture warning must stay visible\n';
writeFileSync(runtime.settingsFile,JSON.stringify({enabled:true}));
const compactor=createOutputCompactor(runtime);

test('only supported unambiguous commands select stdin filters',()=>{
 assert.equal(filterFor('git --no-pager diff'),'git-diff');assert.equal(filterFor('git -C "some folder" status'),'git-status');
 assert.equal(filterFor(['powershell.exe','-NoProfile','-Command','rg -n something src']),'grep');
 for(const value of ['gdalinfo input.tif','node script.mjs','rtk git log','rg --json text src','rg text; Remove-Item file','git diff | node transform','python -c dangerous'])assert.equal(filterFor(value),null);
});
test('real pinned RTK reduces stdout and preserves diagnostics',async()=>{
 const output=await compactor.compact(stdout,'rg -n value src',0);assert(output.startsWith('[RTK summary: grep;'));assert(output.includes('warning: fixture warning must stay visible'));assert(output.length<stdout.length);
 writeFileSync(join(artifacts,'filter-report.json'),JSON.stringify({passed:true,realRtk:true,version:catalog.version,originalChars:stdout.length,summaryChars:output.length,characterReductionPercent:Math.round(1000*(1-output.length/stdout.length))/10,originalOutputPreserved:true,paidModelCalls:0},null,2));
});
test('failed commands, JSON data, unsupported commands and disabled runtime pass through',async()=>{
 assert.equal(await compactor.compact(stdout,'rg value src',1),stdout);
 assert.equal(await compactor.compact(JSON.stringify({data:stdout}),'rg value src',0),JSON.stringify({data:stdout}));
 const ndjson=Array.from({length:50},()=>JSON.stringify({data:stdout})).join('\n');assert.equal(await compactor.compact(ndjson,'rg value src',0),ndjson);
 assert.equal(await compactor.compact(stdout,'gdalinfo input.tif',0),stdout);
 writeFileSync(runtime.settingsFile,'{"enabled":false}');assert.equal(await compactor.compact(stdout,'rg value src',0),stdout);writeFileSync(runtime.settingsFile,'{"enabled":true}');
 const bad=createOutputCompactor({...runtime,sha256:'0'.repeat(64)});assert.equal(await bad.compact(stdout,'rg value src',0),stdout);
 assert.equal(await createOutputCompactor(null).compact(stdout,'rg value src',0),stdout);
});
test('wire request compacts completed exec and session output without mutating native history',async()=>{
 const raw=`Chunk ID: fixture\nWall time: 0.01 seconds\nProcess exited with code 0\nFinal output:\n${stdout}`;
 const signed={type:'reasoning',encrypted_content:'opaque-unaltered-signature'};
 const original={input:[signed,{type:'function_call',namespace:'functions',name:'exec_command',call_id:'a',arguments:'{"cmd":"rg -n value src"}'},{type:'function_call_output',call_id:'a',output:raw}]};
 const next=await compactor.request(original);assert(next.input[2].output.includes('[RTK summary'));assert.equal(original.input[2].output,raw);assert.equal(next.input[0],signed);assert.equal(next.input[1],original.input[1]);
 const running={input:[{type:'function_call',name:'exec_command',call_id:'a',arguments:'{"cmd":"rg -n value src"}'},{type:'function_call_output',call_id:'a',output:'Process running with session ID 23\nFinal output:\n'+stdout},{type:'function_call',name:'write_stdin',call_id:'b',arguments:'{"session_id":23}'},{type:'function_call_output',call_id:'b',output:raw}]};
 const session=await compactor.request(running);assert.equal(session.input[1],running.input[1]);assert(session.input[3].output.includes('[RTK summary'));
});
test('background command records retain argv, stderr, exits and raw ledger',async()=>{
 const record={command:['rg.exe','-n','value','src'],status:'completed',exitCode:0,stdout,stderr:'warning on stderr',planHash:'unchanged',outputExcerptTruncated:false};
 const original={input:[{type:'function_call',name:'background_command_get',call_id:'a',arguments:'{}'},{type:'function_call_output',call_id:'a',output:JSON.stringify(record)}]};
 const next=await compactor.request(original),value=JSON.parse(next.input[1].output);assert(value.stdoutSummarized);assert.equal(value.stderr,record.stderr);assert.deepEqual(value.command,record.command);assert.equal(value.exitCode,0);assert.equal(value.planHash,record.planHash);assert.equal(JSON.parse(original.input[1].output).stdout,stdout);
 const failed={...record,exitCode:1,status:'failed'};assert.equal(await compactor.record(failed),failed);
 const viaMcp={input:[{type:'function_call',name:'mcp_call',call_id:'b',arguments:JSON.stringify({connectorId:'builtin-background-commands',toolName:'background_command_get',arguments:{}})},{type:'function_call_output',call_id:'b',output:JSON.stringify({connectorId:'builtin-background-commands',toolName:'background_command_get',result:record})}]};
 const mcp=await compactor.request(viaMcp);assert(JSON.parse(mcp.input[1].output).result.stdoutSummarized);
});
test('filtering never evaluates shell arguments or invokes the original command',async()=>{
 const never=join(root,'never-created.txt');const cmd='rg value src; Write-Output secret > '+never;
 assert.equal(await compactor.compact(stdout,cmd,0),stdout);assert.throws(()=>readFileSync(never));
});

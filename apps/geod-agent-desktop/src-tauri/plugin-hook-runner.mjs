// Pass Codex's event input/output through unchanged; provide package-scoped paths.
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
const descriptor=JSON.parse(readFileSync(process.argv[2],'utf8'));
const variables={
  PLUGIN_ROOT:descriptor.packageRoot,PLUGIN_DATA:descriptor.dataRoot,
  CODEX_PLUGIN_ROOT:descriptor.packageRoot,CODEX_PLUGIN_DATA:descriptor.dataRoot,
  CLAUDE_PLUGIN_ROOT:descriptor.packageRoot,CLAUDE_PLUGIN_DATA:descriptor.dataRoot,
};
let command=process.platform==='win32'?(descriptor.handler.commandWindows??descriptor.handler.command_windows??descriptor.handler.command):descriptor.handler.command;
if(typeof command!=='string'||!command.trim())throw new Error('PLUGIN_HOOK_COMMAND_INVALID');
for(const [name,value]of Object.entries(variables))command=command.replaceAll('$'+'{'+name+'}',value);
const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>key!=='GEOD_CODEX_BRIDGE_TOKEN'&&!key.startsWith('CODEX_')));
const windows=process.platform==='win32';
const shell=windows?join(environment.SystemRoot??environment.SYSTEMROOT??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'):(environment.SHELL??'/bin/sh');
const args=windows?['-NoProfile','-NonInteractive','-Command',command]:['-lc',command];
const child=spawn(shell,args,{env:{...environment,...variables},cwd:process.cwd(),windowsHide:true,stdio:['pipe','pipe','pipe']});
child.stdin.on('error',error=>{if(error.code!=='EPIPE')process.stderr.write(String(error));});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
child.on('error',error=>{process.stderr.write(String(error));process.exitCode=1;});
child.on('close',code=>{process.exitCode=code??1;});

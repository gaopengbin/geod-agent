import test from 'node:test';import assert from 'node:assert/strict';import{spawn}from'node:child_process';import{existsSync,mkdtempSync,symlinkSync,rmdirSync,lstatSync,unlinkSync}from'node:fs';import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{fileURLToPath}from'node:url';
test('bundled host CLI starts through a Windows junction instead of silently exiting',{skip:process.platform!=='win32',timeout:10000},async()=>{
 const parent=mkdtempSync(join(fileURLToPath(new URL('../../../artifacts/',import.meta.url)),'geod-entry-')),alias=join(parent,'mapped-runtime');const source=resolve(fileURLToPath(new URL('../src-tauri/',import.meta.url)));symlinkSync(source,alias,'junction');
 const bundled=join(source,'resources/codex/node.exe'),node=existsSync(bundled)?bundled:process.execPath;const child=spawn(node,[join(alias,'codex-host.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',c=>stderr+=c);let code;
 const exited=new Promise(resolve=>child.once('exit',value=>{code=value;resolve(value);}));
 try{await new Promise(resolve=>setTimeout(resolve,700));assert.equal(code,undefined,stderr);child.stdin.write('{"type":"close"}\n');await exited;assert.equal(code,0,stderr);}finally{if(child.exitCode===null)child.kill();if(lstatSync(alias).isSymbolicLink())unlinkSync(alias);rmdirSync(parent);}
});

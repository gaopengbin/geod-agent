import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('host entrypoint receives native commands through a directory junction',()=>{
 const artifacts=fileURLToPath(new URL('../../../artifacts/',import.meta.url));mkdirSync(artifacts,{recursive:true});
 const temporary=mkdtempSync(join(artifacts,'geod-host-entry-'));
 const linked=join(temporary,'runtime');
 symlinkSync(fileURLToPath(new URL('../src-tauri/',import.meta.url)),linked,process.platform==='win32'?'junction':'dir');
 const result=spawnSync(process.execPath,[join(linked,'codex-host.mjs')],{
  input:JSON.stringify({type:'start',runId:'entrypoint-only',options:{}})+'\n'+JSON.stringify({type:'close'})+'\n',
  encoding:'utf8',windowsHide:true,timeout:15000,
 });
 assert.equal(result.status,0,result.stderr);
 const events=result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
 assert.equal(events.length,1);
 assert.equal(events[0].type,'failed');
 assert.equal(events[0].runId,'entrypoint-only');
 assert(events[0].error,'The command was dispatched; deliberately incomplete options fail before engine/model startup');
});

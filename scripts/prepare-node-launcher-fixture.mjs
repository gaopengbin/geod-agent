/** Install a local fixture using the bundled npm without registry access. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=path.resolve('artifacts/product-gaps-20261004/plugin-node-launchers');
const runtime=path.resolve('apps/geod-agent-desktop/src-tauri/resources/codex'),work=path.join(root,'offline workspace with spaces'),pkg=path.join(root,'fixture package with spaces'),plugin=path.join(root,'runtime plugin with spaces');
for(const folder of [root,work,pkg,plugin])fs.mkdirSync(folder,{recursive:true});
assert(!fs.existsSync(path.join(root,'restart-state.json')),'Do not replace a fixture belonging to an installed QA plugin');
fs.copyFileSync('scripts/fixtures/mcp-node-launcher-fixture.mjs',path.join(pkg,'server.mjs'));
fs.copyFileSync('scripts/fixtures/mcp-node-launcher-fixture.mjs',path.join(plugin,'server.mjs'));
fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'geod-npx-runtime-fixture',version:'1.0.0',type:'module',bin:{'geod-npx-runtime-fixture':'server.mjs'},files:['server.mjs']}));
fs.writeFileSync(path.join(work,'package.json'),JSON.stringify({name:'geod-offline-runtime-qa',version:'1.0.0',private:true}));
const npmrc=path.join(root,'empty.npmrc');fs.writeFileSync(npmrc,'');
const cache=path.join(root,'isolated npm cache'),registry='http://127.0.0.1:1/registry-must-not-be-used';
const env={...process.env,PATH:runtime+';'+process.env.SystemRoot+'\\System32',npm_config_registry:registry,npm_config_cache:cache,npm_config_userconfig:npmrc,npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'};
const installed=spawnSync(path.join(runtime,'node.exe'),[path.join(runtime,'npm/bin/npm-cli.js'),'install','--offline','--ignore-scripts','--no-audit','--no-fund','--prefix',work,pkg],{env,encoding:'utf8',windowsHide:true});
fs.writeFileSync(path.join(root,'offline-install.log'),installed.stdout+'\n'+installed.stderr);assert.equal(installed.status,0,installed.stderr);assert(fs.existsSync(path.join(work,'node_modules/.bin/geod-npx-runtime-fixture.cmd')));
const marker='NODE_RUNTIME_'+randomUUID().replaceAll('-',''),context=path.join(root,'independent context.json'),audit=path.join(root,'actual-process-audit.jsonl'),literal="qa value & literal $(ignored); 'quote'";
fs.writeFileSync(context,JSON.stringify({marker}));
const shared={QA_CONTEXT_FILE:context,QA_AUDIT_FILE:audit,npm_config_registry:registry,npm_config_cache:cache,npm_config_userconfig:npmrc,npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false'};
const settings={type:'stdio',env:shared,cwd:work,startup_timeout_sec:10,tool_timeout_sec:4,enabled_tools:['read_context']};
const servers={
 node:{...settings,command:'node',args:[path.join(pkg,'server.mjs'),'--tag',literal]},
 node_exe:{...settings,command:'node.exe',args:[path.join(pkg,'server.mjs'),'--tag',literal]},
 npx:{...settings,command:'npx',args:['--offline','--prefix',work,'geod-npx-runtime-fixture','--tag',literal]},
 npx_cmd:{...settings,command:'npx.cmd',args:['--offline','--prefix',work,'geod-npx-runtime-fixture','--tag',literal]},
 npm:{...settings,command:'npm',args:['exec','--offline','--prefix',work,'--','geod-npx-runtime-fixture','--tag',literal]},
 npm_cmd:{...settings,command:'npm.cmd',args:['exec','--offline','--prefix',work,'--','geod-npx-runtime-fixture','--tag',literal]},
};
const explicitRoot=process.env.PATH.split(path.delimiter).find(folder=>['npx.cmd','node.exe','node_modules/npm/bin/npx-cli.js'].every(name=>fs.existsSync(path.join(folder,name))));
assert(explicitRoot,'This acceptance case requires the known local Node installation');
const explicitNodeVersion=spawnSync(path.join(explicitRoot,'node.exe'),['--version'],{encoding:'utf8',windowsHide:true});assert.equal(explicitNodeVersion.status,0);
servers.explicit_npx={...settings,command:path.join(explicitRoot,'npx.cmd'),args:servers.npx.args};
fs.writeFileSync(path.join(plugin,'plugin.json'),JSON.stringify({name:'geod-node-launcher-qa',version:'1.0.0',description:'Actual offline Node/npm/npx launcher acceptance',extensions:{'com.openai':{interface:{displayName:'Node launcher acceptance'}}}}));
fs.writeFileSync(path.join(plugin,'mcp.json'),JSON.stringify({mcpServers:servers}));
const manifest=JSON.parse(fs.readFileSync(path.join(runtime,'manifest.json'),'utf8'));
for(const [name,spec] of Object.entries(manifest.files)){const file=path.join(runtime,name);assert(path.resolve(file).startsWith(runtime+path.sep));assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'),spec.sha256);}
fs.writeFileSync(path.join(root,'fixture.json'),JSON.stringify({root,runtime,work,pkg,plugin,context,audit,marker,literal,registry,servers,explicitRoot,explicitNodeVersion:explicitNodeVersion.stdout.trim(),filesVerified:Object.keys(manifest.files).length,nodeVersion:manifest.nodeVersion,npmVersion:manifest.npmVersion},null,2));
console.log(JSON.stringify({prepared:true,offlineInstall:true,filesVerified:Object.keys(manifest.files).length,nodeVersion:manifest.nodeVersion,npmVersion:manifest.npmVersion}));

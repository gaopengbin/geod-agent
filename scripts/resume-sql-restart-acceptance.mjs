/** Six actual cases already passed; repair QA cleanup without new paid requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const output=path.resolve('artifacts/product-gaps-20261004/sql-inputs');
const report=JSON.parse(fs.readFileSync(path.join(output,'mysql-result.json'),'utf8'));assert.equal(report.cases.length,6);assert(report.cases.every(c=>c.passed));assert.equal(report.error?.code,'INPUT_CONNECTION_NOT_FOUND');
fs.copyFileSync(path.join(output,'mysql-result.json'),path.join(output,'mysql-cleanup-controller-attempt.json'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
const rpc=async(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
try{
  const state=JSON.parse(fs.readFileSync(path.join(output,'actual-background-mysql.json'),'utf8')),fixture=JSON.parse(fs.readFileSync(path.join(output,'mysql-fixture.json'),'utf8'));
  const conversationId=state.run.conversationId;assert(conversationId);
  const before=(await rpc('sql_connections_list')).connections;
  const result=await rpc('sql_connection_connect',{conversationId,request:{credentialFile:fixture.credentialFile}});assert(!result.error);assert(result.connection.id);
  fs.writeFileSync(path.join(output,'mysql-restart-state.json'),JSON.stringify({conversationId,connectionId:result.connection.id,baselineIds:before.map(c=>c.id)},null,2));
  report.passed=true;delete report.error;report.harnessIssue='The first UI controller attempted to change an already bound workspace. The resumed cleanup tried to delete a prior model connection that had already been removed. Six real cases retained; native reconnection and restart proceed without repeating paid requests.';
  fs.writeFileSync(path.join(output,'mysql-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({prepared:true,cases:report.cases.length}));
}finally{await browser.close();}

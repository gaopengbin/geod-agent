/** Actual Oracle Thin PEM wallet, not a mocked TLS client. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/database-tls'),privateRoot=path.join(root,'private/oracle');
const qaFile=path.join(root,'qa-state.json'),qa=JSON.parse(fs.readFileSync(qaFile,'utf8'));
const fixture=JSON.parse(fs.readFileSync(path.join(root,'oracle-fixture.json'),'utf8'));
const draft=JSON.parse(fs.readFileSync(path.join(root,'workspace/oracle-tls.json'),'utf8'));
const secrets=[draft.password,...['ca','server','client','wrong-client'].map(name=>fs.readFileSync(path.join(privateRoot,`${name}.key`),'utf8'))];
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233'),page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));assert(page);await page.locator('.conversation-account-trigger').waitFor();
const rpc=async(command,args={})=>{const result=await page.evaluate(async({command,args})=>{try{return{ok:true,value:await window.__TAURI_INTERNALS__.invoke(command,args)};}catch(error){return{ok:false,error};}},{command,args});if(!result.ok)throw result.error;return result.value;};
const report={passed:false,cases:[]},owned=[];
const record=(name,details={})=>{report.cases.push({name,passed:true,...details});console.log(JSON.stringify({name,passed:true}));};
async function connect(name){const value=await rpc('sql_connection_save',{conversationId:qa.conversationId,draft:{...draft,...(name?{sslClientCert:fs.readFileSync(path.join(privateRoot,name+'.pem'),'utf8'),sslClientKey:fs.readFileSync(path.join(privateRoot,name+'.key'),'utf8')}:{})}});if(value.connection)owned.push(value.connection.id);return value;}
try{
  const absent=await connect();assert(!absent.connection&&absent.error);record('Oracle TCPS listener rejects a client without its required certificate',{error:absent.error});
  const valid=await connect('client');assert(!valid.error,valid.error?.code);assert(valid.connection.clientCertificate);
  const data=await rpc('sql_query',{connectionId:valid.connection.id,sql:`SELECT CITY,MARKER FROM ${fixture.table}`});assert(JSON.stringify(data).includes(fixture.marker));assert(JSON.stringify(data).includes('北京'));
  record('Actual Oracle MCP uses a PEM client wallet and reads the private-CA database',{connection:valid.connection,data});
  const wrong=await connect('wrong-client');assert(!wrong.connection&&wrong.error);record('Oracle rejects a client certificate signed by another CA',{error:wrong.error});
  qa.oracle.mutualId=valid.connection.id;report.passed=true;
}catch(error){report.error={code:error?.code,message:error?.message||String(error)};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{
  qa.owned=[...new Set([...qa.owned,...owned])];fs.writeFileSync(qaFile,JSON.stringify(qa,null,2));
  const text=JSON.stringify(report,null,2);assert(secrets.every(secret=>!text.includes(secret)));fs.writeFileSync(path.join(root,'oracle-client-native-result.json'),text);await browser.close();
}

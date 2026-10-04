/** Enter through the actual settings and database UI; leave the unsaved form. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=path.resolve('artifacts/product-gaps-20261004/database-tls');
const reportFile=path.join(root,'actual-theme-result.json');if(fs.existsSync(reportFile))fs.copyFileSync(reportFile,path.join(root,'actual-theme-attempt-'+Date.now()+'.json'));
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes(':1420'));assert(page);
const errors=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('pageerror',e=>errors.push(e.message));
try{
 await page.reload();
 await page.locator('.conversation-account-trigger').waitFor();
 await page.evaluate(async()=>{const {setLanguagePreferences}=await import('/src/i18n.ts');setLanguagePreferences({language:'en'});});
 if(await page.evaluate(()=>document.documentElement.dataset.theme)!=='light'){
  await page.locator('.conversation-account-trigger').click();await page.getByRole('button',{name:'Light appearance',exact:true}).click();
 }
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await page.setViewportSize({width:1000,height:720});
 if(!await page.getByRole('button',{name:/Add data boundary/}).count())await page.getByRole('button',{name:'Add to prompt',exact:true}).click();await page.getByRole('button',{name:/Add data boundary/}).click();
 await page.locator('.data-input-tabs').getByRole('button',{name:'Database',exact:true}).click();await page.locator('.sql-section-heading').getByRole('button',{name:'Add connection',exact:true}).click();
 const dialog=page.locator('.sql-connection-dialog');await dialog.waitFor();await dialog.getByRole('combobox',{name:'Database type',exact:true}).click();await page.getByRole('option',{name:'MySQL / MariaDB',exact:true}).click();
 await dialog.locator('label').filter({hasText:/^Connection name$/}).locator('input').fill('Unsaved TLS visual verification');
 await dialog.locator('input[type=file]').nth(0).setInputFiles(path.join(root,'private/mysql/ca.pem'));
 await dialog.getByRole('button',{name:'Client certificate · mutual TLS',exact:true}).click();
 await dialog.locator('input[type=file]').nth(1).setInputFiles(path.join(root,'private/mysql/client.pem'));await dialog.locator('input[type=file]').nth(2).setInputFiles(path.join(root,'private/mysql/client.key'));
 await dialog.getByRole('button',{name:'Client certificate · mutual TLS',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:path.join(root,'actual-mtls-settings-light-en.png')});
 const controls=await dialog.locator('button[data-variant]').evaluateAll(nodes=>nodes.filter(n=>!n.disabled&&n.offsetHeight).map(n=>{const css=getComputedStyle(n);return{text:n.textContent.trim(),color:css.color,background:css.backgroundColor};}));
 const bounds=await dialog.boundingBox();assert(bounds&&bounds.y>=0&&bounds.y+bounds.height<=721);assert(controls.every(c=>c.color!=='rgb(204, 204, 204)'),'Enabled controls use stale dark foreground values');
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Close data input',exact:true}).click();assert.equal(await page.locator('.sql-connection-dialog').count(),0);
 fs.writeFileSync(reportFile,JSON.stringify({passed:errors.length===0,cases:[{name:'Actual appearance toggle and unsaved mTLS entry keep English/light controls readable in a 1000×720 window',passed:true,controls}],rendererErrors:errors},null,2));assert.equal(errors.length,0,'Actual UI emitted errors');
 console.log(JSON.stringify({passed:true,cases:1}));
}finally{await browser.close();}

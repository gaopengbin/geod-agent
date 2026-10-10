import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const output='../../artifacts/transcript-follow-20261008';mkdirSync(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:700,height:650}});
 await page.goto('http://127.0.0.1:1420/test/chat-activity-harness.html?scroll=1');
 const viewport=page.locator('.agent-messages-viewport');
 const bottom=()=>page.waitForFunction(()=>{const e=document.querySelector('.agent-messages-viewport');return e.scrollHeight-e.scrollTop-e.clientHeight<2;});
 await page.locator('.agent-work-records-toggle').first().click().catch(async()=>{await page.locator('.agent-work-records button').first().click();});
 await page.getByTestId('writing').click();await page.getByTestId('completed').click();await bottom();
 await page.screenshot({path:output+'/completed.png'});
 // A late layout increase must keep following, even without a running turn.
 await viewport.locator('[role=log]').evaluate(e=>{const p=document.createElement('p');p.textContent='迟到的成果预览';p.style.height='480px';e.append(p);});await bottom();
 // Deliberate upward reading remains undisturbed by completion.
 const box=await viewport.boundingBox();await page.mouse.move(box.x+100,box.y+180);await page.mouse.wheel(0,-500);await page.waitForTimeout(250);
 const before=await viewport.evaluate(e=>e.scrollTop);
 await page.getByTestId('writing').click();await page.getByTestId('completed').click();await page.waitForTimeout(450);
 const after=await viewport.evaluate(e=>e.scrollTop);assert(Math.abs(after-before)<3,'completion must preserve deliberate upward reading');
 // Sending another message explicitly resumes the live edge.
 await page.getByTestId('new-turn').click();await bottom();
 writeFileSync(output+'/report.json',JSON.stringify({passed:true,completion:true,lateLayout:true,readerPosition:true,newMessage:true,modelCalls:0},null,2));
 console.log('Transcript follow checks passed');
}finally{await browser.close();}

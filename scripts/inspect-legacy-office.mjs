import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL('C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const browser=await chromium.connectOverCDP('http://127.0.0.1:9233');
const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(':1420'));
console.log(JSON.stringify(await page.evaluate(()=>({text:document.body.innerText.slice(-5000),inputs:[...document.querySelectorAll('input[type=file]')].map(input=>({accept:input.accept,disabled:input.disabled,files:[...input.files].map(file=>file.name)})),alerts:[...document.querySelectorAll('[role=alert]')].map(item=>item.textContent)}))));
await page.screenshot({path:'artifacts/product-gaps-20261004/legacy-office/current-native.png'});await browser.close();

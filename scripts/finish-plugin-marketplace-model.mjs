/** Finish checking retained actual model output without issuing another paid turn. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
const root=path.resolve("artifacts/product-gaps-20261004/plugin-marketplaces");
const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),"utf8"));
const report=read("model-result.json"),saved=read("restart-state.json"),background=read("actual-background-model.json");
assert.equal(report.cases.length,2);assert(report.cases.every(test=>test.passed));
assert.equal(background.run.scheduleId,saved.scheduleId);assert.equal(background.run.conversationId,saved.modelConversationId);
assert.equal(background.run.state,"succeeded");assert.equal(background.run.result?.status,"completed");
const answer=background.run.result.text;assert(answer.includes("portable-core")&&answer.includes("best-system")&&answer.includes("80"));
const commands=background.events.filter(event=>event.method==="item/completed"&&event.params?.item?.type==="commandExecution"&&event.params.item.command.includes("reviewops.mjs")&&event.params.item.exitCode===0);
assert(commands.length);assert(commands.some(event=>event.params.item.aggregatedOutput.includes("Status: COMPLETE")));
const {chromium}=await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const browser=await chromium.connectOverCDP("http://127.0.0.1:9233");
try{
  const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes(":1420"));assert(page);
  const value=await page.evaluate(async saved=>{
    const status=await window.__TAURI_INTERNALS__.invoke("ai_schedules_list",{conversationId:saved.modelConversationId});
    return {schedule:status.schedules.find(schedule=>schedule.scheduleId===saved.scheduleId),run:status.runs.find(run=>run.runId===saved.runId)};
  },{...saved,runId:background.run.runId});
  assert(value.schedule&&value.schedule.enabled===false);assert.equal(value.run.state,"succeeded");
  report.cases.push({name:"Actual companion scheduled AI discovers and executes the same installed plugin",passed:true,runId:background.run.runId,actualAnswer:answer,commands:commands.map(event=>event.params.item.command),disabledAfterQa:true});
  report.passed=true;report.harnessCorrection="Validated retained succeeded schedule state and completed Codex result; no model request repeated.";delete report.error;
  fs.writeFileSync(path.join(root,"model-result.json"),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,cases:report.cases.length,paidTurnsRepeated:0}));
}finally{await browser.close();}

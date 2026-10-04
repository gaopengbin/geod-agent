/** Real scheduled AI uses the same actual command/exec tools with no window. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), [playwrightModule, evidencePath, python] = process.argv.slice(2), { chromium } = await import(playwrightModule);
await fs.mkdir(evidencePath, { recursive: true });
let browser = await chromium.connectOverCDP('http://127.0.0.1:9233'), page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':1420'));
const conversationId = `commands-schedule-${crypto.randomUUID()}`, nonce = crypto.randomBytes(7).toString('hex'), report = { pass: false, cases: [] };
const rpc = async (command, args = {}) => { const result = await page.evaluate(async ({ command, args }) => { try { return { value: await window.__TAURI_INTERNALS__.invoke(command, args) }; } catch (error) { return { error }; } }, { command, args }); if (result.error) throw result.error; return result.value; };
const background = async (command, args = {}) => { const result = JSON.parse((await exec('python', ['-X', 'utf8', 'scripts/background-runtime-probe.py', 'rpc', '--command', command, '--args', JSON.stringify(args)], { windowsHide: true })).stdout); if (!result.ok) throw result.error; return result.result; };
const wait = async (check, description, timeout = 150000) => { const end = Date.now() + timeout; while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 1000)); } throw new Error(`Timeout: ${description}`); };
let scheduleId, commandId;
try {
  const idle = await rpc('background_status'); assert.equal(idle.activeDownloads, 0); assert.equal(idle.activeCommands, 0); assert.equal(idle.activeAiTurns, 0);
  await rpc('workspace_set', { conversationId, directory: evidencePath, permission: 'fullAccess' });
  const code = `import time; from pathlib import Path; print('SCHEDULE_READY_${nonce}',flush=True); time.sleep(4); Path('actual-scheduled-command.txt').write_text('SCHEDULE_DONE_${nonce}',encoding='utf-8'); print('SCHEDULE_DONE_${nonce}',flush=True)`;
  const prompt = `请使用后台命令工具，在当前工作区启动任务“定时数据处理 ${nonce}”。命令数组依次为 ${JSON.stringify([python, '-X', 'utf8', '-u', '-c', code])}。启动后简要报告实际状态，无需等完成，不要循环查询。`;
  const schedule = await rpc('ai_schedules_create', { conversationId, name: `定时后台命令验收 ${nonce}`, prompt, nextRunAt: new Date(Date.now() + 10000).toISOString(), repeatSeconds: null, executionId: crypto.randomUUID() }); scheduleId = schedule.scheduleId;
  await rpc('plugin:window|close').catch(() => {}); await browser.close(); browser = null;
  const run = await wait(async () => { const data = await background('ai_schedules_list', { conversationId }); const found = data.runs.find(v => v.scheduleId === scheduleId); if (found && ['failed', 'waiting_input', 'interrupted', 'cancelled'].includes(found.state)) throw new Error(JSON.stringify(found)); return found?.state === 'succeeded' ? found : null; }, 'Headless actual AI starts background command');
  const trace = await background('ai_schedules_run_events', { runId: run.runId }); assert(JSON.stringify(trace.events).includes('background_command_prepare') && JSON.stringify(trace.events).includes('background_command_start'), 'Actual headless tool trace missing');
  const overview = await background('background_command_list', { conversationId }); assert.equal(overview.total, 1); const command = overview.commands[0]; commandId = command.id; assert.equal(command.executionMode, 'windowsUser');
  const finished = await wait(async () => { const record = await background('background_command_get', { conversationId, commandId }); if (record.status === 'failed') throw new Error(JSON.stringify(record.error)); return record.status === 'completed' ? record : null; }, 'Actual headless command completes');
  assert.equal(await fs.readFile(path.join(evidencePath, 'actual-scheduled-command.txt'), 'utf8'), `SCHEDULE_DONE_${nonce}`); assert(finished.stdout.includes(`SCHEDULE_DONE_${nonce}`)); assert.equal(finished.exitCode, 0);
  const status = await background('runtime_status'); assert.equal(status.pid, idle.pid); assert.equal(status.activeCommands, 0);
  report.cases.push({ name: 'Closed desktop: actual scheduled Codex and hosted AI invoke real command/exec, retain results and create real file', pass: true, result: { conversationId, run, command: finished, pid: idle.pid, events: trace.events } }); report.pass = true; console.log(report.cases[0].name, 'PASS');
} catch (error) { report.failure = error?.message ?? error; console.error(JSON.stringify(report.failure)); process.exitCode = 1; }
finally {
  if (commandId && !report.pass) await background('background_command_stop', { conversationId, commandId }).catch(() => {});
  if (scheduleId) await background('ai_schedules_set_enabled', { scheduleId, enabled: false }).catch(() => {});
  if (!browser) await exec('python', ['-X', 'utf8', 'scripts/start-codex-dev.py', '--local-gateway'], { windowsHide: true });
  else await browser.close();
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(evidencePath, 'schedule-acceptance.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ pass: report.pass, cases: report.cases.length }));

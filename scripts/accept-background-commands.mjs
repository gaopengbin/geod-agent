/** Actual pinned Codex command/exec through the native background companion. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), [playwrightModule, evidencePath, python] = process.argv.slice(2);
const { chromium } = await import(playwrightModule);
await fs.mkdir(evidencePath, { recursive: true });
const conversationId = `commands-native-${crypto.randomUUID()}`, otherConversation = `commands-other-${crypto.randomUUID()}`;
const nonce = crypto.randomBytes(8).toString('hex'), report = { pass: false, engine: 'Actual Codex 0.159.2 command/exec', cases: [] }, started = [];
let browser, page;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect() {
  for (let i = 0; i < 100; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9233'); page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':1420')); if (page) { await page.waitForFunction(() => !!window.__TAURI_INTERNALS__); return; } } catch {}
    if (browser) await browser.close().catch(() => {}); await sleep(200);
  } throw new Error('Actual desktop unavailable');
}
const rpc = async (command, args = {}) => { const result = await page.evaluate(async ({ command, args }) => { try { return { value: await window.__TAURI_INTERNALS__.invoke(command, args) }; } catch (error) { return { error }; } }, { command, args }); if (result.error) throw result.error; return result.value; };
const get = id => rpc('background_command_get', { conversationId, commandId: id });
const prepare = async (name, source, changes = {}, key = crypto.randomUUID()) => rpc('background_command_prepare', { conversationId, idempotencyKey: key, draft: { title: name, command: [python, '-X', 'utf8', '-u', '-c', source], ...changes } });
const start = async (plan, confirmed = false) => { const result = await rpc('background_command_start', { conversationId, commandId: plan.command.id, planHash: plan.command.planHash, confirmed }); started.push(plan.command.id); return result; };
const wait = async (id, predicate, timeout = 45000) => { const end = Date.now() + timeout; while (Date.now() < end) { const result = await get(id); if (predicate(result)) return result; if (['failed', 'cancelled', 'interrupted'].includes(result.status)) throw new Error(`Command ${result.title}: ${JSON.stringify(result.error)}; ${result.stderr}`); await sleep(200); } throw new Error(`Command ${id} timed out`); };
const ended = id => wait(id, r => !['planned', 'queued', 'running', 'stopping'].includes(r.status));
const casePassed = async (name, result) => { report.cases.push({ name, pass: true, result }); await fs.writeFile(path.join(evidencePath, 'acceptance.json'), JSON.stringify(report, null, 2)); console.log(name, 'PASS'); };
const reject = async (name, command, args, expected) => { let error; try { await rpc(command, args); } catch (cause) { error = cause; } assert.equal(error?.code, expected, `${name}: ${JSON.stringify(error)}`); await casePassed(name, { code: error.code }); };
try {
  await connect();
  const initial = await rpc('background_status'); assert.equal(initial.activeCommands, 0, 'Existing commands must be idle');
  await rpc('workspace_set', { conversationId, directory: evidencePath, permission: 'confirmEach' });
  const key = crypto.randomUUID(), source = `from pathlib import Path; import sys; Path('native-result.txt').write_text('${nonce}',encoding='utf-8'); print('真实中文-${nonce}'); print('标准错误-${nonce}',file=sys.stderr)`;
  const plan = await prepare('实际中文输出与保存文件', source, {}, key); assert.equal(plan.confirmationRequired, true);
  const again = await prepare('实际中文输出与保存文件', source, {}, key); assert.equal(again.command.id, plan.command.id);
  await casePassed('Preparation retains immutable argv and stable idempotent ID', { id: plan.command.id, planHash: plan.command.planHash });
  await reject('Changed argv under the same execution key is rejected', 'background_command_prepare', { conversationId, idempotencyKey: key, draft: { title: plan.command.title, command: [python, '-c', 'print(2)'] } }, 'COMMAND_IDEMPOTENCY_CONFLICT');
  await reject('Confirm-each cannot self-approve a background command', 'background_command_start', { conversationId, commandId: plan.command.id, planHash: plan.command.planHash, confirmed: false }, 'USER_CONFIRMATION_REQUIRED');
  await reject('A changed command hash cannot be approved', 'background_command_start', { conversationId, commandId: plan.command.id, planHash: 'changed', confirmed: true }, 'COMMAND_PLAN_CHANGED');
  await start(plan, true); const result = await ended(plan.command.id); assert.equal(result.status, 'completed'); assert.equal(result.exitCode, 0); assert(result.stdout.includes(`真实中文-${nonce}`)); assert(result.stderr.includes(`标准错误-${nonce}`)); assert.equal(await fs.readFile(path.join(evidencePath, 'native-result.txt'), 'utf8'), nonce);
  await casePassed('Actual standalone Codex runs Python and retains UTF-8 stdout, stderr and real file', result);
  const duplicate = await start(plan, true); assert.equal(duplicate.status, 'completed'); assert.equal(duplicate.startedAt, result.startedAt); await casePassed('Starting a finished command does not rerun it', { startedAt: duplicate.startedAt });
  for (const command of ['background_command_get', 'background_command_stop', 'background_command_write']) await reject(`Cross-conversation ${command} rejected`, command, { conversationId: otherConversation, commandId: plan.command.id, input: 'x', closeStdin: false }, 'COMMAND_NOT_FOUND');
  await reject('Relative working directory cannot escape', 'background_command_prepare', { conversationId, idempotencyKey: crypto.randomUUID(), draft: { title: 'escape', command: [python, '-c', 'print(1)'], relativeCwd: '..' } }, 'WORKSPACE_DENIED');
  const cancelled = await prepare('丢弃计划', 'print(1)'); const discarded = await rpc('background_command_stop', { conversationId, commandId: cancelled.command.id }); assert.equal(discarded.status, 'cancelled'); await casePassed('Prepared command can be discarded without running', { id: discarded.id });
  await rpc('workspace_set', { conversationId, directory: evidencePath, permission: 'fullAccess' });
  const interactive = await prepare('实际输入与 EOF', "import sys; print('READY'); line=sys.stdin.readline(); print('INPUT:'+line.rstrip()); rest=sys.stdin.read(); print('EOF:'+str(len(rest)))"); await start(interactive);
  await wait(interactive.command.id, r => r.stdout?.includes('READY'));
  const accepted = await rpc('background_command_write', { conversationId, commandId: interactive.command.id, input: `input-${nonce}\n`, closeStdin: false }); assert.equal(accepted.accepted, true);
  await rpc('background_command_write', { conversationId, commandId: interactive.command.id, closeStdin: true });
  const received = await ended(interactive.command.id); assert(received.stdout.includes(`INPUT:input-${nonce}`)); assert(received.stdout.includes('EOF:0')); await casePassed('Actual stdin write acknowledged and EOF reaches the running program', received);
  const capped = await prepare('输出上限', "import sys; sys.stdout.write('中'*100000); sys.stderr.write('E'*300000)"); await start(capped); const bounded = await ended(capped.command.id); assert.equal(bounded.status, 'completed'); assert.equal(bounded.outputTruncated, true); assert(Buffer.byteLength(bounded.stdout) <= 262147); assert.equal(Buffer.byteLength(bounded.stderr), 262144); await casePassed('Actual stdout and stderr are independently capped at 256 KiB', { stdoutBytes: Buffer.byteLength(bounded.stdout), stderrBytes: Buffer.byteLength(bounded.stderr), truncated: bounded.outputTruncated });
  const failed = await prepare('实际非零退出', "import sys; print('FAIL_ACTUAL',file=sys.stderr); sys.exit(7)"); await start(failed); const exit = await wait(failed.command.id, r => r.status === 'failed'); assert.equal(exit.exitCode, 7); assert(exit.stderr.includes('FAIL_ACTUAL')); await casePassed('Actual nonzero exit is failed with the real exit code and stderr', exit);
  const timeout = await prepare('实际超时', "import time; print('TIMEOUT_READY'); time.sleep(30)", { timeoutMs: 1200 }); await start(timeout); const timed = await wait(timeout.command.id, r => r.status === 'failed'); assert.notEqual(timed.exitCode, 0); await casePassed('Actual Codex execution timeout ends the command', timed);
  const long = await prepare('关闭窗口后继续', `import time; from pathlib import Path; print('DETACHED_READY'); time.sleep(10); Path('closed-window-result.txt').write_text('${nonce}',encoding='utf-8'); print('DETACHED_DONE')`); await start(long); await wait(long.command.id, r => r.stdout?.includes('DETACHED_READY'));
  const companion = await rpc('background_status'); assert.equal(companion.activeCommands, 1); await reject('The active command prevents shutting down its companion', 'background_stop', {}, 'BACKGROUND_BUSY');
  await rpc('plugin:window|close').catch(() => {}); await browser.close(); browser = null; await sleep(11000); assert.equal(await fs.readFile(path.join(evidencePath, 'closed-window-result.txt'), 'utf8'), nonce);
  await exec('python', ['-X', 'utf8', 'scripts/start-codex-dev.py', '--local-gateway'], { windowsHide: true }); await connect();
  const reopened = await get(long.command.id); assert.equal(reopened.status, 'completed'); assert(reopened.stdout.includes('DETACHED_DONE')); assert.equal((await rpc('background_status')).pid, companion.pid); await casePassed('Closed desktop leaves the same companion running; reopened desktop reads retained output', { pid: companion.pid, command: reopened });
  const stop = await prepare('停止实际进程树', `import subprocess,sys,time; from pathlib import Path; p=subprocess.Popen([sys.executable,'-u','-c',"import time; time.sleep(30); open('descendant-must-not-exist.txt','w').write('wrong')"]); Path('owned-child-pid.txt').write_text(str(p.pid)); print('TREE_READY'); time.sleep(60)`); await start(stop); await wait(stop.command.id, r => r.stdout?.includes('TREE_READY'));
  const childPid = Number(await fs.readFile(path.join(evidencePath, 'owned-child-pid.txt'), 'utf8'));
  await rpc('background_command_stop', { conversationId, commandId: stop.command.id }); const stopped = await wait(stop.command.id, r => r.status === 'cancelled');
  await sleep(500); const processes = await exec('powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { 'running' } else { 'stopped' }`], { windowsHide: true }); assert.equal(processes.stdout.trim(), 'stopped'); await assert.rejects(fs.access(path.join(evidencePath, 'descendant-must-not-exist.txt'))); await casePassed('Stopping the owned command reaps its actual descendant process', { command: stopped, childPid, descendantStopped: true });
  const last = await rpc('background_command_list', { conversationId }); assert.equal(last.commands.length, last.total); assert(last.commands.every(v => v.stdout === undefined && v.stderr === undefined)); assert.equal((await rpc('background_status')).activeCommands, 0); await casePassed('Compact command listing omits output and all owned workers are idle', { total: last.total });
  report.conversationId = conversationId; report.pass = true;
} catch (error) { report.failure = error?.message ?? error; console.error(JSON.stringify(report.failure)); process.exitCode = 1; }
finally {
  if (page && browser) for (const id of new Set(started)) await rpc('background_command_stop', { conversationId, commandId: id }).catch(() => {});
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(evidencePath, 'acceptance.json'), JSON.stringify(report, null, 2)); if (browser) await browser.close();
}
console.log(JSON.stringify({ pass: report.pass, cases: report.cases.length }));

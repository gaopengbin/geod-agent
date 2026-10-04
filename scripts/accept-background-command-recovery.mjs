/** Deliberate crash of only the idle user's owned GeoD companion and QA command. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), [playwrightModule, evidencePath, python] = process.argv.slice(2), { chromium } = await import(playwrightModule);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233'), page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':1420'));
const executable = path.resolve('apps/geod-agent-desktop/src-tauri/target/debug/geod-agent-desktop.exe'), conversationId = `commands-recovery-${crypto.randomUUID()}`, report = { pass: false, cases: [] };
await fs.mkdir(evidencePath, { recursive: true });
const rpc = async (command, args = {}) => { const result = await page.evaluate(async ({ command, args }) => { try { return { value: await window.__TAURI_INTERNALS__.invoke(command, args) }; } catch (error) { return { error }; } }, { command, args }); if (result.error) throw result.error; return result.value; };
const wait = async (check, timeout = 45000) => { const end = Date.now() + timeout; while (Date.now() < end) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 250)); } throw new Error('Recovery timed out'); };
const get = id => rpc('background_command_get', { conversationId, commandId: id });
const prepare = (source, relativeCwd) => rpc('background_command_prepare', { conversationId, idempotencyKey: crypto.randomUUID(), draft: { title: '后台恢复验收', command: [python, '-X', 'utf8', '-u', '-c', source], relativeCwd } });
const passed = async (name, result) => { report.cases.push({ name, pass: true, result }); console.log(name, 'PASS'); };
let commandId, ownPid;
try {
  const idle = await rpc('background_status'); assert.equal(idle.activeDownloads, 0); assert.equal(idle.activeCommands, 0); assert.equal(idle.activeAiTurns, 0); assert.equal(idle.maintenanceActive, false);
  await rpc('workspace_set', { conversationId, directory: evidencePath, permission: 'fullAccess' });
  await fs.mkdir(path.join(evidencePath, 'captured-cwd'), { recursive: true });
  const changed = await prepare('print(1)', 'captured-cwd');
  await fs.rename(path.join(evidencePath, 'captured-cwd'), path.join(evidencePath, `moved-cwd-${crypto.randomUUID()}`));
  let error; try { await rpc('background_command_start', { conversationId, commandId: changed.command.id, planHash: changed.command.planHash, confirmed: false }); } catch (cause) { error = cause; } assert.equal(error?.code, 'WORKSPACE_READ_FAILED'); await rpc('background_command_stop', { conversationId, commandId: changed.command.id }); await passed('A captured working directory that disappears cannot run', { code: error.code });
  const source = "import subprocess,sys,time; from pathlib import Path; p=subprocess.Popen([sys.executable,'-u','-c',\"import time; time.sleep(60); open('recovery-must-not-exist.txt','w').write('wrong')\"]); Path('recovery-owned-pid.txt').write_text(str(p.pid)); print('RECOVERY_READY'); time.sleep(90)";
  const plan = await prepare(source); commandId = plan.command.id;
  await rpc('background_command_start', { conversationId, commandId, planHash: plan.command.planHash, confirmed: false });
  const actual = await wait(async () => { const record = await get(commandId); if (record.status === 'failed') throw new Error(JSON.stringify(record.error)); return record.stdout?.includes('RECOVERY_READY') ? record : null; });
  const childPid = Number(await fs.readFile(path.join(evidencePath, 'recovery-owned-pid.txt'), 'utf8'));
  const active = await rpc('background_status'); ownPid = active.pid; assert.equal(active.activeCommands, 1); assert.equal(active.activeDownloads, 0); assert.equal(active.activeAiTurns, 0); assert.equal(active.maintenanceActive, false);
  const duplicate = spawn(executable, ['--background-runtime'], { cwd: path.dirname(path.dirname(executable)), windowsHide: true, stdio: 'ignore' });
  const exitCode = await new Promise(resolve => duplicate.once('exit', resolve)); assert.notEqual(exitCode, 0); assert.equal((await get(commandId)).status, 'running'); assert.equal((await rpc('background_status')).pid, ownPid);
  await passed('A rejected duplicate companion cannot recover or overwrite a live command', { exitCode, activePid: ownPid, commandId });
  const escaped = executable.replaceAll("'", "''");
  await exec('powershell', ['-NoProfile', '-Command', `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${ownPid}'; if (!$p -or $p.ExecutablePath -ne '${escaped}' -or $p.CommandLine -notmatch '--background-runtime') { throw 'Owned GeoD companion identity mismatch' }; Stop-Process -Id ${ownPid} -Force`], { windowsHide: true });
  const recovered = await wait(async () => { try { const status = await rpc('background_status'); if (status.pid === ownPid) return null; const record = await get(commandId); return record.status === 'interrupted' ? { status, record } : null; } catch { return null; } });
  assert.equal(recovered.status.activeCommands, 0); assert.equal(recovered.record.error.code, 'COMMAND_INTERRUPTED'); assert(recovered.record.stdout.includes('RECOVERY_READY')); assert.equal(recovered.record.startedAt, actual.startedAt);
  const child = await exec('powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${childPid} -ErrorAction SilentlyContinue) { 'running' } else { 'stopped' }`], { windowsHide: true }); assert.equal(child.stdout.trim(), 'stopped'); await assert.rejects(fs.access(path.join(evidencePath, 'recovery-must-not-exist.txt')));
  await passed('Actual companion crash reaps its command tree; replacement retains output and marks interrupted without rerunning', { oldPid: ownPid, newPid: recovered.status.pid, command: recovered.record, childPid, descendantStopped: true });
  report.pass = true;
} catch (error) { report.failure = error?.message ?? error; console.error(JSON.stringify(report.failure)); process.exitCode = 1; }
finally {
  if (commandId) await rpc('background_command_stop', { conversationId, commandId }).catch(() => {});
  report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(evidencePath, 'recovery-acceptance.json'), JSON.stringify(report, null, 2)); await browser.close();
}
console.log(JSON.stringify({ pass: report.pass, cases: report.cases.length }));

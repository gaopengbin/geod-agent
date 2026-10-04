/** Actual command controls and actual hosted AI handoff/readback. No mocked IPC. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const [playwrightModule, evidencePath, python] = process.argv.slice(2), { chromium } = await import(playwrightModule);
await fs.mkdir(evidencePath, { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233'), page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes(':1420'));
const report = { pass: false, cases: [] }, ids = [], uiConversation = `commands-ui-${crypto.randomUUID()}`, nonce = crypto.randomBytes(6).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rpc = async (command, args = {}) => { const result = await page.evaluate(async ({ command, args }) => { try { return { value: await window.__TAURI_INTERNALS__.invoke(command, args) }; } catch (error) { return { error }; } }, { command, args }); if (result.error) throw result.error; return result.value; };
const chats = () => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('geod-agent-conversations-0.1:account:')).flatMap(([, value]) => JSON.parse(value)));
const prepare = async (title, source) => { const plan = await rpc('background_command_prepare', { conversationId: uiConversation, idempotencyKey: crypto.randomUUID(), draft: { title, command: [python, '-X', 'utf8', '-u', '-c', source] } }); ids.push(plan.command.id); return plan; };
const save = () => fs.writeFile(path.join(evidencePath, 'ai-acceptance.json'), JSON.stringify(report, null, 2));
const passed = async (name, result) => { report.cases.push({ name, pass: true, result }); await save(); console.log(name, 'PASS'); };
const wait = async (run, description, timeout = 45000) => { const end = Date.now() + timeout; while (Date.now() < end) { const result = await run(); if (result) return result; await sleep(250); } throw new Error(`Timeout: ${description}`); };
const send = async text => { await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click(); };
const finish = async (id, users = 1) => wait(async () => { const chat = (await chats()).find(v => v.conversationId === id); return chat && !chat.pendingId && chat.display.filter(v => v.role === 'user').length >= users && chat.messages?.at(-1)?.role === 'assistant' && !(await page.getByRole('button', { name: '停止回复', exact: true }).count()) ? chat : null; }, 'Actual model answer', 150000);
let aiConversation, aiCommand;
try {
  await rpc('workspace_set', { conversationId: uiConversation, directory: evidencePath, permission: 'confirmEach' });
  const plan = await prepare('边界文件转换', "import sys,time; print('UI_READY_中文'); line=sys.stdin.readline(); print('UI_INPUT:'+line.rstrip()); time.sleep(60)");
  const discard = await prepare('等待的数据同步', 'print(1)'); await prepare('批量校验范围', 'print(2)');
  await page.goto(`http://127.0.0.1:1420/test/background-command-harness.html?conversationId=${uiConversation}&commandId=${plan.command.id}`);
  await page.getByRole('button', { name: '确认并运行', exact: true }).waitFor(); await page.getByRole('button', { name: '确认并运行', exact: true }).click();
  await page.getByText('UI_READY_中文', { exact: false }).last().waitFor({ timeout: 30000 });
  await page.getByRole('textbox', { name: '命令输入' }).fill(`ui-${nonce}`); await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText(`UI_INPUT:ui-${nonce}`, { exact: false }).last().waitFor({ timeout: 15000 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme); await page.evaluate(() => document.fonts.ready); await page.mouse.move(1200, 500); await page.waitForTimeout(350);
    const layout = await page.locator('.background-command-panel').evaluate(panel => {
      const rows = [...panel.querySelectorAll('.command-list-row')].map(row => ({ height: row.getBoundingClientRect().height, scaled: getComputedStyle(row).transform }));
      const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number), lum = value => rgb(value).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
      const contrasts = [...panel.querySelectorAll('button:not(:disabled)')].filter(button => button.textContent.trim()).map(button => {
        let current = button, bg; while (current) { bg = getComputedStyle(current).backgroundColor; if (bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') break; current = current.parentElement; }
        const a = lum(getComputedStyle(button).color), b = lum(bg || 'rgb(255,255,255)'); return { label: button.textContent.trim(), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
      return { rowCount: rows.length, rows, outputHeight: panel.querySelector('.command-output-area').getBoundingClientRect().height, panelWidth: panel.getBoundingClientRect().width, overflow: panel.scrollWidth > panel.clientWidth, contrasts };
    });
    assert.equal(layout.rowCount, 3); assert(layout.rows.every(row => row.height <= 40 && row.scaled === 'none')); assert(layout.outputHeight <= 322); assert.equal(layout.overflow, false); assert(layout.contrasts.every(v => v.ratio >= 4.5), JSON.stringify(layout.contrasts));
    await page.locator('main').screenshot({ path: path.join(evidencePath, `actual-command-panel-${theme}.png`) }); await passed(`Actual compact ${theme} controls with readable buttons and bounded output`, layout);
  }
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await wait(async () => (await rpc('background_command_get', { conversationId: uiConversation, commandId: plan.command.id })).status === 'cancelled', 'Native stop from the real UI');
  await page.locator('.command-list-row').filter({ hasText: '等待的数据同步' }).click(); await page.getByRole('button', { name: '丢弃', exact: true }).waitFor(); await page.getByRole('button', { name: '丢弃', exact: true }).click();
  await wait(async () => (await rpc('background_command_get', { conversationId: uiConversation, commandId: discard.command.id })).status === 'cancelled', 'Native discard from the real UI'); await passed('Real UI confirmation, acknowledged stdin, stop and discard reach the actual native engine', { conversationId: uiConversation, commandId: plan.command.id });
  await page.goto('http://127.0.0.1:1420'); await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).waitFor();
  const previous = new Set((await chats()).map(chat => chat.conversationId)); await page.locator('.sidebar-new-chat').click();
  aiConversation = await wait(async () => (await chats()).find(chat => !previous.has(chat.conversationId))?.conversationId, 'Real new conversation');
  const workspace = await rpc('workspace_get', { conversationId: aiConversation });
  await rpc('workspace_set', { conversationId: aiConversation, directory: workspace.directory, permission: 'fullAccess' }); await page.reload(); await page.getByRole('textbox', { name: '发送给 GeoD Agent' }).waitFor();
  const code = `import time; from pathlib import Path; print('AI_BACKGROUND_READY_${nonce}',flush=True); time.sleep(25); Path(${JSON.stringify(path.join(evidencePath, 'actual-ai-command.txt').replaceAll('\\', '/'))}).write_text('AI_BACKGROUND_DONE_${nonce}',encoding='utf-8'); print('AI_BACKGROUND_DONE_${nonce}',flush=True)`;
  await send(`请使用后台命令功能，在当前工作区启动一个名为“实际数据处理 ${nonce}”的后台任务。程序为 ${python}，参数依次为 -X、utf8、-u、-c 和下面这段 Python 代码：\n${code}\n请交给独立后台执行，启动后简要告诉我状态即可，无需等它完成，也不要循环查进度。`);
  const first = await finish(aiConversation), tools = JSON.stringify(first.display.filter(v => v.role === 'tool'));
  assert(tools.includes('background_command_prepare') && tools.includes('background_command_start'), 'Actual AI did not call native background prepare/start');
  const commands = await rpc('background_command_list', { conversationId: aiConversation }); assert.equal(commands.total, 1); aiCommand = commands.commands[0]; assert.equal(aiCommand.executionMode, 'windowsUser');
  assert.deepEqual(aiCommand.command.slice(0, 5), [python, '-X', 'utf8', '-u', '-c']); assert(aiCommand.command[5].includes(nonce));
  assert(await page.getByRole('tab', { name: '后台命令', exact: true }).getAttribute('aria-selected') === 'true');
  await page.screenshot({ path: path.join(evidencePath, 'actual-ai-background-handoff.png'), fullPage: true }); await passed('Actual hosted AI prepares and starts the real command; task panel opens and chat returns control', { conversationId: aiConversation, commandId: aiCommand.id, status: aiCommand.status, answer: first.messages.at(-1).content });
  await wait(async () => { const actual = await rpc('background_command_get', { conversationId: aiConversation, commandId: aiCommand.id }); if (actual.status === 'failed') throw new Error(JSON.stringify(actual.error)); return actual.status === 'completed'; }, 'Actual AI command completes', 50000);
  assert.equal(await fs.readFile(path.join(evidencePath, 'actual-ai-command.txt'), 'utf8'), `AI_BACKGROUND_DONE_${nonce}`);
  await send('刚才那条后台命令现在真实状态是什么？查一次实际状态和最后的输出，再简要告诉我。');
  const second = await finish(aiConversation, 2), lastUser = second.display.findLastIndex(v => v.role === 'user');
  const secondTools = JSON.stringify(second.display.slice(lastUser + 1).filter(v => v.role === 'tool')); assert(secondTools.includes('background_command_get'), 'AI did not read the actual saved command'); assert(second.messages.at(-1).content.includes(nonce), 'Actual model answer lacks the program output');
  await fs.writeFile(path.join(evidencePath, 'actual-ai-conversation.json'), JSON.stringify(second, null, 2)); await page.screenshot({ path: path.join(evidencePath, 'actual-ai-background-readback.png'), fullPage: true }); await passed('Actual hosted AI reads the saved completed command and real file/output', { status: 'completed', answer: second.messages.at(-1).content });
  report.pass = true;
} catch (error) { report.failure = error?.message ?? error; console.error(JSON.stringify(report.failure)); process.exitCode = 1; }
finally {
  for (const id of ids) await rpc('background_command_stop', { conversationId: uiConversation, commandId: id }).catch(() => {});
  if (aiCommand && !report.pass) await rpc('background_command_stop', { conversationId: aiConversation, commandId: aiCommand.id }).catch(() => {});
  if (page.url().includes('/test/')) await page.goto('http://127.0.0.1:1420').catch(() => {});
  report.finishedAt = new Date().toISOString(); await save(); await browser.close();
}
console.log(JSON.stringify({ pass: report.pass, cases: report.cases.length }));

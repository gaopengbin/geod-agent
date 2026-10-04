// Read back durable native state after a development restart; no user chat edits.
import { chromium } from 'file:///G:/code/cesium-mcp/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const output = resolve(process.argv[2] ?? 'artifacts/ai-channels-integration-20261004-r6');
const previous = JSON.parse(readFileSync(resolve(process.argv[3] ?? 'artifacts/ai-channels-integration-20261004-r4/native-summary.json'), 'utf8'));
const task = previous.cases.find(c => c.name === 'actual native companion child reads and writes with parent snapshot').task;
const run = previous.cases.find(c => c.name === 'actual native schedule keeps original channel after conversation switch').run;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9233');
const page = browser.contexts()[0].pages().find(p => p.url().includes('127.0.0.1:1420'));
if (!page) throw new Error('Development desktop unavailable');

try {
  const actual = await page.evaluate(async p => {
    const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
    if (document.querySelector('button[aria-label="停止回复"]')) throw new Error('User turn is active');
    const list = await invoke('ai_channels_list');
    const task = await invoke('agent_tasks_get', { conversationId: p.task.conversationId, taskId: p.task.id });
    const run = await invoke('ai_schedules_run_events', { runId: p.run.runId });
    const selection = await invoke('ai_model_selection', { conversationId: 'b0e7ae51-1590-460d-abc0-b6d77bf5aaf9', existingConversation: true });
    const background = await invoke('background_status');
    return { list, task: task.task, run: run.run, selection, background };
  }, { task, run });
  assert.deepEqual(actual.task.modelRoute, task.modelRoute);
  assert.deepEqual(actual.run.modelRoute, run.modelRoute);
  assert.equal(actual.task.status, 'completed');
  assert.equal(actual.run.state, 'succeeded');
  assert.equal(actual.selection.channelId, 'hosted');
  assert.equal(actual.list.default.channelId, 'hosted');
  assert(!actual.list.channels.some(c => c.id === task.modelRoute.channel.id));
  assert.equal(actual.background.activeAiTurns, 0);

  await page.getByRole('button', { name: '账号与设置', exact: true }).click();
  await page.getByRole('button', { name: '模型与渠道', exact: true }).click();
  await page.getByRole('heading', { name: '模型与渠道', exact: true }).waitFor();
  await page.getByRole('heading', { name: '接入你的模型服务', exact: true }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, 'final-models-page.png'), animations: 'disabled' });
  const result = {
    passed: true,
    taskRoutePreservedAcrossRestart: true,
    scheduleRoutePreservedAcrossRestart: true,
    taskStatus: actual.task.status,
    scheduleState: actual.run.state,
    originalModel: actual.task.modelRoute.model.id,
    defaultSelection: actual.list.default,
    originalConversationSelection: actual.selection,
    temporaryChannelRemoved: true,
    currentCustomChannels: actual.list.channels.length,
    background: actual.background,
    visiblePage: '模型与渠道',
  };
  writeFileSync(join(output, 'restart-readback.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}

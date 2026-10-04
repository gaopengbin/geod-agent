// Read and navigate the real running WebView; do not create or run a schedule.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const output = resolve("../../artifacts/sidebar-schedules-20261004");
mkdirSync(output, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9233");
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === "http://127.0.0.1:1420/");
assert(page); const errors = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
const nav = page.locator(".conversation-sidebar-head");
const screen = page.locator(".schedules-page:not([hidden])");
async function ready() { await screen.waitFor(); await screen.locator('[aria-busy="false"]').waitFor(); }
async function snapshot() {
  const state = await page.evaluate(async () => {
    await window.__GEOD_LOCAL_STATE__?.flush();
    const records = await new Promise((resolve, reject) => {
      const opened = indexedDB.open("geod-ui-state-v1", 1);
      opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const db = opened.result, tx = db.transaction("records", "readonly"), store = tx.objectStore("records"), keys = store.getAllKeys(), values = store.getAll();
        tx.oncomplete = () => { db.close(); const records = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])); keys.result.forEach((key, i) => records[key] = values.result[i]); resolve(records); };
        tx.onabort = () => reject(tx.error);
      };
    });
    const key = Object.keys(records).find(key => key.startsWith("geod-agent-conversations-0.1:account:"));
    const chats = JSON.parse(records[key]);
    return { chats, active: records[`geod-agent-active-conversation-0.1:account:${key.split(":account:")[1]}`] };
  });
  const content = state.chats.map(chat => ({ conversationId: chat.conversationId, title: chat.title ?? null, messages: chat.messages, display: chat.display, planId: chat.planId ?? null, planIds: chat.planIds ?? [] }));
  return { chatIds: state.chats.map(chat => chat.conversationId), active: state.active, contentSha256: createHash("sha256").update(JSON.stringify(content)).digest("hex") };
}
const baseline = await snapshot();
try {
  await nav.getByRole("button", { name: "图源管理", exact: true }).click();
  await page.mouse.move(1000, 20);
  const background = await nav.locator(".sidebar-new-chat").evaluate(element => getComputedStyle(element).backgroundColor);
  assert.equal(background, "rgba(0, 0, 0, 0)");
  assert.equal(await nav.locator('[aria-current="page"]').count(), 1);
  assert.equal(await nav.locator('[aria-current="page"]').getAttribute("aria-label"), "图源管理");
  assert.equal(await nav.getByRole("button").count(), 6);
  checks.push("New chat is neutral; only the active destination is selected; six top entrances are visible");

  const expected = await page.evaluate(async chatIds => {
    const { api } = await import("/src/api.ts");
    const { dataSchedules } = await import("/src/data-schedules.ts");
    const entries = [];
    for (const conversationId of chatIds) {
      const [ai, imagery, data] = await Promise.all([api.aiSchedulesList(conversationId), api.schedulesList(conversationId), dataSchedules.list(conversationId)]);
      entries.push(...ai.schedules.map(s => ({ id: s.scheduleId, kind: "ai", enabled: s.enabled, conversationId })), ...imagery.map(s => ({ id: s.scheduleId, kind: "imagery", enabled: s.enabled, conversationId })), ...data.map(s => ({ id: s.id, kind: "data", enabled: s.enabled, conversationId })));
    }
    return entries;
  }, baseline.chatIds);
  await nav.getByRole("button", { name: "定时任务", exact: true }).click();
  await ready();
  assert.equal(await screen.locator(".schedules-row").count(), expected.length);
  assert.equal(await screen.getByRole("alert").count(), 0);
  assert.equal(await nav.locator('[aria-current="page"]').getAttribute("aria-label"), "定时任务");
  assert.equal(await page.locator(".conversation-row.is-active").count(), 0);
  await page.screenshot({ path: join(output, "native-schedules-dark.png") });
  checks.push("Overview reads all three existing native scheduler types across saved conversations");
  const enabled = expected.filter(e => e.enabled).length;
  await screen.getByRole("tab", { name: `已启用 ${enabled}`, exact: true }).click();
  assert.equal(await screen.locator(".schedules-row").count(), enabled);
  await screen.getByRole("tab", { name: `已停止 ${expected.length - enabled}`, exact: true }).click();
  assert.equal(await screen.locator(".schedules-row").count(), expected.length - enabled);
  await screen.getByRole("tab", { name: `全部 ${expected.length}`, exact: true }).click();
  checks.push("Enabled and stopped filters match the real native schedule counts");

  const ai = expected.find(e => e.kind === "ai");
  if (ai) {
    await screen.locator(`[data-schedule-id="${ai.id}"] .schedules-row-title`).click();
    await screen.locator(".schedules-detail .schedule-item").waitFor();
    assert.equal(await screen.locator(".schedules-detail .schedule-item").count(), 1);
    await screen.getByRole("button", { name: "收起定时任务详情", exact: true }).click();
    checks.push("Selecting an AI schedule shows only its own execution settings and history");
  }
  await screen.getByRole("button", { name: "新建任务", exact: true }).click();
  await screen.getByLabel("名称", { exact: true }).fill("入口验收 · 未保存");
  await screen.getByLabel("执行指令", { exact: true }).fill("这是表单显示验收；不保存也不执行。");
  assert(await screen.getByLabel("开始时间", { exact: true }).inputValue());
  await screen.getByRole("button", { name: "关闭新建任务", exact: true }).click();
  checks.push("AI scheduling opens the existing native creation form without creating test jobs");

  await nav.getByRole("button", { name: "模型与渠道", exact: true }).click();
  await page.locator(".ai-channels-page:not([hidden])").waitFor();
  assert.equal(await nav.locator('[aria-current="page"]').getAttribute("aria-label"), "模型与渠道");
  assert.equal(await page.locator(".ai-channels-page:not([hidden])").getByText("赞助渠道", { exact: true }).count(), 0);
  checks.push("Models and channels has a top entrance; sponsor UI remains hidden");

  await nav.getByRole("button", { name: "定时任务", exact: true }).click();
  await ready();
  await screen.getByRole("button", { name: "新建任务", exact: true }).click();
  await screen.getByRole("tab", { name: "定时下载", exact: true }).click();
  await screen.getByRole("button", { name: "选择下载任务", exact: true }).click();
  await page.locator('.task-panel').getByRole("tab", { name: "定时", exact: true }).waitFor();
  assert.equal(await page.locator('.task-panel').getByRole("tab", { name: "定时", exact: true }).getAttribute("aria-selected"), "true");
  await page.locator('.task-panel .ai-schedule-section').waitFor();
  checks.push("Download creation returns to the original conversation with its schedule tab focused");

  const other = baseline.chatIds.find(id => id !== baseline.active);
  if (other) {
    for (const conversationId of [other, baseline.active]) {
      await nav.getByRole("button", { name: "定时任务", exact: true }).click();
      await ready();
      await screen.getByRole("button", { name: "新建任务", exact: true }).click();
      await screen.getByRole("combobox", { name: "创建到会话", exact: true }).click();
      await page.locator(`[role="option"][data-conversation-id="${conversationId}"]`).click();
      await screen.getByRole("tab", { name: "定时下载", exact: true }).click();
      await screen.getByRole("button", { name: "选择下载任务", exact: true }).click();
      await page.locator('.task-panel .ai-schedule-section').waitFor();
      await page.waitForFunction(async conversationId => {
        await window.__GEOD_LOCAL_STATE__?.flush();
        return !!document.querySelector(`.conversation-item.active[data-conversation-id="${conversationId}"]`);
      }, conversationId);
      assert.equal(await page.locator('.task-panel').getByRole("tab", { name: "定时", exact: true }).getAttribute("aria-selected"), "true");
    }
    checks.push("Cross-conversation download navigation keeps the schedule tab focused and restores the original conversation");
  }
  await nav.getByRole("button", { name: "定时任务", exact: true }).click();
  await ready();
  if (await screen.locator(".schedules-create").count()) await screen.getByRole("button", { name: "关闭新建任务", exact: true }).click();
  await page.mouse.move(1000, 20);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(output, "native-schedules-dark.png") });
  assert.equal(errors.length, 0);
  const after = await snapshot();
  assert.deepEqual(after, baseline);
  checks.push("Existing conversations, contents and active conversation are preserved");
  const runtime = await page.evaluate(async () => {
    const { api } = await import("/src/api.ts");
    const [background, sources, dataConnections, sqlConnections] = await Promise.all([api.backgroundStatus(), api.sourcesList(), window.__TAURI_INTERNALS__.invoke("data_connections_list"), window.__TAURI_INTERNALS__.invoke("sql_connections_list")]);
    return { background, sourceCount: sources.length, connectionCount: dataConnections.length + sqlConnections.connections.length };
  });
  assert.equal(runtime.sourceCount, 16); assert.equal(runtime.connectionCount, 4); assert.equal(runtime.background.running, true);
  assert.equal(runtime.background.activeAiTurns, 0); assert.equal(runtime.background.activeCommands, 0); assert.equal(runtime.background.activeDownloads, 0);
  checks.push("The existing background runtime, source registrations and database connections remain available");
  const report = { passed: true, checks, realSchedules: expected.length, enabled, kinds: Object.fromEntries(["ai", "imagery", "data"].map(kind => [kind, expected.filter(e => e.kind === kind).length])), schedulesCreated: 0, originalConversations: baseline.chatIds.length, originalActivePreserved: true, contentSha256: baseline.contentSha256, runtime, rendererErrors: errors };
  writeFileSync(join(output, "native-acceptance.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }

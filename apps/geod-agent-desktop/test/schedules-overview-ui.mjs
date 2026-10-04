// Isolated native-contract fixtures: this browser never connects to the user's database or scheduler.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const output = resolve("../../artifacts/sidebar-schedules-20261004"); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
const errors = [], checks = []; page.on("pageerror", error => errors.push(error.message));
await page.addInitScript(() => {
  window.isTauri = true;
  localStorage.setItem("geod-agent-language-v1", JSON.stringify({ language: "zh-CN", replyLanguage: "auto" }));
  const future = new Date(Date.now() + 86400000).toISOString();
  const tasks = [
    { kind: "ai", scheduleId: "ai-a", conversationId: "chat-a", name: "河南数据每日检查", prompt: "检查新增数据并汇总", enabled: true, nextRunAt: future, repeatSeconds: 86400 },
    { kind: "ai", scheduleId: "ai-b", conversationId: "chat-b", name: "数据库变化提醒", prompt: "读取数据库并汇总变化", enabled: false, nextRunAt: future, repeatSeconds: null },
    { kind: "imagery", scheduleId: "imagery-a", conversationId: "chat-a", name: "驻马店市影像更新", enabled: true, nextRunAt: future, repeatSeconds: 604800 },
    { kind: "data", id: "data-b", conversationId: "chat-b", name: "北京三维建筑更新", enabled: false, nextRunAt: future, repeatSeconds: 86400 }
  ];
  const run = { runId: "ai-result", scheduleId: "ai-a", conversationId: "chat-a", name: "河南数据每日检查", state: "succeeded", scheduledAt: future, attempt: 1, result: { text: "## 检查结果\n发现 2 份新增数据。" } };
  const calls = []; window.__SCHEDULE_TEST__ = { tasks, calls, failImagery: false };
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    calls.push({ command, args });
    const kinds = { ai_schedules_list: "ai", schedules_list: "imagery", data_schedules_list: "data" };
    if (kinds[command]) {
      if (window.__SCHEDULE_TEST__.failImagery && command === "schedules_list") throw new Error("isolated imagery read failure");
      const schedules = tasks.filter(task => task.kind === kinds[command] && task.conversationId === args.conversationId).map(task => ({ ...task }));
      return command === "ai_schedules_list" ? { schedules, runs: args.conversationId === "chat-a" ? [run] : [], windowRequired: false } : schedules;
    }
    if (command.endsWith("_set_enabled")) {
      const task = tasks.find(task => (task.scheduleId ?? task.id) === args.scheduleId);
      task.enabled = args.enabled; if (args.nextRunAt) task.nextRunAt = args.nextRunAt; return { ...task };
    }
    if (command === "ai_schedules_create") {
      const task = { kind: "ai", scheduleId: "ai-new", ...args, enabled: true }; tasks.push(task); return { ...task };
    }
    if (command === "ai_schedules_run_events") return { run, events: [{ type: "completed" }] };
    throw new Error(`Unexpected isolated IPC: ${command}`);
  } };
});
const screen = page.locator(".schedules-page");
async function ready() { await screen.locator('[aria-busy="false"]').waitFor(); }
try {
  await page.goto("http://127.0.0.1:1420/test/schedules-overview-harness.html");
  await page.getByRole("tab", { name: "全部 4", exact: true }).waitFor(); await ready();
  assert.equal(await screen.locator(".schedules-row").count(), 4);
  const selectWidth = await screen.getByRole("combobox", { name: "筛选会话", exact: true }).evaluate(el => el.getBoundingClientRect().width);
  assert.equal(selectWidth, 220);
  checks.push("All three schedule types share a compact list with a bounded chat selector");
  for (const id of ["ai-a", "imagery-a", "data-b"]) {
    const row = screen.locator(`[data-schedule-id="${id}"]`);
    const state = await page.evaluate(id => window.__SCHEDULE_TEST__.tasks.find(t => (t.scheduleId ?? t.id) === id).enabled, id);
    await row.getByRole("button", { name: new RegExp(`^${state ? "暂停" : "启用"} `) }).click();
    await page.waitForFunction(({ id, state }) => window.__SCHEDULE_TEST__.tasks.find(t => (t.scheduleId ?? t.id) === id).enabled !== state, { id, state }); await ready();
  }
  const mutated = await page.evaluate(() => window.__SCHEDULE_TEST__.calls.filter(call => call.command.endsWith("_set_enabled")).map(call => call.command));
  assert.deepEqual(mutated, ["ai_schedules_set_enabled", "schedules_set_enabled", "data_schedules_set_enabled"]);
  checks.push("Pause and enable route to the correct native APIs for AI, imagery and data schedules");
  await screen.locator('[data-schedule-id="ai-b"] button[aria-label^="启用 "]').click(); await ready();
  const nextRun = await page.evaluate(() => window.__SCHEDULE_TEST__.calls.filter(call => call.args.scheduleId === "ai-b").at(-1).args.nextRunAt);
  assert(Date.parse(nextRun) > Date.now());
  checks.push("Re-enabling a one-time schedule assigns a future execution time");
  await screen.locator('[data-schedule-id="ai-a"] .schedules-row-title').click();
  await screen.locator(".schedules-detail .schedule-item").waitFor();
  assert.equal(await screen.locator(".schedules-detail .schedule-item").count(), 1);
  await screen.locator(".schedules-detail").getByRole("button", { name: /查看结果/ }).click();
  await screen.locator(".schedules-detail .ai-run-result").getByText("发现 2 份新增数据。", { exact: true }).waitFor();
  await screen.locator(".schedules-detail").getByRole("button", { name: "打开所属会话", exact: true }).click();
  assert.equal(await page.getByLabel("Navigation result").textContent(), "open:chat-a");
  await screen.getByRole("button", { name: "收起定时任务详情", exact: true }).click();
  await page.screenshot({ path: join(output, "isolated-multi-schedules-dark.png") });
  checks.push("AI detail is scoped to its selected schedule and displays saved results");
  await screen.getByRole("combobox", { name: "筛选会话", exact: true }).click();
  await page.getByRole("option", { name: "三维与矢量数据", exact: true }).click();
  assert.equal(await screen.locator(".schedules-row").count(), 2);
  await screen.locator('[data-schedule-id="data-b"] .schedules-row-title').click();
  assert.equal(await page.getByLabel("Navigation result").textContent(), "download:chat-b");
  checks.push("Chat filtering and download navigation retain the owning conversation");
  await screen.getByRole("button", { name: "新建任务", exact: true }).click();
  await screen.getByLabel("名称", { exact: true }).fill("隔离的新建指令");
  await screen.getByLabel("执行指令", { exact: true }).fill("汇总更新数据");
  await screen.getByRole("button", { name: "保存 AI 定时任务", exact: true }).click();
  await screen.locator('[data-schedule-id="ai-new"]').waitFor();
  const created = await page.evaluate(() => window.__SCHEDULE_TEST__.calls.find(call => call.command === "ai_schedules_create").args);
  assert.equal(created.conversationId, "chat-b"); assert.equal(created.prompt, "汇总更新数据"); assert.equal(created.repeatSeconds, null);
  assert.equal(await screen.locator(".schedules-create").count(), 0);
  checks.push("Create-only form saves to the chosen chat through the existing native scheduler contract");
  await page.evaluate(() => { window.__SCHEDULE_TEST__.failImagery = true; });
  await screen.getByRole("button", { name: "刷新定时任务", exact: true }).click(); await ready();
  await screen.getByRole("alert").filter({ hasText: "部分任务读取失败" }).waitFor();
  assert.equal(await screen.locator(".schedules-row").count(), 3);
  await page.evaluate(() => { window.__SCHEDULE_TEST__.failImagery = false; });
  checks.push("Partial read failures retain the other scheduler types and show a readable error");
  await screen.getByRole("combobox", { name: "筛选会话", exact: true }).click();
  await page.getByRole("option", { name: "全部会话", exact: true }).click();
  await screen.getByRole("button", { name: "刷新定时任务", exact: true }).click(); await ready();
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.screenshot({ path: join(output, "isolated-multi-schedules-light.png") });
  await page.evaluate(async () => { const { setLanguagePreferences } = await import("/src/i18n.ts"); setLanguagePreferences({ language: "en" }); });
  await screen.getByRole("button", { name: "New task", exact: true }).click();
  await screen.getByLabel("Instruction", { exact: true }).waitFor();
  await page.setViewportSize({ width: 380, height: 850 });
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert(layout.scroll <= layout.width, JSON.stringify(layout));
  await page.screenshot({ path: join(output, "isolated-schedule-form-narrow-en.png") });
  checks.push("Light and dark themes, English and the narrow creation layout render without horizontal overflow");
  assert.equal(errors.length, 0, errors.join("\n"));
  const report = { passed: true, isolatedFixtures: true, nativeMutations: 0, checks, selectWidth, layout, rendererErrors: errors };
  writeFileSync(join(output, "isolated-ui-acceptance.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); }

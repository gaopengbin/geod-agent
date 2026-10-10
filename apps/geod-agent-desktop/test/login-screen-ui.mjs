// Real App and account controller, isolated native IPC fixtures. No browser OAuth is started.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const output = resolve("../../artifacts/login-screen-20261007");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1395, height: 900 } });
const errors = [], checks = [];
page.on("pageerror", error => errors.push(error.message));
await page.route(/^https:\/\//, route => route.abort());
await page.addInitScript(() => {
  const params = new URLSearchParams(location.search);
  localStorage.setItem("geod-agent-theme", params.get("theme") || "dark");
  localStorage.setItem("geod-agent-language-v1", JSON.stringify({ language: params.get("lang") || "zh-CN", replyLanguage: "auto" }));
  const fixture = window.__LOGIN_FIXTURE__ = {
    status: { state: params.has("saved") ? "connected" : params.has("unconfigured") ? "unconfigured" : "disconnected", userId: params.has("saved") ? "isolated-login-account" : null, error: null },
    calls: [], unexpected: [], beginError: "", statusError: params.has("offline") ? "暂时无法连接登录服务" : "", statusDelay: 400,
    profileError: params.has("profileError"), profileDelay: Number(params.get("profileDelay") || 0), profileKind: params.get("avatar") || "preset",
  };
  let callbackId = 0;
  window.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => ++callbackId,
    unregisterCallback: () => {},
    convertFileSrc: () => "",
    invoke: async (command, args) => {
      fixture.calls.push(command);
      if (command === "desktop_tray_locale_set") return;
      if (command === "account_profile") {
        const kind = fixture.profileKind, fail = fixture.profileError, id = args.accountId;
        await new Promise(resolve => setTimeout(resolve, fixture.profileDelay));
        if (fail) throw Error("PROFILE_UNAVAILABLE");
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = 30;
        const context = canvas.getContext("2d"); context.fillStyle = "#087e8b"; context.fillRect(0, 0, 30, 30);
        return { accountId: id, email: `${id}@example.test`, nickname: params.has("nickname") ? id === "isolated-login-account" ? "老高 🌍" : "第二个账号" : null, avatar: kind === "preset" ? { kind, id: "summit" } : { kind: "upload", version: "c0b137d7-d6ce-4c64-a45c-f6743e7b0609" }, avatarDataUrl: kind === "preset" ? null : kind === "broken" ? "data:image/webp;base64,invalid" : canvas.toDataURL("image/webp") };
      }
      if (command === "auth_status") {
        const result = structuredClone(fixture.status), error = fixture.statusError;
        await new Promise(resolve => setTimeout(resolve, fixture.statusDelay));
        if (error) throw Error(error);
        return result;
      }
      if (command === "auth_begin") {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (fixture.beginError) throw Error(fixture.beginError);
        fixture.status = { state: "waiting", userId: null, error: null };
        return structuredClone(fixture.status);
      }
      if (command === "auth_logout") {
        fixture.status = { state: "disconnected", userId: null, error: null };
        return structuredClone(fixture.status);
      }
      if (command === "codex_available") return { available: false };
      if (command === "desktop_settings_get") return { updateConfigured: false, automaticUpdateChecks: false };
      if (["jobs_list", "jobs_active", "boundaries_list", "sources_list", "schedules_runs", "schedules_list", "mcp_requests_pending", "data_download_list"].includes(command)) return [];
      if (command === "workspace_default") return { directory: "G:/isolated-login-fixture" };
      if (command === "workspace_get") return { directory: "G:/isolated-login-fixture", permission: "confirmEach" };
      if (command === "imagery_plans_claim") return { claimed: [], rejected: [] };
      if (command === "agent_usage") return { quotaEnforced: false, limitTokens: null, committedTokens: 0, reservedTokens: 0, remainingTokens: null, pendingReconcile: 0 };
      if (command === "ai_channels_list") return { channels: [], sponsors: [], default: { channelId: "hosted", modelId: "deepseek" }, usage: [] };
      if (command === "ai_model_selection") return { channelId: "hosted", modelId: "deepseek" };
      if (command === "agent_payment_snapshot") return { status: { billingMode: "unlimited-test" }, wallet: null };
      if (command === "agent_messages_list") return { schemaVersion: 1, accountId: "isolated-login-account", items: [], unreadCount: 0, checkedAt: new Date().toISOString() };
      if (command === "network_get") return { settings: { mode: "direct", proxyUrl: null }, effectiveProxy: null, source: "直连" };
      if (command === "plugin:event|listen") return callbackId;
      if (command === "plugin:event|unlisten") return;
      fixture.unexpected.push(command);
      throw Error(`Unexpected isolated IPC: ${command}`);
    },
  };
});
async function load(query = "") {
  assert.deepEqual(await page.evaluate(() => window.__LOGIN_FIXTURE__?.unexpected || []), []);
  await page.goto(`http://127.0.0.1:1420/${query}`); await page.locator(".login-screen").waitFor();
}
async function stable() { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(280); }
async function loginReady() { await page.getByRole("button", { name: "使用 GeoD 账号登录", exact: true }).waitFor(); }
const primary = page.locator(".login-primary-action");
try {
  await load();
  await page.getByRole("button", { name: "正在检查登录状态…", exact: true }).waitFor();
  assert.equal(await primary.isEnabled(), false);
  await loginReady(); await stable();
  assert.equal(await page.locator(".workspace").isVisible(), false);
  assert.equal(await page.getByRole("button", { name: "新对话", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "地图选范围", exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__LOGIN_FIXTURE__.calls.filter(c => c === "auth_status").length), 1);
  await page.screenshot({ path: join(output, "isolated-dark.png") });
  checks.push("Startup reads saved authentication once; unsigned users see the dedicated page with no chat, map or navigation controls");

  await page.getByRole("button", { name: "网络与代理", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "语言", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "完成", exact: true }).click();
  await page.getByRole("button", { name: "浅色外观", exact: true }).click();
  await stable();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await page.screenshot({ path: join(output, "isolated-light.png") });
  checks.push("Network, language and appearance settings remain reachable before sign-in");

  await primary.focus();
  await page.keyboard.press("Enter");
  await page.evaluate(() => { for (let n = 0; n < 8; n++) document.querySelector(".login-primary-action").click(); });
  await page.getByRole("button", { name: "等待浏览器授权…", exact: true }).waitFor();
  assert.equal(await primary.isEnabled(), false);
  assert.equal(await page.evaluate(() => window.__LOGIN_FIXTURE__.calls.filter(c => c === "auth_begin").length), 1);
  await page.screenshot({ path: join(output, "isolated-waiting.png") });
  await page.evaluate(() => { window.__LOGIN_FIXTURE__.status = { state: "connected", userId: "isolated-login-account", error: null }; });
  await page.locator(".login-screen").waitFor({ state: "hidden" });
  await page.locator(".workspace").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "新对话", exact: true }).waitFor();
  checks.push("Keyboard sign-in calls the native authorization action once, shows waiting, then automatically enters the real App workspace");
  const settledReads = await page.evaluate(() => window.__LOGIN_FIXTURE__.calls.filter(c => c === "auth_status").length);
  await page.waitForTimeout(1600);
  assert.equal(await page.evaluate(() => window.__LOGIN_FIXTURE__.calls.filter(c => c === "auth_status").length), settledReads);
  checks.push("Browser authorization polling stops after connection");

  await page.getByRole("button", { name: "账号与设置", exact: true }).click();
  await page.locator(".account-menu-identity small").getByText("isolated-login-account@example.test", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-avatar-preset="summit"]').count(), 2);
  assert.equal(await page.evaluate(() => window.__LOGIN_FIXTURE__.calls.filter(c => c === "account_profile").length), 1);
  checks.push("Account preset and email sync into the sidebar and account menu without duplicate requests");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await loginReady();
  assert.equal(await page.locator(".workspace").isVisible(), false);
  await page.evaluate(() => { window.__LOGIN_FIXTURE__.beginError = "无法打开系统浏览器"; });
  await primary.click();
  await page.locator(".login-error").getByText("无法打开系统浏览器").waitFor();
  assert.equal(await primary.isEnabled(), true);
  await page.evaluate(() => { window.__LOGIN_FIXTURE__.beginError = ""; });
  await primary.click();
  await page.getByRole("button", { name: "等待浏览器授权…", exact: true }).waitFor();
  await page.evaluate(() => { window.__LOGIN_FIXTURE__.status = { state: "disconnected", userId: null, error: "本次授权已取消" }; });
  await page.locator(".login-error").getByText("本次授权已取消").waitFor();
  assert.equal(await primary.isEnabled(), true);
  await page.screenshot({ path: join(output, "isolated-error.png") });
  checks.push("Logout returns to login; browser-open failures and rejected authorization remain visible and retryable");

  assert.deepEqual(await page.evaluate(() => window.__LOGIN_FIXTURE__.unexpected), []);
  await page.goto("http://127.0.0.1:1420/?saved=1");
  await page.locator(".workspace").waitFor({ state: "visible" });
  assert.equal(await page.locator(".login-screen").count(), 0);
  assert.equal(await page.evaluate(() => window.__LOGIN_FIXTURE__.calls.includes("auth_begin")), false);
  checks.push("A saved authenticated account enters the workspace without opening the browser again");

  await page.goto("http://127.0.0.1:1420/?saved=1&avatar=upload&nickname=1");
  await page.locator(".conversation-account-trigger .account-avatar img").waitFor();
  await page.getByRole("button", { name: "账号与设置", exact: true }).click();
  await page.locator(".account-menu-identity .account-avatar img").waitFor();
  assert.equal(await page.locator(".conversation-account-trigger strong").innerText(), "老高 🌍");
  assert.equal(await page.locator(".account-menu-identity strong").innerText(), "老高 🌍");
  assert.equal(await page.locator(".account-avatar img").evaluateAll(images => images.every(image => image.complete && image.naturalWidth === 30)), true);
  assert.equal(await page.locator(".account-avatar img").evaluateAll(images => images[0].src === images[1].src), true);
  await stable();
  await page.screenshot({ path: join(output, "avatar-upload-dark.png") });
  checks.push("Uploaded avatar and Unicode nickname display in both locations with native-owned bytes and fixed dimensions");

  await page.goto("http://127.0.0.1:1420/?saved=1&avatar=broken&theme=light");
  await page.locator(".conversation-account-trigger [data-avatar-preset]").waitFor();
  assert.equal(await page.locator(".conversation-account-trigger .account-avatar").evaluate(element => Math.round(element.getBoundingClientRect().width)), 30);
  checks.push("Invalid uploaded image falls back to the account-site preset without changing layout");

  await page.goto("http://127.0.0.1:1420/?saved=1&profileError=1");
  await page.locator(".workspace").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "账号与设置", exact: true }).click();
  await page.getByRole("button", { name: "重新同步头像与账号", exact: true }).waitFor();
  await page.evaluate(() => { window.__LOGIN_FIXTURE__.profileError = false; });
  await page.getByRole("button", { name: "重新同步头像与账号", exact: true }).click();
  await page.locator('.account-menu-identity [data-avatar-preset="summit"]').waitFor();
  assert.equal(await page.getByRole("button", { name: "重新同步头像与账号", exact: true }).count(), 0);
  checks.push("Profile errors preserve sign-in and can be retried from the account menu");

  await page.goto("http://127.0.0.1:1420/?saved=1&profileDelay=3000&avatar=upload&nickname=1");
  await page.locator(".workspace").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "账号与设置", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await loginReady();
  await page.evaluate(() => { window.__LOGIN_FIXTURE__.profileDelay = 0; window.__LOGIN_FIXTURE__.profileKind = "preset"; });
  await primary.click();
  await page.getByRole("button", { name: "等待浏览器授权…", exact: true }).waitFor();
  await page.evaluate(() => { window.__LOGIN_FIXTURE__.status = { state: "connected", userId: "second-avatar-account", error: null }; });
  await page.locator(".workspace").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "账号与设置", exact: true }).click();
  await page.locator(".account-menu-identity small").getByText("second-avatar-account@example.test", { exact: true }).waitFor();
  await page.waitForTimeout(3200);
  assert.equal(await page.locator(".account-avatar img").count(), 0);
  assert.equal(await page.locator(".account-menu-identity small").innerText(), "second-avatar-account@example.test");
  assert.equal(await page.locator(".account-menu-identity strong").innerText(), "第二个账号");
  checks.push("Logout and a second sign-in discard the previous account's delayed profile and uploaded image");

  await load("?unconfigured=1"); await loginReady();
  assert.equal(await primary.isEnabled(), false);
  await page.getByText("登录服务尚未配置，暂时无法登录。", { exact: true }).waitFor();
  await page.evaluate(() => { window.__LOGIN_FIXTURE__.statusError = "暂时无法连接登录服务"; });
  await page.getByRole("button", { name: "重新检查登录状态", exact: true }).click();
  await page.locator(".login-error").getByText("暂时无法连接登录服务").waitFor();
  await page.evaluate(() => { window.__LOGIN_FIXTURE__.statusError = ""; window.__LOGIN_FIXTURE__.status = { state: "disconnected", userId: null, error: null }; });
  await page.getByRole("button", { name: "重新检查登录状态", exact: true }).click();
  await loginReady(); assert.equal(await primary.isEnabled(), true);
  checks.push("Unconfigured or unreachable authentication can be rechecked without pretending the user is signed in");

  await load("?offline=1");
  await page.locator(".login-error").getByText("暂时无法连接登录服务").waitFor();
  await page.getByText("暂时无法读取登录状态，请重新检查。", { exact: true }).waitFor();
  assert.equal(await page.getByText("登录服务尚未配置，暂时无法登录。", { exact: true }).count(), 0);
  await page.evaluate(() => { window.__LOGIN_FIXTURE__.statusError = ""; });
  await page.getByRole("button", { name: "重新检查登录状态", exact: true }).click();
  await loginReady(); assert.equal(await primary.isEnabled(), true);
  checks.push("An initial status-read failure is distinguished from a missing service configuration and can recover");

  await page.setViewportSize({ width: 360, height: 640 });
  await load("?lang=en");
  await page.getByRole("button", { name: "Sign in with GeoD", exact: true }).waitFor();
  await stable();
  assert.equal(await page.evaluate(() => document.querySelector(".login-screen").scrollWidth <= innerWidth), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(output, "isolated-english-narrow.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await page.locator(".login-content").evaluate(e => getComputedStyle(e).animationName), "none");
  checks.push("English and 360px layouts have no horizontal overflow; reduced motion disables decorative movement");

  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => window.__LOGIN_FIXTURE__.unexpected), []);
  writeFileSync(join(output, "ui-acceptance.json"), JSON.stringify({ passed: true, fixtureNativeIpc: true, realOAuthStarted: false, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, errors, output }, null, 2));
} finally { await browser.close(); }

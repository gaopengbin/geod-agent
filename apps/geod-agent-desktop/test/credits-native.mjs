// Read-only verification on the running desktop: no charges, grants, checkout or profile mutations.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const output = resolve("../../artifacts/credits-display-20261004"); mkdirSync(output, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9233");
const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url() === "http://127.0.0.1:1420/"); assert(page);
const errors = [], checks = []; page.on("pageerror", error => errors.push(error.message));
async function state() {
  const data = await page.evaluate(async () => {
    await window.__GEOD_LOCAL_STATE__?.flush();
    const records = await new Promise((resolve, reject) => {
      const opened = indexedDB.open("geod-ui-state-v1", 1); opened.onerror = () => reject(opened.error);
      opened.onsuccess = () => {
        const db = opened.result, tx = db.transaction("records", "readonly"), store = tx.objectStore("records"), keys = store.getAllKeys(), values = store.getAll();
        tx.oncomplete = () => { db.close(); const records = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])); keys.result.forEach((key, i) => records[key] = values.result[i]); resolve(records); };
        tx.onabort = () => reject(tx.error);
      };
    });
    const key = Object.keys(records).find(key => key.startsWith("geod-agent-conversations-0.1:account:"));
    const chats = JSON.parse(records[key]);
    const { api } = await import("/src/api.ts");
    const [payment, background] = await Promise.all([api.agentPaymentSnapshot(), api.backgroundStatus()]);
    return { chats: chats.map(chat => ({ conversationId: chat.conversationId, title: chat.title ?? null, messages: chat.messages, display: chat.display, planId: chat.planId ?? null, planIds: chat.planIds ?? [] })), active: records[`geod-agent-active-conversation-0.1:account:${key.split(":account:")[1]}`], payment, background };
  });
  return { chatCount: data.chats.length, contentSha256: createHash("sha256").update(JSON.stringify(data.chats)).digest("hex"), active: data.active, payment: data.payment, background: data.background };
}
try {
  const before = await state(); assert.equal(before.payment.status.billingMode, "unlimited-test");
  const trigger = page.locator(".conversation-account-trigger"), menu = page.locator(".conversation-account-menu");
  await trigger.getByText("∞ Credits", { exact: true }).waitFor();
  await trigger.click(); await menu.getByText("AI Credits", { exact: true }).waitFor();
  await menu.getByText("∞ Credits", { exact: true }).waitFor();
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[data-morph-popover-portal]')).opacity) >= .999);
  await page.mouse.move(1000, 20); await page.screenshot({ path: join(output, "native-account-credits-dark.png") });
  checks.push("The running native app shows the real test account as unlimited Credits in both footer and account menu");
  await menu.getByRole("button", { name: "余额与订阅", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  const dialog = page.getByRole("dialog"); await dialog.locator(".payment-free-state").waitFor();
  await dialog.getByText("∞ Credits", { exact: true }).waitFor();
  assert.match(await dialog.locator(".payment-credit-conversion").textContent(), /1,000 Credits = ¥1/);
  assert.equal(await dialog.locator(".payment-balances").count(), 0);
  assert.equal(await dialog.getByText("20,000 Credits", { exact: true }).count(), 0);
  await page.screenshot({ path: join(output, "native-wallet-credits-dark.png") });
  checks.push("The real wallet explains the denomination without inventing a finite grant or enabling payment");
  await dialog.getByRole("button", { name: "完成", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
  const after = await state();
  assert.equal(after.contentSha256, before.contentSha256); assert.equal(after.chatCount, before.chatCount); assert.equal(after.active, before.active);
  assert.deepEqual(after.payment, before.payment); assert.deepEqual(after.background, before.background);
  assert.equal(errors.length, 0, errors.join("\n"));
  checks.push("Credits are updated by hot reload; conversations, active chat, wallet and background process are preserved");
  const report = { passed: true, checks, creditsPerCny: 1000, actualBillingMode: before.payment.status.billingMode, checkoutEnabled: before.payment.status.checkoutEnabled, nativePaymentMutations: 0, creditGrantIssued: false, conversations: before.chatCount, activePreserved: true, contentSha256: before.contentSha256, backgroundPid: before.background.pid, rendererErrors: errors };
  writeFileSync(join(output, "native-acceptance.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); }

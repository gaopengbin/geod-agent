// Finite balances are native-contract fixtures in an isolated browser, never a real grant or charge.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = await import(pathToFileURL("C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs").href);
const output = resolve("../../artifacts/credits-display-20261004"); mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [], checks = []; page.on("pageerror", error => errors.push(error.message));
await page.addInitScript(() => {
  window.isTauri = true;
  localStorage.setItem("geod-agent-language-v1", JSON.stringify({ language: "zh-CN", replyLanguage: "auto" }));
  const now = Date.now(), rates = { cachedInput: "80", uncachedInput: "4000", output: "16000" };
  const products = [
    { id: "topup10", name: "AI 余额 10 元", kind: "topup", priceFen: 1000, creditNanoCny: "10000000000", days: 0 },
    { id: "topup20", name: "AI 余额 20 元", kind: "topup", priceFen: 2000, creditNanoCny: "20000000000", days: 0 },
    { id: "month", name: "月订阅", kind: "subscription", priceFen: 2900, creditNanoCny: "10000000000", days: 30 }
  ];
  const snapshot = {
    status: { candidate: true, available: true, checkoutEnabled: false, environment: "isolated", fixture: false, billingMode: "prepaid", pricingVersion: "isolated-candidate", pricesApproved: false, products },
    wallet: { balanceNanoCny: "20000000000", reservedNanoCny: "100000000", availableNanoCny: "19900000000", frozenNanoCny: "0", subscription: null, refunds: [],
      orders: [{ orderId: "isolated-paid-order", product: products[0], priceFen: 1000, creditNanoCny: products[0].creditNanoCny, currency: "CNY", status: "paid", createdAt: now, expiresAt: now, paidAt: now, environment: "isolated", fixture: false }],
      charges: [
        { generationId: "isolated-usage", chargeNanoCny: "8744960", createdAt: now, model: "DeepSeek Flash", inputTokens: 640, cachedInputTokens: 512, outputTokens: 512, reasoningTokens: null, pricingVersion: "isolated-candidate", pricingDigest: null, ratesNanoPerToken: rates },
        { generationId: "isolated-tiny", chargeNanoCny: "80", createdAt: now, model: "DeepSeek Flash", inputTokens: 1, cachedInputTokens: 1, outputTokens: 0, reasoningTokens: null, pricingVersion: "isolated-candidate", pricingDigest: null, ratesNanoPerToken: rates }
      ], chargeCount: 2,
      reservations: [{ generationId: "isolated-held", maximumNanoCny: "100000000", createdAt: now, model: "DeepSeek Flash", pricingVersion: "isolated-candidate" }], reservationCount: 1
    }
  };
  window.__CREDITS_TEST__ = { snapshot, fail: false, calls: [] };
  window.__TAURI_INTERNALS__ = { invoke: async command => {
    window.__CREDITS_TEST__.calls.push(command);
    if (command !== "agent_payment_snapshot") throw new Error(`Unexpected isolated IPC: ${command}`);
    if (window.__CREDITS_TEST__.fail) throw new Error("Isolated wallet read failure");
    return structuredClone(snapshot);
  } };
});
const trigger = page.locator(".conversation-account-trigger"), menu = page.locator(".conversation-account-menu"), dialog = page.getByRole("dialog");
async function openAccount() { await trigger.click(); await menu.waitFor(); await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[data-morph-popover-portal]')).opacity) >= .999); }
async function closeWallet() { await dialog.getByRole("button", { name: /^(完成|Done)$/ }).click(); await dialog.waitFor({ state: "hidden" }); }
try {
  await page.goto("http://127.0.0.1:1420/test/credits-harness.html");
  await trigger.getByText("19,900 Credits", { exact: true }).waitFor();
  const formats = await page.evaluate(async () => {
    const { formatCredits, formatCreditRate } = await import("/src/credits.ts");
    return [formatCredits("20000000000"), formatCredits("19999999"), formatCredits("80"), formatCredits("80", 6), formatCredits("0"), formatCredits(null), formatCredits("wrong"), formatCreditRate("80"), formatCreditRate("4000"), formatCreditRate("16000")];
  });
  assert.deepEqual(formats, ["20,000 Credits", "19.99 Credits", "<0.01 Credits", "0.00008 Credits", "0 Credits", "—", "—", "80 Credits", "4,000 Credits", "16,000 Credits"]);
  checks.push("Nano-CNY maps exactly to Credits; small charges retain precision; balance truncation never increases spendable value");
  await openAccount();
  await menu.getByText("19,900 Credits", { exact: true }).waitFor();
  await menu.getByText("请求预留 100 Credits", { exact: true }).waitFor();
  assert.equal(await menu.getByText("∞ Credits", { exact: true }).count(), 0);
  await page.screenshot({ path: join(output, "isolated-account-credits-dark.png") });
  checks.push("Account footer and menu show spendable Credits; a prepaid account with quotaEnforced=false is not mistaken for unlimited");
  await menu.getByRole("button", { name: "余额与订阅", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  await dialog.locator(".payment-balances").waitFor();
  assert.deepEqual(await dialog.locator(".payment-balances strong").allTextContents(), ["19,900 Credits", "100 Credits"]);
  assert.deepEqual(await dialog.locator(".payment-product strong").allTextContents(), ["10,000 Credits", "20,000 Credits", "GeoD Agent 月订阅"]);
  assert((await dialog.locator(".payment-product > b").allTextContents()).every(text => /¥|￥/.test(text)));
  assert(await dialog.locator(".payment-credit-conversion").textContent().then(text => text.includes("1,000 Credits = ¥1")));
  await page.screenshot({ path: join(output, "isolated-wallet-credits-dark.png") });
  checks.push("Wallet, reserved value and top-ups use Credits while checkout prices remain CNY and inactive");
  await dialog.getByRole("tab", { name: "AI 用量", exact: true }).click();
  assert.equal(await dialog.locator('[data-charge-id="isolated-tiny"] b').textContent(), "0.00008 Credits");
  assert.equal(await dialog.locator('[data-charge-id="isolated-usage"] b').textContent(), "8.74496 Credits");
  await dialog.locator('[data-charge-id="isolated-usage"] summary').click();
  const rateText = await dialog.locator('[data-charge-id="isolated-usage"] .payment-charge-rates').textContent();
  assert(rateText.includes("4,000 Credits") && rateText.includes("80 Credits") && rateText.includes("16,000 Credits"));
  await page.screenshot({ path: join(output, "isolated-usage-credits-dark.png") });
  checks.push("Deductions, reservations and rate breakdown use Credits, including nonzero microscopic deductions");
  await dialog.getByRole("tab", { name: "支付记录 · 1", exact: true }).click();
  assert.equal(await dialog.locator('[data-order-id="isolated-paid-order"] .payment-order-heading strong').textContent(), "10,000 Credits");
  assert.match(await dialog.locator('[data-order-id="isolated-paid-order"] .payment-order-meta b').textContent(), /¥|￥/);
  checks.push("Payment history retains actual yuan amounts alongside credited Credits");
  await page.evaluate(() => { const wallet = window.__CREDITS_TEST__.snapshot.wallet; wallet.balanceNanoCny = "18000000000"; wallet.availableNanoCny = "17900000000"; });
  await dialog.getByRole("button", { name: "刷新支付状态", exact: true }).click();
  await closeWallet(); await trigger.getByText("17,900 Credits", { exact: true }).waitFor();
  await page.evaluate(() => {
    const snapshot = structuredClone(window.__CREDITS_TEST__.snapshot); snapshot.wallet.availableNanoCny = "999000000000";
    window.dispatchEvent(new CustomEvent("geod:credits-changed", { detail: { accountId: "other-account", snapshot } }));
  });
  assert.match(await trigger.textContent(), /17,900 Credits/);
  await page.evaluate(() => { window.__CREDITS_TEST__.snapshot.wallet.availableNanoCny = "16900000000"; window.dispatchEvent(new Event("isolated:consumed")); });
  await trigger.getByText("16,900 Credits", { exact: true }).waitFor();
  checks.push("Wallet refresh and model settlement refresh the footer; another account's balance event cannot replace it");
  await page.evaluate(() => { window.__CREDITS_TEST__.fail = true; window.dispatchEvent(new Event("isolated:consumed")); });
  await openAccount(); await menu.getByText("额度暂不可用", { exact: true }).waitFor();
  assert.equal(await menu.getByText("∞ Credits", { exact: true }).count(), 0);
  await trigger.click();
  await page.evaluate(() => { window.__CREDITS_TEST__.fail = false; window.dispatchEvent(new Event("isolated:consumed")); });
  await trigger.getByText("16,900 Credits", { exact: true }).waitFor();
  checks.push("A read failure is visibly unavailable and can recover; it never invents zero or unlimited credit");
  await openAccount(); await menu.getByRole("button", { name: "余额与订阅", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  await dialog.locator(".payment-balances").waitFor();
  await page.evaluate(async () => { document.documentElement.dataset.theme = "light"; const { setLanguagePreferences } = await import("/src/i18n.ts"); setLanguagePreferences({ language: "en" }); });
  await dialog.getByText("Available Credits", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "isolated-wallet-credits-light-en.png") });
  await page.setViewportSize({ width: 390, height: 850 });
  const bounds = await dialog.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth, client: el.clientWidth, scroll: el.scrollWidth }; });
  assert(bounds.left >= 0 && bounds.right <= bounds.width && bounds.scroll <= bounds.client, JSON.stringify(bounds));
  assert.equal(await dialog.locator(".payment-balances").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length), 1);
  await page.screenshot({ path: join(output, "isolated-wallet-credits-narrow-en.png") });
  await closeWallet();
  checks.push("Dark and light themes and English display clear values; the narrow wallet stacks balances without overflow");
  await page.evaluate(() => { const s = window.__CREDITS_TEST__.snapshot; s.status.billingMode = "unlimited-test"; s.wallet = null; window.dispatchEvent(new Event("isolated:consumed")); });
  await trigger.getByText("∞ Credits", { exact: true }).waitFor();
  await openAccount(); await menu.getByText("∞ Credits", { exact: true }).waitFor();
  checks.push("Unlimited test mode is explicitly unlimited rather than showing a fictitious finite grant");
  assert.equal(errors.length, 0, errors.join("\n"));
  const calls = await page.evaluate(() => window.__CREDITS_TEST__.calls);
  assert(calls.every(command => command === "agent_payment_snapshot"));
  const report = { passed: true, isolatedFixtures: true, nativeMutations: 0, creditGrantIssued: false, creditsPerCny: 1000, checks, formats, bounds, rendererErrors: errors };
  writeFileSync(join(output, "isolated-ui-acceptance.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally { await browser.close(); }

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openLedger } from "../ledger.mjs";

test("provider cache counters persist without double charging and missing counters remain unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "geod-ledger-cache-"));
  const path = join(directory, "usage.sqlite");
  const ledger = openLedger(path, 100_000, "cache-test-secret".repeat(3), false);
  try {
    for (const generationId of ["cache-1", "cache-2"]) {
      ledger.reserve({ userId: "test", generationId, conversationId: "case", requestHash: generationId, model: "deepseek-flash", reserveTokens: 20_000 });
      ledger.markStreaming("test", generationId);
      ledger.settle("test", generationId, 1000, 100, "provider-" + generationId, { content: "done" }, generationId === "cache-1" ? { cachedInputTokens: 900, reasoningTokens: 40, upstreamModel: "deepseek-flash" } : {});
    }
    assert.equal(ledger.usage("test").committedTokens, 2200);
    const db = new Database(path, { readonly: true });
    try {
      assert.deepEqual(db.prepare("SELECT cached_input_tokens,reasoning_tokens,upstream_model FROM model_generations ORDER BY generation_id").all(), [
        { cached_input_tokens: 900, reasoning_tokens: 40, upstream_model: "deepseek-flash" },
        { cached_input_tokens: null, reasoning_tokens: null, upstream_model: null },
      ]);
    } finally { db.close(); }
  } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("pending request reserves quota until evidence-backed reconciliation", () => {
  const directory = mkdtempSync(join(tmpdir(), "geod-ledger-"));
  const path = join(directory, "usage.sqlite");
  const secret = "s".repeat(40);
  try {
    let ledger = openLedger(path, 30_000, secret);
    ledger.reserve({ userId: "u1", generationId: "g1", conversationId: "c1", requestHash: "hash", model: "model", reserveTokens: 20_000 });
    ledger.markStreaming("u1", "g1");
    ledger.close();
    ledger = openLedger(path, 30_000, secret);
    assert.equal(ledger.get("u1", "g1").state, "pending_reconcile");
    assert.equal(ledger.usage("u1").remainingTokens, 10_000);
    assert.throws(() => ledger.reconcile({ userId: "u1", generationId: "g1", decision: "release", operator: "qa", evidence: "weak" }), /evidence/);
    const result = { role: "assistant", content: "private output", toolCalls: [] };
    assert.equal(ledger.reconcile({ userId: "u1", generationId: "g1", decision: "settle", operator: "qa", evidence: "Provider log shows 120+30 tokens", inputTokens: 120, outputTokens: 30, upstreamRequestId: "upstream-1", result }).state, "settled");
    assert.equal(ledger.usage("u1").committedTokens, 150);
    assert.equal(ledger.get("u1", "g1").result.content, "private output");
    assert.equal(ledger.pendingList().length, 0);
    ledger.close();
    const db = new Database(path);
    const raw = db.prepare("SELECT response_ciphertext FROM model_generations WHERE generation_id='g1'").get().response_ciphertext;
    assert.equal(raw.includes("private output"), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reconciliation_audit").get().count, 1);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("verified no-usage releases a pending reservation once", () => {
  const directory = mkdtempSync(join(tmpdir(), "geod-ledger-"));
  try {
    const ledger = openLedger(join(directory, "usage.sqlite"), 30_000, "s".repeat(40));
    ledger.reserve({ userId: "u1", generationId: "g1", conversationId: "c1", requestHash: "hash", model: "model", reserveTokens: 20_000 });
    ledger.markStreaming("u1", "g1");
    ledger.pending("u1", "g1", "UPSTREAM_UNKNOWN");
    assert.equal(ledger.reconcile({ userId: "u1", generationId: "g1", decision: "release", operator: "qa", evidence: "Provider log confirms no matching request" }).state, "failed");
    assert.equal(ledger.usage("u1").remainingTokens, 30_000);
    assert.throws(() => ledger.reconcile({ userId: "u1", generationId: "g1", decision: "release", operator: "qa", evidence: "Provider log confirms no matching request" }), /not pending/);
    ledger.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("unlimited testing preserves accounting and allows requests beyond the configured budget", () => {
  const directory = mkdtempSync(join(tmpdir(), "geod-unlimited-"));
  const path = join(directory, "usage.sqlite");
  const secret = "s".repeat(40);
  try {
    let ledger = openLedger(path, 30_000, secret, false);
    const first = { userId: "u1", generationId: "g1", conversationId: "c1", requestHash: "hash1", model: "model", reserveTokens: 20_000 };
    ledger.reserve(first);
    ledger.markStreaming("u1", "g1");
    ledger.settle("u1", "g1", 40_000, 100, "upstream-1", {content:"test",toolCalls:[]});
    assert.equal(ledger.usage("u1").quotaEnforced, false);
    assert.equal(ledger.usage("u1").limitTokens, null);
    assert.equal(ledger.usage("u1").remainingTokens, null);
    assert.equal(ledger.usage("u1").committedTokens, 40_100);
    assert.equal(ledger.reserve(first).replayed, true);
    assert.equal(ledger.usage("u1").committedTokens, 40_100);
    const second = { ...first, generationId: "g2", requestHash: "hash2" };
    assert.equal(ledger.reserve(second).quotaExceeded, undefined);
    assert.equal(ledger.usage("u1").reservedTokens, 20_000);
    ledger.fail("u1", "g2", "TEST_NO_UPSTREAM");
    ledger.close();
    ledger = openLedger(path, 30_000, secret);
    assert.equal(ledger.usage("u1").committedTokens, 40_100);
    assert.equal(ledger.usage("u1").quotaEnforced, true);
    assert.equal(ledger.reserve({ ...first, generationId: "g3", requestHash: "hash3" }).quotaExceeded, true);
    ledger.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

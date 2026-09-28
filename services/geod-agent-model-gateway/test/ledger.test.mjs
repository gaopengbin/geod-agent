import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { openLedger } from "../ledger.mjs";

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

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

export function openLedger(path, tokenLimit, encryptionSecret) {
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0) throw new Error("GEOD_AGENT_TOKEN_LIMIT must be a positive integer");
  if (typeof encryptionSecret !== "string" || encryptionSecret.length < 32) throw new Error("Result encryption secret must contain at least 32 characters");
  const key = createHash("sha256").update(encryptionSecret).digest();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE IF NOT EXISTS quota_policy_versions (
      policy_id TEXT PRIMARY KEY, token_limit INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_generations (
      user_id TEXT NOT NULL, generation_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL,
      reserved_tokens INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
      upstream_request_id TEXT, error_code TEXT, response_ciphertext TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, generation_id)
    );
    CREATE TABLE IF NOT EXISTS usage_ledger (
      entry_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, generation_id TEXT NOT NULL,
      kind TEXT NOT NULL, tokens INTEGER NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(user_id, generation_id, kind),
      FOREIGN KEY(user_id, generation_id) REFERENCES model_generations(user_id, generation_id)
    );
    CREATE INDEX IF NOT EXISTS usage_ledger_user ON usage_ledger(user_id);
    CREATE TABLE IF NOT EXISTS reconciliation_audit (
      audit_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, generation_id TEXT NOT NULL,
      decision TEXT NOT NULL, evidence TEXT NOT NULL, operator TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  if (!db.prepare("PRAGMA table_info(model_generations)").all().some(row => row.name === "response_ciphertext")) {
    db.exec("ALTER TABLE model_generations ADD COLUMN response_ciphertext TEXT");
  }
  const now = new Date().toISOString();
  const policyId = `token-policy-0.1-${tokenLimit}`;
  db.prepare("INSERT OR IGNORE INTO quota_policy_versions(policy_id,token_limit,created_at) VALUES (?,?,?)").run(policyId, tokenLimit, now);
  // A process crash may happen after the upstream accepted a request. Keep
  // its reservation until an operator reconciles the provider usage record.
  db.prepare("UPDATE model_generations SET state='pending_reconcile',error_code='PROCESS_INTERRUPTED',updated_at=? WHERE state='streaming'").run(now);
  const projected = db.prepare("SELECT COALESCE(SUM(tokens),0) AS tokens FROM usage_ledger WHERE user_id=?");
  const get = db.prepare("SELECT * FROM model_generations WHERE user_id=? AND generation_id=?");
  const entry = db.prepare("INSERT INTO usage_ledger(entry_id,user_id,generation_id,kind,tokens,created_at) VALUES (?,?,?,?,?,?)");
  const reserveTx = db.transaction(({ userId, generationId, conversationId, requestHash, model, reserveTokens }) => {
    const existing = get.get(userId, generationId);
    if (existing) {
      if (existing.request_hash !== requestHash) return { conflict: true };
      return { replayed: true, generation: publicGeneration(existing, key) };
    }
    const used = projected.get(userId).tokens;
    if (used + reserveTokens > tokenLimit) return { quotaExceeded: true, used, remaining: Math.max(0, tokenLimit - used) };
    const at = new Date().toISOString();
    db.prepare("INSERT INTO model_generations(user_id,generation_id,conversation_id,request_hash,model,state,reserved_tokens,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(userId, generationId, conversationId, requestHash, model, "reserved", reserveTokens, at, at);
    entry.run(randomUUID(), userId, generationId, "reserve", reserveTokens, at);
    return { replayed: false, generation: publicGeneration(get.get(userId, generationId), key) };
  });
  const settleTx = db.transaction((userId, generationId, inputTokens, outputTokens, upstreamRequestId, result) => {
    const current = get.get(userId, generationId);
    if (!current || current.state !== "streaming") throw new Error("Generation is not settling from streaming");
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) throw new Error("Upstream usage is invalid");
    const at = new Date().toISOString();
    db.prepare("UPDATE model_generations SET state='settled',input_tokens=?,output_tokens=?,upstream_request_id=?,response_ciphertext=?,updated_at=? WHERE user_id=? AND generation_id=?")
      .run(inputTokens, outputTokens, upstreamRequestId, encrypt(result, key), at, userId, generationId);
    entry.run(randomUUID(), userId, generationId, "release", -current.reserved_tokens, at);
    entry.run(randomUUID(), userId, generationId, "settle", inputTokens + outputTokens, at);
    return publicGeneration(get.get(userId, generationId), key);
  });
  const failTx = db.transaction((userId, generationId, code) => {
    const current = get.get(userId, generationId);
    if (!current || !["reserved", "streaming"].includes(current.state)) throw new Error("Generation cannot fail from this state");
    const at = new Date().toISOString();
    db.prepare("UPDATE model_generations SET state='failed',error_code=?,updated_at=? WHERE user_id=? AND generation_id=?").run(code, at, userId, generationId);
    entry.run(randomUUID(), userId, generationId, "release", -current.reserved_tokens, at);
    return publicGeneration(get.get(userId, generationId), key);
  });
  return {
    reserve: reserveTx,
    markStreaming(userId, generationId) {
      const changed = db.prepare("UPDATE model_generations SET state='streaming',updated_at=? WHERE user_id=? AND generation_id=? AND state='reserved'").run(new Date().toISOString(), userId, generationId);
      if (changed.changes !== 1) throw new Error("Generation was not reserved");
    },
    settle: settleTx,
    fail: failTx,
    pending(userId, generationId, code) {
      db.prepare("UPDATE model_generations SET state='pending_reconcile',error_code=?,updated_at=? WHERE user_id=? AND generation_id=? AND state='streaming'").run(code, new Date().toISOString(), userId, generationId);
      return publicGeneration(get.get(userId, generationId), key);
    },
    reconcile: db.transaction(({ userId, generationId, decision, evidence, operator, inputTokens, outputTokens, upstreamRequestId, result }) => {
      if (typeof evidence !== "string" || evidence.trim().length < 16 || evidence.length > 2000 || typeof operator !== "string" || operator.length < 2 || operator.length > 100) throw new Error("A named operator and provider evidence are required");
      const current = get.get(userId, generationId);
      if (!current || current.state !== "pending_reconcile") throw new Error("Generation is not pending reconciliation");
      const at = new Date().toISOString();
      if (decision === "release") {
        db.prepare("UPDATE model_generations SET state='failed',error_code='RECONCILED_NO_USAGE',updated_at=? WHERE user_id=? AND generation_id=?").run(at, userId, generationId);
        entry.run(randomUUID(), userId, generationId, "release", -current.reserved_tokens, at);
      } else if (decision === "settle") {
        if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0 || typeof upstreamRequestId !== "string" || !upstreamRequestId) throw new Error("Provider usage and request ID are required to settle");
        db.prepare("UPDATE model_generations SET state='settled',input_tokens=?,output_tokens=?,upstream_request_id=?,response_ciphertext=?,error_code=NULL,updated_at=? WHERE user_id=? AND generation_id=?")
          .run(inputTokens, outputTokens, upstreamRequestId, result ? encrypt(result, key) : null, at, userId, generationId);
        entry.run(randomUUID(), userId, generationId, "release", -current.reserved_tokens, at);
        entry.run(randomUUID(), userId, generationId, "settle", inputTokens + outputTokens, at);
      } else throw new Error("Reconciliation decision must be release or settle");
      db.prepare("INSERT INTO reconciliation_audit(audit_id,user_id,generation_id,decision,evidence,operator,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(randomUUID(), userId, generationId, decision, evidence.trim(), operator, at);
      return publicGeneration(get.get(userId, generationId), key);
    }),
    get(userId, generationId) { const row = get.get(userId, generationId); return row ? publicGeneration(row, key) : null; },
    pendingList() {
      return db.prepare("SELECT user_id,generation_id,created_at,updated_at,error_code,upstream_request_id,reserved_tokens FROM model_generations WHERE state='pending_reconcile' ORDER BY created_at LIMIT 100").all();
    },
    usage(userId) {
      const rows = db.prepare("SELECT state,reserved_tokens,input_tokens,output_tokens FROM model_generations WHERE user_id=?").all(userId);
      const committed = rows.filter(row => row.state === "settled").reduce((sum, row) => sum + row.input_tokens + row.output_tokens, 0);
      const reserved = rows.filter(row => ["reserved", "streaming", "pending_reconcile"].includes(row.state)).reduce((sum, row) => sum + row.reserved_tokens, 0);
      return { policyId, limitTokens: tokenLimit, committedTokens: committed, reservedTokens: reserved, remainingTokens: Math.max(0, tokenLimit - committed - reserved), pendingReconcile: rows.filter(row => row.state === "pending_reconcile").length };
    },
    close() { db.close(); },
  };
}

function encrypt(value, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString("base64");
}
function decrypt(value, key) {
  const packed = Buffer.from(value, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8"));
}
function publicGeneration(row, key) {
  return { generationId: row.generation_id, conversationId: row.conversation_id, state: row.state, model: row.model, reservedTokens: row.reserved_tokens, inputTokens: row.input_tokens, outputTokens: row.output_tokens, upstreamRequestId: row.upstream_request_id, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at, result: row.response_ciphertext ? decrypt(row.response_ciphertext, key) : null };
}

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openLedger } from "./ledger.mjs";

const dbPath = resolve(process.env.GEOD_AGENT_DB_PATH || "./data/agent-model.sqlite");
const secret = process.env.GEOD_AGENT_GATEWAY_SECRET;
const tokenLimit = Number(process.env.GEOD_AGENT_TOKEN_LIMIT || 100_000);
const ledger = openLedger(dbPath, tokenLimit, secret, process.env.GEOD_AGENT_QUOTA_MODE !== "unlimited");
try {
  if (process.argv[2] === "--list") {
    process.stdout.write(`${JSON.stringify(ledger.pendingList(), null, 2)}\n`);
  } else if (process.argv[2] === "--decision-file" && process.argv[3]) {
    const decision = JSON.parse(readFileSync(resolve(process.argv[3]), "utf8"));
    const result = ledger.reconcile(decision);
    process.stdout.write(`${JSON.stringify({ generationId: result.generationId, state: result.state, inputTokens: result.inputTokens, outputTokens: result.outputTokens })}\n`);
  } else {
    throw new Error("Usage: node reconcile.mjs --list | --decision-file <JSON path>");
  }
} finally { ledger.close(); }

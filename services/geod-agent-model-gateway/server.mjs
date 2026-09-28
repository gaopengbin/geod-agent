import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { openLedger } from "./ledger.mjs";

const TOOL_NAMES = new Set(["sources_list", "plan_imagery", "jobs_get", "artifacts_inspect"]);
const TOOLS = [
  { type: "function", function: { name: "sources_list", description: "List imagery sources registered on this device. Read only.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "plan_imagery", description: "Calculate a local imagery plan. This does not approve or start a download.", parameters: { type: "object", properties: { sourceId: { type: "string" }, bounds: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 }, zoom: { type: "integer" }, outputFormats: { type: "array", items: { type: "string", enum: ["geotiff", "mbtiles"] } } }, required: ["sourceId", "bounds", "zoom", "outputFormats"], additionalProperties: false } } },
  { type: "function", function: { name: "jobs_get", description: "Read the current state of a local job by ID.", parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false } } },
  { type: "function", function: { name: "artifacts_inspect", description: "Read and verify the manifest of a completed local job.", parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false } } },
];
const SYSTEM = "You are GeoD Agent, an imagery planning assistant. Use only the offered read-only tools for facts about local sources, plans, jobs, and artifacts. Never claim a download ran, permission was granted, or a file was verified without the corresponding local tool result. A plan is not approval. Ask the user to review the concrete plan in the desktop app before any download. Reply in the user's language.";
const RESERVATION_TOKENS = 20_000;

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function safeUrl(raw, label) {
  const url = new URL(raw);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must use HTTPS or local loopback HTTP`);
  }
  return url.toString().replace(/\/$/, "");
}
export function readConfig(env = process.env) {
  const secret = env.GEOD_AGENT_GATEWAY_SECRET ?? "";
  const apiKey = env.LAOGAO_API_KEY ?? "";
  const model = env.LAOGAO_MODEL ?? "";
  const host = env.GEOD_AGENT_LISTEN_HOST || "127.0.0.1";
  if (secret.length < 32 || !apiKey || !model || !env.GEOD_IDENTITY_ORIGIN) throw new Error("GeoD identity, gateway secret, project API key and model must be configured");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Gateway must listen on loopback behind a TLS reverse proxy");
  if (!/^[a-zA-Z0-9._:/-]{1,128}$/.test(model)) throw new Error("LAOGAO_MODEL is invalid");
  const port = Number(env.GEOD_AGENT_LISTEN_PORT || 8786);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Gateway port is invalid");
  const tokenLimit = Number(env.GEOD_AGENT_TOKEN_LIMIT || 100_000);
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 20_000 || tokenLimit > 100_000_000) throw new Error("GeoD Agent token limit is invalid");
  return {
    host, port, secret, apiKey, model,
    identityOrigin: safeUrl(env.GEOD_IDENTITY_ORIGIN, "GEOD_IDENTITY_ORIGIN"),
    upstreamBase: safeUrl(env.LAOGAO_BASE_URL || "http://127.0.0.1:19094/v1", "LAOGAO_BASE_URL"),
    dbPath: resolve(env.GEOD_AGENT_DB_PATH || "./data/agent-model.sqlite"),
    tokenLimit,
  };
}
function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}
async function readJson(request) {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "JSON_REQUIRED");
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536) throw new HttpError(413, "REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpError(400, "INVALID_JSON"); }
}
function validId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value); }
function validateMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 24) throw new HttpError(400, "INVALID_MESSAGES");
  let chars = 0;
  for (const message of value) {
    if (!message || !["user", "assistant", "tool"].includes(message.role)) throw new HttpError(400, "INVALID_MESSAGES");
    if (message.role === "tool") {
      if (!validId(message.tool_call_id) || typeof message.content !== "string") throw new HttpError(400, "INVALID_MESSAGES");
    } else if (message.role === "assistant" && message.tool_calls) {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length > 4 || message.tool_calls.some(call => !validId(call.id) || call.type !== "function" || !TOOL_NAMES.has(call.function?.name) || typeof call.function.arguments !== "string" || call.function.arguments.length > 4096)) throw new HttpError(400, "INVALID_MESSAGES");
      if (message.content !== null && typeof message.content !== "string") throw new HttpError(400, "INVALID_MESSAGES");
    } else if (typeof message.content !== "string") throw new HttpError(400, "INVALID_MESSAGES");
    chars += (message.content?.length ?? 0) + JSON.stringify(message.tool_calls ?? "").length;
    if (chars > 12_000) throw new HttpError(413, "CONTEXT_TOO_LARGE");
  }
  if (value.at(-1).role !== "user" && value.at(-1).role !== "tool") throw new HttpError(400, "INVALID_LAST_MESSAGE");
  return value;
}
async function identity(config, token, fetchImpl) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401, "UNAUTHORIZED");
  let response;
  try {
    response = await fetchImpl(`${config.identityOrigin}/api/geod/oauth/introspect`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(8000) });
  } catch { throw new HttpError(503, "IDENTITY_UNAVAILABLE"); }
  if (!response.ok) throw new HttpError(503, "IDENTITY_UNAVAILABLE");
  let data;
  try { data = await response.json(); } catch { throw new HttpError(503, "IDENTITY_UNAVAILABLE"); }
  const active = data?.active;
  if (!active || typeof active.userId !== "string" || active.clientId !== "geod-agent-desktop" || active.scope !== "geod:agent" || active.expiresAt <= Date.now()) throw new HttpError(401, "UNAUTHORIZED");
  return active.userId;
}
function publicError(error) { return error instanceof HttpError ? error : new HttpError(500, "INTERNAL_ERROR"); }

export function createGatewayServer(config, { fetchImpl = fetch } = {}) {
  const ledger = openLedger(config.dbPath, config.tokenLimit, config.secret);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { status: "ok" });
      const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? "";
      const userId = await identity(config, bearer, fetchImpl);
      if (request.method === "GET" && url.pathname === "/api/agent/usage") return json(response, 200, ledger.usage(userId));
      const match = url.pathname.match(/^\/api\/agent\/generations\/([A-Za-z0-9_-]{8,80})$/);
      if (request.method === "GET" && match) {
        const generation = ledger.get(userId, match[1]);
        return generation ? json(response, 200, generation) : json(response, 404, { error: "NOT_FOUND" });
      }
      if (request.method !== "POST" || url.pathname !== "/api/agent/generations") throw new HttpError(404, "NOT_FOUND");
      const body = await readJson(request);
      if (!validId(body?.generationId) || !validId(body?.conversationId)) throw new HttpError(400, "INVALID_GENERATION");
      const messages = validateMessages(body.messages);
      const requestHash = createHash("sha256").update(JSON.stringify({ conversationId: body.conversationId, messages })).digest("hex");
      const reserved = ledger.reserve({ userId, generationId: body.generationId, conversationId: body.conversationId, requestHash, model: config.model, reserveTokens: RESERVATION_TOKENS });
      if (reserved.conflict) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      if (reserved.quotaExceeded) return json(response, 429, { error: "QUOTA_EXCEEDED", remainingTokens: reserved.remaining });
      if (reserved.replayed) return json(response, 200, reserved.generation);
      ledger.markStreaming(userId, body.generationId);
      let upstream;
      try {
        upstream = await fetchImpl(`${config.upstreamBase}/chat/completions`, {
          method: "POST", redirect: "error", headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: config.model, messages: [{ role: "system", content: SYSTEM }, ...messages], tools: TOOLS, tool_choice: "auto", max_tokens: 1024, stream: false }),
          signal: AbortSignal.timeout(45_000),
        });
      } catch {
        return json(response, 202, ledger.pending(userId, body.generationId, "UPSTREAM_UNKNOWN"));
      }
      if (!upstream.ok) {
        if (upstream.status >= 500) {
          return json(response, 202, ledger.pending(userId, body.generationId, "UPSTREAM_UNKNOWN"));
        }
        ledger.fail(userId, body.generationId, "UPSTREAM_REJECTED");
        throw new HttpError(502, "UPSTREAM_REJECTED");
      }
      let payload;
      try { payload = await upstream.json(); }
      catch {
        return json(response, 202, ledger.pending(userId, body.generationId, "UPSTREAM_MALFORMED"));
      }
      const usage = payload?.usage;
      const message = payload?.choices?.[0]?.message;
      if (!Number.isSafeInteger(usage?.prompt_tokens) || usage.prompt_tokens < 0 || !Number.isSafeInteger(usage?.completion_tokens) || usage.completion_tokens < 0 || !message || !(typeof message.content === "string" || message.content === null)) {
        return json(response, 202, ledger.pending(userId, body.generationId, "UPSTREAM_MALFORMED"));
      }
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(call => validId(call.id) && call.type === "function" && TOOL_NAMES.has(call.function?.name) && typeof call.function.arguments === "string").slice(0, 4) : [];
      const result = { role: "assistant", content: typeof message.content === "string" ? message.content.slice(0, 16000) : null, toolCalls };
      const settled = ledger.settle(userId, body.generationId, usage.prompt_tokens, usage.completion_tokens, typeof payload.id === "string" ? payload.id : null, result);
      return json(response, 200, settled);
    } catch (error) {
      const safe = publicError(error);
      return json(response, safe.status, { error: safe.code });
    }
  });
  server.on("close", () => ledger.close());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig();
  createGatewayServer(config).listen(config.port, config.host, () => {
    process.stdout.write(`GeoD Agent model gateway listening on ${config.host}:${config.port}\n`);
  });
}

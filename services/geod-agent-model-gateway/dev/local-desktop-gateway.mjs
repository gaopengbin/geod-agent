import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGatewayServer, readConfig } from "../server.mjs";

if (process.env.GEOD_LOCAL_DESKTOP_TEST !== "1" || !process.env.DEEPSEEK_API_KEY) {
  throw new Error("Local desktop test requires GEOD_LOCAL_DESKTOP_TEST=1 and DEEPSEEK_API_KEY");
}
const port = Number(process.env.GEOD_LOCAL_GATEWAY_PORT || 43123);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local gateway port");
const secret = process.env.GEOD_LOCAL_GATEWAY_SECRET||randomBytes(32).toString("hex");
if(secret.length<32)throw new Error('Invalid local gateway secret');
const folder = mkdtempSync(join(tmpdir(), "geod-desktop-gateway-"));
let gateway;
const identity = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/api/geod/oauth/introspect" || request.headers.authorization !== `Bearer ${secret}`) {
    response.writeHead(404); response.end(); return;
  }
  try {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 1024) { response.writeHead(413); response.end(); return; }
    }
    const token = JSON.parse(raw).token;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      response.writeHead(401); response.end(); return;
    }
    const check = await fetch("https://geod.laogao.xyz/api/agent/usage", {
      headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(8000),
    });
    if (check.status !== 200) { response.writeHead(401); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ active: { userId: "local-desktop-test", clientId: "geod-agent-desktop", scope: "geod:agent", expiresAt: Date.now() + 60_000 } }));
  } catch {
    response.writeHead(503); response.end();
  }
});

const identityOrigin = await new Promise(resolve => identity.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${identity.address().port}`)));
const config = readConfig({ ...process.env, GEOD_AGENT_GATEWAY_SECRET: secret, GEOD_IDENTITY_ORIGIN: identityOrigin,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_MODEL: "deepseek-flash",GEOD_AGENT_SPONSORS_JSON:process.env.GEOD_AGENT_SPONSORS_JSON||'[]',
   GEOD_AGENT_DB_PATH: process.env.GEOD_LOCAL_GATEWAY_DB_PATH||join(folder, "gateway.sqlite"), GEOD_AGENT_TOKEN_LIMIT: "200000", GEOD_AGENT_QUOTA_MODE: "unlimited" });
gateway = createGatewayServer(config);
gateway.listen(port, "127.0.0.1", () => process.stdout.write(`GeoD local desktop gateway ready on 127.0.0.1:${port}\n`));

function shutdown() {
  gateway?.close(() => identity.close(() => { rmSync(folder, { recursive: true, force: true }); process.exit(0); }));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

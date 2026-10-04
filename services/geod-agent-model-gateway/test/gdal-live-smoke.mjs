import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGatewayServer, readConfig } from "../server.mjs";

assert.ok(process.env.DEEPSEEK_API_KEY, "Set DEEPSEEK_API_KEY for this optional local test");
const folder = mkdtempSync(join(tmpdir(), "geod-gdal-live-"));
const secret = "g".repeat(40);
const identity = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401); response.end(); return; }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ active: { userId: "gdal-local-smoke", clientId: "geod-agent-desktop", scope: "geod:agent", expiresAt: Date.now() + 60_000 } }));
});
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => server.close(resolve));
let gateway;
try {
  const identityOrigin = await listen(identity);
  gateway = createGatewayServer(readConfig({ GEOD_AGENT_GATEWAY_SECRET: secret, GEOD_IDENTITY_ORIGIN: identityOrigin,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_MODEL: "deepseek-flash", GEOD_AGENT_DB_PATH: join(folder, "gateway.sqlite") }));
  const origin = await listen(gateway);
  // The native test receives only the local gateway origin; the provider key stays here.
  const { DEEPSEEK_API_KEY: _key, ...nativeEnvironment } = process.env;
  const child = spawn("cargo", ["test", "--locked", "gdal_reprojection_live_model", "--", "--ignored", "--nocapture"], {
    cwd: fileURLToPath(new URL("../../../apps/geod-agent-desktop/src-tauri/", import.meta.url)),
    env: { ...nativeEnvironment, GEOD_GDAL_LIVE_ORIGIN: origin }, stdio: "inherit", windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, "Real model/native GDAL test failed");
} finally {
  if (gateway) await close(gateway);
  await close(identity);
  rmSync(folder, { recursive: true, force: true });
}

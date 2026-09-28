import assert from "node:assert/strict";
import test from "node:test";
import { accountErrorText, safeReturnTo } from "./login.js";

test("GeoD login return path stays on the current site", () => {
  const origin = "https://geod.laogao.xyz";
  assert.equal(safeReturnTo("/api/geod/oauth/authorize?client_id=geod-agent-desktop", origin), "/api/geod/oauth/authorize?client_id=geod-agent-desktop");
  for (const value of [null, "", "//evil.example/", "/\\evil.example/", "https://evil.example/", "javascript:alert(1)"])
    assert.equal(safeReturnTo(value, origin), "/dashboard");
});

test("GeoD login uses account error codes without showing service internals", () => {
  assert.match(accountErrorText("INVALID_CREDENTIALS"), /邮箱或密码/);
  assert.match(accountErrorText("ORIGIN_REJECTED"), /GeoD 官网/);
  assert.equal(accountErrorText("UNKNOWN_INTERNAL_ERROR"), "暂时无法完成操作，请稍后重试。");
});

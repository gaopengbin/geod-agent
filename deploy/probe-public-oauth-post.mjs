// Anonymous same-origin POST should reach the session check, without a browser or user cookie.
const origin = "https://geod.laogao.xyz";
const form = new URLSearchParams({
  response_type: "code",
  client_id: "geod-agent-desktop",
  redirect_uri: "http://127.0.0.1:54321/oauth/callback",
  scope: "geod:agent",
  code_challenge: "A".repeat(43),
  code_challenge_method: "S256",
  state: "geod-production-anonymous-post-probe",
});
const response = await fetch(`${origin}/api/geod/oauth/authorize`, {
  method: "POST",
  headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
  body: form,
  redirect: "manual",
  signal: AbortSignal.timeout(10_000),
});
const body = await response.json();
console.log(`Anonymous same-origin OAuth POST: HTTP ${response.status} ${body?.error?.code ?? "unknown"}`);
if (response.status !== 401 || body?.error?.code !== "AUTH_REQUIRED") process.exitCode = 1;

// Exercise the public anonymous OAuth redirect without opening a browser.
const origin = "https://geod.laogao.xyz";
const url = new URL("/api/geod/oauth/authorize", origin);
for (const [key, value] of Object.entries({
  response_type: "code",
  client_id: "geod-agent-desktop",
  redirect_uri: "http://127.0.0.1:54321/oauth/callback",
  scope: "geod:agent",
  code_challenge: "A".repeat(43),
  code_challenge_method: "S256",
  state: "geod-production-anonymous-probe",
})) url.searchParams.set(key, value);
const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
const location = response.headers.get("location");
if (response.status !== 303 || !location) throw new Error(`Expected GeoD login redirect; HTTP ${response.status}`);
const destination = new URL(location, origin);
if (destination.origin !== origin || !["/login", "/login.html"].includes(destination.pathname)) {
  throw new Error(`Unexpected OAuth redirect: HTTP ${response.status} -> ${destination.origin}${destination.pathname}`);
}
if (response.headers.get("referrer-policy") !== "origin") throw new Error("OAuth form referrer policy is not ready");
console.log(`Anonymous GeoD OAuth: HTTP ${response.status} -> ${destination.pathname}; Referrer-Policy origin`);

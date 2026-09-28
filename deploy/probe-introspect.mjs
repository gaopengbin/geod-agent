// Verify the service-to-service secret without printing it or any token.
const port = Number(process.argv[2] || 9116);
if (![9114, 9116].includes(port)) throw new Error("Unsupported GeoD identity port");
const response = await fetch(`http://127.0.0.1:${port}/api/geod/oauth/introspect`, {
  method: "POST",
  redirect: "error",
  headers: {
    authorization: `Bearer ${process.env.GEOD_AGENT_GATEWAY_SECRET}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ token: "A".repeat(43) }),
  signal: AbortSignal.timeout(8_000),
});
if (response.status !== 200) throw new Error(`GeoD introspection returned HTTP ${response.status}`);
const body = await response.json();
if (body?.active !== null) throw new Error("Unknown token was not rejected");
console.log(`GeoD service secret accepted on loopback ${port}; unknown token is inactive`);

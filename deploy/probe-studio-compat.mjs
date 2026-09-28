// Anonymous, read-only compatibility check before replacing the 9114 service.
const paths = [
  "/api/geod-studio/health",
  "/api/account/session",
  "/api/account/sources",
  "/api/account/usage",
];
for (const path of paths) {
  const [current, candidate] = await Promise.all([9114, 9116].map(port =>
    fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual", signal: AbortSignal.timeout(8_000) })
  ));
  console.log(`${path}: current ${current.status}, candidate ${candidate.status}`);
  if (current.status !== candidate.status) throw new Error(`Status regression at ${path}`);
  if (path.endsWith("/health")) {
    const value = await candidate.json();
    if (value?.ready !== true) throw new Error("Candidate Studio is not ready");
  }
}

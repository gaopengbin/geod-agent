// Run with Node --env-file on the server. Never print the API key or response text.
const response = await fetch("https://api.deepseek.com/chat/completions", {
  method: "POST",
  redirect: "error",
  headers: {
    authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "deepseek-flash",
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 16,
    stream: false,
    thinking: { type: "disabled" },
  }),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`DeepSeek probe failed with HTTP ${response.status}`);
const body = await response.json();
if (typeof body?.choices?.[0]?.message?.content !== "string" || !Number.isSafeInteger(body?.usage?.total_tokens)) {
  throw new Error("DeepSeek probe returned an invalid completion");
}
console.log(`DeepSeek completion verified; billed ${body.usage.total_tokens} tokens`);

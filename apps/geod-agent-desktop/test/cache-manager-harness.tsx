import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CacheManager } from "../src/cache-manager";
import { Button } from "../src/components/motion/button/base";
import "../src/styles.css";
import "../src/theme.css";
const runtime = window as unknown as Record<string, unknown>;
runtime.__TAURI_INTERNALS__ = { invoke: async (command: string, args: unknown) => {
  const result = await (await fetch("http://127.0.0.1:1421/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command, args }) })).json();
  if (result.error) throw result.error;
  return result.value;
} };
document.documentElement.dataset.theme = new URL(location.href).searchParams.get("theme") === "dark" ? "dark" : "light";
function Harness() {
  const [opened, setOpened] = useState(true);
  return <main style={{ height: "100dvh", background: "var(--background)", padding: 24 }}><Button onClick={() => setOpened(true)}>下载缓存</Button>{opened && <CacheManager onClose={() => setOpened(false)} />}</main>;
}
createRoot(document.getElementById("root")!).render(<Harness />);

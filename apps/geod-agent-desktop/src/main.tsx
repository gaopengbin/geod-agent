import { t } from "./i18n";
// i18n: presentation strings migrated
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { TooltipProvider } from "./ui-tooltip";
import { initializeLocalState } from "./local-state";
import { Button } from "@/components/motion/button/base";
import "ol/ol.css";
import "./styles.css";
import "./theme.css";
import "./workspace.css";

const root = createRoot(document.getElementById("root")!);
async function start() {
  try {
    await initializeLocalState();
    root.render(<React.StrictMode><TooltipProvider><App /></TooltipProvider></React.StrictMode>);
  } catch (error) {
    root.render(<main className="local-state-recovery" role="alert"><h2>{t("本机记录暂时无法打开")}</h2><p>{error instanceof Error ? error.message : t("请检查磁盘后重试。")}</p><Button onClick={() => void start()}>{t("重试")}</Button></main>);
  }
}
void start();

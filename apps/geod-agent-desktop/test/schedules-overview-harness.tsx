import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SchedulesPage } from "../src/schedules-page";
import { TooltipProvider } from "../src/ui-tooltip";
import { useLocale } from "../src/i18n";
import "../src/styles.css";
import "../src/theme.css";
import "../src/workspace.css";
const query = new URL(location.href).searchParams;
document.documentElement.dataset.theme = query.get("theme") === "light" ? "light" : "dark";
function Harness() {
  useLocale();
  const [last, setLast] = useState("");
  return <TooltipProvider><main style={{ display: "grid", gridTemplateColumns: "0 minmax(0,1fr)", height: "100vh" }}>
    <SchedulesPage active accountId="isolated-account" currentConversationId="chat-a" conversations={[{ conversationId: "chat-a", title: "河南影像更新" }, { conversationId: "chat-b", title: "三维与矢量数据" }]} onOpenConversation={id => setLast(`open:${id}`)} onManageDownload={id => setLast(`download:${id}`)}/>
    <output aria-label="Navigation result" style={{ position: "fixed", bottom: 0 }}>{last}</output>
  </main></TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);

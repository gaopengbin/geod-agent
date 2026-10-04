import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AccountMenu } from "../src/account-menu";
import { PaymentDialog, PAYMENT_OPEN } from "../src/payment-dialog";
import { TooltipProvider } from "../src/ui-tooltip";
import { useLocale } from "../src/i18n";
import "../src/styles.css";
import "../src/theme.css";
import "../src/workspace.css";
document.documentElement.dataset.theme = "dark";
const noop = () => {};
function Harness() {
  useLocale();
  const [open, setOpen] = useState(false), [payment, setPayment] = useState(false);
  const [usage, setUsage] = useState({ quotaEnforced: false, limitTokens: null, remainingTokens: null, committedTokens: 123400, reservedTokens: 0, pendingReconcile: 0 });
  useEffect(() => {
    const wallet = () => setPayment(true);
    const consumed = () => setUsage(old => ({ ...old, committedTokens: old.committedTokens + 100 }));
    window.addEventListener(PAYMENT_OPEN, wallet); window.addEventListener("isolated:consumed", consumed);
    return () => { window.removeEventListener(PAYMENT_OPEN, wallet); window.removeEventListener("isolated:consumed", consumed); };
  }, []);
  return <TooltipProvider><aside className="conversation-sidebar" style={{ width: 248, height: "100dvh" }}>
    <div style={{ flex: 1 }} />
    <AccountMenu open={open} onOpenChange={setOpen} connected userId="isolated-account" usage={usage} busy={false} theme="dark" onModels={noop} onNetwork={noop} onCache={noop} onTheme={noop} onLogout={noop} telemetryEnabled={false} onTelemetry={noop}/>
  </aside>{payment && <PaymentDialog accountId="isolated-account" onClose={() => setPayment(false)}/>}</TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);

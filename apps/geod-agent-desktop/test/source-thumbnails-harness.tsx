import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SourcePage } from "../src/source-page";
import { Button } from "../src/components/motion/button/base";
import { TooltipProvider } from "../src/ui-tooltip";
import "../src/styles.css";
import "../src/theme.css";
function Harness() {
  const [dark, setDark] = useState(true);
  return <TooltipProvider><div className="app-shell" data-theme={dark ? "dark" : "light"}>
    <header className="app-header custom-titlebar"><div className="brand"><img src="/geod-symbol.png" alt=""/><strong>GeoD <span>Agent</span></strong></div><Button variant="ghost" size="sm" onClick={()=>{setDark(!dark);document.documentElement.dataset.theme=dark?"light":"dark";}}>切换主题</Button></header>
    <div style={{flex:1,display:"grid",minHeight:0,gridTemplateColumns:"0 minmax(0,1fr)"}}><SourcePage active draft={null} reviewing={false} onReturn={()=>{}} onSaved={()=>{}}/></div>
  </div></TooltipProvider>;
}
document.documentElement.dataset.theme="dark";
createRoot(document.getElementById("root")!).render(<Harness/>);

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useGeoDAuth } from "../src/geod-auth";
import { api, errorMessage } from "../src/api";
import { Button } from "../src/components/motion/button/base";
function Harness() {
  const auth=useGeoDAuth(), [error,setError]=useState("");
  return <main data-auth-state={auth.status.state} data-auth-owner={auth.status.userId??""}>
    <p>{auth.status.state}</p><Button onClick={()=>void api.workspaceGet("auth-sync-fixture").catch(e=>setError(errorMessage(e)))}>读取工作区</Button><p>{error}</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);

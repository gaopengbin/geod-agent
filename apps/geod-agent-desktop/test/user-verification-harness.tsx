import React from "react";
import {createRoot} from "react-dom/client";
import {CodexRequestCard} from "../src/codex-request";
import {setLanguagePreferences} from "../src/i18n";
import "../src/styles.css";
import "../src/theme.css";
import "../src/codex-work.css";

const query=new URLSearchParams(location.search);
setLanguagePreferences({language:query.get("language")==="en"?"en":"zh-CN"});
document.documentElement.dataset.theme=query.get("theme")==="dark"?"dark":"light";
const request={type:"request" as const,requestId:"protocol-component-fixture",method:"mcpServer/elicitation/request",params:{mode:"openai/userVerification",title:"确认连接到地理数据库",description:"此连接器请求用设备身份确认登录。",challenge:"PRIVATE_CHALLENGE_MUST_NOT_RENDER",_meta:{sensitive:"PRIVATE_METADATA_MUST_NOT_RENDER"}}};
createRoot(document.getElementById("root")!).render(<main style={{maxWidth:560,padding:20,margin:"24px auto"}}><CodexRequestCard request={request} respond={async value=>{(window as unknown as {fixtureResult:unknown}).fixtureResult=value;}}/></main>);

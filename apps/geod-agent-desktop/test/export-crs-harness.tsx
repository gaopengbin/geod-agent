import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {UserInputQuestionCard} from "../src/user-input-card";
import {exportCrsQuestions} from "../src/export-crs";
import "../src/styles.css";
import "../src/theme.css";
import "../src/workspace.css";
import "../src/codex-work.css";
function Harness(){
 const [reply,setReply]=useState<unknown>();
 document.documentElement.dataset.theme=new URLSearchParams(location.search).get("theme")??"dark";
 return <main style={{maxWidth:540,margin:"32px auto",padding:16}}><h2>导出坐标系</h2>{!reply?<UserInputQuestionCard questions={exportCrsQuestions} respond={value=>{setReply(value);}}/>:<pre data-testid="reply">{JSON.stringify(reply)}</pre>}</main>;
}
createRoot(document.getElementById("root")!).render(<Harness/>);

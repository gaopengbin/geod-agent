import {useState} from "react";
import {createRoot} from "react-dom/client";
import {Tiles3dConnections} from "../src/tiles3d-connections";
import {Button} from "../src/components/motion/button/base";
import "../src/styles.css";
import "../src/theme.css";
const runtime=window as unknown as Record<string,unknown>;
runtime.__TAURI_INTERNALS__={invoke:async(command:string,args:unknown)=>{const result=await(await fetch("http://127.0.0.1:1421/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({command,args})})).json();if(result.error)throw result.error;return result.value;}};
const params=new URL(location.href).searchParams;
document.documentElement.dataset.theme=params.get("theme")==="dark"?"dark":"light";
function Harness(){const[open,setOpen]=useState(true);return <main style={{height:"100dvh",padding:24,background:"var(--background)"}}><Button onClick={()=>setOpen(true)}>三维连接</Button>{open&&<Tiles3dConnections onClose={()=>setOpen(false)} initialConnectionId={params.get("connection")??undefined}/>}</main>;}
createRoot(document.getElementById("root")!).render(<Harness/>);

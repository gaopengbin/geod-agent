import {useState} from 'react';import {createRoot} from 'react-dom/client';
import {CodexRequestCard} from '../src/codex-request';
import '../src/styles.css';import '../src/theme.css';import '../src/workspace.css';
import '../src/codex-work.css';
const p=new URLSearchParams(location.search);document.documentElement.dataset.theme=p.get('theme')??'light';document.body.style.fontFamily='var(--app-font, sans-serif)';
function Harness(){const [reply,setReply]=useState<unknown>(),[fails,setFails]=useState(p.has('fail'));return <main style={{margin:'auto',maxWidth:660,padding:20,background:'var(--app-surface)',color:'var(--app-text)'}}><CodexRequestCard request={{type:'request',requestId:'execution-review-fixture',method:'geod/executionReview',params:{reason:p.get('reason')??'budget',lastTool:'读取下载状态',spending:{budgetCredits:p.get('reason')&&p.get('reason')!=='budget'?5000:2000,spentCredits:2003.25,unknownRequests:p.get('reason')==='unknownCost'?1:0,recordedRequests:35}}}} respond={async value=>{if(fails){setFails(false);throw Error('测试：暂时无法保存，请重试');}setReply(value);}}/>{reply!==undefined&&<pre data-testid="reply">{JSON.stringify(reply)}</pre>}</main>;}
createRoot(document.getElementById('root')!).render(<Harness/>);

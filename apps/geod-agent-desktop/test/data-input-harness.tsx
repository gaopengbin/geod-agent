import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DataInputPanel } from '../src/data-input-panel';
import { Button } from '../src/components/motion/button/base';
import type { BoundaryImport, DataConnectionDraft, DataConnectionResult } from '../src/api';
import { executeDataInputTool } from '../src/data-input-tools';
import '../src/theme.css';
import '../src/styles.css';
const query=new URLSearchParams(location.search);
document.documentElement.dataset.theme=query.get('theme')??'light';
function App(){
 const[open,setOpen]=useState(!query.has('auth'));
 const[boundary,setBoundary]=useState<BoundaryImport|null>(null);
 const[authentication,setAuthentication]=useState<Omit<DataConnectionDraft,'password'>|null>(null);
 const[result,setResult]=useState<unknown>(null);
 const resolver=useRef<((value:DataConnectionResult)=>void)|null>(null);
 async function connect(){setResult(null);setResult(await executeDataInputTool('data-ui-test-auth','data_connection_connect',{name:'Agent 认证实测',host:'127.0.0.1',port:55438,database:'geod_test',user:'geod_reader',sslMode:'disable'},{authenticate: draft=>new Promise(resolve=>{resolver.current=resolve;setAuthentication(draft);setOpen(true);})}));}
 return <main style={{padding:30}}><Button onClick={()=>query.has('auth')?void connect():setOpen(true)}>{query.has('auth')?'测试 Agent 连接':'添加数据范围'}</Button><DataInputPanel open={open} initialConnection={authentication} onConnection={authentication?value=>{resolver.current?.({connection:{id:value.connection.id,name:value.connection.name},layers:value.layers,readOnly:true});resolver.current=null;setAuthentication(null);setOpen(false);}:undefined} onOpenChange={value=>{setOpen(value);if(!value){resolver.current?.({error:{code:'INPUT_CANCELLED',message:'数据库认证已取消'}});resolver.current=null;setAuthentication(null);}}} conversationId={'data-ui-test-'+(query.get('id')??'1')} onBoundary={setBoundary}/>{boundary&&<output data-testid="boundary-result">{JSON.stringify({name:boundary.name,bounds:boundary.bounds,polygonCount:boundary.polygonCount})}</output>}{result&&<output>{JSON.stringify(result)}</output>}</main>
}
createRoot(document.getElementById('root')!).render(<App/>);

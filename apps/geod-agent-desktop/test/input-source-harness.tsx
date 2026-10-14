import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PromptInput} from '../src/components/agents/prompt-input';
import {SourcePage} from '../src/source-page';
import {SourceThumbnail} from '../src/source-thumbnail';
import {rasterPreset} from '../src/source-presets';
import '../src/styles.css';
import '../src/theme.css';
import '../src/workspace.css';
import {api} from '../src/api';
Object.assign(window,{qa:{submissions:[],events:[]},api});
document.addEventListener('compositionstart',()=> (window as any).qa.events.push('start'));
document.addEventListener('compositionend',e=> (window as any).qa.events.push(['end', (e as CompositionEvent).data]));
function Harness(){
 const [value,setValue]=useState(''), [mode,setMode]=useState('input');
 const draft=rasterPreset('esri-world-imagery');draft.source.urlTemplate='https://tiles.example.org/{z}/{x}/{y}?qa=retry';
 return <main style={{padding:32}}><nav><button onClick={()=>setMode('input')}>输入验证</button><button onClick={()=>setMode('sources')}>图源验证</button><button onClick={()=>setMode('preview')}>预览验证</button></nav>{mode==='input'?<div className="agent-start-content" style={{maxWidth:760,margin:'100px auto'}}><h1>输入验证（不会调用模型）</h1><PromptInput value={value} onValueChange={setValue} onSubmit={v=>{(window as any).qa.submissions.push(v);setValue('');}} className="geod-prompt-input" aria-label="输入验证"/><output>{value}</output></div>:mode==='preview'?<div style={{width:116,marginTop:24}}><SourceThumbnail target={{draft}} name="测试图源"/></div>:<SourcePage active onSaved={()=>{}} onReturn={()=>setMode('input')} onOpenConnections={()=>{}}/>}</main>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

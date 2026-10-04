import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/motion/button/base";
import { CircleAlert, PencilSimple, Plus, Trash, X } from "./icons";
import { errorMessage } from "./api";
import { memory, MEMORY_CHANGED, type MemoryDraft, type MemoryEntry, type MemoryPage } from "./agent-memory";
import "./memory-panel.css";

const empty:MemoryPage={entries:[],total:0,nextOffset:null};
const fresh=():MemoryDraft=>({title:"",content:"",scope:"workspace",enabled:true});
export function MemoryPanel({active,conversationId}:{active:boolean;conversationId:string}){
  const [page,setPage]=useState<MemoryPage>(empty);
  const [query,setQuery]=useState("");
  const [draft,setDraft]=useState<MemoryDraft|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [revision,setRevision]=useState(0);
  const requests=useRef(0);
  useEffect(()=>{setDraft(null);setPage(empty);setError("");},[conversationId]);
  useEffect(()=>{const changed=()=>setRevision(r=>r+1);window.addEventListener(MEMORY_CHANGED,changed);return()=>window.removeEventListener(MEMORY_CHANGED,changed);},[]);
  useEffect(()=>{
    if(!active||!conversationId)return;
    const request=++requests.current;
    const timer=window.setTimeout(()=>void memory.list(conversationId,query).then(p=>{if(request===requests.current)setPage(p);}).catch(e=>{if(request===requests.current)setError(errorMessage(e));}),200);
    return()=>{window.clearTimeout(timer);requests.current++;};
  },[active,conversationId,query,revision]);
  async function run(action:()=>Promise<unknown>,refresh=true){
    if(busy)return;setBusy(true);setError("");
    try{await action();if(refresh)window.dispatchEvent(new CustomEvent(MEMORY_CHANGED));}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  const edit=(e:MemoryEntry)=>setDraft({id:e.id,expectedRevision:e.revision,title:e.title,content:e.content,scope:e.scope,enabled:e.enabled});
  return <section className="memory-panel" hidden={!active} aria-label={t("偏好与记忆")}>
    <div className="memory-heading"><div><h2>{t("偏好与记忆")}</h2><p>{t("只保存你明确要求记住的偏好。可随时修改、停用或删除。")}</p></div><Button size="sm" variant="outline" disabled={busy} onClick={()=>setDraft(fresh())}><Plus size={16}/>{t("添加记忆")}</Button></div>
    <div className="memory-search"><input aria-label={t("搜索记忆")} placeholder={t("搜索标题或内容")} value={query} maxLength={120} onChange={e=>setQuery(e.target.value)}/><span>{page.total} {t(" 条")}</span></div>
    {error&&<div className="extension-error" role="alert"><CircleAlert size={16}/><span>{localize(error)}</span><Button size="icon" variant="ghost" aria-label={t("关闭记忆错误")} onClick={()=>setError("")}><X size={16}/></Button></div>}
    {draft&&<form className="memory-editor" aria-label={draft.id?t("编辑记忆"):t("添加记忆")} onSubmit={e=>{e.preventDefault();void run(async()=>{await memory.save(conversationId,draft);setDraft(null);});}}>
      <div className="memory-scope" role="group" aria-label={t("记忆范围")}><Button type="button" size="sm" variant={draft.scope==="workspace"?"secondary":"ghost"} aria-pressed={draft.scope==="workspace"} onClick={()=>setDraft({...draft,scope:"workspace"})}>{t("当前工作区")}</Button><Button type="button" size="sm" variant={draft.scope==="account"?"secondary":"ghost"} aria-pressed={draft.scope==="account"} onClick={()=>setDraft({...draft,scope:"account"})}>{t("当前账号")}</Button><span>{draft.scope==="workspace"?t("同一文件夹下的对话共享"):t("此账号的所有工作区共享")}</span></div>
      <label>{t("标题")}<input autoFocus required maxLength={120} value={draft.title} onChange={e=>setDraft({...draft,title:e.target.value})}/></label>
      <label>{t("内容")}<textarea required maxLength={4000} rows={4} value={draft.content} onChange={e=>setDraft({...draft,content:e.target.value})} placeholder={t("例如：影像默认输出 GeoTIFF，并按行政区边界裁剪")}/></label>
      <div className="memory-editor-actions"><label className="memory-enabled"><input type="checkbox" checked={draft.enabled} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>{t("用于后续对话")}</label><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>setDraft(null)}>{t("取消")}</Button><Button type="submit" size="sm" disabled={busy||!draft.title.trim()||!draft.content.trim()}>{t("保存")}</Button></div>
    </form>}
    <div className="memory-list">
      {!page.entries.length&&!draft&&<p className="extension-empty-inline">{query?t("未找到相关记忆。"):t("还没有保存的偏好。也可以在对话里说“记住……”来添加。")}</p>}
      {page.entries.map(e=><article className={`memory-row ${e.enabled?"":"is-disabled"}`} key={e.id}>
        <div className="memory-row-copy"><div><strong>{e.title}</strong><span>{e.scope==="workspace"?t("工作区"):t("账号")}</span>{!e.enabled&&<span>{t("已停用")}</span>}</div><p>{e.content}</p></div>
        <div className="memory-row-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void run(()=>memory.save(conversationId,{id:e.id,expectedRevision:e.revision,title:e.title,content:e.content,scope:e.scope,enabled:!e.enabled}))}>{e.enabled?t("停用"):t("启用")}</Button><Button size="icon" variant="ghost" aria-label={t("编辑记忆 {0}", {"0": e.title})} disabled={busy} onClick={()=>edit(e)}><PencilSimple size={15}/></Button><Button size="icon" variant="ghost" aria-label={t("删除记忆 {0}", {"0": e.title})} disabled={busy} onClick={()=>void run(()=>memory.remove(conversationId,e.id,e.revision))}><Trash size={15}/></Button></div>
      </article>)}
    </div>
    {page.nextOffset!==null&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void run(async()=>{const next=await memory.list(conversationId,query,page.nextOffset!);setPage(p=>({...next,entries:[...p.entries,...next.entries]}));},false)}>{t("查看更多")}</Button>}
    <p className="memory-footnote">{t("记忆随账号保存在本机，不保存密码或密钥。删除后不再用于后续对话；已有的对话记录仍会保留。")}</p>
  </section>;
}

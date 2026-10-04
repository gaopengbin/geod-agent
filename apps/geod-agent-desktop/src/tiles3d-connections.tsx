import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/motion/button/base";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ArrowLeft, CheckCircle2, ChevronDown, CircleAlert, Loader2, Network, Plus, Trash, X } from "./icons";
import { errorMessage } from "./app-error";
import "./tiles3d-connections.css";

export interface Tiles3dConnection { id: string; revision: string; name: string; kind: "direct" | "cesiumIon"; tilesetUrl: string | null; assetId: number | null; requiredHeaders: string[]; credentialReady: boolean }
type HeaderRow = { key: string; name: string; value: string };
const row = (name = ""): HeaderRow => ({ key: crypto.randomUUID(), name, value: "" });

/** Secrets are written directly to native Windows Credential Manager. */
export function Tiles3dConnections({ onClose, initialConnectionId }: { onClose: () => void; initialConnectionId?: string }) {
  const [connections, setConnections] = useState<Tiles3dConnection[]>([]), [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Tiles3dConnection | null>(null), [editing, setEditing] = useState(false), [busy, setBusy] = useState(false);
  const [name, setName] = useState(""), [kind, setKind] = useState<"direct" | "cesiumIon">("direct"), [url, setUrl] = useState(""), [assetId, setAssetId] = useState("");
  const [token, setToken] = useState(""), [headers, setHeaders] = useState<HeaderRow[]>([]), [error, setError] = useState(""), [notice, setNotice] = useState("");
  async function refresh() { const next = await invoke<Tiles3dConnection[]>("tiles3d_connections_list"); setConnections(next); return next; }
  function choose(connection: Tiles3dConnection | null) {
    setSelected(connection); setEditing(true); setError(""); setNotice(""); setToken("");
    setName(connection?.name ?? ""); setKind(connection?.kind ?? "direct"); setUrl(connection?.tilesetUrl ?? ""); setAssetId(connection?.assetId?.toString() ?? "");
    setHeaders((connection?.requiredHeaders ?? []).map(name => row(name)));
  }
  useEffect(() => { void refresh().then(next => { const target=next.find(c=>c.id===initialConnectionId); if(target)choose(target); }).catch(cause=>setError(errorMessage(cause))).finally(()=>setLoading(false)); }, [initialConnectionId]);
  async function save(test = false) {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try {
      const values: Record<string,string> = {}, names = new Set<string>();
      for (const header of headers) {
        const name=header.name.trim(); if(!name)throw new Error("请填写请求头名称，或移除空白行");
        if(names.has(name.toLowerCase()))throw new Error("请求头名称不能重复"); names.add(name.toLowerCase()); values[name]=header.value;
      }
      let connection = selected;
      if (!connection) {
        connection = await invoke<Tiles3dConnection>("tiles3d_connection_prepare", { draft: { name, kind, ...(kind==="cesiumIon"?{assetId:Number(assetId)}:{tilesetUrl:url}), requiredHeaders:Object.keys(values) } });
        setSelected(connection); // Retry a failed credential save against the same profile.
      }
      const removed=connection.requiredHeaders.filter(name=>!names.has(name.toLowerCase()));
      connection = await invoke<Tiles3dConnection>("tiles3d_connection_save", { connectionId:connection.id, token:token||null, headers:values, removeHeaders:removed });
      setSelected(connection); setToken(""); setHeaders(connection.requiredHeaders.map(name=>row(name))); await refresh();
      if(test) {
        const result=await invoke<{connected:boolean;version:string}>("tiles3d_connection_test",{connectionId:connection.id});
        setNotice(`连接成功 · 3D Tiles ${result.version}`);
      } else setNotice("连接已保存，可以让 AI 使用此连接下载三维数据。");
    } catch(cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  async function remove(connection: Tiles3dConnection) {
    setBusy(true); setError("");
    try { await invoke("tiles3d_connection_remove",{connectionId:connection.id}); await refresh(); if(selected?.id===connection.id){setEditing(false);setSelected(null);} }
    catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}
  }
  return <Dialog.Root open onOpenChange={value=>{if(!value&&!busy)onClose();}}><Dialog.Portal><Dialog.Overlay className="dialog-backdrop"/><Dialog.Content className="dialog tiles3d-connections">
    <div className="dialog-head"><div><Dialog.Title>{editing ? selected?.name ?? t("添加三维连接") : t("三维数据连接")}</Dialog.Title><Dialog.Description>{editing ? t("凭证保存在本机，AI 通过连接名称使用。") : t("管理 Cesium Ion 和需要认证的 3D Tiles 服务。")}</Dialog.Description></div><Button variant="ghost" size="icon" disabled={busy} aria-label={t("关闭三维连接")} onClick={onClose}><X size={18}/></Button></div>
    <ScrollArea className="tiles3d-connections-scroll"><div className="dialog-body tiles3d-connections-body">
      {loading ? <p className="connection-muted"><Loader2 className="animate-spin" size={16}/>{t("正在读取连接…")}</p> : editing ? <>
        <Button variant="ghost" size="sm" className="connection-back" disabled={busy} onClick={()=>{setEditing(false);setToken("");setHeaders([]);setError("");setNotice("");}}><ArrowLeft size={14}/>{t("连接列表")}</Button>
        {!selected ? <>
          <label className="field"><span className="field-label">{t("连接名称")}</span><input value={name} onChange={e=>setName(e.target.value)} placeholder={t("例如：园区三维模型")} maxLength={80} disabled={busy}/></label>
          <div className="field"><span className="field-label" id="tiles3d-kind-label">{t("连接方式")}</span><Select.Root value={kind} disabled={busy} onValueChange={value=>setKind(value as typeof kind)}><Select.Trigger className="select-trigger" aria-labelledby="tiles3d-kind-label"><Select.Value/><Select.Icon><ChevronDown size={15}/></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="select-content" position="popper" sideOffset={5}><Select.Viewport>{[{value:"direct",label:"3D Tiles 服务地址"},{value:"cesiumIon",label:"Cesium Ion"}].map(option=><Select.Item key={option.value} value={option.value} className="select-item"><Select.ItemText>{localize(option.label)}</Select.ItemText></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root></div>
          {kind==="cesiumIon"?<label className="field"><span className="field-label">Asset ID</span><input inputMode="numeric" value={assetId} onChange={e=>setAssetId(e.target.value)} placeholder={t("Cesium Ion 中的资产编号")} disabled={busy}/></label>:<label className="field"><span className="field-label">{t("服务地址")}</span><input type="url" aria-label={t("服务地址")} value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://example.com/tileset.json" disabled={busy}/><small>{t("填写根 tileset.json 地址；认证值在下方请求头中填写。")}</small></label>}
        </>:<div className="connection-source"><Network size={16}/><div><strong>{selected.kind==="cesiumIon"?`Cesium Ion · Asset ${selected.assetId}`:"3D Tiles"}</strong>{selected.tilesetUrl&&<p>{selected.tilesetUrl}</p>}</div><span className={selected.credentialReady?"connection-ready":"connection-pending"}>{selected.credentialReady?t("已配置"):t("待填写凭证")}</span></div>}
        {kind==="cesiumIon"&&<label className="field"><span className="field-label">Access Token</span><input type="password" autoComplete="new-password" value={token} onChange={e=>setToken(e.target.value)} placeholder={selected?.credentialReady?t("已保存，留空继续使用"):t("填写可访问此资产的 Token")} disabled={busy}/></label>}
        <section className="connection-headers"><div className="connection-section-heading"><h3>{t("请求头")}<span>{t("可选")}</span></h3><Button variant="ghost" size="sm" disabled={busy||headers.length>=32} onClick={()=>setHeaders(values=>[...values,row()])}><Plus size={14}/>{t("添加")}</Button></div>
          {headers.length===0?<p className="connection-muted">{t("服务需要 Referer、X-API-Key 或其他认证头时可在此添加。")}</p>:headers.map((header,index)=><div className="field connection-header-row" key={header.key}><input aria-label={t("请求头 {0} 名称", {"0": index+1})} value={header.name} onChange={e=>setHeaders(values=>values.map(h=>h.key===header.key?{...h,name:e.target.value}:h))} placeholder={t("例如 Referer")} disabled={busy}/><input aria-label={t("请求头 {0} 内容", {"0": index+1})} type="password" autoComplete="new-password" value={header.value} onChange={e=>setHeaders(values=>values.map(h=>h.key===header.key?{...h,value:e.target.value}:h))} placeholder={selected?.requiredHeaders.includes(header.name)?t("已保存，留空保留"):t("请求头内容")} disabled={busy}/><Button variant="ghost" size="icon" aria-label={t("移除请求头 {0}", {"0": index+1})} disabled={busy} onClick={()=>setHeaders(values=>values.filter(h=>h.key!==header.key))}><X size={15}/></Button></div>)}
        </section>
      </> : <>
        <div className="connection-list-heading"><span>{connections.length?t("{0} 个连接", {"0": connections.length}):t("暂无三维连接")}</span><Button size="sm" variant="outline" onClick={()=>choose(null)}><Plus size={14}/>{t("添加连接")}</Button></div>
        {connections.length===0?<div className="connection-empty"><Network size={28}/><p>{t("添加一次连接，之后可直接告诉 AI")}<br/>{t("“用园区模型连接下载这个范围”。")}</p></div>:<div className="connection-list">{connections.map(connection=><div className="connection-list-row" key={connection.id}><Button variant="ghost" className="connection-list-select" onClick={()=>choose(connection)}><Network size={18}/><span><strong>{connection.name}</strong><small>{connection.kind==="cesiumIon"?`Cesium Ion · Asset ${connection.assetId}`:t("3D Tiles 服务")}</small></span><em className={connection.credentialReady?"connection-ready":"connection-pending"}>{connection.credentialReady?t("已配置"):t("待填写")}</em></Button><Button variant="ghost" size="icon" disabled={busy} aria-label={t("删除连接 {0}", {"0": connection.name})} onClick={()=>void remove(connection)}><Trash size={15}/></Button></div>)}</div>}
      </>}
      {notice&&<p className="connection-notice" role="status"><CheckCircle2 size={16}/>{localize(notice)}</p>}{error&&<p className="error-box" role="alert"><CircleAlert size={16}/>{localize(error)}</p>}
    </div></ScrollArea>
    <div className="dialog-actions">{editing?<><Button variant="outline" disabled={busy||(!selected&&(!name.trim()||(kind==="direct"?!url.trim():!Number(assetId))))} onClick={()=>void save(true)}>{busy?<Loader2 size={14} className="animate-spin"/>:<Network size={14}/>}{t("保存并测试")}</Button><Button disabled={busy||(!selected&&(!name.trim()||(kind==="direct"?!url.trim():!Number(assetId))))} onClick={()=>void save()}>{busy?t("处理中…"):t("保存连接")}</Button></>:<Button variant="outline" onClick={onClose}>{t("完成")}</Button>}</div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

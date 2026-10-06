import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/motion/button/base";
import { api, errorMessage, type BoundaryImport, type DataConnection, type DataConnectionDraft, type DataConnectionAuthentication, type DataInputRequest, type DataInputResult, type DataConnectionResult, type OnlineConnection, type OnlineService } from "./api";
import { Loader2, Plus, Trash, X } from "./icons";
import "./data-input.css";
import { DatabaseTlsFields } from "./database-tls-fields";
import {SqlConnectionsSection} from "./sql-connections";

export const vectorAccept = ".geojson,.json,.shp,.shx,.dbf,.prj,.cpg,.zip,.gpkg,.sqlite,.db,.kml,.kmz,.gml,.fgb,.gpx,.wkt,.csv";
export async function vectorFiles(files: File[]): Promise<DataInputRequest> {
  if (files.reduce((n, file) => n + file.size, 0) > 32 * 1024 * 1024) throw new Error("文件组不能超过 32 MiB");
  return { files: await Promise.all(files.map(async file => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { name: file.name, base64: btoa(text) };
  })) };
}

export function DataInputPanel({ open, initialRequest, initialConnection, onConnection, onOpenChange, conversationId, onBoundary }: { open: boolean; initialRequest?: DataInputRequest | null; initialConnection?: DataConnectionAuthentication | null; onConnection?: (value: DataConnectionResult & { connection: DataConnection }) => void; onOpenChange: (open: boolean) => void; conversationId: string; onBoundary: (boundary: BoundaryImport) => void }) {
  const [tab, setTab] = useState<"file" | "url" | "database">("file");
  const [url, setUrl] = useState("");
  const [onlineConnections, setOnlineConnections] = useState<OnlineConnection[]>([]);
  const [onlineId, setOnlineId] = useState<string | null>(null);
  const [onlineService, setOnlineService] = useState<OnlineService | null>(null);
  const [onlineAdding, setOnlineAdding] = useState(false);
  const [onlineName, setOnlineName] = useState("");
  const [onlineHeaders, setOnlineHeaders] = useState("{}");
  const [connections, setConnections] = useState<DataConnection[]>([]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<DataConnectionDraft>({ name: "", host: "localhost", port: 5432, database: "", user: "", password: "", sslMode: "prefer" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [passwordReset,setPasswordReset]=useState(0);
  const [result, setResult] = useState<DataInputResult | null>(null);
  const [request, setRequest] = useState<DataInputRequest | null>(null);
  const [crs, setCrs] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const initialRead = useRef<DataInputRequest | null>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (!open) setDraft(current => ({ ...current, password: "", sslClientCert: undefined, sslClientKey: undefined,sslClientKeyPassword:undefined,sslClientBundle:undefined })); }, [open]);
  useEffect(() => { if (open) void api.dataConnectionsList().then(setConnections).catch(cause => setMessage(errorMessage(cause))); }, [open]);
  useEffect(() => { if (open) void api.onlineConnectionsList().then(setOnlineConnections).catch(cause => setMessage(errorMessage(cause))); }, [open]);
  useEffect(() => {
    if (open && initialConnection) {
      setTab("database"); setAdding(true); setDraft({ ...initialConnection, password: "" }); setResult(null); setMessage("");
    }
  }, [open, initialConnection]);
  useEffect(() => {
    if (!open) { initialRead.current = null; return; }
    if (initialRequest && initialRead.current !== initialRequest) {
      initialRead.current = initialRequest;
      setTab("file"); setCrs("");
      void read(initialRequest);
    }
  }, [open, initialRequest]);
  function changeTab(value: typeof tab) { setTab(value); setResult(null); setRequest(null); setMessage(""); setCrs(""); setOnlineService(null); }
  async function discoverOnline(connectionId?: string) {
    if (busy) return;
    setBusy(true); setMessage(""); setResult(null); setOnlineService(null); setOnlineId(connectionId ?? null);
    try { const value = await api.onlineServicesDiscover(connectionId ? undefined : url.trim(), connectionId); if (active.current) { setOnlineService(value); setMessage(value.layers?.length ? `发现 ${value.layers.length} 个图层，选择要读取的范围。` : value.queryUrl ? "已发现要素图层，可读取范围。" : "目录已读取，请使用具体要素服务地址。"); } }
    catch (cause) { if (active.current) setMessage(errorMessage(cause)); }
    finally { if (active.current) setBusy(false); }
  }
  async function saveOnline() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const headers: unknown = JSON.parse(onlineHeaders);
      if (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some(value=>typeof value!=="string")) throw new Error("请求头需要 JSON 对象，名称和内容均为文本。");
      const connection=await api.onlineConnectionSave({name:onlineName.trim(),url:url.trim(),headers:headers as Record<string,string>});
      if (active.current) { setOnlineConnections(await api.onlineConnectionsList()); setOnlineId(connection.id); setOnlineHeaders("{}"); setOnlineAdding(false); setMessage("在线连接已保存，可以发现图层并读取范围。"); }
    } catch (cause) { if (active.current) setMessage(errorMessage(cause)); }
    finally { if (active.current) setBusy(false); }
  }
  async function read(next: DataInputRequest) {
    if (busy) return;
    setBusy(true); setMessage(""); setResult(null);
    try {
      const value = await api.dataInputRead(conversationId, next);
      if (!active.current) return;
      setResult(value); setRequest(value.handle ? { handle: value.handle, layer: next.layer } : next);
      if (value.error) setMessage(value.error.message);
      else if (value.boundary) { onBoundary(value.boundary); setMessage(`已附加 ${value.boundary.polygonCount} 个面，坐标已转换为 WGS84。`); }
      else if (!value.layers?.length) setMessage("没有可读取的空间图层。");
    } catch (cause) { if (active.current) setMessage(errorMessage(cause)); }
    finally { if (active.current) setBusy(false); }
  }
  async function saveConnection() {
    setBusy(true); setMessage("");
    try {
      const value = await api.dataConnectionSave(draft);
      if (value.error) throw value.error;
      setDraft(current => ({ ...current, password: "", sslClientCert: undefined, sslClientKey: undefined,sslClientKeyPassword:undefined,sslClientBundle:undefined }));
      setConnections(await api.dataConnectionsList()); setAdding(false);
      if (value.connection) { setRequest({ connectionId: value.connection.id }); setResult({ layers: value.layers, selectionRequired: true }); }
      if (value.connection && onConnection) onConnection({ ...value, connection: value.connection, readOnly: true });
    } catch (cause) { setMessage(errorMessage(cause));if(['INPUT_TLS_KEY_PASSWORD_REQUIRED','INPUT_TLS_KEY_PASSWORD_INCORRECT','INPUT_TLS_BUNDLE_PASSWORD_REQUIRED','INPUT_TLS_BUNDLE_OPEN_FAILED'].includes((cause as {code?:string})?.code??''))setPasswordReset(value=>value+1); }
    finally { setBusy(false); }
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className="data-input-dialog">
      <div className="data-input-heading"><div><Dialog.Title>{initialConnection ? t("数据库认证") : t("添加数据范围")}</Dialog.Title><Dialog.Description>{initialConnection ? t("Agent 已填写连接信息，输入密码后继续操作") : t("从文件、在线数据或 PostGIS 读取裁剪范围")}</Dialog.Description></div><Dialog.Close asChild><Button variant="ghost" size="icon" disabled={busy} aria-label={t("关闭数据输入")}><X size={18} /></Button></Dialog.Close></div>
      {!initialConnection && <div className="data-input-tabs">{([['file', '文件'], ['url', '在线数据'], ['database', '数据库']] as const).map(([value, label]) => <Button key={value} variant="ghost" disabled={busy} aria-pressed={tab === value} onClick={() => changeTab(value)}>{localize(label)}</Button>)}</div>}
      <div className="data-input-body">
        {tab === "file" && <><input hidden ref={input} type="file" multiple accept={vectorAccept} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) void vectorFiles(files).then(read).catch(cause => setMessage(errorMessage(cause))); }} /><Button disabled={busy} onClick={() => input.current?.click()}><Plus size={16} />{t("选择矢量文件")}</Button><p className="data-input-hint">{t("GeoJSON、Shapefile / ZIP、GeoPackage、KML / KMZ、GML、FlatGeobuf、WKT、CSV。Shapefile 请一起选择配套文件。")}</p></>}
        {tab === "url" && <>
          {!!onlineConnections.length && <div className="data-input-connections">{onlineConnections.map(connection=><div key={connection.id}><Button variant="ghost" pressScale={1} whileHover={{scale:1}} disabled={busy} onClick={()=>void discoverOnline(connection.id)}><span><strong>{connection.name}</strong><small>{connection.url}</small></span></Button><Button variant="ghost" size="icon" disabled={busy} aria-label={t("移除 {0}", {"0": connection.name})} onClick={()=>void api.onlineConnectionRemove(connection.id).then(()=>api.onlineConnectionsList()).then(value=>{setOnlineConnections(value);if(onlineId===connection.id){setOnlineId(null);setOnlineService(null);}}).catch(cause=>setMessage(errorMessage(cause)))}><Trash size={15}/></Button></div>)}</div>}
          <form onSubmit={event=>{event.preventDefault();void read({url:url.trim()});}}><label>{t("数据或服务网址")}<input value={url} onChange={event=>{setUrl(event.target.value);setOnlineService(null);setOnlineId(null);}} placeholder={t("https://…/FeatureServer 或数据文件网址")} disabled={busy}/></label><p className="data-input-hint">{t("ArcGIS、OGC API Features、WFS 或在线矢量文件。服务先发现图层；读取范围会核对分页完整性。")}</p><div className="data-input-online-actions"><Button variant="outline" type="button" disabled={busy||!url.trim()} onClick={()=>void discoverOnline()}>{t("发现图层")}</Button><Button disabled={busy||!url.trim()} type="submit">{t("读取数据")}</Button><Button variant="ghost" type="button" disabled={busy} onClick={()=>setOnlineAdding(!onlineAdding)}>{t("保存私有连接")}</Button></div></form>
          {onlineAdding && <form onSubmit={event=>{event.preventDefault();void saveOnline();}}><label>{t("连接名称")}<input value={onlineName} onChange={event=>setOnlineName(event.target.value)} disabled={busy}/></label><label>{t("认证请求头 · JSON")}<input type="password" autoComplete="off" value={onlineHeaders} onChange={event=>setOnlineHeaders(event.target.value)} disabled={busy} placeholder={'{"Authorization":"Bearer …"}'}/></label><p className="data-input-hint">{t("请求头和网址中的 Token 保存在系统凭据库。AI 使用连接名称与图层信息。")}</p><Button type="submit" disabled={busy||!onlineName.trim()||!url.trim()}>{t("保存连接")}</Button></form>}
          {!!onlineService?.layers?.length && <div className="data-input-layers"><strong>{t("服务图层")}</strong>{onlineService.layers.map(layer=><Button key={layer.name} variant="ghost" disabled={busy} pressScale={1} whileHover={{scale:1}} onClick={()=>void read(onlineId?{onlineConnectionId:onlineId,layer:layer.name}:{url:layer.queryUrl??url,layer:layer.queryUrl?undefined:layer.name})}><span><strong>{layer.title||layer.name}</strong><small>{layer.geometryType||t("要素图层")}</small></span></Button>)}</div>}
          {onlineService?.queryUrl && <Button disabled={busy} onClick={()=>void read(onlineId?{onlineConnectionId:onlineId}:{url:onlineService.queryUrl})}>{t("读取图层范围")}</Button>}
        </>}
        {tab === "database" && <>
          {!initialConnection && <><div className="data-input-connections">{connections.map(connection => <div key={connection.id}><Button variant="ghost" pressScale={1} whileHover={{ scale: 1 }} disabled={busy} onClick={() => void read({ connectionId: connection.id })}><span><strong>{connection.name}</strong><small>{connection.host}:{connection.port} / {connection.database}</small></span></Button><Button variant="ghost" size="icon" aria-label={t("移除 {0}", {"0": connection.name})} disabled={busy} onClick={() => void api.dataConnectionRemove(connection.id).then(() => api.dataConnectionsList()).then(setConnections).catch(cause => setMessage(errorMessage(cause)))}><Trash size={15} /></Button></div>)}</div><Button variant="ghost" disabled={busy} onClick={() => setAdding(!adding)}><Plus size={16} />{t("添加 PostgreSQL / PostGIS")}</Button><SqlConnectionsSection conversationId={conversationId}/></>}
          {adding && <form className="data-input-db-form" onSubmit={event => { event.preventDefault(); void saveConnection(); }}>{initialConnection && <div className="data-input-auth-summary"><strong>{draft.name}</strong><span>{draft.host}:{draft.port} / {draft.database} · {draft.user}</span></div>}{(initialConnection ? ([['password', '密码']] as const) : ([['name', '连接名称'], ['host', '主机'], ['port', '端口'], ['database', '数据库'], ['user', '用户名'], ['password', '密码']] as const)).map(([key, label]) => <label key={key}>{localize(label)}<input type={key === 'password' ? 'password' : key === 'port' ? 'number' : 'text'} value={draft[key]} disabled={busy} autoComplete="off" onChange={event => setDraft(current => ({ ...current, [key]: key === 'port' ? Number(event.target.value) : event.target.value }))} /></label>)}{!initialConnection && <><div className="data-input-ssl"><span>TLS</span>{(['prefer','require','verify-ca','verify-full','disable'] as const).map(mode=><Button key={mode} variant="ghost" type="button" disabled={busy} aria-pressed={draft.sslMode===mode} onClick={()=>setDraft(current=>({...current,sslMode:mode}))}>{t({prefer:'优先加密',require:'必须加密','verify-ca':'验证证书','verify-full':'验证证书及主机',disable:'关闭'}[mode])}</Button>)}</div></>}<DatabaseTlsFields draft={draft} disabled={busy} passwordReset={passwordReset} requireClientCertificate={Boolean((initialConnection as { clientCertificate?: boolean } | undefined)?.clientCertificate)} onChange={value => setDraft(current => ({ ...current, ...value }))} onError={setMessage} /><p className="data-input-hint">{t("只读连接。密码和客户端私钥保存在系统保护的本机存储，AI 只会看到连接名称和图层信息。")}</p><Button type="submit" disabled={busy || !draft.name || !draft.database || !draft.user}>{initialConnection ? t("连接并继续") : t("测试并保存")}</Button></form>}
        </>}
        {busy && <div className="data-input-status" role="status"><Loader2 className="spin" size={16} />{tab === "database" ? t("正在连接数据库并读取图层…") : t("正在读取数据…首次启动会准备 GIS 运行环境")}</div>}
        {message && <p className={`data-input-status ${result?.boundary ? 'success' : ''}`} role="status">{message}</p>}
        {result?.error?.code === 'INPUT_CRS_REQUIRED' && request && <form className="data-input-crs" onSubmit={event => { event.preventDefault(); void read({ ...request, sourceCrs: crs }); }}><label>{t("源坐标系")}<input placeholder="EPSG:4326 / EPSG:3857" value={crs} onChange={event => setCrs(event.target.value)} disabled={busy} /></label><Button disabled={busy || !crs} type="submit">{t("转换并附加")}</Button></form>}
        {!!result?.layers?.length && !result.boundary && <div className="data-input-layers"><strong>{t("选择范围图层")}</strong>{result.layers.map(layer => <Button variant="ghost" pressScale={1} whileHover={{ scale: 1 }} key={layer.name} disabled={busy} onClick={() => { if (request) void read({ ...request, layer: layer.name }); }}><span><strong>{layer.name}</strong><small>{layer.geometryType} · {layer.crs || t("坐标系未声明")}{layer.featureCount !== null ? t(" · {0} 个要素", {"0": layer.featureCount}) : ''}</small></span></Button>)}</div>}
        {result?.boundary && <div className="data-input-footer"><Button onClick={() => onOpenChange(false)}>{t("完成")}</Button></div>}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

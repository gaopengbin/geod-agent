import {useEffect,useState} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {open as selectFile} from "@tauri-apps/plugin-dialog";
import {Button} from "@/components/motion/button/base";
import {ScrollArea} from "@/components/ui/scroll-area";
import {UiSelect} from "./ui-select";
import {api,errorMessage,type SqlConnection,type SqlConnectionDraft,type SqlConnectionResult,type SqlDatabaseKind} from "./api";
import {Database,FolderOpen,Loader2,Plus,Trash,X} from "./icons";
import {t} from "./i18n";
import {DatabaseTlsFields} from "./database-tls-fields";
import "./sql-connections.css";

const labels:Record<SqlDatabaseKind,string>={sqlite:"SQLite / GeoPackage",mysql:"MySQL / MariaDB",sqlserver:"SQL Server",oracle:"Oracle"};
const blank=():SqlConnectionDraft=>({name:"",kind:"sqlite",relativePath:"",host:"localhost",database:"",user:"",password:"",sslMode:"require"});
function clean(value:SqlConnectionDraft):SqlConnectionDraft{return {name:value.name,kind:value.kind,host:value.host,port:value.port,database:value.database,user:value.user,relativePath:value.relativePath,sslMode:value.sslMode,sslRootCert:value.sslRootCert,clientCertificate:value.clientCertificate,password:""};}
function objects(value:unknown):{name:string;schema?:string}[]{
  const list=(value as {results?:unknown})?.results;
  return Array.isArray(list)?list.filter(item=>item&&typeof item.name==="string"):[];
}
export function SqlConnectionDialog({open,conversationId,initial,onOpenChange,onSaved}:{open:boolean;conversationId:string;initial?:SqlConnectionDraft|null;onOpenChange:(value:boolean)=>void;onSaved:(result:SqlConnectionResult)=>void}){
  const [draft,setDraft]=useState<SqlConnectionDraft>(blank),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [passwordReset,setPasswordReset]=useState(0);
  useEffect(()=>{if(open){setDraft(initial?clean(initial):blank());setError("");}else setDraft(current=>({...current,password:"",sslClientCert:undefined,sslClientKey:undefined,sslClientKeyPassword:undefined}));},[open,initial]);
  async function save(){
    if(busy)return;setBusy(true);setError("");
    try{const result=await api.sqlConnectionSave(conversationId,{...clean(draft),password:draft.password||"",sslClientCert:draft.sslClientCert,sslClientKey:draft.sslClientKey,sslClientKeyPassword:draft.sslClientKeyPassword});
      if(result.error)throw result.error;setDraft(current=>({...current,password:"",sslClientCert:undefined,sslClientKey:undefined,sslClientKeyPassword:undefined}));onSaved(result);onOpenChange(false);
    }catch(cause){setError(errorMessage(cause));if(['INPUT_TLS_KEY_PASSWORD_REQUIRED','INPUT_TLS_KEY_PASSWORD_INCORRECT'].includes((cause as {code?:string})?.code??''))setPasswordReset(value=>value+1);}finally{setBusy(false);}
  }
  async function choose(){
    try{const workspace=await api.workspaceGet(conversationId),file=await selectFile({title:t("选择数据库文件"),defaultPath:workspace.directory,filters:[{name:"SQLite",extensions:["db","sqlite","sqlite3","gpkg"]}],multiple:false});if(typeof file!=="string")return;
      const prefix=workspace.directory.replaceAll("\\","/").replace(/\/$/,"")+"/",path=file.replaceAll("\\","/");if(!path.toLowerCase().startsWith(prefix.toLowerCase()))throw new Error(t("请选择当前工作区内的数据库文件"));setDraft(current=>({...current,relativePath:path.slice(prefix.length),name:current.name||path.split("/").at(-1)||""}));
    }catch(cause){setError(errorMessage(cause));}
  }
  return <Dialog.Root open={open} onOpenChange={value=>{if(!busy)onOpenChange(value);}}><Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content className="data-input-dialog sql-connection-dialog">
    <header className="data-input-heading"><div><Dialog.Title>{initial?t("数据库认证"):t("添加数据库连接")}</Dialog.Title><Dialog.Description>{t("连接保存到本机，Agent 可发现表并读取数据。")}</Dialog.Description></div><Dialog.Close asChild><Button variant="ghost" size="icon" disabled={busy} aria-label={t("关闭数据库连接")}><X size={18}/></Button></Dialog.Close></header>
    <ScrollArea className="sql-connection-scroll" viewportClassName="sql-connection-viewport"><form id="sql-connection-form" className="sql-connection-form" onSubmit={event=>{event.preventDefault();void save();}}>
      <label className="sql-full">{t("数据库类型")}<UiSelect value={draft.kind} disabled={busy||Boolean(initial)} ariaLabel={t("数据库类型")} onValueChange={value=>setDraft(current=>({...current,kind:value as SqlDatabaseKind,port:{sqlite:0,mysql:3306,sqlserver:1433,oracle:1521}[value]||undefined,sslMode:current.sslMode==="verify-ca"&&value==="sqlserver"?"verify-full":current.sslMode,sslRootCert:undefined,sslClientCert:undefined,sslClientKey:undefined,sslClientKeyPassword:undefined,clientCertificate:false}))} options={Object.entries(labels).map(([value,label])=>({value,label}))}/></label>
      <label className="sql-full">{t("连接名称")}<input value={draft.name} disabled={busy} onChange={event=>setDraft(current=>({...current,name:event.target.value}))} autoComplete="off" maxLength={80}/></label>
      {draft.kind==="sqlite"?<label className="sql-full">{t("工作区数据库文件")}<div className="sql-file-field"><input value={draft.relativePath||""} disabled={busy} placeholder="data/example.sqlite" onChange={event=>setDraft(current=>({...current,relativePath:event.target.value}))}/><Button type="button" variant="outline" disabled={busy} onClick={()=>void choose()} aria-label={t("选择数据库文件")}><FolderOpen size={16}/></Button></div></label>:<>
        <label>{t("主机")}<input disabled={busy} value={draft.host||""} onChange={event=>setDraft(current=>({...current,host:event.target.value}))} autoComplete="off"/></label>
        <label>{t("端口")}<input type="number" min={1} max={65535} disabled={busy} value={draft.port||({mysql:3306,sqlserver:1433,oracle:1521}[draft.kind])} onChange={event=>setDraft(current=>({...current,port:Number(event.target.value)}))}/></label>
        <label className="sql-full">{draft.kind==="oracle"?t("服务名称"):t("数据库")}<input disabled={busy} value={draft.database||""} onChange={event=>setDraft(current=>({...current,database:event.target.value}))} autoComplete="off"/></label>
        <label>{t("用户名")}<input disabled={busy} value={draft.user||""} onChange={event=>setDraft(current=>({...current,user:event.target.value}))} autoComplete="off"/></label>
        <label>{t("密码")}<input type="password" disabled={busy} value={draft.password||""} onChange={event=>setDraft(current=>({...current,password:event.target.value}))} autoComplete="off"/></label>
        <label className="sql-full">{t("连接加密")}<UiSelect value={draft.sslMode||"require"} disabled={busy} ariaLabel={t("连接加密")} onValueChange={value=>setDraft(current=>({...current,sslMode:value,...(value==="disable"?{sslRootCert:undefined,sslClientCert:undefined,sslClientKey:undefined,sslClientKeyPassword:undefined,clientCertificate:false}:{})}))} options={[{value:"require",label:t("加密连接")},...(draft.kind!=="sqlserver"?[{value:"verify-ca",label:t("加密并验证 CA 证书")}]:[]),{value:"verify-full",label:t("加密并验证证书及主机")},{value:"disable",label:t("关闭加密")} ]}/></label>
        {draft.sslMode!=="disable"&&<div className="sql-full sql-tls-fields"><DatabaseTlsFields draft={{sslMode:draft.sslMode||"require",sslRootCert:draft.sslRootCert,sslClientCert:draft.sslClientCert,sslClientKey:draft.sslClientKey,sslClientKeyPassword:draft.sslClientKeyPassword}} disabled={busy} passwordReset={passwordReset} showCa allowClientCertificate={draft.kind!=="sqlserver"} requireClientCertificate={draft.clientCertificate} onChange={value=>setDraft(current=>({...current,...value,...(value.sslClientCert===undefined&&Object.hasOwn(value,"sslClientCert")?{clientCertificate:false}:{})}))} onError={setError}/></div>}
        {draft.kind==="oracle"&&draft.sslMode!=="disable"&&<p className="data-input-hint sql-full">{t("Oracle 加密连接始终验证证书链；私有证书需要配置 CA。")}</p>}
        <p className="data-input-hint sql-full">{t("密码保存在系统凭据库，连接工具不会返回密码。")}</p>
      </>}
      {error&&<p className="sql-connection-error sql-full" role="alert">{error}</p>}
    </form></ScrollArea>
    <footer className="sql-connection-footer"><Button variant="outline" disabled={busy} onClick={()=>onOpenChange(false)}>{t("取消")}</Button><Button type="submit" form="sql-connection-form" disabled={busy||!draft.name.trim()||draft.kind==="sqlite"&&!draft.relativePath?.trim()}>{busy&&<Loader2 size={16} className="animate-spin"/>}{t("测试并保存")}</Button></footer>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export function SqlConnectionsSection({conversationId}:{conversationId:string}){
  const [connections,setConnections]=useState<SqlConnection[]>([]),[adding,setAdding]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[catalog,setCatalog]=useState<{connection:SqlConnection;tables:{name:string;schema?:string}[]}|null>(null);
  const refresh=()=>api.sqlConnectionsList().then(value=>setConnections(value.connections));
  useEffect(()=>{void refresh().catch(cause=>setError(errorMessage(cause)));},[]);
  async function inspect(connection:SqlConnection){setBusy(true);setError("");setCatalog(null);try{const value=await api.sqlObjectsSearch(connection.id,{objectType:"table",detailLevel:"names",limit:100});setCatalog({connection,tables:objects(value.result)});}catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}}
  return <section className="sql-connections-section"><div className="sql-section-heading"><strong>{t("其他数据库")}</strong><Button variant="ghost" disabled={busy} onClick={()=>setAdding(true)}><Plus size={15}/>{t("添加连接")}</Button></div><p className="data-input-hint">SQLite · MySQL · SQL Server · Oracle</p>
    <div className="data-input-connections">{connections.map(connection=><div key={connection.id}><Button variant="ghost" disabled={busy} onClick={()=>void inspect(connection)}><Database size={16}/><span><strong>{connection.name}</strong><small>{labels[connection.kind]} · {connection.database}</small></span></Button><Button variant="ghost" size="icon" disabled={busy} aria-label={t("移除 {0}",{0:connection.name})} onClick={()=>{void api.sqlConnectionRemove(connection.id).then(refresh).then(()=>setCatalog(null)).catch(cause=>setError(errorMessage(cause)));}}><Trash size={15}/></Button></div>)}</div>
    {busy&&<p className="data-input-status"><Loader2 size={15} className="animate-spin"/>{t("读取数据库目录…")}</p>}
    {error&&<p className="sql-connection-error" role="alert">{error}</p>}
    {catalog&&<div className="sql-catalog"><strong>{catalog.connection.name}</strong><p className="data-input-hint">{t("发现 {0} 个表，可在对话中继续读取。",{0:catalog.tables.length})}</p><ScrollArea className="sql-catalog-scroll">{catalog.tables.map(table=><div key={`${table.schema}.${table.name}`}><Database size={13}/><span>{table.schema?`${table.schema}.`:""}{table.name}</span></div>)}</ScrollArea></div>}
    <SqlConnectionDialog open={adding} conversationId={conversationId} onOpenChange={setAdding} onSaved={()=>{void refresh().catch(cause=>setError(errorMessage(cause)));}}/>
  </section>;
}

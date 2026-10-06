import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import {useEffect,useState} from "react";
import {Button} from "@/components/motion/button/base";
import {api,errorMessage,type McpAuthorization,type McpConnector} from "./api";
import {CircleAlert,ArrowRight as ExternalLink,Loader2} from "./icons";

export function McpOAuthPanel({connector,onUpdated}:{connector:McpConnector;onUpdated:()=>Promise<void>}){
  const [clientId,setClientId]=useState("");
  const [clientSecret,setClientSecret]=useState("");
  const [callbackPort,setCallbackPort]=useState("");
  const [scopes,setScopes]=useState("");
  const [authorization,setAuthorization]=useState<McpAuthorization|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  useEffect(()=>{let active=true;void api.mcpOauthPending(connector.id).then(value=>{if(active)setAuthorization(value);}).catch(cause=>{if(active)setError(errorMessage(cause));});return()=>{active=false;};},[connector.id]);
  useEffect(()=>{
    if(!authorization||!["waiting","saving"].includes(authorization.state))return;
    let active=true;
    const timer=window.setInterval(()=>void api.mcpOauthStatus(authorization.authorizationId).then(async value=>{
      if(!active)return;
      setAuthorization(value);
      if(value.state==="authorized")await onUpdated();
    }).catch(cause=>{if(active)setError(errorMessage(cause));}),1000);
    return()=>{active=false;window.clearInterval(timer);};
  },[authorization?.authorizationId,authorization?.state,onUpdated]);
  async function start(){
    setBusy(true);setError("");setNotice("");
    try{
      const port=callbackPort.trim()?Number(callbackPort):undefined;
      if(clientSecret&&!clientId.trim())throw new Error(t("填写客户端密钥时，请同时提供客户端 ID"));
      if(port!==undefined&&(!Number.isInteger(port)||port<1||port>65535))throw new Error(t("本机回调端口必须为 1 到 65535"));
      const started=await api.mcpOauthStart(connector.id,clientId.trim()||undefined,scopes.trim()?scopes.trim().split(/\s+/):undefined,clientSecret||undefined,port);
      setClientSecret("");
      setAuthorization(started);
      if(started.authorizationUrl)await api.mcpOauthOpen(started.authorizationId);
    }catch(cause){setError(errorMessage(cause));}finally{setClientSecret("");setBusy(false);}
  }
  async function disconnect(){setBusy(true);setError("");setNotice("");try{const result=await api.mcpOauthDisconnect(connector.id);setAuthorization(null);setNotice(result.message);await onUpdated();}catch(cause){setError(errorMessage(cause));}finally{setBusy(false);}}
  const pending=authorization&&["waiting","saving"].includes(authorization.state);
  return <section className="extension-oauth-panel" aria-label={t("MCP 浏览器授权")}>
    <p>{t("在服务提供方的浏览器页面完成授权。访问令牌和刷新令牌保存在系统凭据库。")}</p>
    {!pending&&<><label><span className="extension-oauth-field-title">{t("客户端 ID ")}<span>{t("可选")}</span></span><input value={clientId} disabled={busy} onChange={event=>setClientId(event.target.value)} placeholder={t("支持自动注册的服务可留空")} autoComplete="off"/></label><label><span className="extension-oauth-field-title">{t("客户端密钥")}<span>{t("可选")}</span></span><input type="password" value={clientSecret} disabled={busy} onChange={event=>setClientSecret(event.target.value)} maxLength={8192} placeholder={t("仅在提供方要求时填写")} autoComplete="off"/></label><label><span className="extension-oauth-field-title">{t("本机回调端口")}<span>{t("可选")}</span></span><input inputMode="numeric" maxLength={5} value={callbackPort} disabled={busy} onChange={event=>setCallbackPort(event.target.value)} placeholder={t("留空自动分配端口")}/></label><p className="extension-oauth-note">{t("提供方要求固定回调地址时，登记 http://127.0.0.1:{0}/callback。",{0:callbackPort||t("端口")})}</p><label><span className="extension-oauth-field-title">{t("授权范围 ")}<span>{t("可选")}</span></span><input value={scopes} disabled={busy} onChange={event=>setScopes(event.target.value)} placeholder={t("留空使用服务声明的范围")}/></label></>}
    {authorization&&<p role="status" className="extension-oauth-status">{pending&&<Loader2 size={15} className="extension-spin"/>}{authorization.message??t("请在浏览器中完成授权")}</p>}
    {error&&<p className="extension-tile-error" role="alert"><CircleAlert size={15}/>{localize(error)}</p>}
    {notice&&<p className="extension-oauth-status" role="status">{localize(notice)}</p>}
    <div className="extension-review-actions">{pending?<><Button variant="outline" size="sm" disabled={busy||authorization.state==="saving"} onClick={()=>void api.mcpOauthOpen(authorization.authorizationId).catch(cause=>setError(errorMessage(cause)))}><ExternalLink size={15}/>{t("打开授权页")}</Button><Button variant="ghost" size="sm" disabled={authorization.state==="saving"} onClick={()=>void api.mcpOauthCancel(authorization.authorizationId).then(setAuthorization).catch(cause=>setError(errorMessage(cause)))}>{t("取消授权")}</Button></>:<><Button size="sm" disabled={busy} onClick={()=>void start()}>{busy?<Loader2 size={15} className="extension-spin"/>:null}{connector.oauth?t("重新授权"):t("打开浏览器授权")}</Button>{connector.oauth&&<Button variant="ghost" size="sm" disabled={busy} onClick={()=>void disconnect()}>{t("断开授权")}</Button>}</>}</div>
    <p className="extension-oauth-note">{t("断开时移除本机令牌，并在提供方支持时请求撤销服务端令牌。")}</p>
  </section>;
}

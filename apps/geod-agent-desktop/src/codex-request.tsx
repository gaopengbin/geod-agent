import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useState } from "react";
import { Button } from "@/components/motion/button/base";
import type { CodexEvent } from "./codex-client";
import { api, errorMessage } from "./api";
import { ExternalLink } from "./icons";
import { elicitationBrowserUrl, elicitationContent, fieldOptions, type ElicitationSchema } from "./codex-elicitation";
import { UserInputQuestionCard } from "./user-input-card";

export type CodexRequest = Extract<CodexEvent, { type: "request" }>;
export function CodexRequestCard({ request, respond }: { request: CodexRequest; respond: (value: unknown) => void|Promise<void> }) {
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [formError, setFormError] = useState("");
  const [submitting,setSubmitting]=useState(false);
  const approval = request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval";
  const permissions = request.method === "item/permissions/requestApproval";
  const userInput = request.method === "item/tool/requestUserInput";
  const elicitation = request.method === "mcpServer/elicitation/request";
  const formMode = ["form", "openai/form", "openaiForm"].includes(String(request.params.mode));
  const urlMode=elicitation&&request.params.mode==="url";
  const verificationMode=elicitation&&request.params.mode==="openai/userVerification";
  const browserUrl=urlMode?elicitationBrowserUrl(request.params.url):null;
  async function sendReply(value:unknown){setSubmitting(true);setFormError("");try{await respond(value);}catch(cause){setFormError(errorMessage(cause));}finally{setSubmitting(false);}}
  async function openBrowser(){setSubmitting(true);setFormError("");try{await api.mcpRequestOpenBrowser(request.requestId);await respond({action:"accept",content:null,_meta:null});}catch(cause){setFormError(errorMessage(cause));}finally{setSubmitting(false);}}
  const schema = request.params.requestedSchema as ElicitationSchema | undefined;
  const fields = Object.entries(schema?.properties ?? {});
  const setField = (name: string, value: unknown) => setFormValues(previous => ({ ...previous, [name]: value }));
  if (userInput) return <UserInputQuestionCard questions={request.params.questions} respond={respond}/>;
  return <section className="codex-request-card" role="region" aria-label={t("Agent 等待你的回复")}>
    <strong>{verificationMode?t("设备身份验证"):urlMode?t("在浏览器中继续"):approval || permissions ? t("需要你的确认") : t("需要补充信息")}</strong>
    {verificationMode&&<div className="codex-browser-flow">
      {typeof request.params.title==="string"&&<b>{request.params.title}</b>}
      {typeof request.params.description==="string"&&<p>{request.params.description}</p>}
      <p role="status">{t("此验证方式目前未向 GeoD 开放。你可以取消此请求，并向连接器提供方选择其他登录方式。")}</p>
    </div>}
    {typeof request.params.reason === "string" && <p>{request.params.reason}</p>}
    {typeof request.params.command === "string" && <pre>{request.params.command}</pre>}
    {typeof request.params.message === "string" && <p>{request.params.message}</p>}
    {elicitation && formMode && fields.map(([name, field]) => {
      const value = formValues[name] ?? field.default;
      const options = fieldOptions(field);
      return <div className="codex-request-field" key={name}><span>{field.title ?? name}{schema?.required?.includes(name) ? " *" : ""}</span>
        {field.description && <p>{field.description}</p>}
        {field.type === "boolean" ? [true, false].map(choice => <Button key={String(choice)} variant={value === choice ? "outline" : "ghost"} aria-pressed={value === choice} onClick={() => setField(name, choice)}>{choice ? t("是") : t("否")}</Button>)
          : options.length ? options.map(option => {
            const selected = field.type === "array" ? Array.isArray(value) && value.includes(option.value) : value === option.value;
            return <Button key={option.value} variant={selected ? "outline" : "ghost"} aria-pressed={selected} onClick={() => setField(name, field.type === "array" ? selected ? (value as string[]).filter(item => item !== option.value) : [...(Array.isArray(value) ? value : []), option.value] : option.value)}>{localize(option.label)}</Button>;
          }) : <input aria-label={field.title ?? name} inputMode={field.type === "number" || field.type === "integer" ? "decimal" : "text"} value={String(value ?? "")} onChange={event => setField(name, event.target.value)}/>}</div>;
    })}
    {urlMode&&<div className="codex-browser-flow"><div className="codex-browser-destination"><ExternalLink size={16}/><b>{browserUrl?.host??t("无效的浏览器地址")}</b></div><code>{typeof request.params.url==="string"?request.params.url:""}</code><p>{t("将在系统浏览器中打开。完成后返回对话，是否成功以连接器结果为准。")}</p>{!browserUrl&&<p role="alert">{t("仅支持 HTTPS 或本机 HTTP 地址，无法打开此页面。")}</p>}</div>}
    {elicitation && !formMode&&!urlMode&&!verificationMode && <p>{t("此连接器需要身份验证，当前客户端尚未支持此请求。")}</p>}
    {formError && <p role="alert">{formError}</p>}
    {permissions && <pre>{JSON.stringify(request.params.permissions, null, 2)}</pre>}
    {!approval && !permissions && !userInput && !elicitation && <p>{t("当前客户端尚未支持此请求：")}{request.method}</p>}
    <div className="codex-request-actions">
      {(approval || permissions) && <Button variant="outline" disabled={submitting} onClick={() => void sendReply(approval ? { decision: "accept" } : { permissions: request.params.permissions, scope: "turn" })}>{t("允许本次操作")}</Button>}
      {elicitation && formMode && <Button variant="outline" disabled={submitting} onClick={() => { try { void sendReply({ action: "accept", content: elicitationContent(schema ?? {}, formValues), _meta: null }); } catch (cause) { setFormError((cause as Error).message); } }}>{t("发送回复")}</Button>}
      {urlMode&&<Button variant="outline" disabled={!browserUrl||submitting} onClick={()=>void openBrowser()}><ExternalLink size={15}/>{submitting?t("正在打开…"):t("打开浏览器继续")}</Button>}
      <Button variant="ghost" disabled={submitting} onClick={() => void sendReply(approval ? { decision: "decline" } : permissions ? { permissions: {}, scope: "turn" } : userInput ? { answers: {} } : { action: "cancel", content: null, _meta: null })}>{t("取消")}</Button>
    </div>
  </section>;
}

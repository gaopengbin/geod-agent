import { localize, getLocale, t } from "./i18n";
// i18n: presentation strings migrated
import { cloneElement, isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import * as Select from "@radix-ui/react-select";
import { Button } from "@/components/motion/button/base";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, Check, ChevronDown, CircleAlert, Loader2, Plus, RefreshCw, Save, ShieldCheck, Trash } from "./icons";
import { aiChannels, notifyChannelsChanged, modelValue, protocolName, type AIChannel, type AIChannelDraft, type AIChannelList, type AIModel } from "./ai-channels";
import { desktopAvailable, errorMessage } from "./api";
import { UiTooltip } from "./ui-tooltip";
import {availableAIChannels,sponsorAvailability,useSponsorClock,SPONSORED_CHANNELS_VISIBLE,type AISponsor} from './ai-channels';
import {ExternalLink} from './icons';

const newModel = (): AIModel => ({ id: "", name: "", contextWindow: 128000, maxOutputTokens: 4096, inputModalities: ["text"], thinking: null });
const emptyDraft = (): AIChannelDraft => ({ name: "", baseUrl: "", protocol: "chatCompletions", enabled: true, models: [newModel()] });
const sponsorStateLabel=(sponsor:AISponsor)=>({active:'',disabled:'已停用',scheduled:'尚未开始',ended:'活动已结束'})[sponsorAvailability(sponsor)];
const activityTime=(value:string)=>new Date(value).toLocaleString(getLocale(),{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
const budgetTime=(value:string)=>new Date(value).toLocaleString(getLocale(),{timeZone:'UTC',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' UTC';
const presets = [
  { id: "custom", name: "自定义 / 中转服务", baseUrl: "", protocol: "chatCompletions" as const, model: "" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", protocol: "chatCompletions" as const, model: "" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", protocol: "responses" as const, model: "" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", protocol: "chatCompletions" as const, model: "" },
  { id: "litellm", name: "LiteLLM / 本机网关", baseUrl: "http://127.0.0.1:4000/v1", protocol: "responses" as const, model: "" },
  { id: "anthropic", name: "Anthropic / Claude", baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic" as const, model: "" },
  { id: "gemini", name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", protocol: "gemini" as const, model: "" },
];
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const control = isValidElement<{ "aria-labelledby"?: string; "aria-describedby"?: string }>(children)
    ? cloneElement(children, { "aria-labelledby": `${id}-label`, "aria-describedby": hint ? `${id}-hint` : undefined })
    : children;
  return <label className="field"><span id={`${id}-label`} className="field-label">{localize(label)}</span>{control}{hint && <small id={`${id}-hint`}>{localize(hint)}</small>}</label>;
}
function Choice({ label, value, options, onChange, disabled }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  return <div className="field"><span id={id} className="field-label">{localize(label)}</span><Select.Root value={value} onValueChange={onChange} disabled={disabled}><Select.Trigger className="select-trigger" aria-labelledby={id}><Select.Value/><Select.Icon><ChevronDown size={15}/></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="select-content" position="popper" sideOffset={6} collisionPadding={8}><ScrollArea style={{ maxHeight: 280 }}><Select.Viewport>{options.map(o => <Select.Item key={o.value} className="select-item" value={o.value}><Select.ItemText>{localize(o.label)}</Select.ItemText><Select.ItemIndicator className="select-item-indicator"><Check size={14}/></Select.ItemIndicator></Select.Item>)}</Select.Viewport></ScrollArea></Select.Content></Select.Portal></Select.Root></div>;
}
const tokens = (value: number | null) => value === null ? "未返回" : value < 1000 ? value.toLocaleString(getLocale()) : `${(value / 1000).toLocaleString(getLocale(), { maximumFractionDigits: 1 })}K`;

function ChannelForm({ channel, onSaved, onCancel }: { channel: AIChannel | null; onSaved: (channel: AIChannel) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<AIChannelDraft>(() => channel ? { id: channel.id, name: channel.name, baseUrl: channel.baseUrl, protocol: channel.protocol, enabled: channel.enabled, models: channel.models } : emptyDraft());
  const [apiKey, setApiKey] = useState("");
  const [preset, setPreset] = useState("custom");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [catalog, setCatalog] = useState<{ id: string }[]>([]);
  const [catalogChoice, setCatalogChoice] = useState("");
  function updateModel(index: number, changes: Partial<AIModel>) { setDraft(d => ({ ...d, models: d.models.map((m, i) => i === index ? { ...m, ...changes } : m) })); }
  async function save() {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await aiChannels.save({ ...draft, models: draft.models.map(m => ({ ...m, id: m.id.trim(), name: m.name.trim() || m.id.trim() })), ...(apiKey ? { apiKey } : {}) });
      // Key values are never read back or stored with browser application state.
      setApiKey(""); setDraft(d => ({ ...d, id: saved.id })); notifyChannelsChanged();
      onSaved(saved);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function readCatalog() {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { const actual = await aiChannels.probe(draft.baseUrl, apiKey || undefined, draft.id,draft.protocol); setCatalog(actual.models); setNotice(`已连接 · 服务返回 ${actual.models.length} 个模型。选择模型后保存渠道。`); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <form className="ai-channel-form" aria-label={channel ? t("编辑模型渠道") : t("添加模型渠道")} onSubmit={event => { event.preventDefault(); void save(); }}>
    <fieldset disabled={busy}>
      <div className="ai-channel-form-heading"><div><h2>{channel ? channel.name : t("添加渠道")}</h2><p>{t("连接自己的模型服务或兼容网关。")}</p></div><Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t("返回列表")}</Button></div>
      {!channel && <Choice label={t("服务预设")} value={preset} options={presets.map(p => ({ value: p.id, label: p.name }))} onChange={value => { const p = presets.find(p => p.id === value)!; setPreset(value); setCatalog([]); setCatalogChoice(""); setDraft(d => ({ ...d, name: value === "custom" ? d.name : p.name, baseUrl: p.baseUrl, protocol: p.protocol, models: d.models.map(model => ({ ...model, thinking: model.thinking === "adaptive" && p.protocol !== "anthropic" ? null : model.thinking })) })); }}/ >}
      <div className="ai-channel-fields"><Field label={t("渠道名称")}><input value={draft.name} placeholder={t("例如：我的 DeepSeek / 自定义网关")} autoComplete="off" required maxLength={120} onChange={event => setDraft(d => ({ ...d, name: event.target.value }))}/></Field><Choice label={t("接口类型")} value={draft.protocol} options={[{ value: "chatCompletions", label: "OpenAI Chat Completions" }, { value: "responses", label: "OpenAI Responses" },{value:"anthropic",label:"Claude Messages"},{value:"gemini",label:"Google Gemini"}]} onChange={value => {setCatalog([]);setDraft(d => ({ ...d, protocol: value as AIChannel["protocol"],models:d.models.map(model=>({...model,thinking:model.thinking==='adaptive'&&value!=='anthropic'?null:model.thinking}))}));}}/></div>
      <Field label={t("API 基础地址")} hint={draft.protocol==='gemini'?t("填写基础路径，例如 https://generativelanguage.googleapis.com/v1beta；不包含模型名或请求参数。"):t("填写 API 基础路径，例如 https://api.example.com/v1；不包含具体调用接口或请求参数。")}><input type="url" value={draft.baseUrl} placeholder={draft.protocol==='gemini'?"https://generativelanguage.googleapis.com/v1beta":"https://api.example.com/v1"} autoComplete="off" required onChange={event => setDraft(d => ({ ...d, baseUrl: event.target.value }))}/></Field>
      <Field label="API Key" hint={draft.id ? t("已保存到系统凭据。留空保留原密钥，填写新密钥会更新。") : t("保存到本机系统凭据；费用由此渠道的服务方结算。")}><input type="password" value={apiKey} placeholder={draft.id ? t("•••••••• · 已保存") : t("粘贴此渠道的 API Key")} autoComplete="new-password" spellCheck={false} onChange={event => setApiKey(event.target.value)}/></Field>
      <div className="ai-model-heading"><h3>{t("可用模型 ")}<span>{draft.models.length}</span></h3><div><Button type="button" size="sm" variant="ghost" onClick={() => void readCatalog()}><RefreshCw size={14}/>{t("读取模型目录")}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setDraft(d => ({ ...d, models: [...d.models, newModel()] }))}><Plus size={14}/>{t("手动添加")}</Button></div></div>
      {catalog.length > 0 && <Choice label={t("从服务目录添加")} value={catalogChoice || "none"} options={[{ value: "none", label: "选择一个模型 ID" }, ...catalog.map(m => ({ value: m.id, label: m.id }))]} onChange={id => { if (id === "none") return; setCatalogChoice(id); setDraft(d => { if (d.models.some(m => m.id === id)) return d; const m = { ...newModel(), id, name: id }; return { ...d, models: d.models.length === 1 && !d.models[0].id ? [m] : [...d.models, m] }; }); }}/ >}
      {draft.models.map((model, index) => <section className="ai-model-editor" key={index} aria-label={t("模型 {0}", {"0": index + 1})}>
        <div className="ai-model-editor-head"><span>{t("模型 ")}{index + 1}</span><UiTooltip content={t("移除此模型")}><Button type="button" aria-label={t("移除模型 {0}", {"0": index + 1})} size="icon" variant="ghost" disabled={draft.models.length === 1} onClick={() => setDraft(d => ({ ...d, models: d.models.filter((_, i) => i !== index) }))}><Trash size={15}/></Button></UiTooltip></div>
        <div className="ai-channel-fields"><Field label={t("模型 ID")}><input value={model.id} placeholder={t("服务实际提供的模型 ID")} autoComplete="off" required onChange={event => updateModel(index, { id: event.target.value })}/></Field><Field label={t("显示名称")}><input value={model.name} placeholder={model.id || t("模型名称")} onChange={event => updateModel(index, { name: event.target.value })}/></Field></div>
        <details className="ai-model-advanced"><summary>{t("模型能力与上限 ")}<span>{(model.contextWindow / 1000).toLocaleString(getLocale())}{t("K 上下文 · ")}{model.inputModalities.includes("image") ? t("图片、文本") : t("文本")}</span></summary><div className="ai-channel-fields"><Field label={t("上下文 Token")}><input type="number" min={16000} max={4000000} step={1} value={model.contextWindow} onChange={event => updateModel(index, { contextWindow: Number(event.target.value) })}/></Field><Field label={t("最大输出 Token")}><input type="number" min={128} max={131072} step={1} value={model.maxOutputTokens} onChange={event => updateModel(index, { maxOutputTokens: Number(event.target.value) })}/></Field><Choice label={t("输入能力")} value={model.inputModalities.includes("image") ? "image" : "text"} options={[{ value: "text", label: "文本" }, { value: "image", label: "文本与图片" }]} onChange={value => updateModel(index, { inputModalities: value === "image" ? ["text", "image"] : ["text"] })}/><Choice label={t("思考模式")} value={model.thinking || "default"} options={[{ value: "default", label: "不发送 · 服务默认" }, { value: "enabled", label: "启用" }, { value: "disabled", label: "禁用" },...(draft.protocol==='anthropic'?[{value:'adaptive',label:'自适应思考'}]:[])]} onChange={value => updateModel(index, { thinking: value === "default" ? null : value as AIModel["thinking"] })}/></div><p>{t("模型须支持工具调用；目录接口通常不返回能力与容量，以上设置请以服务说明为准。")}</p></details>
      </section>)}
      <label className="ai-channel-enabled"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft(d => ({ ...d, enabled: event.target.checked }))}/>{t("启用此渠道")}</label>
      {notice && <p className="ai-channel-notice" role="status"><Check size={15}/>{localize(notice)}</p>}
      {error && <p className="ai-channel-error" role="alert"><CircleAlert size={15}/>{localize(error)}</p>}
      <div className="ai-channel-form-actions"><Button type="button" variant="ghost" onClick={onCancel}>{t("取消")}</Button><Button type="submit" disabled={busy || !desktopAvailable}>{busy ? <Loader2 size={16} className="animate-spin"/> : <Save size={16}/>}{t("保存渠道")}</Button></div>
    </fieldset>
  </form>;
}

export function AIChannelsPage({ active, accountId, onReturn }: { active: boolean; accountId: string | null; onReturn: () => void }) {
  const [list, setList] = useState<AIChannelList | null>(null);
  useSponsorClock(SPONSORED_CHANNELS_VISIBLE?list?.sponsors:undefined);
  const [editing, setEditing] = useState<AIChannel | "new" | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function refresh() { try { setList(await aiChannels.list()); setError(""); } catch (cause) { setError(errorMessage(cause)); } }
  useEffect(() => {
    let current=true;
    setEditing(null);setList(null);setNotice("");setError("");
    const reload=()=>{void aiChannels.list().then(value=>{if(current){setList(value);setError("")}}).catch(cause=>{if(current)setError(errorMessage(cause))});};
    if(active&&accountId&&desktopAvailable){
      reload();
      window.addEventListener('geod:ai-channels-changed',reload);
      if(SPONSORED_CHANNELS_VISIBLE)void aiChannels.sponsors(true).then(()=>{if(current)reload()}).catch(()=>{});
    }
    return()=>{current=false;window.removeEventListener('geod:ai-channels-changed',reload)};
  }, [active, accountId]);
  async function action(operation: () => Promise<unknown>, message: string) { if (busy) return; setBusy(true); setError(""); try { await operation(); notifyChannelsChanged(); await refresh(); setNotice(message); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); } }
  return <section className="ai-channels-page" hidden={!active} aria-label={t("模型与渠道")}>
    <header className="ai-channels-page-head"><div><h1>{t("模型与渠道")}</h1><p>{t(SPONSORED_CHANNELS_VISIBLE?"选择 GeoD 托管、赞助模型或自有渠道。":"选择 GeoD 托管或自有渠道。")}</p></div><div><Button variant="ghost" size="sm" onClick={onReturn}>{t("返回对话")}</Button><Button size="sm" disabled={!accountId || busy} onClick={() => { setEditing("new"); setNotice(""); }}><Plus size={16}/>{t("添加渠道")}</Button></div></header>
    <ScrollArea key={`${active}:${editing === "new" ? "new" : editing?.id ?? "list"}`} className="ai-channels-scroll"><div className="ai-channels-body">
      {!accountId ? <p className="ai-channel-empty">{t("登录 GeoD 后管理此账号的本机模型配置。")}</p> : editing ? <ChannelForm key={editing === "new" ? "new" : editing.id} channel={editing === "new" ? null : editing} onCancel={() => { setEditing(null); void refresh(); }} onSaved={saved => { setEditing(null); setNotice(`已保存 ${saved.name}，可在会话输入栏选择。`); void refresh(); }}/> : <>
        {error && <p className="ai-channel-error" role="alert"><CircleAlert size={16}/>{localize(error)}</p>}{notice && <p className="ai-channel-notice" role="status"><Check size={16}/>{localize(notice)}</p>}
        <section className="ai-channel-row ai-channel-hosted"><span className="ai-channel-icon"><Bot size={22}/></span><div className="ai-channel-info"><h2>{t("GeoD 托管")}{list?.default.channelId === "hosted" && <span>{t("新对话默认")}</span>}</h2><p>{t("直接使用 GeoD 账号 · 无需填写密钥")}</p></div><Button size="sm" variant="ghost" disabled={busy || !list || list.default.channelId === "hosted"} onClick={() => void action(() => aiChannels.select("default", "hosted", "hosted"), "新对话将使用 GeoD 托管；已有会话与定时任务保留原选择。")}>{t("设为默认")}</Button></section>
        {SPONSORED_CHANNELS_VISIBLE&&<><div className="ai-channel-section-heading ai-sponsors-heading"><div><h2>{t("赞助渠道")} <span>{list?.sponsors?.length??0}</span></h2><p>{t("额度由供应方提供，不扣 GeoD 托管额度。")}</p></div><Button size="sm" variant="ghost" disabled={busy} onClick={()=>void action(()=>aiChannels.sponsors(true),'赞助渠道已更新')}><RefreshCw size={14}/>{t("刷新赞助渠道")}</Button></div>
        {!list?.sponsors?.length&&<p className="ai-sponsors-empty">{t("当前账号暂无赞助渠道。")}</p>}
        {list?.sponsors?.map(sponsor=><section className={`ai-channel-row ai-sponsor-row${sponsorAvailability(sponsor)!=='active'?' is-disabled':''}`} key={sponsor.id}>
          <span className="ai-channel-icon"><ShieldCheck size={22}/></span><div className="ai-channel-info"><h2>{sponsor.name}<span>{t("赞助")}</span>{sponsorStateLabel(sponsor)&&<span>{t(sponsorStateLabel(sponsor))}</span>}{list.default.channelId===`sponsor:${sponsor.id}`&&<span>{t("新对话默认")}</span>}</h2>{sponsor.description&&<p>{sponsor.description}</p>}<div className="ai-channel-model-names">{sponsor.models.map(model=><span key={model.id}>{model.name}{model.inputModalities.includes('image')&&<em> · {t("支持图片")}</em>}</span>)}</div><small>{t("无需填写密钥 · 用量由网关记录")}</small>{(sponsor.startsAt||sponsor.endsAt)&&<small className="ai-sponsor-period">{sponsor.startsAt&&t("开始：{0}",{'0':activityTime(sponsor.startsAt)})}{sponsor.startsAt&&sponsor.endsAt?' · ':''}{sponsor.endsAt&&t("结束：{0}",{'0':activityTime(sponsor.endsAt)})}</small>}{sponsor.website&&<Button size="sm" variant="ghost" className="ai-sponsor-website" onClick={()=>void action(()=>aiChannels.openSponsorWebsite(sponsor.id),"")}><ExternalLink size={13}/>{t("供应方网站")}</Button>}</div>
          <div className="ai-sponsor-quota"><strong>{sponsor.usage.quotaEnforced?t("可用 {0} token",{"0":tokens(sponsor.usage.remainingTokens)}):t("不限额度")}</strong><small>{t(sponsor.usage.budgetPeriod==='month'?"本月已用 {0} token":"已用 {0} token",{"0":tokens(sponsor.usage.committedTokens)})}</small>{sponsor.usage.reservedTokens>0&&<small>{t("请求中 {0} token",{"0":tokens(sponsor.usage.reservedTokens)})}</small>}{sponsor.usage.budgetPeriod==='month'&&sponsor.usage.periodEnd&&<small>{t("下次刷新：{0}",{'0':budgetTime(sponsor.usage.periodEnd)})}</small>}{(sponsor.usage.priorReservedTokens??0)>0&&<small>{t("上期请求待核对 {0} token",{'0':tokens(sponsor.usage.priorReservedTokens??0)})}</small>}<Button size="sm" variant="ghost" disabled={busy||sponsorAvailability(sponsor)!=='active'||(sponsor.usage.quotaEnforced&&sponsor.usage.remainingTokens===0)||list.default.channelId===`sponsor:${sponsor.id}`} onClick={()=>void action(()=>aiChannels.select('default',`sponsor:${sponsor.id}`,sponsor.models[0].id),'新对话默认模型已更新')}>{t("设为默认")}</Button></div>
        </section>)}
        {!!list?.sponsors?.length&&<p className="ai-sponsors-empty">{t("额度以上次刷新为准；渠道变化不会自动切换已保存的任务。")}</p>}</>}
        <div className="ai-channel-section-heading"><h2>{t("自有渠道 ")}<span>{list?.channels.length ?? 0}</span></h2><p>{t("自有渠道用量独立记录，不扣 GeoD 托管额度。")}</p></div>
        {list?.channels.length === 0 && <div className="ai-channel-empty"><ShieldCheck size={24}/><h3>{t("接入你的模型服务")}</h3><p>{t("支持 Responses、Chat Completions、Claude Messages 和 Gemini，也可填写兼容中转地址。")}</p><Button variant="outline" size="sm" onClick={() => setEditing("new")}><Plus size={16}/>{t("添加第一个渠道")}</Button></div>}
        {list?.channels.map(channel => <section className={`ai-channel-row ${!channel.enabled ? "is-disabled" : ""}`} key={channel.id}>
          <span className="ai-channel-icon"><Bot size={22}/></span><div className="ai-channel-info"><h2>{channel.name}{list.default.channelId === channel.id && <span>{t("新对话默认")}</span>}{!channel.enabled && <span>{t("已停用")}</span>}</h2><p>{protocolName(channel.protocol)} · {channel.models.length} {t(" 个模型 · ")}{channel.keyConfigured ? t("密钥已保存") : t("未配置密钥")}</p><small title={channel.baseUrl}>{channel.baseUrl}</small><div className="ai-channel-model-names">{channel.models.map(m => <span key={m.id}>{m.name}</span>)}</div></div>
          <div className="ai-channel-row-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(channel)}>{t("编辑")}</Button><UiTooltip content={t("删除渠道及其系统密钥；保存的定时任务保留记录，执行时提示配置缺失")}><Button aria-label={t("删除 {0}", {"0": channel.name})} size="icon" variant="ghost" disabled={busy} onClick={() => void action(() => aiChannels.remove(channel.id), `已删除 ${channel.name}。`)}><Trash size={16}/></Button></UiTooltip></div>
        </section>)}
        {availableAIChannels(list).length > 0 && <div className="ai-default-model"><Choice label={t("新对话默认模型")} value={modelValue(list!.default.channelId, list!.default.modelId)} disabled={busy} options={[{ value: modelValue("hosted", "hosted"), label: t("GeoD 托管") }, ...availableAIChannels(list).flatMap(c => c.models.map(m => ({ value: modelValue(c.id, m.id), label: `${c.name} · ${m.name}` })))]} onChange={value => { const [channelId, modelId] = JSON.parse(value) as string[]; void action(() => aiChannels.select("default", channelId, modelId), "默认模型已更新；已有会话、子任务和定时任务保留原选择。"); }}/><p>{t("每个会话有自己的选择。定时任务使用创建时的渠道与模型配置。")}</p></div>}
        {!!list?.usage.length && <section className="ai-channel-usage"><h2>{t("自有渠道实际用量")}</h2><p>{t("按服务返回的 Token 记录；费用与余额请到对应服务查看。")}</p><div className="ai-channel-usage-table"><div className="ai-channel-usage-head"><span>{t("渠道 / 模型")}</span><span>{t("输入")}</span><span>{t("输出")}</span><span>{t("请求")}</span></div>{list.usage.map(u => <div key={`${u.channelId}:${u.model}`}><span>{list.channels.find(c => c.id === u.channelId)?.name ?? t("已删除渠道")}<small>{u.model}{u.unknownUsageRequests > 0 ? t(" · {0} 次用量未返回", {"0": u.unknownUsageRequests}) : ""}</small></span><span>{tokens(u.inputTokens)}</span><span>{tokens(u.outputTokens)}</span><span>{u.requests}</span></div>)}</div></section>}
      </>}
    </div></ScrollArea>
  </section>;
}

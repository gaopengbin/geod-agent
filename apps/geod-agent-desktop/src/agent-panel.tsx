import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, CircleAlert, LogIn, LogOut, RotateCcw, Send, Settings2, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { api, desktopAvailable, errorMessage, type AgentMessage, type AgentToolCall, type AuthStatus, type Bounds, type Generation, type ModelUsage, type OutputFormat, type ServiceConfig, type SourceDescriptor, type StoredPlan, type TaskSpec } from "./api";

interface DisplayMessage { id: string; role: "user" | "assistant" | "tool"; content: string }
interface SavedChat { conversationId: string; messages: AgentMessage[]; display: DisplayMessage[]; pendingId?: string }
const STORAGE_KEY = "geod-agent-chat-0.1";
const blankStatus: AuthStatus = { state: "unconfigured", userId: null, error: null };
function restore(): SavedChat {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as SavedChat;
    if (value && typeof value.conversationId === "string" && Array.isArray(value.messages) && Array.isArray(value.display)) return value;
  } catch { /* Start a clean local conversation when an older cache is invalid. */ }
  return { conversationId: crypto.randomUUID(), messages: [], display: [] };
}
function compactPlan(stored: StoredPlan) {
  const plan = stored.plan;
  return { planId: stored.planId, planHash: plan.planHash, source: plan.sourceName, bounds: plan.spec.bounds, zoomLevels: plan.spec.zoomLevels, outputFormats: plan.spec.outputFormats, outputLocation: "用户本机选择的位置，模型不可读取路径", totalTiles: plan.totalTiles, decodedRgbaBytes: plan.decodedRgbaBytes, license: plan.license, attribution: plan.attribution, expiresAt: plan.expiresAt, approval: "尚未批准。必须由用户在桌面计划卡片中核对并确认。" };
}
function stringArg(value: unknown) { return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null; }

export function AgentPanel({ onClose, directory, onPlanned }: { onClose: () => void; directory: string; onPlanned: (plan: StoredPlan) => void }) {
  const restored = useRef<SavedChat>(restore());
  const [conversationId, setConversationId] = useState(restored.current.conversationId);
  const [messages, setMessages] = useState<AgentMessage[]>(restored.current.messages);
  const [display, setDisplay] = useState<DisplayMessage[]>(restored.current.display);
  const [pendingId, setPendingId] = useState(restored.current.pendingId ?? "");
  const [draft, setDraft] = useState("");
  const [config, setConfig] = useState<ServiceConfig | null>(null);
  const [identityOrigin, setIdentityOrigin] = useState("");
  const [gatewayOrigin, setGatewayOrigin] = useState("");
  const [status, setStatus] = useState<AuthStatus>(blankStatus);
  const [usage, setUsage] = useState<ModelUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [planReady, setPlanReady] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const sending = useRef(false);

  useEffect(() => { if (desktopAvailable) Promise.all([api.serviceConfigGet(), api.authStatus()]).then(([saved, auth]) => { setConfig(saved); setIdentityOrigin(saved?.identityOrigin ?? ""); setGatewayOrigin(saved?.gatewayOrigin ?? ""); setStatus(auth); }).catch(cause => setError(errorMessage(cause))); }, []);
  useEffect(() => { if (!desktopAvailable || status.state !== "waiting") return; const timer = window.setInterval(() => { void api.authStatus().then(setStatus).catch(cause => setError(errorMessage(cause))); }, 1200); return () => window.clearInterval(timer); }, [status.state]);
  useEffect(() => { if (status.state === "connected") void api.agentUsage().then(setUsage).catch(cause => setError(errorMessage(cause))); }, [status.state]);
  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify({ conversationId, messages: messages.slice(-24), display: display.slice(-60), pendingId })); }, [conversationId, messages, display, pendingId]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }, [display, busy]);

  async function saveConfig() {
    setBusy(true); setError("");
    try { const saved = await api.serviceConfigSet({ identityOrigin: identityOrigin.trim(), gatewayOrigin: gatewayOrigin.trim() }); setConfig(saved); setStatus(await api.authStatus()); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function beginAuth() {
    setBusy(true); setError("");
    try { setStatus(await api.authBegin()); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError("");
    try { setStatus(await api.authLogout()); setUsage(null); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  function newChat() { if (sending.current) return; setConversationId(crypto.randomUUID()); setMessages([]); setDisplay([]); setPlanReady(false); setPendingId(""); setError(""); }
  async function executeTool(call: AgentToolCall): Promise<unknown> {
    let args: Record<string, unknown>;
    try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; }
    catch { return { error: "INVALID_TOOL_ARGUMENTS" }; }
    if (!args || typeof args !== "object" || Array.isArray(args)) return { error: "INVALID_TOOL_ARGUMENTS" };
    try {
      if (call.function.name === "sources_list") {
        const sources = await api.sourcesList();
        return { sources: sources.map(source => ({ id: source.id, name: source.displayName, license: source.license, attribution: source.attribution, minZoom: source.minZoom, maxZoom: source.maxZoom })) };
      }
      if (call.function.name === "plan_imagery") {
        if (!directory) return { error: "OUTPUT_DIRECTORY_REQUIRED", message: "请先在任务表单中选择成果保存位置。" };
        const sourceId = stringArg(args.sourceId);
        const sources: SourceDescriptor[] = await api.sourcesList();
        const source = sources.find(item => item.id === sourceId);
        const bounds = args.bounds;
        const zoom = args.zoom;
        const formats = args.outputFormats;
        if (!source || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(value => typeof value === "number" && Number.isFinite(value)) ||
          typeof zoom !== "number" || !Number.isInteger(zoom) || zoom < source.minZoom || zoom > source.maxZoom ||
          !Array.isArray(formats) || !formats.length || !formats.every(value => value === "geotiff" || value === "mbtiles")) return { error: "INVALID_PLAN_ARGUMENTS" };
        const spec: TaskSpec = { schemaVersion: "0.1", kind: "imagery", sourceId: source.id, bounds: bounds as Bounds, zoomLevels: [zoom], outputFormats: [...new Set(formats)] as OutputFormat[], outputDirectory: directory, limits: { maxTiles: 4096, maxDecodedRgbaBytes: 512 * 1024 * 1024 } };
        const plan = await api.plansCreate(spec);
        onPlanned(plan); setPlanReady(true);
        return compactPlan(plan);
      }
      if (call.function.name === "jobs_get") {
        const id = stringArg(args.jobId);
        if (!id) return { error: "INVALID_JOB_ID" };
        const job = await api.jobsGet(id);
        return job ? { jobId: job.jobId, state: job.state, planHash: job.planHash, version: job.version } : { error: "JOB_NOT_FOUND" };
      }
      if (call.function.name === "artifacts_inspect") {
        const id = stringArg(args.jobId);
        if (!id) return { error: "INVALID_JOB_ID" };
        const job = await api.jobsGet(id);
        if (!job || job.state !== "completed") return { error: "JOB_NOT_COMPLETED" };
        const manifest = await api.artifactsInspect(id);
        return { jobId: id, quality: manifest.quality, assets: manifest.assets.map(asset => ({ kind: asset.kind, bytes: asset.bytes, sha256: asset.sha256, path: asset.path })), provenance: manifest.provenance };
      }
      return { error: "TOOL_NOT_ALLOWED" };
    } catch (cause) { return { error: cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : "LOCAL_TOOL_ERROR" }; }
  }
  async function finishGeneration(first: Generation, startingContext: AgentMessage[]) {
    let context = startingContext;
    let generation = first;
    for (let round = 0; round < 4; round++) {
      if (generation.state === "failed") { setPendingId(""); setError("该模型请求已失败，额度已按网关记录处理。可以继续提问。"); return; }
      if (generation.state === "settled" && !generation.result) { setPendingId(""); setError("上游用量已核对，但原回答不可恢复。可以继续提问。"); return; }
      if (generation.state !== "settled" || !generation.result) {
        setPendingId(generation.generationId);
        setError(`模型请求状态：${generation.state}。已保留请求编号，可稍后核对。`);
        return;
      }
      setPendingId("");
      const result = generation.result;
      const reply = result.content?.trim();
      if (reply) setDisplay(current => [...current, { id: crypto.randomUUID(), role: "assistant", content: reply }]);
      else if (!result.toolCalls.length) setDisplay(current => [...current, { id: crypto.randomUUID(), role: "assistant", content: "模型没有返回可展示的内容，请再描述一次目标。" }]);
      context = [...context, { role: "assistant", content: result.content, ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}) }];
      setMessages(context);
      if (!result.toolCalls.length) return;
      for (const call of result.toolCalls) {
        const output = await executeTool(call);
        context = [...context, { role: "tool", tool_call_id: call.id, content: JSON.stringify(output) }];
        setMessages(context);
        setDisplay(current => [...current, { id: crypto.randomUUID(), role: "tool", content: `${call.function.name} · ${"error" in (output as object) ? "需要处理" : "已读取本机结果"}` }]);
      }
      if (round === 3) { setError("本轮工具调用已达到上限。请继续提问。"); return; }
      generation = await api.agentGenerate(crypto.randomUUID(), conversationId, context);
    }
  }
  async function checkPending() {
    if (!pendingId || busy) return;
    setBusy(true); setError("");
    try { await finishGeneration(await api.agentGenerationGet(pendingId), messages); setUsage(await api.agentUsage()); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending.current || pendingId || status.state !== "connected") return;
    sending.current = true; setBusy(true); setError(""); setDraft("");
    setDisplay(current => [...current, { id: crypto.randomUUID(), role: "user", content: text }]);
    const context: AgentMessage[] = [...messages, { role: "user", content: text }];
    setMessages(context);
    try {
      await finishGeneration(await api.agentGenerate(crypto.randomUUID(), conversationId, context), context);
      setUsage(await api.agentUsage());
    } catch (cause) { setError(errorMessage(cause)); }
    finally { sending.current = false; setBusy(false); }
  }

  return <div className="agent-overlay"><button className="agent-backdrop" type="button" aria-label="关闭智能助手" onClick={onClose} /><aside className="agent-panel" aria-label="GeoD Agent 智能助手">
    <div className="agent-header"><div className="agent-icon"><Bot size={21} /></div><div><strong>GeoD Agent</strong><small>本地工具 · 托管模型</small></div><button type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button></div>
    {error && <div className="agent-error"><CircleAlert size={16} />{error}</div>}
    {!desktopAvailable && <div className="agent-state"><p>浏览器中仅预览界面。请在桌面程序中配置 GeoD 服务并登录。</p></div>}
    {desktopAvailable && status.state === "unconfigured" && <div className="agent-config"><Settings2 size={24} /><h3>连接 GeoD 服务</h3><p>填写 GeoD 账号站点与 Agent 模型网关的 HTTPS 地址。本地开发可使用 127.0.0.1。</p><label>GeoD 账号地址<input value={identityOrigin} onChange={event => setIdentityOrigin(event.target.value)} placeholder="https://geod.example.com" /></label><label>模型网关地址<input value={gatewayOrigin} onChange={event => setGatewayOrigin(event.target.value)} placeholder="https://agent.example.com" /></label><Button disabled={busy} onClick={saveConfig}>保存服务地址</Button></div>}
    {desktopAvailable && config && status.state !== "unconfigured" && <>
      <div className="agent-account"><div><ShieldCheck size={16} /><span>{status.state === "connected" ? `已连接 GeoD · ${status.userId?.slice(0, 12) ?? ""}` : status.state === "waiting" ? "等待浏览器授权…" : "尚未登录 GeoD"}</span></div>{status.state === "connected" ? <button type="button" onClick={logout} disabled={busy} title="退出 GeoD"><LogOut size={16} /></button> : <Button size="sm" onClick={beginAuth} disabled={busy || status.state === "waiting"}><LogIn size={15} />浏览器登录</Button>}</div>
      {status.error && <div className="agent-error"><CircleAlert size={16} />{status.error}</div>}
      {status.state === "connected" && <><div className="agent-usage"><span>模型额度</span><strong>{usage ? `${usage.remainingTokens.toLocaleString()} / ${usage.limitTokens.toLocaleString()} token` : "查询中…"}</strong>{usage && usage.pendingReconcile > 0 && <small>{usage.pendingReconcile} 个请求待核对</small>}</div><div className="agent-chat-actions"><span>当前对话仅保存在本机</span><button type="button" onClick={newChat} disabled={busy}><RotateCcw size={14} />新对话</button></div><div className="agent-messages" ref={scroll}>{display.length ? display.map(item => <div className={`agent-message ${item.role}`} key={item.id}><span>{item.role === "user" ? "你" : item.role === "tool" ? "本机工具" : "GeoD Agent"}</span><p>{item.content}</p></div>) : <div className="agent-welcome"><Bot size={28} /><h3>从任务说起</h3><p>可以询问已登记图源、规划影像范围，或核对作业和成果。模型可生成计划，下载仍需你亲自确认。</p></div>}{busy && <div className="agent-thinking">正在读取与整理…</div>}</div>{pendingId && <Button className="agent-plan-link" variant="outline" onClick={checkPending} disabled={busy}>核对未完成请求 · {pendingId.slice(0, 8)}</Button>}{planReady && <Button className="agent-plan-link" variant="outline" onClick={onClose}>查看待确认计划</Button>}<form className="agent-composer" onSubmit={send}><textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="例如：列出可用图源，帮我规划北京城区影像" maxLength={3000} disabled={busy || !!pendingId} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><Button type="submit" size="icon" aria-label="发送消息" disabled={busy || !!pendingId || !draft.trim()}><Send size={17} /></Button></form></>}
    </>}
  </aside></div>;
}

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Bot, CircleAlert, LogIn, LogOut, MessageSquare, Paperclip, Plus, Send, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { api, desktopAvailable, errorMessage, type AgentMessage, type AgentToolCall, type AuthStatus, type BoundaryImport, type Bounds, type Generation, type ModelUsage, type OutputFormat, type SourceDescriptor, type StoredPlan, type TaskSpec } from "./api";
import { artifactResultForModel, modelMessagesWithoutArtifactPaths } from "./model-artifacts";

interface DisplayMessage { id: string; role: "user" | "assistant" | "tool"; content: string }
interface SavedChat { conversationId: string; messages: AgentMessage[]; display: DisplayMessage[]; pendingId?: string; planId?: string }
const STORAGE_KEY = "geod-agent-chat-0.1";
const LIST_KEY = "geod-agent-conversations-0.1";
const blankStatus: AuthStatus = { state: "unconfigured", userId: null, error: null };
function restore(): SavedChat {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as SavedChat;
    if (value && typeof value.conversationId === "string" && Array.isArray(value.messages) && Array.isArray(value.display)) return value;
  } catch { /* Start a clean local conversation when an older cache is invalid. */ }
  return { conversationId: crypto.randomUUID(), messages: [], display: [] };
}
function restoreChats(): SavedChat[] {
  try {
    const value = JSON.parse(localStorage.getItem(LIST_KEY) ?? "null") as SavedChat[];
    if (Array.isArray(value) && value.length && value.every(item => typeof item.conversationId === "string" && Array.isArray(item.messages) && Array.isArray(item.display))) return value.slice(0, 30);
  } catch { /* An invalid local index falls back to the previous single chat. */ }
  return [restore()];
}
function chatTitle(chat: SavedChat) { return chat.display.find(item => item.role === "user")?.content.slice(0, 34) || "新对话"; }
function compactPlan(stored: StoredPlan) {
  const plan = stored.plan;
  return { planId: stored.planId, planHash: plan.planHash, source: plan.sourceName, bounds: plan.spec.bounds, boundary: plan.spec.boundary ? `${plan.spec.boundary.polygons.length} 个面；GeoTIFF 按边界透明裁剪，MBTiles 保留整瓦片` : null, zoomLevels: plan.spec.zoomLevels, outputFormats: plan.spec.outputFormats, outputLocation: "用户本机选择的位置，模型不可读取路径", totalTiles: plan.totalTiles, decodedRgbaBytes: plan.decodedRgbaBytes, license: plan.license, attribution: plan.attribution, expiresAt: plan.expiresAt, approval: "尚未批准。必须由用户在桌面计划卡片中核对并确认。" };
}
function stringArg(value: unknown) { return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null; }

export function AgentPanel({ onPlanned, onOpenSources, onSelectConversation }: { onPlanned: (plan: StoredPlan) => void; onOpenSources: () => void; onSelectConversation: (planId: string | null) => void }) {
  const restored = useRef<SavedChat[]>(restoreChats());
  const [chatRecords, setChatRecords] = useState<SavedChat[]>(restored.current);
  const [conversationId, setConversationId] = useState(restored.current[0].conversationId);
  const [messages, setMessages] = useState<AgentMessage[]>(restored.current[0].messages);
  const [display, setDisplay] = useState<DisplayMessage[]>(restored.current[0].display);
  const [pendingId, setPendingId] = useState(restored.current[0].pendingId ?? "");
  const [planId, setPlanId] = useState(restored.current[0].planId ?? "");
  const [draft, setDraft] = useState("");
  const [boundary, setBoundary] = useState<BoundaryImport | null>(null);
  const [status, setStatus] = useState<AuthStatus>(blankStatus);
  const [usage, setUsage] = useState<ModelUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [planReady, setPlanReady] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const boundaryInput = useRef<HTMLInputElement>(null);
  const sending = useRef(false);

  useEffect(() => { if (desktopAvailable) void api.authStatus().then(setStatus).catch(cause => setError(errorMessage(cause))); }, []);
  useEffect(() => { if (!desktopAvailable || status.state !== "waiting") return; const timer = window.setInterval(() => { void api.authStatus().then(setStatus).catch(cause => setError(errorMessage(cause))); }, 1200); return () => window.clearInterval(timer); }, [status.state]);
  useEffect(() => { if (status.state === "connected") void api.agentUsage().then(setUsage).catch(cause => setError(errorMessage(cause))); }, [status.state]);
  useEffect(() => { setChatRecords(current => current.map(item => item.conversationId === conversationId ? { conversationId, messages: messages.slice(-24), display: display.slice(-60), pendingId, planId } : item)); }, [conversationId, messages, display, pendingId, planId]);
  useEffect(() => { localStorage.setItem(LIST_KEY, JSON.stringify(chatRecords)); }, [chatRecords]);
  useEffect(() => { scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: "smooth" }); }, [display, busy]);

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
  function newChat() { if (sending.current || busy) return; const next: SavedChat = { conversationId: crypto.randomUUID(), messages: [], display: [] }; setChatRecords(current => [next, ...current].slice(0, 30)); setConversationId(next.conversationId); setMessages([]); setDisplay([]); setBoundary(null); setPlanReady(false); setPendingId(""); setPlanId(""); setError(""); onSelectConversation(null); }
  function selectChat(chat: SavedChat) { if (sending.current || busy || chat.conversationId === conversationId) return; setConversationId(chat.conversationId); setMessages(chat.messages); setDisplay(chat.display); setBoundary(null); setPendingId(chat.pendingId ?? ""); setPlanId(chat.planId ?? ""); setPlanReady(!!chat.planId); setError(""); onSelectConversation(chat.planId ?? null); }
  async function attachBoundary(event: ChangeEvent<HTMLInputElement>) {
    if (!desktopAvailable || busy || pendingId) return;
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      if (file.size > 1024 * 1024) throw new Error("GeoJSON 边界文件不能超过 1 MiB");
      setBoundary(await api.boundaryInspect(file.name, await file.text()));
    } catch (cause) { setError(errorMessage(cause)); }
  }
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
        const sourceId = stringArg(args.sourceId);
        const sources: SourceDescriptor[] = await api.sourcesList();
        const source = sources.find(item => item.id === sourceId);
        const bounds = args.bounds;
        const zoom = args.zoom;
        const formats = args.outputFormats;
        const validBounds = Array.isArray(bounds) && bounds.length === 4 && bounds.every(value => typeof value === "number" && Number.isFinite(value));
        if (!source || (!boundary && !validBounds) ||
          typeof zoom !== "number" || !Number.isInteger(zoom) || zoom < source.minZoom || zoom > source.maxZoom ||
          !Array.isArray(formats) || !formats.length || !formats.every(value => value === "geotiff" || value === "mbtiles")) return { error: "INVALID_PLAN_ARGUMENTS" };
        const spec: TaskSpec = { schemaVersion: "0.1", kind: "imagery", sourceId: source.id, bounds: boundary?.bounds ?? bounds as Bounds, ...(boundary ? { boundary: boundary.geometry } : {}), zoomLevels: [zoom], outputFormats: [...new Set(formats)] as OutputFormat[], outputDirectory: await api.outputDirectorySuggest(), limits: { maxTiles: 4096, maxDecodedRgbaBytes: 512 * 1024 * 1024 } };
        const plan = await api.plansCreate(spec);
        onPlanned(plan); setPlanId(plan.planId); setPlanReady(true);
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
        return artifactResultForModel(id, manifest);
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
      generation = await api.agentGenerate(crypto.randomUUID(), conversationId, modelMessagesWithoutArtifactPaths(context));
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
    const text = draft.trim() || (boundary ? "请根据附加边界规划影像任务，并补问缺少的信息。" : "");
    if (!text || sending.current || pendingId || status.state !== "connected") return;
    sending.current = true; setBusy(true); setError(""); setDraft("");
    setDisplay(current => [...current, { id: crypto.randomUUID(), role: "user", content: boundary ? `${text}\n已附加边界：${boundary.name} · ${boundary.polygonCount} 个面` : text }]);
    const modelText = boundary ? `${text}\n[本机已附加 GeoJSON 多边形。WGS84 范围：${boundary.bounds.join(", ")}；共 ${boundary.polygonCount} 个面。规划时使用此范围；几何仅由本机处理，边界外在 GeoTIFF 中透明。请先读取已授权图源，缺少缩放级别或格式时向我确认。]` : text;
    const context: AgentMessage[] = [...messages, { role: "user", content: modelText }];
    setMessages(context);
    try {
      await finishGeneration(await api.agentGenerate(crypto.randomUUID(), conversationId, modelMessagesWithoutArtifactPaths(context)), context);
      setUsage(await api.agentUsage());
    } catch (cause) { setError(errorMessage(cause)); }
    finally { sending.current = false; setBusy(false); }
  }

  return <><aside className="conversation-sidebar" aria-label="对话列表"><div className="conversation-sidebar-head"><span>工作空间</span><Button variant="secondary" size="sm" onClick={newChat} disabled={busy}><Plus size={16} />新对话</Button></div><div className="conversation-list">{chatRecords.map(chat => <button type="button" key={chat.conversationId} className={`conversation-item ${chat.conversationId === conversationId ? "active" : ""}`} aria-current={chat.conversationId === conversationId ? "page" : undefined} disabled={busy} onClick={() => selectChat(chat)}><MessageSquare size={16} /><span>{chatTitle(chat)}</span></button>)}</div><div className="conversation-sidebar-foot"><ShieldCheck size={15} />对话保存在本机</div></aside><section className="agent-panel agent-primary" aria-label="GeoD Agent 智能助手">
    <div className="agent-header"><div className="agent-icon"><Bot size={21} /></div><div><strong>GeoD Agent</strong><small>描述需求 · 核对计划 · 本机交付</small></div><Button variant="outline" size="sm" onClick={onOpenSources}><ShieldCheck size={15} />授权图源</Button></div>
    {error && <div className="agent-error"><CircleAlert size={16} />{error}</div>}
    {status.error && <div className="agent-error"><CircleAlert size={16} />{status.error}</div>}
    {(!desktopAvailable || status.state !== "connected") && <div className="agent-auth-landing"><div className="agent-auth-mark"><Bot size={26} /></div><span className="eyebrow">GEOD ACCOUNT</span><h3>登录 GeoD，开始对话</h3><p>在浏览器完成 GeoD 账号授权后，回到这里使用托管模型规划任务。地图和本机已有成果可以先查看。</p>{status.state === "unconfigured" && desktopAvailable && <div className="agent-auth-note">GeoD 桌面授权接口尚未上线，暂时无法登录。</div>}{!desktopAvailable && <div className="agent-auth-note">当前是浏览器界面预览，请在桌面应用中登录。</div>}<Button onClick={beginAuth} disabled={!desktopAvailable || status.state === "unconfigured" || status.state === "waiting" || busy}><LogIn size={16} />{status.state === "waiting" ? "等待浏览器授权…" : "登录 GeoD"}</Button></div>}
    {desktopAvailable && status.state === "connected" && <>
      <div className="agent-account"><div><ShieldCheck size={16} /><span>已登录 GeoD · {status.userId?.slice(0, 12) ?? ""}</span></div><button type="button" onClick={logout} disabled={busy} title="退出 GeoD"><LogOut size={16} /></button></div>
      <div className="agent-usage"><span>模型额度</span><strong>{usage ? `${usage.remainingTokens.toLocaleString()} / ${usage.limitTokens.toLocaleString()} token` : "查询中…"}</strong>{usage && usage.pendingReconcile > 0 && <small>{usage.pendingReconcile} 个请求待核对</small>}</div><div className="agent-messages" ref={scroll}>{display.length ? display.map(item => <div className={`agent-message ${item.role}`} key={item.id}><span>{item.role === "user" ? "你" : item.role === "tool" ? "本机工具" : "GeoD Agent"}</span><p>{item.content}</p></div>) : <div className="agent-welcome"><Bot size={28} /><h3>描述你要获取的影像</h3><p>GeoD Agent 会读取已授权图源、整理范围与格式，生成可核对的计划。下载仅在你确认计划后开始。</p></div>}{busy && <div className="agent-thinking">正在读取与整理…</div>}</div>{pendingId && <Button className="agent-plan-link" variant="outline" onClick={checkPending} disabled={busy}>核对未完成请求 · {pendingId.slice(0, 8)}</Button>}{planReady && <div className="agent-plan-ready">计划已生成，请在成果页核对并确认。</div>}{boundary && <div className="agent-attachment"><span><Paperclip size={14} />{boundary.name}<small>{boundary.polygonCount} 个面 · 边界外透明</small></span><Button type="button" variant="ghost" size="icon" aria-label="移除边界附件" disabled={busy || !!pendingId} onClick={() => setBoundary(null)}><X size={15} /></Button></div>}<form className="agent-composer" onSubmit={send}><input className="agent-boundary-input" ref={boundaryInput} type="file" accept=".geojson,.json" hidden onChange={event => void attachBoundary(event)} /><Button type="button" variant="secondary" size="icon" aria-label="附加 GeoJSON 边界" title="附加 GeoJSON 边界" disabled={busy || !!pendingId} onClick={() => boundaryInput.current?.click()}><Paperclip size={17} /></Button><textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="描述区域与影像需求，或附加 GeoJSON 边界" maxLength={3000} disabled={busy || !!pendingId} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><Button type="submit" size="icon" aria-label="发送消息" disabled={busy || !!pendingId || (!draft.trim() && !boundary)}><Send size={17} /></Button></form>
    </>}
  </section></>;
}

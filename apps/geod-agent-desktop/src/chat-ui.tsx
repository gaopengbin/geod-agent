import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { Activity, ArrowRight, Bot, Check, CheckCircle2, ChevronDown, CircleAlert, Copy } from "./icons";
import "./codex-work.css";
import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Message, MessageContent, MessageGroup, MessageHeader, MessageScroller, MessageTyping } from "@/components/agents/message";
import { MessageBubble, MessageBubbleContent } from "@/components/agents/message-bubble";
import { Button } from "@/components/motion/button/base";
import { UiTooltip } from "./ui-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api, errorMessage, type SourceRegistrationDraft } from "./api";
import type { DisplayMessage, ExtensionProposal } from "./pending-generations";
import { BackgroundJobRow } from "./background-job-row";
import {ImageAttachments} from "./image-attachments";
import {DocumentAttachments} from "./document-attachments";
import { collapsePollingHistory, type BackgroundSnapshot } from "./background-jobs";
import { groupWorkRecords, isTurnWork, uniqueDisplayMessages, type TurnWork } from "./chat-work";

function PollingHistory({ item }: { item: DisplayMessage }) {
  const [open, setOpen] = useState(false);
  return <section className="background-monitor-history">
    <Button variant="ghost" size="sm" className="background-job-trigger" aria-expanded={open} onClick={() => setOpen(!open)}><Activity size={17}/><span className="background-job-title">{localize(item.content)}</span><ChevronDown size={15} className={open ? "is-open" : ""}/></Button>
    <AnimatePresence initial={false}>{open && <motion.div className="background-job-details" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: .25 }}><div className="background-job-detail-content">{item.monitorTrace?.map(entry => <p key={entry.id}>{entry.content}</p>)}</div></motion.div>}</AnimatePresence>
  </section>;
}

function CopyMessage({ content, label = "消息" }: { content: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { /* Clipboard access may be unavailable in browser preview. */ }
  }
  return <UiTooltip content={copied ? t("已复制") : t("复制")}>
    <Button type="button" variant="ghost" size="sm" className="chat-copy" onClick={copy} aria-label={copied ? t("已复制{0}", {"0": label}) : t("复制{0}", {"0": label})}>{copied ? <Check size={16} /> : <Copy size={16} />}</Button>
  </UiTooltip>;
}

const disclosureMotion = {
  initial: { height: 0, opacity: 0 }, animate: { height: "auto", opacity: 1 }, exit: { height: 0, opacity: 0 },
  transition: { duration: .26, ease: [.22, 1, .36, 1] as [number, number, number, number] },
};

function WorkDetailSection({ label, content }: { label: string; content: string }) {
  const empty = label === "输入" && content.trim() === "{}";
  let format = "文本";
  try { JSON.parse(content); format = "JSON"; } catch { /* Preserve command and text output. */ }
  return <div className={`agent-work-code-panel${empty ? " is-empty" : ""}`}>
    <div className="agent-work-code-heading"><span>{localize(label)}</span><small>{empty ? t("无参数") : localize(format)}</small><CopyMessage content={content} label={localize(label)}/></div>
    {!empty && <ScrollArea className="agent-work-code-area" viewportProps={{"aria-label":`${label}详情`}}><pre className="agent-work-code"><code>{content}</code></pre></ScrollArea>}
  </div>;
}

function WorkDetails({ item }: { item: DisplayMessage }) {
  if (item.monitorTrace) return <div className="agent-work-reasoning agent-work-content geod-message-body">{item.monitorTrace.map(entry => <ReactMarkdown key={entry.id} remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>)}</div>;
  if (item.itemType === "reasoning") return <div className="agent-work-reasoning agent-work-content geod-message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.details}</ReactMarkdown></div>;
  const sections: { label: string; content: string }[] = [];
  if (item.itemType === "commandExecution") sections.push({ label: "命令", content: item.content });
  if (item.details) {
    let payload: Record<string, unknown> | undefined;
    try {
      const value = JSON.parse(item.details);
      if (value && typeof value === "object" && !Array.isArray(value) && ("arguments" in value || "result" in value || "error" in value)) payload = value;
    } catch { /* Command output and plain-text tool results are not JSON. */ }
    if (payload) {
      for (const [key, label] of [["arguments", "输入"], ["result", "结果"], ["error", "错误"]]) {
        if (payload[key] != null) sections.push({ label, content: typeof payload[key] === "string" ? payload[key] as string : JSON.stringify(payload[key], null, 2) });
      }
    } else sections.push({ label: item.itemType === "commandExecution" ? "输出" : "详情", content: item.details });
  }
  return <div className="agent-work-detail-sections">{sections.map(section => <WorkDetailSection key={section.label} {...section}/>)}</div>;
}

function workTitle(item: DisplayMessage) {
   if (item.itemType === "commandExecution") return t("运行命令");
  // A native MCP server may be named by its local connection ID.
  if (item.itemType === "mcpToolCall" && /^[a-f0-9-]{36} · /i.test(item.content)) return item.content.replace(/^[a-f0-9-]{36} · /i, "MCP 工具 · ");
  return localize(item.content);
}

function WorkRecord({ item, active }: { item: DisplayMessage; active: boolean }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const running = active && (item.toolStatus === "running" || item.streaming);
  const attention = item.toolStatus === "attention" || (!active && item.toolStatus === "running");
  const reasoning = item.itemType === "reasoning";
  const hasDetails = !!item.details || item.itemType === "commandExecution" || !!item.monitorTrace?.length;
  const icon = running ? <MessageTyping label={t("正在执行")} /> : attention ? <CircleAlert size={16}/> : reasoning ? <Activity size={16}/> : <CheckCircle2 size={16}/>;
  if (item.role === "assistant") return <motion.div className={`agent-work-record agent-work-note ${item.streaming ? "is-streaming" : ""}`} initial={active ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: .24 }}>
    <span className="agent-work-record-icon"><Activity size={15}/></span><div className="agent-work-content geod-message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown></div>
  </motion.div>;
  const row = <><span className={`agent-work-record-icon ${running ? "is-running" : ""}`}>{icon}</span><span className="agent-work-record-title">{workTitle(item)}</span>{hasDetails && <ChevronDown size={14} className={open ? "is-open" : ""}/>}</>;
  return <motion.div className={`agent-work-record ${attention ? "attention" : ""}`} initial={active ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: .24 }}>
    {hasDetails ? <Button variant="ghost" size="sm" whileHover={undefined} whileTap={undefined} className="agent-work-record-trigger" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>{row}</Button> : <div className="agent-work-record-heading">{row}</div>}
    <AnimatePresence initial={false}>{open && <motion.div id={detailId} className="agent-work-record-details" {...disclosureMotion}><WorkDetails item={item}/></motion.div>}</AnimatePresence>
  </motion.div>;
}

function WorkRecords({ group, active, activity }: { group: TurnWork; active: boolean; activity: string }) {
  const [open, setOpen] = useState(active);
  const bodyId = useId();
  const { items } = group;
  const operations = items.filter(item => item.role === "tool" && item.itemType !== "reasoning").length;
  const failed = items.some(item => item.toolStatus === "attention" || (!active && item.toolStatus === "running"));
  // Completion closes the whole turn once; a finished turn can still be reopened.
  useEffect(() => { setOpen(active); }, [active]);
  return <section className={`agent-work-records ${active ? "is-active" : ""}`} data-work-turn={group.id} aria-label={t("本轮思考与执行")}>
    <Button variant="ghost" size="sm" whileHover={undefined} whileTap={undefined} className="agent-work-records-trigger" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
      <span className="agent-work-records-icon">{active ? <MessageTyping label={t("正在处理")} /> : <Activity size={16}/>}</span>
       <span className="agent-work-records-label">{active ? localize(activity) || t("正在处理") : t("思考与执行")}</span>
      {operations > 0 && <span className="agent-work-count">{operations} {t(" 项操作")}</span>}
      {!active && failed && <span className="agent-work-warning"><CircleAlert size={14}/>{t("有异常记录")}</span>}
      <ChevronDown size={14} className={open ? "is-open" : ""}/>
    </Button>
    <AnimatePresence initial={false}>{open && <motion.div id={bodyId} className="agent-work-records-body" {...disclosureMotion}>
      <div className="agent-work-timeline">{items.map(item => <WorkRecord key={item.id} item={item} active={active}/>)}</div>
    </motion.div>}</AnimatePresence>
  </section>;
}

function activeWorkId(entries: ReturnType<typeof groupWorkRecords>, busy: boolean, activeTurnId?: string | null) {
  if (!busy) return undefined;
  if (activeTurnId) return activeTurnId;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (isTurnWork(entry)) return entry.id;
    if (entry.role === "user" || (entry.role === "assistant" && !entry.streaming)) return undefined;
  }
  return undefined;
}

function ExtensionReview({ proposal, busy, onApprove }: { proposal: ExtensionProposal; busy: boolean; onApprove: (proposal: ExtensionProposal) => void }) {
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [loading, setLoading] = useState(false);
  async function showPreview() {
    setLoading(true);
    setPreviewError("");
    try { setPreview(await api.skillPreview(proposal.id)); }
    catch (cause) { setPreviewError(errorMessage(cause)); }
    finally { setLoading(false); }
  }
  return <div className="agent-source-review">
    <strong>{proposal.kind === "mcp" ? t("MCP 连接器") : "Skill"} · {proposal.name}</strong>
    <span>{proposal.detail}</span>
    {proposal.description && <small>{proposal.description}</small>}
    {proposal.toolNames?.length ? <small>{t("提供工具：")}{proposal.toolNames.join("、")}</small> : null}
    {proposal.sha256 && <small>{t("内容 SHA-256：")}{proposal.sha256.slice(0, 16)}…</small>}
    <small>{proposal.kind === "mcp" ? t("启用后，Agent 可以调用此连接器提供的工具。请确认你信任这个服务。") : t("启用后，Agent 可以读取这份 Skill 的工作说明。请先核对来源和内容。")}</small>
    {proposal.kind === "skill" && <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => void showPreview()}>{loading ? t("正在读取…") : t("查看完整 SKILL.md")}</Button>}
    {previewError && <small role="alert">{previewError}</small>}
    {preview && <pre className="agent-skill-preview">{preview}</pre>}
    <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onApprove(proposal)}>{t("确认启用")}<ArrowRight size={16} /></Button>
  </div>;
}

export function ChatTranscript({ conversationId, messages, busy, activity, activeTurnId, onReviewSource, onApproveExtension, backgroundJobs = {}, onOpenJob, afterEntry, planTitles = {}, children }: { conversationId: string; messages: DisplayMessage[]; busy: boolean; activity: string; activeTurnId?: string | null; onReviewSource: (draft: SourceRegistrationDraft) => void; onApproveExtension: (proposal: ExtensionProposal) => void; backgroundJobs?: Record<string, BackgroundSnapshot>; onOpenJob?: (jobId: string) => void; afterEntry?: (id: string) => ReactNode; planTitles?: Record<string, string>; children?: ReactNode }) {
  const entries = groupWorkRecords(collapsePollingHistory(uniqueDisplayMessages(messages)));
  const liveWorkId = activeWorkId(entries, busy, activeTurnId);
  const hasLiveWork = entries.some(entry => isTurnWork(entry) && entry.id === liveWorkId);
  return <MessageScroller key={conversationId} className="agent-messages" viewportClassName="agent-messages-viewport" contentClassName="agent-messages-content" label={t("GeoD Agent 工作记录")} busy={busy}>
    <motion.div className="agent-transcript-stage" initial={{ opacity: 0, x: 24, scale: 0.985 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}>
    {messages.length ? <MessageGroup spacing="default" className="geod-message-group">
      {entries.map(item => <Fragment key={item.id}>{isTurnWork(item)
        ? <WorkRecords key={`work-${conversationId}-${item.id}`} group={item} active={item.id === liveWorkId} activity={activity}/>
        : item.monitorTrace
        ? <PollingHistory key={item.id} item={item}/>
        : item.backgroundJob
        ? <BackgroundJobRow key={item.id} task={item.backgroundJob} title={planTitles[item.backgroundJob.planId]} snapshot={backgroundJobs[item.backgroundJob.jobId]} onOpen={onOpenJob} />
        : item.role === "user"
        ? <Message key={item.id} from="user" className="geod-message geod-message-user" initial={busy ? { opacity: 0, x: 30, y: 16, scale: 0.9 } : false} animate={{ opacity: 1, x: 0, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 390, damping: 24, mass: 0.72 }}>
            <MessageContent><MessageHeader>{t("你")}</MessageHeader>{item.images?.length?<ImageAttachments images={item.images}/>:null}{item.documents?.length?<DocumentAttachments documents={item.documents}/>:null}<MessageBubble variant="soft" animateIn={false} className="geod-message-bubble"><MessageBubbleContent className="geod-message-body">{item.content}</MessageBubbleContent></MessageBubble></MessageContent>
          </Message>
        : item.role === "tool"
          ? <motion.div className={`agent-step ${item.toolStatus === "attention" ? "attention" : ""} ${item.toolStatus === "running" ? "agent-step-running" : ""}`} key={item.id} role="status" initial={busy ? { opacity: 0, x: -22, y: 8, scale: 0.96 } : false} animate={{ opacity: 1, x: 0, y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 370, damping: 27, mass: 0.7 }}>
              <span className="agent-step-icon">{item.toolStatus === "running" ? <MessageTyping label={t("正在调用工具")} /> : item.toolStatus === "attention" ? <CircleAlert size={17} /> : <CheckCircle2 size={17} />}</span>
              <div className="agent-step-content"><span>{item.content}</span>{item.sourceDraft && <div className="agent-source-review"><strong>{item.sourceDraft.source.name}</strong><span>{item.sourceDraft.source.urlTemplate}</span><small>{t("已整理图源配置。请核对服务地址和参数。")}</small><Button type="button" size="sm" variant="outline" onClick={() => onReviewSource(item.sourceDraft!)}>{t("查看配置")}<ArrowRight size={16} /></Button></div>}{item.extensionProposal && <ExtensionReview proposal={item.extensionProposal} busy={busy} onApprove={onApproveExtension} />}</div>
            </motion.div>
          : <motion.article className={`agent-work-entry ${item.phase === "progress" ? "progress" : "final"} ${busy && messages.at(-1)?.id === item.id ? "is-live" : ""} ${item.streaming ? "is-streaming" : ""}`} key={item.id} initial={busy ? { opacity: 0, y: 24, scale: 0.975, filter: "blur(5px)" } : false} animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }} transition={{ type: "spring", stiffness: 310, damping: 28, mass: 0.85 }}>
              {item.phase !== "progress" && <div className="agent-work-label"><Bot size={17} /><span>GeoD Agent</span></div>}
              <div className="agent-work-content geod-message-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown></div>
              {item.phase !== "progress" && !item.streaming && <CopyMessage content={item.content} />}
            </motion.article>}{afterEntry?.(item.id)}</Fragment>)}
    </MessageGroup> : <div className="agent-welcome"><Bot size={28} /><h3>{t("描述你要获取的影像")}</h3><p>{t("也可以直接说需要什么 Skill 或 MCP 能力，Agent 会查找并准备接入。")}</p></div>}
    {children}
    <AnimatePresence mode="popLayout">
      {busy && !hasLiveWork && !messages.at(-1)?.streaming && messages.at(-1)?.toolStatus !== "running" && <motion.div key="agent-running" layout="position" className="agent-step agent-step-running" role="status" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}><span className="agent-step-icon"><MessageTyping label={t("正在处理")} /></span><span>{localize(activity)}</span></motion.div>}
    </AnimatePresence>
    </motion.div>
  </MessageScroller>;
}

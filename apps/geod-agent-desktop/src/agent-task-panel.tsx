import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/motion/button/base";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, CheckCircle2, CircleAlert, Loader2, RefreshCw, Square } from "./icons";
import { errorMessage } from "./api";
import { agentTasks, AGENT_TASK_FOCUS, pendingAgentFocus, type AgentTask, type AgentTaskDetails } from "./agent-task-tools";

const labels: Record<string, string> = { queued: "启动中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
const live = (task: AgentTask) => ["queued", "running"].includes(task.status);
const label = (task: AgentTask) => live(task) && task.cancelRequested ? "停止中" : labels[task.status] ?? task.status;
const toolLabels: Record<string, string> = { worker_files_list: "查看文件", worker_file_read: "读取文件", worker_file_write: "保存结果" };

export function AgentTaskPanel({ conversationId }: { conversationId: string }) {
  const [tasks, setTasks] = useState<AgentTask[]>([]), [detail, setDetail] = useState<AgentTaskDetails | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const selectedId = useRef(pendingAgentFocus(conversationId)), loading = useRef(false), scope = useRef(conversationId), mounted = useRef(true);
  scope.current = conversationId;
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const result = await agentTasks.list(conversationId), id = selectedId.current ?? result.tasks[0]?.id;
      const next = id ? await agentTasks.get(conversationId, id) : null;
      if (mounted.current && scope.current === conversationId) {
        setTasks(result.tasks); setError("");
        if (!selectedId.current || selectedId.current === id) { selectedId.current = id; setDetail(next); }
      }
    } catch (cause) { if (mounted.current && scope.current === conversationId) setError(errorMessage(cause)); }
    finally { loading.current = false; }
  }, [conversationId]);
  useEffect(() => {
    mounted.current = true; selectedId.current = pendingAgentFocus(conversationId);
    setTasks([]); setDetail(null); setFile(null); setError(""); setBusy(false);
    const focus = (event: Event) => {
      const next = (event as CustomEvent).detail;
      if (next?.conversationId === conversationId) { selectedId.current = next.taskId; setFile(null); void refresh(); }
    };
    window.addEventListener(AGENT_TASK_FOCUS, focus);
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener(AGENT_TASK_FOCUS, focus); };
  }, [conversationId, refresh]);
  const action = async (run: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await run(); if (mounted.current && scope.current === conversationId) await refresh(); }
    catch (cause) { if (mounted.current && scope.current === conversationId) setError(errorMessage(cause)); }
    finally { if (mounted.current && scope.current === conversationId) setBusy(false); }
  };
  const openFile = async (path: string) => {
    const id = selectedId.current;
    if (!id) return;
    await action(async () => {
      const result = await agentTasks.readFile(conversationId, id, path);
      if (mounted.current && scope.current === conversationId && selectedId.current === id) setFile(result);
    });
  };
  const task = detail?.task, operations = detail?.events.filter(event => event.type === "tool") ?? [];
  return <section className="agent-task-panel">
    <div className="command-section-heading"><h3>{t("独立子任务")}{tasks.length > 0 && <span>{tasks.length}</span>}</h3><Button variant="ghost" size="icon" aria-label={t("刷新子任务")} whileHover={undefined} whileTap={undefined} onClick={() => void refresh()}><RefreshCw size={15}/></Button></div>
    <p className="field-hint">{t("各自分析选中的文件，互不混用上下文。关闭窗口后继续执行。")}</p>
    {error && <p className="warning-text" role="alert">{localize(error)}</p>}
    <ScrollArea className="agent-task-list-area" viewportClassName="agent-task-list-scroll"><div className="command-list">{tasks.map(item => <Button key={item.id} variant="ghost" size="sm" className="command-list-row" aria-pressed={item.id === task?.id} whileHover={undefined} whileTap={undefined} onClick={() => { selectedId.current = item.id; setFile(null); void refresh(); }}>
      {live(item) ? <Loader2 size={15} className="animate-spin"/> : item.status === "completed" ? <CheckCircle2 size={15}/> : ["failed", "interrupted"].includes(item.status) ? <CircleAlert size={15}/> : <Bot size={15}/>}
      <span>{item.name}</span><small>{label(item)}</small>
    </Button>)}</div></ScrollArea>
    {!tasks.length && <p className="task-empty">{t("可以让 Agent 分别分析多份文件，结果会保存在这里。")}</p>}
    {task && <section className="command-detail">
      <div className="command-section-heading"><h4>{task.name}</h4><span>{label(task)}</span></div>
      <p className="field-hint">{task.readOnly ? t("只读输入文件") : t("可在独立目录保存结果")}</p>
      {live(task) && <div className="command-actions"><Button size="sm" variant="outline" disabled={busy || task.cancelRequested} onClick={() => void action(() => agentTasks.cancel(conversationId, task.id))}><Square size={13}/>{task.cancelRequested ? t("停止中…") : t("取消此任务")}</Button></div>}
      {task.error && <p className="warning-text" role="alert">{task.error}</p>}
      {task.result ? <div className="geod-message-body agent-task-result"><ReactMarkdown remarkPlugins={[remarkGfm]}>{task.result}</ReactMarkdown></div> : <p className="field-hint">{live(task) ? t("正在处理，结果会自动更新。") : t("暂无文字结果")}</p>}
      {!!detail?.files.length && <details className="command-properties agent-task-files"><summary>{t("文件 · ")}{detail.files.length}</summary>{detail.files.map(item => <Button key={item.path} variant="ghost" size="sm" className="agent-task-file" disabled={busy} whileHover={undefined} whileTap={undefined} onClick={() => void openFile(item.path)}><span>{item.path}</span><small>{(item.bytes / 1024).toFixed(1)} KB</small></Button>)}</details>}
      {file && <section className="agent-task-file-preview"><div className="command-section-heading"><h4>{file.path}</h4><Button size="sm" variant="ghost" onClick={() => setFile(null)}>{t("收起")}</Button></div><ScrollArea className="command-output-area" viewportClassName="command-output-scroll"><pre>{file.text}</pre></ScrollArea></section>}
      {!!operations.length && <details className="command-properties"><summary>{t("操作记录 · ")}{operations.length}</summary><ol className="agent-task-operations">{operations.map((event, index) => <li key={index}>{toolLabels[String(event.tool)] ?? t("执行文件操作")}</li>)}</ol></details>}
    </section>}
  </section>;
}

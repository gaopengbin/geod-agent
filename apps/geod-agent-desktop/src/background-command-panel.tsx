import { t, localize, getLocale } from "./i18n";
// i18n: presentation strings migrated
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/motion/button/base";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CircleAlert, CheckCircle2, Loader2, RefreshCw, Square, Terminal } from "./icons";
import { errorMessage } from "./api";
import { backgroundCommands, BACKGROUND_COMMAND_CHANGED, BACKGROUND_COMMAND_FOCUS, pendingCommandFocus, type BackgroundCommand } from "./background-commands";
const labels = { planned: "待确认", queued: "启动中", running: "运行中", stopping: "停止中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
const live = (record: BackgroundCommand) => ["queued", "running", "stopping"].includes(record.status);
export function BackgroundCommandPanel({ conversationId, permission }: { conversationId: string; permission?: string | null }) {
  const [records, setRecords] = useState<BackgroundCommand[]>([]), [selected, setSelected] = useState<BackgroundCommand | null>(null);
  const [total, setTotal] = useState(0), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [input, setInput] = useState("");
  const scope = useRef(conversationId); scope.current = conversationId;
  const mounted = useRef(true), selectedId = useRef<string | undefined>(pendingCommandFocus(conversationId)), loadedPages = useRef(1), loading = useRef(false);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      let next: number | null = 0, count = 0, rows: BackgroundCommand[] = [];
      for (let page = 0; page < loadedPages.current && next !== null; page++) {
        const result = await backgroundCommands.list(conversationId, next); rows.push(...result.commands); count = result.total; next = result.nextOffset;
      }
      const id = selectedId.current ?? rows[0]?.id;
      const detail = id ? await backgroundCommands.get(conversationId, id) : null;
      if (mounted.current && scope.current === conversationId) {
        setRecords(rows); setTotal(count); setNextOffset(next);
        // A selection made while reading output must win over the old read.
        if (!selectedId.current || selectedId.current === id) { selectedId.current = id; setSelected(detail); }
      }
    } catch (cause) { if (mounted.current && scope.current === conversationId) setError(errorMessage(cause)); }
    finally { loading.current = false; }
  }, [conversationId]);
  useEffect(() => {
    mounted.current = true; selectedId.current = pendingCommandFocus(conversationId); loadedPages.current = 1;
    setRecords([]); setSelected(null); setError(""); setInput(""); setBusy(false);
    const changed = (event: Event) => { if ((event as CustomEvent).detail?.conversationId === conversationId) void refresh(); };
    const focus = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail?.conversationId === conversationId) { selectedId.current = detail.commandId; setInput(""); void refresh(); } };
    window.addEventListener(BACKGROUND_COMMAND_CHANGED, changed); window.addEventListener(BACKGROUND_COMMAND_FOCUS, focus);
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { mounted.current = false; clearInterval(timer); window.removeEventListener(BACKGROUND_COMMAND_CHANGED, changed); window.removeEventListener(BACKGROUND_COMMAND_FOCUS, focus); };
  }, [conversationId, refresh]);
  const action = async (run: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await run(); if (scope.current === conversationId && mounted.current) await refresh(); }
    catch (cause) { if (scope.current === conversationId && mounted.current) setError(errorMessage(cause)); }
    finally { if (scope.current === conversationId && mounted.current) setBusy(false); }
  };
  return <section className="background-command-panel">
    <div className="command-section-heading"><h3>{t("后台命令")}{total > 0 && <span>{total}</span>}</h3><Button variant="ghost" size="icon" aria-label={t("刷新后台命令")} whileHover={undefined} whileTap={undefined} onClick={() => void refresh()}><RefreshCw size={15}/></Button></div>
    <p className="field-hint">{t("关闭窗口后继续运行。输出保存在这里，可随时停止。")}</p>
    {error && <p className="warning-text" role="alert">{localize(error)}</p>}
    <div className="command-list">{records.map(record => <Button key={record.id} variant="ghost" size="sm" whileHover={undefined} whileTap={undefined} className="command-list-row" aria-pressed={record.id === selected?.id} onClick={() => { selectedId.current = record.id; setInput(""); void refresh(); }}>
      {live(record) ? <Loader2 size={15} className="animate-spin"/> : record.status === "completed" ? <CheckCircle2 size={15}/> : ["failed", "interrupted"].includes(record.status) ? <CircleAlert size={15}/> : <Terminal size={15}/>}<span>{record.title}</span><small>{record.status === "planned" && permission === "fullAccess" ? t("待运行") : labels[record.status]}</small>
    </Button>)}</div>
    {nextOffset !== null && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { loadedPages.current++; void refresh(); }}>{t("更多命令")}</Button>}
    {!records.length && <p className="task-empty">{t("长时间运行的本机命令会显示在这里。")}</p>}
    {selected && <section className="command-detail"><div className="command-section-heading"><h4>{selected.title}</h4><span>{localize(labels[selected.status])}</span></div>
      <p className="field-hint">{t("命令按当前 Windows 用户权限执行，工作目录为所选工作区。")}</p>
      <details className="command-properties" open={selected.status === "planned"}><summary>{t("运行参数")}</summary><ScrollArea className="command-code-area" viewportClassName="command-code-scroll"><pre>{selected.command.map(arg => JSON.stringify(arg)).join(" ")}</pre></ScrollArea><dl><dt>{t("工作目录")}</dt><dd>{selected.cwd}</dd><dt>{t("超时")}</dt><dd>{selected.timeoutMs ? t("{0} 秒", {"0": selected.timeoutMs / 1000}) : t("不设超时")}</dd>{selected.startedAt && <><dt>{t("开始时间")}</dt><dd>{new Date(selected.startedAt).toLocaleString(getLocale(), { hour12: false })}</dd></>}{selected.exitCode != null && <><dt>{t("退出码")}</dt><dd>{selected.exitCode}</dd></>}</dl></details>
      <div className="command-actions">{selected.status === "planned" && <Button size="sm" disabled={busy} onClick={() => void action(() => backgroundCommands.start(conversationId, selected.id, selected.planHash, true))}>{permission === "fullAccess" ? t("运行") : t("确认并运行")}</Button>}{(selected.status === "planned" || live(selected)) && <Button size="sm" variant="outline" disabled={busy || selected.status === "stopping"} onClick={() => void action(() => backgroundCommands.stop(conversationId, selected.id))}>{selected.status !== "planned" && <Square size={13}/ >}{selected.status === "planned" ? t("丢弃") : selected.status === "stopping" ? t("停止中…") : t("停止")}</Button>}</div>
      {selected.error && <p className="warning-text" role="alert">{selected.error.message}</p>}
      <div className="command-section-heading command-output-heading"><h4>{t("输出")}</h4>{selected.exitCode != null && <span>{t("退出码 ")}{selected.exitCode}</span>}</div>
      {selected.stdout || selected.stderr ? <ScrollArea className="command-output-area" viewportClassName="command-output-scroll"><pre>{selected.stdout}{selected.stderr && <span className="command-stderr">{selected.stdout ? "\n" : ""}{selected.stderr}</span>}</pre></ScrollArea> : <p className="field-hint">{live(selected) ? t("等待程序输出…") : t("暂无输出")}</p>}
      {selected.outputTruncated && <p className="field-hint">{t("已保存每个输出流的前 256 KiB；超出部分未保留。")}</p>}
      {selected.status === "running" && <form className="command-input" onSubmit={event => { event.preventDefault(); const value = input; void action(async () => { await backgroundCommands.write(conversationId, selected.id, `${value}\n`); if (scope.current === conversationId && mounted.current) setInput(""); }); }}><input aria-label={t("命令输入")} placeholder={t("输入一行内容")} maxLength={16000} value={input} onChange={event => setInput(event.target.value)} disabled={busy}/><Button variant="outline" size="sm" type="submit" disabled={busy}>{t("发送")}</Button><Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => void action(() => backgroundCommands.write(conversationId, selected.id, undefined, true))}>{t("结束输入")}</Button></form>}
    </section>}
  </section>;
}

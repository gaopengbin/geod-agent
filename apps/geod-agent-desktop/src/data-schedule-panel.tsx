import { getLocale, t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useId, useState } from "react";
import * as Select from "@radix-ui/react-select";
import { Button } from "./components/motion/button/base";
import { ChevronDown } from "./icons";
import { errorMessage } from "./api";
import { dataDownloadChanged, focusDataTask, type DataDownloadTask } from "./data-downloads";
import { dataSchedules, type DataSchedule, type DataScheduleRun } from "./data-schedules";

const labels: Record<string, string> = { queued: "排队中", waiting_confirmation: "待确认", running: "执行中", cancelling: "正在取消", succeeded: "已完成", partial: "部分完成", failed: "失败", cancelled: "已取消" };
const date = (value: string) => new Date(value).toLocaleString(getLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const future = () => { const value = new Date(Date.now() + 5 * 60_000); value.setSeconds(0, 0); return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const options = [{ value: "once", label: "仅一次" }, { value: "3600", label: "每小时" }, { value: "86400", label: "每天" }, { value: "604800", label: "每周" }];

/** Uses the same typography, inputs and compact rows as imagery schedules. */
export function DataSchedulePanel({ conversationId, task, onChanged }: { conversationId: string; task: DataDownloadTask | null; onChanged?: () => void }) {
  const frequencyId = useId();
  const [schedules, setSchedules] = useState<DataSchedule[]>([]), [runs, setRuns] = useState<DataScheduleRun[]>([]);
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [name, setName] = useState(""), [time, setTime] = useState(future), [repeat, setRepeat] = useState("once");
  async function refresh() { const [next, records] = await Promise.all([dataSchedules.list(conversationId), dataSchedules.runs(conversationId)]); setSchedules(next); setRuns(records); }
  useEffect(() => {
    let disposed = false, loading = false;
    setSchedules([]); setRuns([]); setError(""); setEditing(false);
    const load = async () => { if (loading) return; loading = true; try { const [next, records] = await Promise.all([dataSchedules.list(conversationId), dataSchedules.runs(conversationId)]); if (!disposed) { setSchedules(next); setRuns(records); } } catch (e) { if (!disposed) setError(errorMessage(e)); } finally { loading = false; } };
    void load(); const timer = setInterval(() => void load(), 3000);
    return () => { disposed = true; clearInterval(timer); };
  }, [conversationId]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await work(); await refresh(); dataDownloadChanged(conversationId); onChanged?.(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const open = (run: DataScheduleRun) => { if (run.taskId) focusDataTask(conversationId, run.taskId); };
  if (!task && !schedules.length && !error) return null;
  return <section className="schedule-section">
    <div className="schedule-heading"><h4>{t("矢量与三维定时任务")}{schedules.length > 0 && <span>{schedules.length}</span>}</h4>
      <Button variant="ghost" size="sm" disabled={!task || busy} onClick={() => { setName(task!.title); setTime(future()); setEditing(value => !value); }}>{editing ? t("收起") : t("新建")}</Button>
    </div>
    {editing && task && <form className="schedule-form" onSubmit={event => { event.preventDefault(); void action(async () => { await dataSchedules.create(conversationId, task.id, name, new Date(time).toISOString(), repeat === "once" ? null : Number(repeat)); setEditing(false); }); }}>
      <label>{t("任务名称")}<input value={name} maxLength={120} required onChange={event => setName(event.target.value)} /></label>
      <label>{t("开始时间")}<input type="datetime-local" value={time} required onChange={event => setTime(event.target.value)} /></label>
      <div className="field"><span className="field-label" id={frequencyId}>{t("重复频率")}</span>
        <Select.Root value={repeat} onValueChange={setRepeat}><Select.Trigger className="select-trigger" aria-labelledby={frequencyId}><Select.Value /><Select.Icon><ChevronDown size={15} /></Select.Icon></Select.Trigger>
          <Select.Portal><Select.Content className="select-content" position="popper" sideOffset={6}><Select.Viewport>{options.map(option => <Select.Item className="select-item" key={option.value} value={option.value}><Select.ItemText>{localize(option.label)}</Select.ItemText></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal>
        </Select.Root>
      </div>
      <p>{t("每次沿用此任务的数据地址、范围与格式，保存到独立目录。关闭窗口后由本机后台继续执行；退出后台或关机后暂停。错过的周期合并执行一次，已有任务未结束时不重复创建。")}</p>
      <Button type="submit" size="sm" disabled={busy}>{busy ? t("保存中…") : t("保存定时任务")}</Button>
    </form>}
    {schedules.length > 0 ? <><p className="schedule-hint">{t("完全访问模式自动执行；逐次确认模式先生成待确认任务。暂停只停止后续触发。")}</p>
      <div className="schedule-list">{schedules.map(schedule => {
        const history = runs.filter(run => run.scheduleId === schedule.id), latest = history[0];
        return <div className="schedule-item" key={schedule.id}>
          <div className="schedule-item-caption"><strong title={schedule.name}>{schedule.name}</strong><Button variant="ghost" size="sm" disabled={busy} onClick={() => void action(() => dataSchedules.setEnabled(schedule.id, !schedule.enabled, !schedule.enabled && !schedule.repeatSeconds ? new Date(Date.now() + 300_000).toISOString() : undefined))}>{schedule.enabled ? t("暂停") : t("启用")}</Button></div>
          <p>{schedule.enabled ? `${date(schedule.nextRunAt)} · ${options.find(option => option.value === String(schedule.repeatSeconds))?.label ?? (schedule.repeatSeconds ? `每 ${schedule.repeatSeconds} 秒` : "一次")}` : t("已停止后续触发")}</p>
          {latest && <><Button variant="ghost" size="sm" className="schedule-run-row" disabled={!latest.taskId} onClick={() => open(latest)}><span>{date(latest.scheduledAt)} · {labels[latest.state] ?? latest.state}</span><span>{t("查看任务")}</span></Button>{latest.error && <p className="warning-text">{latest.error}</p>}
            {["queued", "waiting_confirmation", "running"].includes(latest.state) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void action(() => dataSchedules.cancelRun(latest.id))}>{t("取消本次执行")}</Button>}</>}
          {history.length > 1 && <details className="schedule-history"><summary>{t("运行记录")}</summary>{history.slice(1, 10).map(run => <Button key={run.id} variant="ghost" size="sm" className="schedule-run-row" disabled={!run.taskId} onClick={() => open(run)}><span>{date(run.scheduledAt)} · {labels[run.state] ?? run.state}</span><span>{t("查看")}</span></Button>)}</details>}
        </div>;
      })}</div></> : !editing && <p className="schedule-hint">{t("选择一个矢量或三维任务，即可按相同范围和格式定时获取数据。")}</p>}
    {error && <p className="warning-text" role="alert">{localize(error)}</p>}
  </section>;
}

import { getLocale, t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useId, useState } from "react";
import {
  api,
  errorMessage,
  type ImagerySchedule,
  type ScheduleRun,
  type StoredPlan,
} from "./api";
import { Button } from "./components/motion/button/base";
import * as Select from "@radix-ui/react-select";
import { ChevronDown } from "./icons";

const date = (value: string) =>
  new Date(value).toLocaleString(getLocale(), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const localFuture = () => {
  const value = new Date(Date.now() + 5 * 60_000);
  value.setSeconds(0, 0);
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};
const labels: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_confirmation: "待确认",
  paused: "已暂停",
  retrying: "等待重试",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
export function SchedulePanel({
  conversationId,
  plan,
  title,
  onOpenRun,
  onChanged,
}: {
  conversationId: string;
  plan: StoredPlan | null;
  title?: string;
  onOpenRun?: (run: ScheduleRun) => void;
  onChanged?: () => void;
}) {
  const repeatLabelId = useId();
  const [schedules, setSchedules] = useState<ImagerySchedule[]>([]),
    [runs, setRuns] = useState<ScheduleRun[]>([]),
    [editing, setEditing] = useState(false),
    [name, setName] = useState(""),
    [time, setTime] = useState(localFuture),
    [repeat, setRepeat] = useState("once"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    const [next, records] = await Promise.all([
      api.schedulesList(conversationId),
      api.schedulesRuns(conversationId),
    ]);
    setSchedules(next);
    setRuns(records);
  }
  useEffect(() => {
    let disposed = false,
      loading = false;
    setSchedules([]);
    setRuns([]);
    setEditing(false);
    setError("");
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const [next, records] = await Promise.all([
          api.schedulesList(conversationId),
          api.schedulesRuns(conversationId),
        ]);
        if (!disposed) {
          setSchedules(next);
          setRuns(records);
        }
      } catch (error) {
        if (!disposed) setError(errorMessage(error));
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [conversationId]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      onChanged?.();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  if (!plan && !schedules.length && !error) return null;
  return (
    <section className="schedule-section">
      <div className="schedule-heading">
        <h4>
          {t("影像定时下载")}{schedules.length > 0 && <span>{schedules.length}</span>}
        </h4>
        <Button
          variant="ghost"
          size="sm"
          disabled={!plan || busy}
          onClick={() => {
            setName(title ?? plan!.plan.sourceName);
            setTime(localFuture());
            setEditing((value) => !value);
          }}
        >
          {editing ? t("收起") : t("新建")}
        </Button>
      </div>
      {editing && plan && (
        <form
          className="schedule-form"
          onSubmit={(event) => {
            event.preventDefault();
            void action(async () => {
              await api.schedulesCreate(
                conversationId,
                plan.planId,
                name,
                new Date(time).toISOString(),
                repeat === "once" ? null : Number(repeat),
              );
              setEditing(false);
            });
          }}
        >
          <label>
            {t("任务名称 ")}<input
              value={name}
              maxLength={120}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            {t("开始时间 ")}<input
              type="datetime-local"
              value={time}
              required
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
          <div className="field">
            <span className="field-label" id={repeatLabelId}>
              {t("重复频率 ")}</span>
            <Select.Root value={repeat} onValueChange={setRepeat}>
              <Select.Trigger
                className="select-trigger"
                aria-labelledby={repeatLabelId}
              >
                <Select.Value />
                <Select.Icon>
                  <ChevronDown size={15} />
                </Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Content
                  className="select-content"
                  position="popper"
                  sideOffset={6}
                >
                  <Select.Viewport>
                    {[
                      { value: "once", label: "仅一次" },
                      { value: "3600", label: "每小时" },
                      { value: "86400", label: "每天" },
                      { value: "604800", label: "每周" },
                    ].map((option) => (
                      <Select.Item
                        className="select-item"
                        value={option.value}
                        key={option.value}
                      >
                        <Select.ItemText>{localize(option.label)}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Viewport>
                </Select.Content>
              </Select.Portal>
            </Select.Root>
          </div>
          <p>
            {t("每次按当前图源重新规划，保存到新的成果目录。应用关闭期间的重复任务合并补执行一次。 ")}</p>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? t("保存中…") : t("保存定时任务")}
          </Button>
        </form>
      )}
      {schedules.length > 0 && (
        <>
          <p className="schedule-hint">
            {t("关闭窗口后由本机后台继续执行；退出后台或关机后暂停。临时网络错误按设定次数重试，逐次确认模式先生成待确认计划。 ")}</p>
          <div className="schedule-list">
            {schedules.map((schedule) => {
              const latest = runs.find(
                (run) => run.scheduleId === schedule.scheduleId,
              );
              return (
                <div className="schedule-item" key={schedule.scheduleId}>
                  <div className="schedule-item-caption">
                    <strong title={schedule.name}>{schedule.name}</strong>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void action(() =>
                          api.schedulesSetEnabled(
                            schedule.scheduleId,
                            !schedule.enabled,
                            !schedule.enabled && !schedule.repeatSeconds
                              ? new Date(Date.now() + 5 * 60_000).toISOString()
                              : undefined,
                          ),
                        )
                      }
                    >
                      {schedule.enabled ? t("暂停") : t("启用")}
                    </Button>
                  </div>
                  <p>
                    {schedule.enabled
                      ? `${date(schedule.nextRunAt)} · ${schedule.repeatSeconds === 86400 ? "每天" : schedule.repeatSeconds === 604800 ? "每周" : schedule.repeatSeconds === 3600 ? "每小时" : schedule.repeatSeconds ? `每 ${schedule.repeatSeconds} 秒` : "一次"}`
                      : t("已停止后续触发")}
                  </p>
                  {latest && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="schedule-run-row"
                      disabled={!latest.planId}
                      onClick={() => onOpenRun?.(latest)}
                    >
                      <span>
                        {date(latest.scheduledAt)} ·{" "}
                        {labels[latest.state] ?? latest.state}
                        {latest.attempt > 1
                          ? t(" · 第 {0} 次尝试", {"0": latest.attempt})
                          : ""}
                      </span>
                      <span>{latest.errorCode ?? t("查看任务")}</span>
                    </Button>
                  )}
                  {latest &&
                    !["succeeded", "failed", "cancelled"].includes(
                      latest.state,
                    ) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            api.schedulesCancelRun(latest.runId),
                          )
                        }
                      >
                        {t("取消本次执行 ")}</Button>
                    )}
                  {runs.filter((run) => run.scheduleId === schedule.scheduleId)
                    .length > 1 && (
                    <details className="schedule-history">
                      <summary>{t("运行记录")}</summary>
                      {runs
                        .filter((run) => run.scheduleId === schedule.scheduleId)
                        .slice(0, 10)
                        .map((run) => (
                          <Button
                            key={run.runId}
                            variant="ghost"
                            size="sm"
                            className="schedule-run-row"
                            disabled={!run.planId}
                            onClick={() => onOpenRun?.(run)}
                          >
                            <span>
                              {date(run.scheduledAt)} ·{" "}
                              {labels[run.state] ?? run.state}
                            </span>
                            <span>{run.errorCode ?? t("查看")}</span>
                          </Button>
                        ))}
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {error && (
        <p className="warning-text" role="alert">
          {localize(error)}
        </p>
      )}
    </section>
  );
}

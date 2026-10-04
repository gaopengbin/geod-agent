import { t } from "./i18n";
// i18n: presentation strings migrated
import { motion } from "motion/react";
import { Button } from "@/components/motion/button/base";
import { Activity, CheckCircle2, ChevronRight, CircleAlert, Clock3, ShieldCheck } from "./icons";
import { UiTooltip } from "./ui-tooltip";
import { summarizeTasks } from "./task-summary";
import type { WorkspaceSettings } from "./api";
import type { QueueTask } from "./task-queue";

/** One bounded entry per answer; task details and approvals live in the task panel. */
export function TranscriptTaskGroup({ tasks, permission, onOpen }: {
  tasks: QueueTask[]; permission?: WorkspaceSettings["permission"] | null; onOpen: (planIds: string[]) => void;
}) {
  if (!tasks.length) return null;
  const multi = tasks.length > 1;
  const { status, kind } = summarizeTasks(tasks, permission);
  const title = multi ? `${tasks.length} 项影像任务` : tasks[0].title ?? tasks[0].stored.plan.sourceName;
  const preview = tasks.slice(0, 2).map(task => task.title ?? task.stored.plan.sourceName).join("、") + (tasks.length > 2 ? ` 等 ${tasks.length} 项` : "");
  const icon = kind === "attention" ? <CircleAlert size={17}/> : kind === "pending" ? <ShieldCheck size={17}/> : kind === "running" ? <Activity size={17}/> : kind === "scheduled" ? <Clock3 size={17}/> : <CheckCircle2 size={17}/>;
  return <motion.section className={`transcript-task-group ${multi ? "is-batch" : ""} state-${kind}`} data-task-group={tasks.map(task => task.stored.planId).join(" ")} aria-label={multi ? t("本轮 {0} 项任务", {"0": tasks.length}) : title} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .24 }}>
    <UiTooltip content={t("{0}{1}。在右侧查看{2}，可逐项或批量处理。{3}", {"0": title, "1": multi ? `：${preview}` : "", "2": multi ? `这 ${tasks.length} 项任务` : "此任务", "3": status})}>
      <Button variant="ghost" size="sm" whileHover={undefined} whileTap={undefined} aria-label={multi ? t("查看本轮 {0} 项任务", {"0": tasks.length}) : t("查看{0}任务", {"0": title})} onClick={() => onOpen(tasks.map(task => task.stored.planId))}>
        <span className="transcript-task-icon">{icon}</span><span className="transcript-task-label"><strong>{title}</strong>{multi && <span className="transcript-task-preview">{status}</span>}</span>{!multi && <span className="transcript-task-state">{status}</span>}<ChevronRight size={16}/>
      </Button>
    </UiTooltip>
  </motion.section>;
}

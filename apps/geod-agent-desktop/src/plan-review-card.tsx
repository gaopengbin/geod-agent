import { getLocale, t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useState } from "react";
import { ArrowDownToLine, ShieldCheck, Trash } from "./icons";
import { Button } from "@/components/motion/button/base";
import { UiTooltip } from "./ui-tooltip";
import { displayPath } from "./path-display";
import { errorMessage, type StoredPlan, type WorkspaceSettings } from "./api";

export function PlanReviewCard({ stored, title, permission, working = false, compact = false, externalErrors = false, onStart, onDiscard }: {
  stored: StoredPlan; permission?: WorkspaceSettings["permission"] | null; working?: boolean; compact?: boolean;
  title?: string;
  externalErrors?: boolean;
  onStart: (plan: StoredPlan) => Promise<void>; onDiscard: (plan: StoredPlan) => Promise<void>;
}) {
  const [checked, setChecked] = useState(false);
  const [action, setAction] = useState<"start" | "discard" | null>(null);
  const [error, setError] = useState("");
  const disabled = working || action !== null;
  async function run(next: "start" | "discard") {
    if (disabled) return;
    setAction(next); setError("");
    try { await (next === "start" ? onStart(stored) : onDiscard(stored)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setAction(null); }
  }
  return <section className={`chat-plan-card plan-review-card ${compact ? "plan-review-compact" : ""}`} data-plan-id={stored.planId} aria-label={title ?? t("待处理的影像计划")} aria-busy={action !== null}>
    {!compact && <><div className="approval-title"><ShieldCheck size={18} /><strong>{title ?? stored.plan.sourceName}</strong><span className="plan-review-state">{permission === "fullAccess" ? t("待执行") : t("待确认")}</span></div>
      <p>{stored.plan.sourceName} · Z{stored.plan.spec.zoomLevels.join(", ")} · {stored.plan.totalTiles.toLocaleString(getLocale())} {t(" 瓦片 · ")}{stored.plan.spec.outputFormats.map(outputFormatLabel).join(" + ")}</p>
      <UiTooltip content={displayPath(stored.plan.spec.outputDirectory)}><small className="plan-review-path" tabIndex={0}>{displayPath(stored.plan.spec.outputDirectory)}</small></UiTooltip></>}
    {permission !== "fullAccess" && <label className="check-row"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => setChecked(event.target.checked)} /><span>{t("我已核对图源、范围、格式和保存位置")}</span></label>}
    <div className="plan-review-actions"><Button disabled={disabled || !permission || (permission !== "fullAccess" && !checked)} onClick={() => void run("start")}>{action === "start" ? <span className="task-spinner" /> : <ArrowDownToLine size={16} />}{action === "start" ? t("正在启动…") : permission === "fullAccess" ? t("开始下载") : t("确认并开始下载")}</Button>
      <Button variant="ghost" disabled={disabled} onClick={() => void run("discard")}>{action === "discard" ? <span className="task-spinner" /> : <Trash size={16} />}{action === "discard" ? t("丢弃中…") : t("丢弃")}</Button></div>
    {error && !externalErrors && <p className="warning-text" role="alert">{localize(error)}</p>}
  </section>;
}
import { outputFormatLabel } from "./output-formats";

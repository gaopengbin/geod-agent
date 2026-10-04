import { t, getLocale, localize } from "./i18n";
// i18n: presentation strings migrated
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/motion/button/base";
import { ArrowDownToLine, RefreshCw } from "./icons";
import { errorMessage, type Job, type StoredPlan, type WorkspaceSettings } from "./api";

export type ImageryRecoveryMode = "retryMissing" | "exportAvailable";
export interface ImageryRecoveryPlan {
  stored: StoredPlan;
  originalJobId: string;
  mode: ImageryRecoveryMode;
  permission: WorkspaceSettings["permission"];
  requiresPlanConfirmation: boolean;
}
export function planImageryRecovery(conversationId: string, jobId: string, mode: ImageryRecoveryMode, executionId: string = crypto.randomUUID()) {
  return invoke<ImageryRecoveryPlan>("imagery_recovery_plan", { conversationId, jobId, mode, executionId });
}
export const IMAGERY_RECOVERY_PLANNED = "geod-imagery-recovery-planned";
export function presentImageryRecovery(conversationId: string, result: ImageryRecoveryPlan) {
  window.dispatchEvent(new CustomEvent(IMAGERY_RECOVERY_PLANNED, { detail: { conversationId, result } }));
}

/** Compact recovery actions live with the selected task, never in the transcript.
 * The owner decides whether to show its normal confirmation card or start under
 * full access. This component only creates and presents a new immutable plan. */
export function ImageryRecoveryActions({ conversationId, job, workerActive, disabled, missingTiles, onPlanned }: {
  conversationId: string; job: Job; workerActive: boolean; disabled?: boolean; missingTiles?: number;
  onPlanned: (result: ImageryRecoveryPlan) => void | Promise<void>;
}) {
  const [pending, setPending] = useState<ImageryRecoveryMode | null>(null);
  const [error, setError] = useState("");
  if (workerActive || !["partial", "failed", "cancelled", "paused", "downloading", "queued"].includes(job.state)) return null;
  async function recover(mode: ImageryRecoveryMode) {
    setPending(mode); setError("");
    try { await onPlanned(await planImageryRecovery(conversationId, job.jobId, mode)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setPending(null); }
  }
  return <section className="task-recovery" aria-label={t("恢复下载与缓存导出")}>
    <div className="task-actions">
      <Button variant="secondary" size="sm" disabled={disabled || pending !== null} onClick={() => void recover("retryMissing")}>
        <RefreshCw size={14} className={pending === "retryMissing" ? "animate-spin" : undefined}/>
        {pending === "retryMissing" ? t("生成补漏计划…") : t("补齐缺失瓦片")}
      </Button>
      <Button variant="ghost" size="sm" disabled={disabled || pending !== null} onClick={() => void recover("exportAvailable")}>
        <ArrowDownToLine size={14}/>{pending === "exportAvailable" ? t("生成缓存导出…") : t("导出已有瓦片")}
      </Button>
    </div>
    <p className="task-subtitle">{missingTiles ? t("缺失 {0} 张。", {"0": missingTiles.toLocaleString(getLocale())}) : ""}{t("保存为独立成果；缓存导出不联网，缺失区域留空。")}</p>
    {error && <p className="warning-text" role="alert">{localize(error)}</p>}
  </section>;
}

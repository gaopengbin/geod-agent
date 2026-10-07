import { t } from "./i18n";

export const generatingArtifacts = (state?: string | null) => state === "processing" || state === "verifying";

/** Only tile download has a measured percentage; output generation is indeterminate. */
export function TaskProgressBar({ state, percent = 0, className = "progress-track", downloadLabel }: { state?: string | null; percent?: number; className?: string; downloadLabel?: string }) {
  const indeterminate = generatingArtifacts(state);
  const value = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const label = indeterminate ? state === "processing" ? t("正在生成成果") : t("正在核验成果") : downloadLabel ?? t("瓦片下载进度");
  return <span className={`${className}${indeterminate ? " task-progress-indeterminate" : ""}`} role="progressbar" aria-label={label}
    aria-valuenow={indeterminate ? undefined : Math.round(value)} aria-valuemin={0} aria-valuemax={100} aria-valuetext={indeterminate ? label : undefined}>
    <span style={indeterminate ? undefined : { width: `${value}%` }}/>
  </span>;
}

import { getLocale, t } from "./i18n";
// i18n: presentation strings migrated
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "@/components/motion/popover-morph";
import { MAX_CONTEXT_CHARS, MAX_CONTEXT_MESSAGES, contextWindowUsage } from "./conversation-context";
import type { CodexTokenUsage } from "./codex-client";

type Usage = ReturnType<typeof contextWindowUsage>;

const formatK = (value: number) => {
  if (value === 0) return "0K";
  if (value < 50) return "<0.1K";
  const rounded = Math.round(value / 100) / 10;
  return `${rounded.toLocaleString(getLocale(), { maximumFractionDigits: 1 })}K`;
};

export function ContextWindow({ usage, compressedBefore, lastInputTokens, codex }: {
  usage: Usage;
  compressedBefore: boolean;
  lastInputTokens: number | null;
  codex?: { usage: CodexTokenUsage | null };
}) {
  const tokens = codex?.usage;
  const used = tokens ? tokens.inputTokens + tokens.outputTokens : 0;
  const limit = tokens?.modelContextWindow ?? 0;
  const percent = Math.min(100, codex ? limit ? used / limit * 100 : 0 : usage.sentChars / MAX_CONTEXT_CHARS * 100);
  const ringLength = 2 * Math.PI * 8;
  const categories = [
    { key: "user" as const, label: "用户消息与摘要", color: "var(--app-blue)" },
    { key: "assistant" as const, label: "助手消息与工具调用", color: "#19a889" },
    { key: "tool" as const, label: "工具结果", color: "#e8a03d" },
    { key: "structure" as const, label: "消息结构", color: "#8f72df" },
  ];

  return <MorphPopover className="context-usage-root">
    <MorphPopoverTrigger>
      <button type="button" className="context-usage-trigger" aria-label={codex ? t("查看 Codex 上下文用量，{0}", {"0": tokens ? `${formatK(used)} / ${formatK(limit)} token，${percent.toFixed(1)}%` : "等待首次请求"}) : t("查看上下文用量，当前 {0} / {1} 字符，{2}%", {"0": formatK(usage.sentChars), "1": formatK(MAX_CONTEXT_CHARS), "2": percent.toFixed(1)})}>
        <svg className="context-usage-ring" viewBox="0 0 24 24" aria-hidden="true">
          <circle className="context-usage-ring-track" cx="12" cy="12" r="8" fill="none" strokeWidth="2.5" />
          <circle className={`context-usage-ring-progress${usage.error || percent >= 90 ? " is-near-limit" : ""}`} cx="12" cy="12" r="8" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={ringLength} strokeDashoffset={ringLength * (1 - percent / 100)} />
        </svg>
      </button>
    </MorphPopoverTrigger>
    <MorphPopoverContent side="top" align="end" className="context-usage-panel">
      <div className="context-usage-heading"><strong>{t("上下文用量")}</strong><span>{t("本次会话")}</span></div>
      {codex ? <>
        <div className="context-usage-number"><strong>{tokens ? `${percent.toFixed(1)}%` : "—"}</strong><span>{tokens ? `${formatK(used)} / ${limit ? formatK(limit) : "未知"} token` : t("等待首次模型请求")}</span></div>
        <div className="context-usage-track" role="meter" aria-label={t("Codex 上下文占用")} aria-valuemin={0} aria-valuemax={limit || 1} aria-valuenow={Math.min(used, limit || 1)}><span style={{ width: `${percent}%`, backgroundColor: "var(--app-blue)" }} /></div>
        <div className="context-usage-details">
          <div><span>{t("引擎")}</span><strong>Codex app-server</strong></div>
          <div><span>{t("最近请求输入")}</span><strong>{tokens ? `${formatK(tokens.inputTokens)} token` : t("暂无记录")}</strong></div>
          <div><span>{t("最近请求输出")}</span><strong>{tokens ? `${formatK(tokens.outputTokens)} token` : t("暂无记录")}</strong></div>
          <div><span>{t("缓存输入")}</span><strong>{tokens ? `${formatK(tokens.cachedInputTokens)} token` : t("暂无记录")}</strong></div>
          <div><span>{t("模型")}</span><strong>DeepSeek Flash</strong></div>
        </div>
        <p className="context-usage-note">{t("用量来自最近一次模型请求；窗口由网关配置，Codex 会在接近上限时自动压缩上下文。完整请求经过原生层传输。账号用量另计。")}</p>
      </> : <>
      <div className="context-usage-number"><strong>{percent.toFixed(1)}%</strong><span>{formatK(usage.sentChars)} / {formatK(MAX_CONTEXT_CHARS)} {t(" 字符")}</span></div>
      <div className="context-usage-track" role="meter" aria-label={t("本机对话上下文占用")} aria-valuemin={0} aria-valuemax={MAX_CONTEXT_CHARS} aria-valuenow={Math.min(usage.sentChars, MAX_CONTEXT_CHARS)}>
        {categories.map(category => <span key={category.key} style={{ width: `${Math.min(100, usage.roles[category.key] / MAX_CONTEXT_CHARS * 100)}%`, backgroundColor: category.color }} />)}
      </div>
      <div className="context-usage-count">{t("消息 ")}{usage.messageCount} / {MAX_CONTEXT_MESSAGES} {t(" 条")}{usage.error ? t(" · 已超出本机上限") : ""}</div>
      <div className="context-usage-categories">
        {categories.map(category => <div key={category.key}><span className="context-usage-dot" style={{ backgroundColor: category.color }} /><span>{category.label}</span><span>{formatK(usage.roles[category.key])}</span></div>)}
      </div>
      {(usage.compressed || compressedBefore) && <p className="context-usage-compressed">{t("较早对话已自动压缩；当前任务与工具调用会继续保留。")}</p>}
      <div className="context-usage-details">
        <div><span>{t("上次模型请求")}</span><strong>{lastInputTokens === null ? t("暂无记录") : t("{0} token 输入", {"0": formatK(lastInputTokens)})}</strong></div>
        <div><span>{t("网关保护上限")}</span><strong>{t("48K 字符 / 64 条")}</strong></div>
        <div><span>{t("DeepSeek 标称窗口")}</span><strong>1,000K token</strong></div>
        <div><span>{t("每次模型调用输出")}</span><strong>{t("最多 2.048K token")}</strong></div>
      </div>
      <p className="context-usage-note">{t("进度按应用实际发送的对话字符计算，不是模型 token 占比；上次请求的 token 用量包含系统提示和工具定义。账号额度另计。")}</p>
      </>}
    </MorphPopoverContent>
  </MorphPopover>;
}

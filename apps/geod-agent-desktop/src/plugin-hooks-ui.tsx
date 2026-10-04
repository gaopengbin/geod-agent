import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/motion/button/base";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown, CircleAlert, Loader2, X } from "./icons";
import { localize, t } from "./i18n";
import { CODEX_HOOK_LABELS } from "./codex-items";

interface PluginCommandHookHandler {
  type: "command"; command: string; commandWindows?: string; command_windows?: string;
  timeout?: number; async?: boolean; statusMessage?: string; additionalContextLimit?: number;
}
interface PluginMcpHookHandler {
  type: "mcp_tool"; server: string; tool: string; input?: Record<string, unknown>;
  timeout?: number; statusMessage?: string;
}
export type PluginHookHandler = PluginCommandHookHandler | PluginMcpHookHandler;
export interface PluginHookGroup { event: string; matcher: string | null; handlers: PluginHookHandler[] }
export interface PluginHooksReview { id: string; displayName: string; sha256: string; hooks: PluginHookGroup[]; enabled: boolean; reviewed: boolean }
export function hookCount(groups: PluginHookGroup[] = []) { return groups.reduce((sum, group) => sum + group.handlers.length, 0); }
export function PluginHookList({ groups }: { groups: PluginHookGroup[] }) {
  return <div className="plugin-hook-list">{groups.flatMap((group, groupIndex) => group.handlers.map((handler, handlerIndex) => {
    const event = group.event.charAt(0).toLowerCase() + group.event.slice(1);
    return <article className="plugin-hook-row" key={groupIndex + "-" + handlerIndex}>
      <div><strong>{t(CODEX_HOOK_LABELS[event] || group.event)}</strong><span>{handler.type === "command" && handler.async ? t("后台运行") : t("同步运行")}</span></div>
      {handler.statusMessage && <p>{handler.statusMessage}</p>}
      <ScrollArea className="plugin-hook-command"><pre>{handler.type === "mcp_tool" ? handler.server + " · " + handler.tool : handler.commandWindows || handler.command_windows || handler.command}</pre></ScrollArea>
      {handler.type === "mcp_tool" && Object.keys(handler.input ?? {}).length > 0 && <details className="plugin-hook-input"><summary><span>{t("输入模板")}</span><ChevronDown size={14} /></summary><ScrollArea className="plugin-hook-command"><pre>{JSON.stringify(handler.input, null, 2)}</pre></ScrollArea></details>}
      <small>{group.matcher ? t("匹配：{0}", { "0": group.matcher }) : t("适用于此事件的每次调用")}{handler.timeout != null && " · " + t("超时 {0} 秒", { "0": handler.timeout })}</small>
    </article>;
  }))}</div>;
}
export function PluginHooksDialog({ review, busy, error, onClose, onSetEnabled }: {
  review: PluginHooksReview; busy: boolean; error: string; onClose: () => void; onSetEnabled: (enabled: boolean) => void;
}) {
  const [approved, setApproved] = useState(false);
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="dialog plugin-preview-dialog" aria-busy={busy}>
      <div className="dialog-head"><div><Dialog.Title>{t("插件自动化")}</Dialog.Title><Dialog.Description>{review.displayName}</Dialog.Description></div><Button size="icon" variant="ghost" disabled={busy} aria-label={t("关闭")} onClick={onClose}><X size={18} /></Button></div>
      <div className="dialog-body"><PluginHookList groups={review.hooks} /><p className="memory-footnote">{t("这些操作会在对应事件发生时由本机自动执行。资源变更后需重新导入并审阅；可随时停用。")}</p>
        {!review.enabled && <label className="plugin-hook-consent"><input type="checkbox" checked={approved} disabled={busy} onChange={event => setApproved(event.target.checked)} /><span>{t("我已审阅这些自动化操作，允许随会话运行")}</span></label>}
        {error && <div className="extension-error" role="alert"><CircleAlert size={16} /><span>{localize(error)}</span></div>}
      </div>
      <div className="dialog-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t("取消")}</Button><Button size="sm" disabled={busy || (!review.enabled && !approved)} onClick={() => onSetEnabled(!review.enabled)}>{busy && <Loader2 size={15} className="animate-spin" />}{review.enabled ? t("停用自动化") : t("启用自动化")}</Button></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}

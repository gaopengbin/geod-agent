import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/motion/button/base";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CircleAlert, Loader2, X } from "./icons";
import { localize, t } from "./i18n";
import { useState } from "react";
import { hookCount, PluginHookList, type PluginHookGroup } from "./plugin-hooks-ui";
import type { McpRuntimeSettings, RegisteredPluginApp } from "./api";
import { PluginRegisteredApps } from "./plugin-apps-ui";

export interface PluginSource { repository: string; commit: string; path: string; marketplace: string }
export interface PluginPreview {
  name: string; displayName: string; description: string; version: string; format: string; sha256: string;
  source?: PluginSource | null;
  hooks?: PluginHookGroup[];
  registeredApps?: RegisteredPluginApp[];
  skills: { name: string; description: string; content: string }[];
  connectors: { name: string; url: string; command: string | null; argumentCount: number; envNames: string[]; headerNames: string[]; runtime?: McpRuntimeSettings; enabled?: boolean }[];
}
export function PluginPreviewDialog({ bundle, busy, error, onClose, onInstall }: {
  bundle: PluginPreview; busy: boolean; error: string; onClose: () => void; onInstall: (enabled: boolean, hooksApproved: boolean) => void;
}) {
  const [hooksApproved, setHooksApproved] = useState(false);
  const hooks = bundle.hooks ?? [];
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-backdrop" />
      <Dialog.Content className="dialog plugin-preview-dialog" aria-busy={busy}>
        <div className="dialog-head">
          <div><Dialog.Title>{bundle.displayName}</Dialog.Title><Dialog.Description>{t("检查插件内容，再选择是否启用。")}</Dialog.Description></div>
          <Button size="icon" variant="ghost" disabled={busy} aria-label={t("取消插件导入")} onClick={onClose}><X size={18} /></Button>
        </div>
        <div className="dialog-body">
          <div className="plugin-preview-meta"><span>{bundle.version}</span><span>{t("{0} 个技能 · {1} 个工具服务", { "0": bundle.skills.length, "1": bundle.connectors.length })}</span></div>
          {bundle.description && <p className="plugin-preview-description">{bundle.description}</p>}
          {bundle.source && <div className="plugin-preview-source"><strong>{bundle.source.repository}</strong><span>{bundle.source.marketplace} · {bundle.source.commit.slice(0, 12)}</span></div>}
          <div className="plugin-components">
            {bundle.skills.map(skill => <details key={skill.name}>
              <summary>{t("技能 · ")}{skill.name}</summary><p>{skill.description}</p>
              <ScrollArea className="plugin-skill-scroll"><pre>{skill.content}</pre></ScrollArea>
            </details>)}
            {bundle.connectors.map(connector => <div className="plugin-tool-summary" key={connector.name}>
              <strong>{t("工具 · ")}{connector.name}</strong><p>{connector.url || connector.command}</p>
              <small>{connector.url ? t("HTTP 服务") : t("本机进程")}
                {connector.enabled === false && " · " + t("默认停用")}
                {connector.envNames.length > 0 && " · " + t("环境变量") + " " + connector.envNames.join("、")}
                {connector.headerNames.length > 0 && " · " + t("请求头") + " " + connector.headerNames.join("、")}
              </small>
              <PluginMcpSettings runtime={connector.runtime} />
            </div>)}
            {hooks.length > 0 && <div><h3 className="plugin-hook-heading">{t("自动化操作 {0} 项", { "0": hookCount(hooks) })}</h3><PluginHookList groups={hooks} /></div>}
            <PluginRegisteredApps apps={bundle.registeredApps} />
          </div>
          <p className="memory-footnote">{!bundle.skills.length && !bundle.connectors.length && !hooks.length ? t("此插件只有应用声明，可保存到列表；当前没有可启用的技能或工具。") : t("添加后，Agent 可读取这些技能并调用所列工具。配置与脚本保存在本机，认证值进入系统凭据库。")}</p>
          {hooks.length > 0 && <><label className="plugin-hook-consent"><input type="checkbox" checked={hooksApproved} disabled={busy} onChange={event => setHooksApproved(event.target.checked)} /><span>{t("我已审阅这些自动化操作，允许随会话运行")}</span></label><p className="plugin-hook-note">{t("未勾选时，自动化保持停用，可稍后审阅启用。")}</p></>}
          {error && <div className="extension-error" role="alert"><CircleAlert size={16} /><span>{localize(error)}</span></div>}
        </div>
        <div className="dialog-actions">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>{t("取消")}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onInstall(false, hooksApproved)}>{t("仅添加")}</Button>
          <Button size="sm" disabled={busy || (!bundle.skills.length && !bundle.connectors.length && (!hooks.length || !hooksApproved))} onClick={() => onInstall(true, hooksApproved)}>{busy && <Loader2 size={15} className="animate-spin" />}{t("添加并启用")}</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function PluginMcpSettings({ runtime }: { runtime?: McpRuntimeSettings }) {
  if (!runtime) return null;
  const references = [...Object.values(runtime.envHttpHeaders ?? {}), ...(runtime.bearerTokenEnvVar ? [runtime.bearerTokenEnvVar] : [])];
  return <dl className="plugin-tool-runtime">
    {runtime.cwd && <div><dt>{t("工作目录")}</dt><dd>{runtime.cwd}</dd></div>}
    {!!runtime.envVars?.length && <div><dt>{t("继承变量")}</dt><dd>{runtime.envVars.join("、")}</dd></div>}
    {!!references.length && <div><dt>{t("认证变量")}</dt><dd>{[...new Set(references)].join("、")}</dd></div>}
    {(runtime.startupTimeoutSec != null || runtime.toolTimeoutSec != null) && <div><dt>{t("超时设置")}</dt><dd>{t("启动 {0} 秒 · 调用 {1} 秒", { "0": runtime.startupTimeoutSec ?? t("默认"), "1": runtime.toolTimeoutSec ?? t("默认") })}</dd></div>}
    {runtime.enabledTools && <div><dt>{t("可用工具")}</dt><dd>{runtime.enabledTools.length ? runtime.enabledTools.join("、") : t("无")}</dd></div>}
    {!!runtime.disabledTools?.length && <div><dt>{t("排除工具")}</dt><dd>{runtime.disabledTools.join("、")}</dd></div>}
  </dl>;
}

import { t, localize } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/motion/button/base";
import { CircleAlert, FolderOpen, PuzzlePiece, Trash, X } from "./icons";
import { errorMessage, type RegisteredPluginApp } from "./api";
import { PluginRegisteredApps } from "./plugin-apps-ui";
import { PluginCatalog } from "./plugin-catalog";
import { PluginPreviewDialog, type PluginPreview, type PluginSource } from "./plugin-preview";
import { PluginHooksDialog, type PluginHooksReview } from "./plugin-hooks-ui";
import "./memory-panel.css";

interface Plugin {
  id: string; name: string; displayName: string; description: string; version: string; format: string; sha256: string;
  skillIds: string[]; connectorIds: string[]; enabledSkills: number; enabledConnectors: number; source?: PluginSource | null;
  hooksCount?: number; enabledHooks?: number; hooksReviewed?: boolean;
  registeredApps?: RegisteredPluginApp[];
}
export function PluginPanel({ active, conversationId, onChanged }: {
  active: boolean; conversationId: string; onChanged: () => void;
}) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [preview, setPreview] = useState<{ path: string; bundle: PluginPreview } | null>(null);
  const [hookReview, setHookReview] = useState<PluginHooksReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [tab, setTab] = useState<"installed" | "catalog">("installed");
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const scope = useRef(conversationId);
  const inFlight = useRef(false);
  scope.current = conversationId;
  useEffect(() => { setPreview(null); setHookReview(null); setPlugins([]); setError(""); setBusy(false); }, [conversationId]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void invoke<{ plugins: Plugin[] }>("plugins_list").then(value => { if (current) setPlugins(value.plugins); })
      .catch(cause => { if (current) setError(errorMessage(cause)); });
    return () => { current = false; };
  }, [active, conversationId, refresh]);
  async function run(action: () => Promise<unknown>, changed = true) {
    if (inFlight.current) return;
    const origin = conversationId;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await action();
      if (changed && scope.current === origin) { setRefresh(value => value + 1); onChanged(); }
    } catch (cause) { if (scope.current === origin) setError(errorMessage(cause)); }
    finally { inFlight.current = false; if (scope.current === origin) setBusy(false); }
  }
  function changed() { setRefresh(value => value + 1); onChanged(); }
  const locked = busy || catalogBusy;
  return <section className="memory-panel plugin-panel" hidden={!active} aria-label={t("插件管理")}>
    <div className="memory-heading">
      <div><h2>{t("插件")}</h2><p>{t("将一组技能与工具一起添加、启用或移除。")}</p></div>
      <Button size="sm" variant="outline" disabled={locked} onClick={() => void run(async () => {
        const origin = conversationId;
        const path = await open({ directory: true, multiple: false, title: t("选择插件文件夹") });
        if (typeof path === "string" && scope.current === origin) {
          const bundle = await invoke<PluginPreview>("plugin_preview", { path });
          if (scope.current === origin) { setTab("installed"); setPreview({ path, bundle }); }
        }
      }, false)}><FolderOpen size={16} />{t("导入插件")}</Button>
    </div>
    <div className="plugin-tabs" role="group" aria-label={t("插件视图")}>
      <Button size="sm" variant="ghost" disabled={locked} aria-pressed={tab === "installed"} className={tab === "installed" ? "active" : ""} onClick={() => setTab("installed")}>{t("已添加")}<span>{plugins.length}</span></Button>
      <Button size="sm" variant="ghost" disabled={locked} aria-pressed={tab === "catalog"} className={tab === "catalog" ? "active" : ""} onClick={() => setTab("catalog")}>{t("浏览插件")}</Button>
    </div>
    {error && !preview && !hookReview && <div className="extension-error" role="alert"><CircleAlert size={16} /><span>{localize(error)}</span><Button size="icon" variant="ghost" aria-label={t("关闭插件错误")} onClick={() => setError("")}><X size={16} /></Button></div>}
    {hookReview && <PluginHooksDialog review={hookReview} busy={busy} error={error} onClose={() => { setHookReview(null); setError(""); }} onSetEnabled={enabled => void run(async () => {
      const origin = conversationId;
      await invoke("plugin_hooks_set_enabled", { id: hookReview.id, expectedSha256: hookReview.sha256, enabled });
      if (scope.current === origin) setHookReview(null);
    })} />}
    {preview && <PluginPreviewDialog bundle={preview.bundle} busy={busy} error={error} onClose={() => { setPreview(null); setError(""); }} onInstall={(enabled, hooksApproved) => void run(async () => {
      const origin = conversationId;
      await invoke("plugin_import", { path: preview.path, expectedSha256: preview.bundle.sha256, enabled, hooksApproved });
      if (scope.current === origin) setPreview(null);
    })} />}
    {tab === "catalog" && active ? <PluginCatalog conversationId={conversationId} installedNames={plugins.map(plugin => plugin.name)} onChanged={changed} onBusy={setCatalogBusy} /> : <>
      {!plugins.length && !preview && <p className="extension-empty-inline">{t("从目录浏览插件，或导入本机插件文件夹。")}</p>}
      <div className="memory-list">{plugins.map(plugin => {
        const enabled = plugin.enabledSkills + plugin.enabledConnectors + (plugin.enabledHooks ?? 0);
        const total = plugin.skillIds.length + plugin.connectorIds.length + (plugin.hooksCount ?? 0);
        const reviewHooks = () => void run(async () => {
          const origin = conversationId;
          const review = await invoke<PluginHooksReview>("plugin_hooks_preview", { id: plugin.id });
          if (scope.current === origin) setHookReview(review);
        }, false);
        return <article className="memory-row" key={plugin.id}>
          <PuzzlePiece size={19} />
          <div className="memory-row-copy">
            <div><strong>{plugin.displayName}</strong><span>{plugin.version}</span><span>{enabled ? t("{0}/{1} 已启用", { "0": enabled, "1": total }) : total ? t("已停用") : t("暂不可用")}</span></div>
            <p>{t("{0} 个技能 · {1} 个工具服务", { "0": plugin.skillIds.length, "1": plugin.connectorIds.length })}{plugin.description && " · " + plugin.description}</p>
            {plugin.source && <small className="plugin-installed-source">{plugin.source.repository} · {plugin.source.commit.slice(0, 8)}</small>}
            <PluginRegisteredApps apps={plugin.registeredApps} compact />
          </div>
          <div className="memory-row-actions">
            {(plugin.hooksCount ?? 0) > 0 && <Button size="sm" variant="ghost" disabled={busy} onClick={reviewHooks}>{t("自动化 {0}/{1}", { "0": plugin.enabledHooks ?? 0, "1": plugin.hooksCount ?? 0 })}</Button>}
            {plugin.skillIds.length + plugin.connectorIds.length > 0 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => invoke("plugin_set_enabled", { id: plugin.id, enabled: !enabled }))}>{enabled ? t("停用") : t("启用")}</Button>}
            <Button size="icon" variant="ghost" aria-label={t("移除插件 {0}", { "0": plugin.displayName })} disabled={busy} onClick={() => void run(() => invoke("plugin_remove", { id: plugin.id }))}><Trash size={15} /></Button>
          </div>
        </article>;
      })}</div>
      <p className="memory-footnote">{t("插件只属于当前 GeoD 账号。启用后会用于新一轮对话；停用与移除不改写已有回答。")}</p>
    </>}
  </section>;
}

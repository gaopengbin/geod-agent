import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Select from "@radix-ui/react-select";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/motion/button/base";
import { Check, ChevronDown, CircleAlert, Globe2, Loader2, Plus, PuzzlePiece, RefreshCw, Search, Trash, X } from "./icons";
import { errorMessage } from "./api";
import { localize, t } from "./i18n";
import { PluginPreviewDialog, type PluginPreview } from "./plugin-preview";

interface CatalogEntry {
  name: string; displayName: string; version: string; developerName: string; description: string; category: string; components: string[];
  unavailableReason: string | null; fileCount: number; bytes: number;
}
interface Marketplace {
  id: string; repository: string; reference: string; name: string; displayName: string;
  builtin: boolean; commit: string | null; refreshedAt: string | null; entries: CatalogEntry[];
}
interface Stage { stageId: string; bundle: PluginPreview }
const labels: Record<string, string> = { skills: "技能", mcp: "工具", hooks: "Hook", apps: "账号连接" };

export function PluginCatalog({ conversationId, installedNames, onChanged, onBusy }: {
  conversationId: string; installedNames: string[]; onChanged: () => void; onBusy: (busy: boolean) => void;
}) {
  const [markets, setMarkets] = useState<Marketplace[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyEntry, setBusyEntry] = useState("");
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState("");
  const [stage, setStage] = useState<Stage | null>(null);
  const stageRef = useRef<Stage | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  stageRef.current = stage;

  useEffect(() => {
    const token = ++generation.current;
    setMarkets([]); setSelectedId(""); setStage(null); setError(""); setBusy(false); setAdding(false);
    void invoke<{ marketplaces: Marketplace[] }>("plugin_marketplaces_list").then(result => {
      if (token !== generation.current) return;
      setMarkets(result.marketplaces); setSelectedId(result.marketplaces[0]?.id ?? "");
    }).catch(cause => { if (token === generation.current) setError(errorMessage(cause)); });
    return () => {
      generation.current++;
      onBusy(false);
      const previous = stageRef.current;
      if (previous && !inFlight.current) void invoke("plugin_marketplace_discard", { stageId: previous.stageId }).catch(() => {});
    };
  }, [conversationId, onBusy]);

  async function run(action: (current: () => boolean) => Promise<void>) {
    if (inFlight.current) return;
    const token = generation.current;
    const current = () => token === generation.current;
    inFlight.current = true; setBusy(true); onBusy(true); setError("");
    try { await action(current); }
    catch (cause) { if (current()) setError(errorMessage(cause)); }
    finally { inFlight.current = false; if (current()) { setBusy(false); setBusyEntry(""); onBusy(false); } }
  }
  function replace(market: Marketplace) {
    setMarkets(previous => [...previous.filter(item => item.id !== market.id), market].sort((a, b) => Number(b.builtin) - Number(a.builtin)));
    setSelectedId(market.id);
  }
  async function closePreview() {
    const previous = stageRef.current;
    setStage(null); setError("");
    if (previous) await invoke("plugin_marketplace_discard", { stageId: previous.stageId }).catch(() => {});
  }
  const selected = markets.find(market => market.id === selectedId);
  const normalized = query.trim().toLocaleLowerCase();
  const entries = selected?.entries.filter(entry => [entry.name, entry.displayName, entry.developerName, entry.description, entry.category].some(value => value.toLocaleLowerCase().includes(normalized))) ?? [];
  const refresh = () => void run(async current => {
    const refreshed = await invoke<Marketplace>("plugin_marketplace_refresh", { id: selectedId });
    if (current()) replace(refreshed);
  });
  return <div className="plugin-catalog" aria-busy={busy}>
    <div className="plugin-catalog-toolbar">
      <Select.Root value={selectedId} onValueChange={setSelectedId} disabled={busy || !markets.length}>
        <Select.Trigger className="select-trigger" aria-label={t("插件目录")}><Globe2 size={16} /><Select.Value placeholder={t("插件目录")} /><Select.Icon><ChevronDown size={15} /></Select.Icon></Select.Trigger>
        <Select.Portal><Select.Content className="select-content" position="popper" sideOffset={6} collisionPadding={8}>
          <Select.Viewport>{markets.map(market => <Select.Item className="select-item" value={market.id} key={market.id}>
            <Select.ItemText>{market.displayName}{!market.builtin && " · " + (market.reference === "HEAD" ? market.repository : market.reference.slice(0, 8))}</Select.ItemText><Select.ItemIndicator className="select-item-indicator"><Check size={14} /></Select.ItemIndicator>
          </Select.Item>)}</Select.Viewport>
        </Select.Content></Select.Portal>
      </Select.Root>
      <label className="plugin-catalog-search"><Search size={16} /><input aria-label={t("搜索插件")} placeholder={t("搜索插件")} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <Button size="icon" variant="ghost" disabled={busy || !selected} aria-label={t("刷新插件目录")} onClick={refresh}>{busy && !busyEntry ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { setSource(""); setError(""); setAdding(true); }}><Plus size={15} />{t("添加目录")}</Button>
    </div>
    {selected && <div className="plugin-catalog-caption">
      <span>{selected.repository}{selected.reference !== "HEAD" && "@" + selected.reference}{selected.commit && " · " + selected.commit.slice(0, 8)}</span>
      <span>{t("{0} 个插件", { "0": selected.entries.length })}{!selected.builtin && <Button size="icon" variant="ghost" disabled={busy} aria-label={t("移除插件目录 {0}", { "0": selected.displayName })} onClick={() => void run(async current => {
        await invoke("plugin_marketplace_remove", { id: selected.id });
        if (current()) { setMarkets(previous => previous.filter(item => item.id !== selected.id)); setSelectedId(markets.find(item => item.id !== selected.id)?.id ?? ""); }
      })}><Trash size={14} /></Button>}</span>
    </div>}
    {error && !stage && !adding && <div className="extension-error" role="alert"><CircleAlert size={16} /><span>{localize(error)}</span><Button size="icon" variant="ghost" aria-label={t("关闭插件错误")} onClick={() => setError("")}><X size={16} /></Button></div>}
    {!selected?.commit && <div className="plugin-catalog-empty"><Globe2 size={26} /><p>{t("刷新目录，查看可添加的插件。")}</p><Button size="sm" disabled={busy || !selected} onClick={refresh}>{t("查看插件")}</Button></div>}
    {selected?.commit && !entries.length && <p className="extension-empty-inline">{t("没有找到匹配的插件。")}</p>}
    <div className="plugin-catalog-list">{entries.map(entry => {
      const installed = installedNames.includes(entry.name);
      return <article className="plugin-catalog-row" key={entry.name}>
        <div className="plugin-catalog-icon"><PuzzlePiece size={18} /></div>
        <div className="plugin-catalog-copy"><strong>{entry.displayName || entry.name}</strong><p>{entry.description || entry.category || selected?.displayName}</p>
          <div className="plugin-catalog-tags">{entry.components.map(component => <span key={component}>{t(labels[component] || component)}</span>)}{entry.unavailableReason && <span className="plugin-catalog-unavailable">{localize(entry.unavailableReason)}</span>}</div>
        </div>
        <Button size="sm" variant="outline" disabled={busy || installed || !!entry.unavailableReason} onClick={() => {
          setBusyEntry(entry.name);
          void run(async current => {
            const prepared = await invoke<Stage>("plugin_marketplace_prepare", { marketplaceId: selectedId, name: entry.name });
            if (!current()) { await invoke("plugin_marketplace_discard", { stageId: prepared.stageId }).catch(() => {}); return; }
            setStage(prepared);
          });
        }}>{busyEntry === entry.name ? <Loader2 size={15} className="animate-spin" /> : null}{installed ? t("已添加") : t("检查")}</Button>
      </article>;
    })}</div>
    <p className="memory-footnote">{t("目录内容来自对应仓库。添加前核对技能与工具；需要账号连接或 Hook 的插件会标注其组件，兼容情况以检查结果为准。")}</p>
    {stage && <PluginPreviewDialog bundle={stage.bundle} busy={busy} error={error} onClose={() => void closePreview()} onInstall={(enabled, hooksApproved) => void run(async current => {
      await invoke("plugin_marketplace_install", { stageId: stage.stageId, expectedSha256: stage.bundle.sha256, enabled, hooksApproved });
      if (current()) { setStage(null); onChanged(); }
    })} />}
    {adding && <Dialog.Root open onOpenChange={open => { if (!open && !busy) setAdding(false); }}>
      <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" /><Dialog.Content className="dialog plugin-source-dialog">
        <div className="dialog-head"><div><Dialog.Title>{t("添加插件目录")}</Dialog.Title><Dialog.Description>{t("连接公开 GitHub 仓库中的插件目录。")}</Dialog.Description></div><Button size="icon" variant="ghost" disabled={busy} aria-label={t("关闭")} onClick={() => setAdding(false)}><X size={18} /></Button></div>
        <form onSubmit={event => { event.preventDefault(); void run(async current => {
          const added = await invoke<Marketplace>("plugin_marketplace_add", { source });
          if (current()) { replace(added); setAdding(false); }
        }); }}>
          <div className="dialog-body"><label className="field"><span className="field-label">{t("GitHub 仓库")}</span><input value={source} onChange={event => setSource(event.target.value)} placeholder="owner/repo@main" disabled={busy} required autoComplete="off" /></label><p className="field-help">{t("可填写 owner/repo、owner/repo@版本或 GitHub 仓库链接。")}</p>{error && <p className="form-error" role="alert">{localize(error)}</p>}</div>
          <div className="dialog-actions"><Button type="button" variant="outline" disabled={busy} onClick={() => setAdding(false)}>{t("取消")}</Button><Button type="submit" disabled={busy || !source.trim()}>{busy && <Loader2 size={15} className="animate-spin" />}{t("添加目录")}</Button></div>
        </form>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>}
  </div>;
}

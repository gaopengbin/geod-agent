import { t } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useState } from "react";
import { Button } from "@/components/motion/button/base";
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "@/components/motion/popover-morph";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChevronDown, Paperclip, X } from "./icons";
import type { BoundaryImport, BoundarySummary } from "./api";

export function BoundaryPicker({ items, active, disabled, onSelect, onCombine, onClear, onError }: {
  items: BoundarySummary[]; active: BoundaryImport | null; disabled: boolean;
  onSelect: (id: string) => Promise<void>; onCombine: (ids: string[]) => Promise<void>; onClear: () => void; onError: (cause: unknown) => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => { setSelected(active?.boundaryId ? [active.boundaryId] : []); }, [active?.boundaryId]);
  if (!items.length && !active) return null;
  const name = (value: string) => value.replace(/-AreaCity-\d{8}\.geojson$/i, "");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try { await action(); setOpen(false); } catch (cause) { onError(cause); } finally { setBusy(false); }
  }
  return <div className="boundary-picker">
    <MorphPopover open={open} onOpenChange={setOpen}>
      <MorphPopoverTrigger><Button type="button" variant="ghost" size="sm" disabled={disabled || busy} className="boundary-picker-trigger">
        <Paperclip size={14}/><span>{active ? name(active.name) : t("选择范围")}</span><small>{items.length} {t(" 个已保存")}</small><ChevronDown size={13}/>
      </Button></MorphPopoverTrigger>
      <MorphPopoverContent side="top" align="start" className="boundary-picker-popover">
        <div className="boundary-picker-heading">{t("会话范围")}<span>{t("选择多个可合并裁剪")}</span></div>
        <ScrollArea className="boundary-picker-list" style={{ height: Math.min(items.length * 45, 240) }}>
          {items.map(item => <div key={item.boundaryId} className={`boundary-picker-item ${active?.boundaryId === item.boundaryId ? "active" : ""}`}>
            <input type="checkbox" checked={selected.includes(item.boundaryId)} disabled={busy} aria-label={t("选择{0}", {"0": name(item.name)})} onChange={event => setSelected(current => event.target.checked ? [...current, item.boundaryId] : current.filter(id => id !== item.boundaryId))}/>
            <button type="button" disabled={busy} onClick={() => void run(() => onSelect(item.boundaryId))}><span>{name(item.name)}</span><small>{item.polygonCount} {t(" 个面")}{item.inputIds.length > 0 ? t(" · 合并 {0} 个范围", {"0": item.inputIds.length}) : ""}</small></button>
          </div>)}
        </ScrollArea>
        <div className="boundary-picker-footer"><span>{selected.length ? t("已选择 {0} 个", {"0": selected.length}) : t("范围会随会话保存")}</span><Button type="button" variant="outline" size="sm" disabled={busy || selected.length < 2} onClick={() => void run(() => onCombine(selected))}>{busy ? t("处理中…") : t("合并范围")}</Button></div>
      </MorphPopoverContent>
    </MorphPopover>
    {active && <Button type="button" variant="ghost" size="icon" aria-label={t("清除当前范围选择")} disabled={disabled || busy} onClick={onClear}><X size={14}/></Button>}
  </div>;
}

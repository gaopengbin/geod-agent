import { t } from "./i18n";
// i18n: presentation strings migrated
import { localStateStore } from "./local-state";
import { useEffect, useMemo, useRef, useState } from "react";
import type Map from "ol/Map";
import Draw, { createBox } from "ol/interaction/Draw";
import Modify from "ol/interaction/Modify";
import Snap from "ol/interaction/Snap";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import GeoJSON from "ol/format/GeoJSON";
import { transformExtent } from "ol/proj";
import { Fill, Stroke, Style, Circle as CircleStyle } from "ol/style";
import { Bookmark, BookmarkPlus, Check, Maximize2, Pencil, Pentagon, SquareDashed, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from "@/components/motion/popover-morph";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api, type BoundaryImport, type StoredBoundary } from "./api";
import { bookmarkBoundary, readBoundaryBookmarks, writeBoundaryBookmarks, type BoundaryBookmark } from "./boundary-bookmarks";
import { selectBoundaryForConversation } from "./boundary-selection";
import { errorMessage } from "./app-error";
import "./manual-boundaries.css";

type Mode = "idle" | "rectangle" | "polygon" | "edit";
const format = new GeoJSON();
const defaultName = () => `手绘范围 ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())}`;
const stableButton = { size: "icon" as const, variant: "ghost" as const, whileHover: { scale: 1 }, pressScale: 1 };

export function ManualBoundaries({ map, conversationId, theme, planBoundary }: { map: Map; conversationId: string; theme: "light" | "dark"; planBoundary: BoundaryImport | null }) {
  const source = useMemo(() => new VectorSource({ wrapX: false }), [map]);
  const [mode, setMode] = useState<Mode>("idle");
  const [hasDraft, setHasDraft] = useState(false);
  const [name, setName] = useState("");
  const [bookmarks, setBookmarks] = useState(() => readBoundaryBookmarks(localStateStore, conversationId));
  const bookmarksRef = useRef(bookmarks); bookmarksRef.current = bookmarks;
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [renamingId, setRenamingId] = useState<string>();
  const [rename, setRename] = useState("");
  const drawRef = useRef<Draw | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const stroke = theme === "dark" ? "#94bfff" : "#1769e8";
    const layer = new VectorLayer({ source, zIndex: 1000, properties: { id: "manual-boundary-draft", name: "手绘范围", geodManual: true }, style: new Style({
      stroke: new Stroke({ color: stroke, width: 2 }), fill: new Fill({ color: "rgba(23,105,232,.13)" }),
      image: new CircleStyle({ radius: 4, fill: new Fill({ color: stroke }), stroke: new Stroke({ color: "#fff", width: 1.5 }) }),
    }) });
    map.addLayer(layer);
    return () => { map.removeLayer(layer); };
  }, [map, source, theme]);
  useEffect(() => {
    if (mode === "idle") return;
    const snap = new Snap({ source });
    const interaction = mode === "edit" ? new Modify({ source }) : new Draw({ type: mode === "rectangle" ? "Circle" : "Polygon", ...(mode === "rectangle" ? { geometryFunction: createBox(), freehand: true } : {}) });
    if (interaction instanceof Draw) {
      drawRef.current = interaction;
      interaction.on("drawend", event => {
        source.clear(); source.addFeature(event.feature);
        setName(defaultName()); setEditingId(undefined); setHasDraft(true); setMode("edit"); setNotice(""); setError("");
      });
    }
    map.addInteraction(interaction); map.addInteraction(snap);
    const viewport = map.getViewport(); viewport.style.cursor = mode === "edit" ? "default" : "crosshair";
    return () => { map.removeInteraction(snap); map.removeInteraction(interaction); drawRef.current = null; viewport.style.cursor = ""; };
  }, [map, source, mode]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000); return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (mode === "idle") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "Escape") { drawRef.current?.abortDrawing(); setMode(hasDraft ? "edit" : "idle"); }
      if (mode === "polygon" && (event.key === "Backspace" || event.key === "Delete")) { event.preventDefault(); drawRef.current?.removeLastPoint(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [mode, hasDraft]);

  function store(items: BoundaryBookmark[]) { writeBoundaryBookmarks(localStateStore, conversationId, items); bookmarksRef.current = items; setBookmarks(items); }
  async function perform(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (cause) { if (mounted.current) setError(errorMessage(cause)); } finally { if (mounted.current) setBusy(false); }
  }
  function clearDraft() { drawRef.current?.abortDrawing(); source.clear(); setHasDraft(false); setMode("idle"); setEditingId(undefined); setError(""); }
  function showBoundary(boundary: BoundaryImport, bookmarkId?: string) {
    source.clear(); source.addFeatures(format.readFeatures({ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: boundary.geometry.polygons } }, { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" }));
    setName(boundary.name); setEditingId(bookmarkId); setHasDraft(true); setMode("edit"); setBookmarksOpen(false); setError("");
    map.getView().fit(transformExtent(boundary.bounds, "EPSG:4326", "EPSG:3857"), { padding: [80, 50, 150, 50], maxZoom: 17, duration: 250 });
  }
  async function save(use: boolean) {
    const title = name.trim(); if (!title) throw new Error("请填写范围名称。");
    const geojson = format.writeFeaturesObject(source.getFeatures(), { featureProjection: "EPSG:3857", dataProjection: "EPSG:4326", decimals: 8 });
    const inspected = await api.boundaryInspect(`${title}.geojson`, JSON.stringify(geojson));
    const saved = await api.boundariesSave(conversationId, { ...inspected, name: title });
    store(bookmarkBoundary(bookmarksRef.current, saved, editingId));
    if (use) await selectBoundaryForConversation(conversationId, saved);
    clearDraft(); setNotice(use ? `已将「${saved.name}」用于当前对话` : `已保存「${saved.name}」`);
  }
  async function load(item: BoundaryBookmark): Promise<StoredBoundary> { return { ...await api.boundariesGet(conversationId, item.boundaryId), name: item.name }; }
  async function renameBookmark(item: BoundaryBookmark) {
    const title = rename.trim(); if (!title) throw new Error("请填写书签名称。");
    const original = await load(item);
    const saved = await api.boundariesSave(conversationId, { name: title, geometry: original.geometry, bounds: original.bounds, polygonCount: original.polygonCount });
    store(bookmarkBoundary(bookmarksRef.current, saved, item.id)); setRenamingId(undefined);
  }
  return <>
    <div className="manual-boundary-toolbar" role="toolbar" aria-label={t("地图范围工具")}>
      <Button {...stableButton} aria-label={t("绘制矩形范围")} title={t("绘制矩形范围")} aria-pressed={mode === "rectangle"} disabled={busy} onClick={() => { setMode(mode === "rectangle" ? (hasDraft ? "edit" : "idle") : "rectangle"); setError(""); }}><SquareDashed size={17}/></Button>
      <Button {...stableButton} aria-label={t("绘制多边形范围")} title={t("绘制多边形范围")} aria-pressed={mode === "polygon"} disabled={busy} onClick={() => { setMode(mode === "polygon" ? (hasDraft ? "edit" : "idle") : "polygon"); setError(""); }}><Pentagon size={17}/></Button>
      <Button {...stableButton} aria-label={t("编辑当前范围")} title={t("编辑当前范围")} aria-pressed={mode === "edit"} disabled={busy || (!hasDraft && !planBoundary)} onClick={() => { if (hasDraft) setMode(mode === "edit" ? "idle" : "edit"); else if (planBoundary) showBoundary(planBoundary); }}><Pencil size={16}/></Button>
      <span className="manual-boundary-divider"/>
      <MorphPopover open={bookmarksOpen} onOpenChange={setBookmarksOpen}>
        <MorphPopoverTrigger><Button {...stableButton} aria-label={t("范围书签")} title={t("范围书签")} disabled={busy}><Bookmark size={17}/></Button></MorphPopoverTrigger>
        <MorphPopoverContent side="bottom" align="start" className="manual-bookmark-popover" radius={12}>
          <div className="manual-bookmark-heading"><strong>{t("范围书签")}</strong><span>{bookmarks.length} {t(" 个")}</span></div>
          {!bookmarks.length ? <p className="manual-bookmark-empty">{t("在地图上绘制范围并保存，下次可直接使用。")}</p> : <ScrollArea style={{ height: Math.min(bookmarks.length * 78, 310) }}>
            {bookmarks.map(item => <div className="manual-bookmark-item" key={item.id}>
              {renamingId === item.id ? <form className="manual-bookmark-rename field" onSubmit={event => { event.preventDefault(); void perform(() => renameBookmark(item)); }}>
                <input aria-label={t("书签名称")} value={rename} maxLength={120} disabled={busy} onChange={event => setRename(event.target.value)} autoFocus/>
                <Button {...stableButton} type="submit" aria-label={t("保存书签名称")}><Check size={15}/></Button><Button {...stableButton} aria-label={t("取消重命名")} onClick={() => setRenamingId(undefined)}><X size={15}/></Button>
              </form> : <div className="manual-bookmark-title"><Button variant="ghost" size="sm" whileHover={{ scale: 1 }} pressScale={1} disabled={busy} onClick={() => void perform(async () => { const saved = await load(item); await selectBoundaryForConversation(conversationId, saved); setNotice(`已将「${item.name}」用于当前对话`); setBookmarksOpen(false); })}><span>{item.name}</span></Button><span>{item.polygonCount} {t(" 个面")}</span></div>}
              <div className="manual-bookmark-actions">
                <Button variant="ghost" size="sm" whileHover={{ scale: 1 }} pressScale={1} disabled={busy} onClick={() => { map.getView().fit(transformExtent(item.bounds, "EPSG:4326", "EPSG:3857"), { padding: [70, 50, 70, 50], maxZoom: 17, duration: 250 }); setBookmarksOpen(false); }}><Maximize2 size={13}/>{t("定位")}</Button>
                <Button variant="ghost" size="sm" whileHover={{ scale: 1 }} pressScale={1} disabled={busy} onClick={() => void perform(async () => showBoundary(await load(item), item.id))}><Pencil size={13}/>{t("编辑")}</Button>
                <Button variant="ghost" size="sm" whileHover={{ scale: 1 }} pressScale={1} disabled={busy} onClick={() => { setRenamingId(item.id); setRename(item.name); }}>{t("重命名")}</Button>
                <Button {...stableButton} className="manual-bookmark-remove" aria-label={t("删除书签 {0}", {"0": item.name})} title={t("删除书签")} disabled={busy} onClick={() => { try { store(bookmarks.filter(value => value.id !== item.id)); } catch (cause) { setError(errorMessage(cause)); } }}><Trash2 size={14}/></Button>
              </div>
            </div>)}
          </ScrollArea>}
        </MorphPopoverContent>
      </MorphPopover>
    </div>
    {(mode === "rectangle" || mode === "polygon") && <div className="manual-boundary-hint" role="status"><span>{mode === "rectangle" ? t("拖动鼠标绘制矩形，Esc 取消") : t("点击添加顶点，双击结束，Esc 取消")}</span>{mode === "polygon" && <Button {...stableButton} aria-label={t("撤销上一个顶点")} onClick={() => drawRef.current?.removeLastPoint()}><Undo2 size={15}/></Button>}<Button {...stableButton} aria-label={t("取消绘制")} onClick={() => { drawRef.current?.abortDrawing(); setMode(hasDraft ? "edit" : "idle"); }}><X size={15}/></Button></div>}
    {hasDraft && mode !== "rectangle" && mode !== "polygon" && <section className="manual-boundary-editor" aria-label={t("保存地图范围")} aria-busy={busy}>
      <label className="field"><span className="field-label">{t("范围名称")}</span><input aria-label={t("范围名称")} value={name} maxLength={120} disabled={busy} onChange={event => setName(event.target.value)}/></label>
      <div className="manual-boundary-editor-actions"><span>{mode === "edit" ? t("拖动顶点调整范围") : t("范围已绘制")}</span><Button size="sm" variant="ghost" whileHover={{ scale: 1 }} pressScale={1} disabled={busy} onClick={clearDraft}>{t("取消")}</Button><Button size="sm" variant="outline" whileHover={{ scale: 1 }} pressScale={1} disabled={busy || !name.trim()} onClick={() => void perform(() => save(false))}><BookmarkPlus size={14}/>{t("保存")}</Button><Button size="sm" whileHover={{ scale: 1 }} pressScale={1} disabled={busy || !name.trim()} onClick={() => void perform(() => save(true))}>{busy ? t("保存中…") : t("用于对话")}</Button></div>
    </section>}
    {(error || notice) && <div className={`manual-boundary-message ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}><span>{error || notice}</span><Button {...stableButton} aria-label={t("关闭范围提示")} onClick={() => { setError(""); setNotice(""); }}><X size={15}/></Button></div>}
  </>;
}

import { t } from "./i18n";
// i18n: presentation strings migrated
import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Button } from "@/components/motion/button/base";
import { MapTrifold, NewChat, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "./icons";
import { UiTooltip } from "./ui-tooltip";
import { fitPanelWidths, workspaceArrangement, type WorkspaceMode } from "./workspace-layout";

const storageKey = "geod-agent-panel-widths-v2";
const sidebarKey = "geod-agent-sidebar-collapsed";
const labels = ["导航与对话区宽度", "对话区与地图区宽度", "地图区与任务区宽度"];
type View = "conversation" | "map" | "tasks";
function savedWidths(): Record<string, number[]> {
  try { return Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem(storageKey) ?? "{}"))
    .filter(([, value]) => Array.isArray(value) && value.every(n => typeof n === "number" && Number.isFinite(n) && n > 0))) as Record<string, number[]>; }
  catch { return {}; }
}
export function useResizableWorkspace(mode: WorkspaceMode) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1440);
  const [preferred, setPreferred] = useState(savedWidths);
  const [activeDivider, setActiveDivider] = useState<number | "inspector" | null>(null);
  const dragging = activeDivider !== null;
  const [view, setView] = useState<View>("conversation");
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => { try { return localStorage.getItem(sidebarKey) === "true"; } catch { return false; } });
  const drag = useRef<{ index: number; x: number; widths: number[] } | null>(null);
  const inspectorDrag = useRef<{ x: number; width: number } | null>(null);
  const current = useRef(preferred); current.current = preferred;
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    const resize = () => { if (element.clientWidth > 0) setWidth(element.clientWidth); }; resize();
    const observer = new ResizeObserver(resize); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { density, rail, key, minimums, defaults } = workspaceArrangement(mode, width, sidebarCollapsed);
  const sidebarOverlay = density === "compact" || density === "single";
  const sidebarVisible = sidebarOverlay ? sidebarExpanded : !sidebarCollapsed;
  const saved = preferred[key];
  const widths = fitPanelWidths(saved?.length === defaults.length ? saved : defaults, width, minimums);
  const inspectorMax = Math.max(300, width - widths[0] - widths[1] - 120);
  const inspectorWidth = Math.max(300, Math.min(inspectorMax, preferred.inspector?.[0] ?? 340));
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(current.current)); } catch { /* Session widths remain usable. */ } };
  function move(index: number, delta: number, initial = widths) {
    const amount = Math.max(minimums[index] - initial[index], Math.min(initial[index + 1] - minimums[index + 1], delta));
    const next = initial.map((n, i) => i === index ? n + amount : i === index + 1 ? n - amount : n);
    current.current = { ...current.current, [key]: next }; setPreferred(current.current);
  }
  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    drag.current = null; setActiveDivider(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    save();
  }
  const separators = density === "single" ? [] : widths.slice(0, -1).flatMap((_, index) => {
    if (rail && index === 0) return [];
    return [<div key={`${key}-${index}`} className="workspace-separator" role="separator" tabIndex={0}
      data-dragging={activeDivider === index}
      aria-label={labels[index]} aria-orientation="vertical" aria-valuemin={minimums[index]}
      aria-valuemax={Math.round(widths[index] + widths[index + 1] - minimums[index + 1])}
      aria-valuenow={Math.round(widths[index])} aria-valuetext={`${Math.round(widths[index])} 像素`}
      style={{ left: widths.slice(0, index + 1).reduce((a, b) => a + b, 0) }}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { index, x: event.clientX, widths }; setActiveDivider(index); }}
      onPointerMove={event => { if (drag.current?.index === index) move(index, event.clientX - drag.current.x, drag.current.widths); }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { drag.current = null; setActiveDivider(null); save(); }}
      onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); move(index, (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 12)); save(); }}
      onDoubleClick={() => { current.current = { ...current.current, [key]: defaults }; setPreferred(current.current); save(); }}
    ><span /></div>];
  });
  function resizeInspector(next: number) {
    current.current = { ...current.current, inspector: [Math.max(300, Math.min(inspectorMax, next))] };
    setPreferred(current.current);
  }
  if (density === "overlay" && mode === "tasks") separators.push(<div key="inspector" className="workspace-separator" role="separator" tabIndex={0} data-dragging={activeDivider === "inspector"} aria-label={t("地图区与任务区宽度")} aria-orientation="vertical" aria-valuemin={300} aria-valuemax={Math.round(inspectorMax)} aria-valuenow={Math.round(inspectorWidth)} style={{left:width-inspectorWidth}}
    onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);inspectorDrag.current={x:event.clientX,width:inspectorWidth};setActiveDivider("inspector");}}
    onPointerMove={event=>{if(inspectorDrag.current)resizeInspector(inspectorDrag.current.width-event.clientX+inspectorDrag.current.x);}}
    onPointerUp={event=>{inspectorDrag.current=null;setActiveDivider(null);if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);save();}}
    onPointerCancel={()=>{inspectorDrag.current=null;setActiveDivider(null);save();}} onLostPointerCapture={()=>{inspectorDrag.current=null;setActiveDivider(null);save();}}
    onKeyDown={event=>{if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;event.preventDefault();resizeInspector(inspectorWidth+(event.key==="ArrowLeft"?1:-1)*(event.shiftKey?40:12));save();}}
    onDoubleClick={()=>{resizeInspector(340);save();}}><span/></div>);
  function show(next: View) { setView(next); setSidebarExpanded(false); }
  function toggleSidebar() {
    if (sidebarOverlay) setSidebarExpanded(!sidebarExpanded);
    else { const next = !sidebarCollapsed; setSidebarCollapsed(next); setSidebarExpanded(false); try { localStorage.setItem(sidebarKey, String(next)); } catch { /* Keep the session usable. */ } }
  }
  return { ref, style: { "--workspace-columns": widths.map(n => `${n}px`).join(" "), "--canvas-start": `${widths.slice(0, 2).reduce((a, b) => a + b, 0)}px`, "--inspector-width": `${inspectorWidth}px` } as CSSProperties,
    attributes: { "data-layout": density, "data-view": view, "data-sidebar-rail": rail, "data-sidebar-expanded": sidebarOverlay && sidebarExpanded },
    separators, dragging, density, view, show, sidebarExpanded: sidebarOverlay && sidebarExpanded, setSidebarExpanded, sidebarVisible, toggleSidebar };
}
export function WorkspaceSidebarToggle({ layout }: { layout: ReturnType<typeof useResizableWorkspace> }) {
  const label = layout.sidebarVisible ? "收起会话列表" : "展开会话列表";
  return <UiTooltip content={label} side="bottom"><Button className="workspace-sidebar-toggle" variant="ghost" size="icon" aria-label={label} aria-expanded={layout.sidebarVisible} whileHover={undefined} whileTap={undefined} onClick={layout.toggleSidebar}>{layout.sidebarVisible ? <PanelLeftClose size={18}/> : <PanelLeftOpen size={18}/>}</Button></UiTooltip>;
}
export function WorkspaceControls({ layout, tasksOpen, onTasksChange, focused }: {
  layout: ReturnType<typeof useResizableWorkspace>; tasksOpen: boolean; onTasksChange: (open: boolean) => void; focused: boolean;
}) {
  const active = tasksOpen && (layout.density !== "single" || layout.view === "tasks");
  return <nav className="workspace-view-controls" aria-label={t("工作台视图")}>
    {!focused && <>
      {layout.density === "single" && <><Button size="sm" variant="ghost" aria-label={t("对话")} aria-pressed={layout.view === "conversation"} onClick={() => layout.show("conversation")}><NewChat size={16}/><span>{t("对话")}</span></Button><Button size="sm" variant="ghost" aria-label={t("地图")} aria-pressed={layout.view === "map"} onClick={() => { onTasksChange(false); layout.show("map"); }}><MapTrifold size={16}/><span>{t("地图")}</span></Button></>}
      <Button size="sm" variant="ghost" aria-label={active ? t("收起任务与成果") : t("打开任务与成果")} aria-pressed={active} onClick={() => {
        const open = layout.density === "single" ? layout.view !== "tasks" : !tasksOpen;
        onTasksChange(open); if (layout.density === "single") layout.show(open ? "tasks" : "conversation");
      }}>{active ? <PanelRightClose size={16}/> : <PanelRightOpen size={16}/>}<span>{t("任务与成果")}</span></Button>
    </>}
  </nav>;
}

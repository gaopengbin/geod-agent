import { t } from "./i18n";
// i18n: presentation strings migrated
import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Button } from "@/components/motion/button/base";
import { MapTrifold, NewChat, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "./icons";
import { UiTooltip } from "./ui-tooltip";
import { fitPanelWidths, resizePanelWidths, workspaceArrangement, type WorkspaceMode } from "./workspace-layout";

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
  const [activeDivider, setActiveDivider] = useState<number | null>(null);
  const dragging = activeDivider !== null;
  const [view, setView] = useState<View>("conversation");
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => { try { return localStorage.getItem(sidebarKey) === "true"; } catch { return false; } });
  const drag = useRef<{ index: number; x: number; widths: number[]; key: string; minimums: number[] } | null>(null);
  const current = useRef(preferred);
  const dragFrame = useRef<number | null>(null);
  const pendingMove = useRef<(() => void) | null>(null);
  function flushMove() {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    const apply = pendingMove.current; pendingMove.current = null; apply?.();
  }
  function scheduleMove(apply: () => void) {
    pendingMove.current = apply;
    if (dragFrame.current === null) dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = null;
      const next = pendingMove.current; pendingMove.current = null; next?.();
    });
  }
  useLayoutEffect(() => () => {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    pendingMove.current = null;
  }, []);
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    let frame: number | null = null;
    const resize = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (element.clientWidth > 0) setWidth(element.clientWidth);
      });
    }; resize();
    const observer = new ResizeObserver(resize); observer.observe(element);
    return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, []);
  const { density, rail, key, minimums, defaults } = workspaceArrangement(mode, width, sidebarCollapsed);
  const sidebarOverlay = density === "compact" || density === "single";
  const sidebarVisible = sidebarOverlay ? sidebarExpanded : !sidebarCollapsed;
  const saved = preferred[key];
  const widths = fitPanelWidths(saved?.length === defaults.length ? saved : defaults, width, minimums);
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(current.current)); } catch { /* Session widths remain usable. */ } };
  function paintWidths(next: number[]) {
    const element = ref.current; if (!element) return;
    element.style.setProperty("--workspace-columns", next.map(n => `${n}px`).join(" "));
    element.style.setProperty("--canvas-start", `${next.slice(0, 2).reduce((a, b) => a + b, 0)}px`);
    for (const divider of element.querySelectorAll<HTMLElement>("[data-panel-divider]")) {
      const index = Number(divider.dataset.panelDivider);
      const boundary = next.slice(0, index + 1).reduce((a, b) => a + b, 0);
      divider.style.left = `${boundary}px`;
      divider.setAttribute("aria-valuenow", String(Math.round(boundary)));
      divider.setAttribute("aria-valuetext", `${Math.round(boundary)} 像素`);
    }
  }
  function move(index: number, delta: number, initial = widths) {
    const next = resizePanelWidths(initial, minimums, index, delta);
    current.current = { ...current.current, [key]: next }; setPreferred(current.current);
  }
  function endDrag(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    flushMove();
    drag.current = null; setActiveDivider(null);
    setPreferred(current.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    save();
  }
  const separators = density === "single" ? [] : widths.slice(0, -1).flatMap((_, index) => {
    if (rail && index === 0) return [];
    return [<div key={`${key}-${index}`} className="workspace-separator" role="separator" tabIndex={0}
      data-dragging={activeDivider === index} data-panel-divider={index}
      aria-label={labels[index]} aria-orientation="vertical" aria-valuemin={minimums.slice(0,index+1).reduce((a,b)=>a+b,0)}
      aria-valuemax={Math.round(width-minimums.slice(index+1).reduce((a,b)=>a+b,0))}
      aria-valuenow={Math.round(widths.slice(0,index+1).reduce((a,b)=>a+b,0))} aria-valuetext={`${Math.round(widths.slice(0,index+1).reduce((a,b)=>a+b,0))} 像素`}
      style={{ left: widths.slice(0, index + 1).reduce((a, b) => a + b, 0) }}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); drag.current = { index, x: event.clientX, widths, key, minimums }; setActiveDivider(index); }}
      onPointerMove={event => {
        const active = drag.current; if (active?.index !== index) return;
        const delta = event.clientX - active.x;
        scheduleMove(() => {
          const next = resizePanelWidths(active.widths, active.minimums, index, delta);
          current.current = { ...current.current, [active.key]: next };
          paintWidths(next);
        });
      }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onKeyDown={event => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); move(index, (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 40 : 12)); save(); }}
      onDoubleClick={() => { current.current = { ...current.current, [key]: defaults }; setPreferred(current.current); save(); }}
    ><span /></div>];
  });
  function show(next: View) { setView(next); setSidebarExpanded(false); }
  function toggleSidebar() {
    if (sidebarOverlay) setSidebarExpanded(!sidebarExpanded);
    else { const next = !sidebarCollapsed; setSidebarCollapsed(next); setSidebarExpanded(false); try { localStorage.setItem(sidebarKey, String(next)); } catch { /* Keep the session usable. */ } }
  }
  return { ref, style: { "--workspace-columns": widths.map(n => `${n}px`).join(" "), "--canvas-start": `${widths.slice(0, 2).reduce((a, b) => a + b, 0)}px` } as CSSProperties,
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

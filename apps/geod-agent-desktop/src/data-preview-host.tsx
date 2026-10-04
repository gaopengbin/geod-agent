import { t } from "./i18n";
// i18n: presentation strings migrated
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Box } from "lucide-react";
import { DATA_DOWNLOAD_PREVIEW, type DataPreviewEvent } from "./data-downloads";
import { openLayersCall } from "./openlayers-mcp";
import { errorMessage } from "./api";
import { attachCesiumView } from "./cesium-mcp";
import { Button } from "./components/motion/button/base";

const Tiles3dPreview = lazy(() => import("./tiles3d-preview").then(module => ({ default: module.Tiles3dPreview })));
const release = (token: string) => void invoke("data_asset_unregister", { token }).catch(() => {});

/** Resolves a model load call only after the actual map accepts the data. */
export function DataPreviewHost({ conversationId, onShowMap }: { conversationId: string; onShowMap: () => void }) {
  const [active, setActive] = useState<DataPreviewEvent | null>(null);
  const [mode, setMode] = useState<'2d' | '3d'>('2d');
  const [ready, setReady] = useState(false);
  const [viewRevision, setViewRevision] = useState(0);
  const state = useRef({ active, mode, ready });
  const closing = useRef(false);
  type ViewResult = { success: boolean; data?: { mode: '2d' | '3d'; has3DScene: boolean; ready: boolean; taskId: string | null; title: string | null }; error?: string; message?: string };
  const transitions = useRef<{ mode: '2d' | '3d'; close: boolean; resolve: (result: ViewResult) => void }[]>([]);
  const currentView = (): ViewResult => ({ success: true, data: { mode: state.current.mode, has3DScene: !!state.current.active, ready: state.current.ready, taskId: state.current.active?.taskId ?? null, title: state.current.active?.title ?? null } });
  const shown = useRef(onShowMap);
  shown.current = onShowMap;
  useLayoutEffect(() => {
    state.current = { active, mode, ready };
    if (!active) closing.current = false;
    const committed = transitions.current.filter(request => request.mode === mode && (!request.close || !active));
    transitions.current = transitions.current.filter(request => !committed.includes(request));
    for (const request of committed) request.resolve(currentView());
  }, [active, mode, ready, viewRevision]);
  const switchView = (next: '2d' | '3d', close = false): Promise<ViewResult> => {
    if (next === '3d' && (!state.current.active || closing.current)) return Promise.resolve({ success: false, error: 'NO_3D_SCENE', message: '请先用 data_download_load 打开已完成的三维任务，再切换到三维。' });
    shown.current();
    if (mode === next && (!close || !state.current.active) && !transitions.current.length) return Promise.resolve(currentView());
    for (const request of transitions.current) request.resolve({ success: false, error: 'VIEW_CHANGE_SUPERSEDED' });
    transitions.current = [];
    const committed = new Promise<ViewResult>(resolve => transitions.current.push({ mode: next, close, resolve }));
    if (close) {
      closing.current = true;
      const previous = state.current.active;
      if (previous) { previous.reject(new Error('预览已关闭')); release(previous.preview.token); }
      setActive(null); setReady(false);
    }
    setMode(next);
    setViewRevision(revision => revision + 1);
    return committed;
  };
  const switchRef = useRef(switchView); switchRef.current = switchView;
  useEffect(() => {
    const detach = attachCesiumView(conversationId, async (name, args) => {
      if (name === 'getViewMode') return currentView();
      if (name === 'closeScene') return switchRef.current('2d', true);
      if (name === 'setViewMode' && (args.mode === '2d' || args.mode === '3d')) return switchRef.current(args.mode);
      return { success: false, error: 'INVALID_VIEW_MODE' };
    });
    return () => {
      detach();
      for (const request of transitions.current) request.resolve({ success: false, error: 'SCENE_SESSION_CHANGED' });
      transitions.current = [];
    };
  }, [conversationId]);
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    const pending = new Set<DataPreviewEvent>();
    const receive = (raw: Event) => {
      const event = (raw as CustomEvent<DataPreviewEvent>).detail;
      if (event.conversationId !== conversationId) return;
      shown.current();
      pending.add(event);
      if (event.preview.kind === "tiles3d") {
        closing.current = false;
        setMode('3d'); setReady(false);
        setActive(previous => {
          if (previous) { previous.reject(new Error("已切换预览")); release(previous.preview.token); }
          return event;
        });
        return;
      }
      setMode('2d'); setReady(false);
      setActive(previous => {
        if (previous) { previous.reject(new Error("已切换预览")); release(previous.preview.token); }
        return null;
      });
      void (async () => {
        try {
          const response = await fetch(event.url, { signal: abort.signal });
          if (!response.ok) throw new Error(`无法读取矢量成果 (${response.status})`);
          const data = await response.json();
          if (disposed) throw new Error("会话已切换");
          const id = `download-${event.taskId}`;
          const layers = await openLayersCall(conversationId, "listLayers", {});
          if (Array.isArray(layers) && layers.some(layer => layer.id === id)) {
            const removed = await openLayersCall(conversationId, "removeLayer", { id }) as Record<string, unknown>;
            if (removed?.error) throw new Error(String(removed.message ?? removed.error));
          }
          // addGeoJSON(layerId) appends features to an existing layer. A newly
          // downloaded dataset must create its layer through addVectorLayer.
          const result = await openLayersCall(conversationId, "addVectorLayer", { name: event.title, id, data, format: "geojson", fit: true }) as Record<string, unknown>;
          if (result?.error) throw new Error(String(result.message ?? result.error));
          if (result.featureCount !== event.preview.featureCount) throw new Error("地图中的要素数量与已核验预览不一致");
          event.resolve({ ...result, loaded: true, taskId: event.taskId, featureCount: event.preview.featureCount, previewTruncated: event.preview.truncated });
        } catch (cause) { event.reject(new Error(errorMessage(cause))); }
        finally { pending.delete(event); release(event.preview.token); }
      })();
    };
    window.addEventListener(DATA_DOWNLOAD_PREVIEW, receive);
    return () => {
      disposed = true;
      abort.abort();
      window.removeEventListener(DATA_DOWNLOAD_PREVIEW, receive);
      for (const event of pending) { event.reject(new Error("预览已关闭或会话已切换")); release(event.preview.token); }
    };
  }, [conversationId]);
  if (!active) return null;
  return <>
    {mode === '2d' && <div className="data-preview-view-switch"><Button variant="secondary" size="sm" aria-label={t("切换到三维")} onClick={() => void switchView('3d')}><Box size={15}/>{t("三维")}</Button></div>}
    <div className="data-preview-overlay" hidden={mode !== '3d'} inert={mode !== '3d'}><Suspense fallback={<p className="data-preview-loading" role="status">{t("正在打开三维视图…")}</p>}>
    <Tiles3dPreview conversationId={conversationId} taskId={active.taskId} tilesetUrl={active.url} bounds={active.preview.bounds} title={active.title} visible={mode === '3d'}
      onShow2d={() => void switchView('2d')}
      onClose={() => void switchView('2d', true)}
      onReady={summary => { setReady(true); active.resolve({ ...summary, taskId: active.taskId, kind: "tiles3d", title: active.title }); }}
      onError={message => active.reject(new Error(message))}/>
  </Suspense></div></>;
}

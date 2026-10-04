import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { Focus, LoaderCircle, Map, X } from 'lucide-react';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './tiles3d-preview.css';
import { fitDownloadedTileset } from './tiles3d-camera';
import { attachCesium } from './cesium-mcp';
import { GeoDCesiumScene } from './cesium-scene';
import { Button } from './components/motion/button/base';
import { UiTooltip } from './ui-tooltip';

export interface Tiles3dPreviewProps {
  conversationId?: string;
  taskId?: string;
  /** Host-provided, verified bundle URL. It must serve relative bundle assets. */
  tilesetUrl: string;
  /** The requested offline download area; a global tileset root is not local. */
  bounds?: readonly number[] | null;
  title?: string;
  visible?: boolean;
  onShow2d?: () => void;
  onClose?: () => void;
  onReady?: (summary: { loaded: boolean; radius: number }) => void;
  onError?: (message: string) => void;
}

/** Verified offline model with a conversation-scoped Cesium MCP and native basemap. */
export function Tiles3dPreview({ conversationId = '', taskId = 'preview', tilesetUrl, bounds, title = '三维成果', visible = true, onShow2d, onClose, onReady, onError }: Tiles3dPreviewProps) {
  const container = useRef<HTMLDivElement>(null);
  const viewer = useRef<Cesium.Viewer | null>(null);
  const tileset = useRef<Cesium.Cesium3DTileset | null>(null);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const area = useRef(bounds);
  area.current = bounds;
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let resize: ResizeObserver | undefined;
    let removeFailure: (() => void) | undefined;
    let instance: Cesium.Viewer | undefined;
    let scene: GeoDCesiumScene | undefined;
    let detach: (() => void) | undefined;
    setState('loading');
    setError('');
    const fail = (message: string) => {
      if (disposed) return;
      setError(message);
      setState('error');
      callbacks.current.onError?.(message);
    };
    try {
      instance = new Cesium.Viewer(container.current, {
        animation: false, timeline: false, baseLayerPicker: false,
        geocoder: false, homeButton: false, navigationHelpButton: false,
        sceneModePicker: false, fullscreenButton: false, infoBox: false,
        selectionIndicator: false, baseLayer: false,
        skyBox: false, skyAtmosphere: false, requestRenderMode: true,
      });
      viewer.current = instance;
      instance.scene.backgroundColor = Cesium.Color.fromCssColorString('#15171a');
      instance.scene.globe.enableLighting = false;
      instance.scene.globe.showGroundAtmosphere = false;
      scene = new GeoDCesiumScene(instance, taskId, title, area.current, conversationId);
      detach = attachCesium(conversationId, (name, args) => scene!.execute(name, args));
      void scene.loadSource(null).catch(() => { /* Scene state exposes basemap errors without hiding a verified model. */ });
      instance.scene.screenSpaceCameraController.minimumZoomDistance = 0.01;
      if (instance.scene.sun) instance.scene.sun.show = false;
      if (instance.scene.moon) instance.scene.moon.show = false;
      resize = new ResizeObserver(() => {
        if (!instance?.isDestroyed()) {
          instance?.resize();
          instance?.scene.requestRender();
        }
      });
      resize.observe(container.current);
      void Cesium.Cesium3DTileset.fromUrl(tilesetUrl, { maximumScreenSpaceError: 8 }).then(async (model) => {
        if (disposed || !instance || instance.isDestroyed()) { model.destroy(); return; }
        // Cesium 1.146's dynamic SSE height estimation does not handle S2 in
        // local coordinates. With a root transform it produces NaN and stops
        // child traversal. Keep ordinary SSE; no geometry or volume is changed.
        if (model.hasExtension('3DTILES_bounding_volume_S2')) model.dynamicScreenSpaceError = false;
        instance.scene.primitives.add(model);
        tileset.current = model;
        scene?.registerDownloaded(model);
        removeFailure = model.tileFailed.addEventListener(() => fail('部分三维内容无法读取，请检查成果完整性。'));
        const removeLoaded = model.initialTilesLoaded.addEventListener(() => {
          removeLoaded();
          if (disposed) return;
          setState('ready');
          callbacks.current.onReady?.({ loaded: true, radius: model.boundingSphere.radius });
        });
        fitDownloadedTileset(instance, model, area.current);
      }).catch(() => fail('三维成果加载失败，请检查文件是否完整。'));
    } catch {
      fail('当前设备无法初始化三维视图，请检查图形加速设置。');
    }
    return () => {
      disposed = true;
      resize?.disconnect();
      removeFailure?.();
      detach?.();
      scene?.dispose();
      tileset.current = null;
      viewer.current = null;
      if (instance && !instance.isDestroyed()) instance.destroy();
    };
  }, [tilesetUrl, conversationId, taskId]);

  useEffect(() => {
    const instance = viewer.current;
    if (!instance || instance.isDestroyed()) return;
    // Keep initial loading alive, then pause the hidden viewer's render loop.
    instance.useDefaultRenderLoop = visible || state === 'loading';
    if (visible) { instance.resize(); instance.scene.requestRender(); }
  }, [visible, state]);

  function fit() {
    if (viewer.current && tileset.current) {
      fitDownloadedTileset(viewer.current, tileset.current, area.current);
    }
  }

  return <section className="tiles3d-preview" aria-label={title}>
    <div ref={container} className="tiles3d-preview__canvas" />
    <div className="tiles3d-preview__toolbar">
      <span className="tiles3d-preview__title">{title}</span>
      {onShow2d && <Button variant="secondary" size="sm" className="tiles3d-preview__mode" onClick={onShow2d} aria-label={t("切换到二维")}><Map size={15}/>{t("二维")}</Button>}
      <UiTooltip content={t("定位三维成果")}><Button variant="secondary" size="icon" className="tiles3d-preview__button" aria-label={t("定位三维成果")} onClick={fit} disabled={state !== 'ready'}><Focus size={16} /></Button></UiTooltip>
      {onClose && <UiTooltip content={t("关闭三维预览")}><Button variant="secondary" size="icon" className="tiles3d-preview__button" aria-label={t("关闭三维预览")} onClick={onClose}><X size={16} /></Button></UiTooltip>}
    </div>
    {state === 'loading' && <div className="tiles3d-preview__status" role="status"><LoaderCircle size={18} className="tiles3d-preview__spinner" />{t("正在加载三维成果")}</div>}
    {state === 'error' && <div className="tiles3d-preview__status tiles3d-preview__status--error" role="alert">{localize(error)}</div>}
  </section>;
}

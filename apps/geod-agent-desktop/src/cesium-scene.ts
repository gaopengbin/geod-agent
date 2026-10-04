import * as Cesium from 'cesium';
import { CesiumBridge } from 'cesium-mcp-bridge';
import { api } from './api';
import { nativeImageryProvider } from './cesium-imagery';
import { fitDownloadedTileset } from './tiles3d-camera';
import { cesiumToolResult } from './cesium-tool-result';
import { sceneClock, sceneModels, scenePosition, terrainType } from './cesium-scene-state';
import { ionTerrain, type IonTerrainSession } from './cesium-terrain';

/** Adapt the published bridge to GeoD's actual downloaded model and native sources. */
export class GeoDCesiumScene {
  readonly bridge: CesiumBridge;
  private imagery: { id: string; sourceId: string | null; layer: Cesium.ImageryLayer; stats: ReturnType<typeof nativeImageryProvider>['stats'] }[] = [];
  private model: Cesium.Cesium3DTileset | null = null;
  private disposed = false;
  private terrainErrors = 0;
  private terrainSamples = 0;
  private terrainSession: IonTerrainSession | null = null;
  private terrainRequest = 0;
  private removeTerrainError: (() => void) | undefined;
  private removeTerrainChanged: (() => void) | undefined;
  constructor(readonly viewer: Cesium.Viewer, readonly taskId: string, readonly title: string, readonly bounds?: readonly number[] | null, readonly conversationId = '') {
    // Bridge 1.146.0 validates optional undefined fields before JSON serialization.
    // Validate its wire result below instead; inputs retain the published validation.
    this.bridge = new CesiumBridge(viewer, { validateOutputs: false });
    const observe = () => {
      this.removeTerrainError?.(); this.terrainErrors = 0; this.terrainSamples = 0;
      this.removeTerrainError = viewer.terrainProvider.errorEvent.addEventListener(() => { this.terrainErrors++; });
    };
    observe(); this.removeTerrainChanged = viewer.scene.terrainProviderChanged.addEventListener(observe);
  }
  registerDownloaded(model: Cesium.Cesium3DTileset) {
    this.model = model;
    const id = `download-${this.taskId}`;
    this.bridge.layerManager.setCesiumRefs(id, { tileset: model });
    this.bridge.layerManager.layers.push({ id, name: this.title, type: '3D Tiles', visible: true, color: '#8B5CF6' });
  }
  async loadSource(sourceId: string | null, replace = true, opacity = 1, url: string | null = null) {
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('透明度应为 0–1');
    const source = sourceId ? await api.sourcesGet(sourceId) : null;
    if (sourceId && !source) throw new Error('图源不存在，请使用 sources_list 返回的 sourceId');
    if (this.disposed || this.viewer.isDestroyed()) throw new Error('SCENE_SESSION_CHANGED');
    if (replace) {
      for (const item of this.imagery) this.bridge.removeLayer(item.id);
      this.viewer.imageryLayers.removeAll();
      this.imagery = [];
    }
    const name = source?.descriptor.displayName ?? (url ? '自定义底图' : 'OpenStreetMap');
    const { provider, stats } = nativeImageryProvider(sourceId, source?.descriptor.attribution ?? '© OpenStreetMap contributors', source?.descriptor.maxZoom ?? 19, url);
    const layer = this.viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = opacity;
    const id = `imagery-${crypto.randomUUID()}`;
    this.bridge.layerManager.setCesiumRefs(id, { imageryLayer: layer });
    this.bridge.layerManager.layers.push({ id, name, type: 'imagery', visible: true, color: '#3B82F6' });
    this.imagery.push({ id, sourceId, layer, stats });
    this.viewer.scene.requestRender();
    return { success: true, data: { layerId: id, sourceId, name, state: 'loading' }, message: '底图已加入三维地球，瓦片异步加载；用 getSceneState 查看实际状态。' };
  }
  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.disposed || this.viewer.isDestroyed()) return { success: false, error: 'SCENE_SESSION_CHANGED' };
    if (name === 'getSceneState') return { success: true, data: {
      opened: true, scene: 'Cesium', taskId: this.taskId, title: this.title, bounds: this.bounds,
      camera: this.bridge.getView(), globe: !!this.viewer.scene.globe?.show, rendering: this.viewer.useDefaultRenderLoop,
      terrain: { provider: this.terrainSession ? 'cesiumIon' : terrainType(this.viewer.terrainProvider), tilesLoaded: this.viewer.scene.globe.tilesLoaded, errors: this.terrainErrors, sampledPositions: this.terrainSamples, ...(this.terrainSession ? { connection: await ionTerrain.status(this.terrainSession.sessionId).catch(() => ({ unavailable: true })) } : {}) },
      clock: sceneClock(this.viewer), models: sceneModels(this.viewer),
      downloaded: this.model && !this.model.isDestroyed() ? { tilesLoaded: this.model.tilesLoaded, show: this.model.show,
        radius: this.model.boundingSphere.radius, center: { x: this.model.boundingSphere.center.x, y: this.model.boundingSphere.center.y, z: this.model.boundingSphere.center.z } } : null,
      animations: this.bridge.listAnimations().map(animation => ({ ...animation, position: scenePosition(this.viewer.entities.getById(animation.entityId), this.viewer.clock.currentTime) })),
      layers: this.bridge.listLayers(),
      imagery: this.imagery.filter(item => this.viewer.imageryLayers.contains(item.layer)).map(item => ({
        id: item.id, sourceId: item.sourceId, visible: item.layer.show, opacity: item.layer.alpha,
        ...item.stats, state: item.stats.loaded > 0 ? 'ready' : item.stats.failed > 0 && item.stats.pending === 0 ? 'error' : 'loading',
      })),
    } };
    if (name === 'sampleTerrain') {
      const level = args.level ?? 12, positions = args.positions;
      if (!Number.isInteger(level) || Number(level) < 0 || Number(level) > 18 || !Array.isArray(positions) || positions.length < 1 || positions.length > 100
        || positions.some(p => !p || typeof p !== 'object' || !Number.isFinite(p.longitude) || !Number.isFinite(p.latitude) || p.longitude < -180 || p.longitude > 180 || p.latitude < -90 || p.latitude > 90)) {
        return { success: false, error: 'INVALID_TERRAIN_SAMPLES', message: '提供 1–100 个有效经纬度点，level 为 0–18 整数。' };
      }
      const provider = this.viewer.terrainProvider;
      const sampled = await Cesium.sampleTerrain(provider, Number(level), positions.map(p => Cesium.Cartographic.fromDegrees(p.longitude, p.latitude)), true);
      if (this.disposed || this.viewer.isDestroyed() || this.viewer.terrainProvider !== provider) return { success: false, error: 'SCENE_SESSION_CHANGED' };
      if (sampled.some(p => !Number.isFinite(p.height))) return { success: false, error: 'TERRAIN_HEIGHT_UNAVAILABLE' };
      this.terrainSamples += sampled.length;
      return { success: true, data: { provider: terrainType(provider), level, positions: sampled.map(p => ({ longitude: Cesium.Math.toDegrees(p.longitude), latitude: Cesium.Math.toDegrees(p.latitude), height: p.height })) } };
    }
    if (name === 'fitScene') {
      if (!this.model || this.model.isDestroyed()) return { success: false, error: 'NO_DOWNLOADED_MODEL' };
      fitDownloadedTileset(this.viewer, this.model, this.bounds);
      return { success: true, data: { camera: this.bridge.getView(), bounds: this.bounds } };
    }
    if (name === 'loadTerrain' && args.provider === 'cesiumion') {
      if (args.url) return { success: false, error: 'ION_TERRAIN_URL_NOT_USED', message: 'Ion 地形通过已保存的连接和 Asset ID 加载。自定义公开地形使用对应服务类型。' };
      const request = ++this.terrainRequest;
      const session = await ionTerrain.open(this.conversationId, typeof args.connectionId === 'string' ? args.connectionId : undefined, typeof args.cesiumIonAssetId === 'number' ? args.cesiumIonAssetId : 1);
      try {
        const provider = await Cesium.CesiumTerrainProvider.fromUrl(ionTerrain.url(session), { requestVertexNormals: true, requestWaterMask: true });
        if (this.disposed || this.viewer.isDestroyed() || request !== this.terrainRequest) { await ionTerrain.close(session.sessionId); return { success: false, error: 'SCENE_SESSION_CHANGED' }; }
        const previous = this.terrainSession;
        this.viewer.terrainProvider = provider; this.terrainSession = session;
        if (previous) await ionTerrain.close(previous.sessionId);
        this.viewer.scene.requestRender();
        return { success: true, data: { provider: 'cesiumIon', connectionId: session.connectionId, assetId: session.assetId, ready: true }, message: '已读取实际地形元数据并切换地形；用 sampleTerrain 读取真实高程，getSceneState 查看瓦片状态。' };
      } catch (error) { await ionTerrain.close(session.sessionId).catch(() => {}); throw error; }
    }
    if (name === 'loadTerrain') ++this.terrainRequest;
    if (name === 'loadSource') {
      if (typeof args.sourceId !== 'string' || !args.sourceId) return { success: false, error: 'SOURCE_ID_REQUIRED' };
      return this.loadSource(args.sourceId, args.replace !== false, typeof args.opacity === 'number' ? args.opacity : 1);
    }
    if (name === 'setBasemap') {
      const type = typeof args.basemap === 'string' ? args.basemap : 'osm';
      if (typeof args.url === 'string') return this.loadSource(null, true, 1, args.url);
      if (type === 'osm' || type === 'standard') return this.loadSource(null);
      const ids: Record<string, string[]> = {
        satellite: ['esri-world-imagery'], tianditu_img: ['tianditu-img-w'], tianditu_vec: ['tianditu-vec-w'],
        amap: ['amap-road', 'amap-vector'], amap_satellite: ['amap-satellite'],
      };
      const sources = await api.sourcesList();
      const source = sources.find(item => ids[type]?.includes(item.id));
      if (source) return this.loadSource(source.id);
      if (type.startsWith('tianditu')) return { success: false, error: 'SOURCE_NOT_CONFIGURED', message: '请配置天地图图源；已有图源使用 loadSource(sourceId)，无需在对话提供密钥。' };
    }
    const result = await this.bridge.execute({ action: name, params: args });
    if (!this.disposed && !this.viewer.isDestroyed()) this.viewer.scene.requestRender();
    const validated = cesiumToolResult(name, result);
    if (name === 'loadTerrain' && validated && typeof validated === 'object' && 'success' in validated && validated.success && this.terrainSession) { const previous = this.terrainSession; this.terrainSession = null; await ionTerrain.close(previous.sessionId); }
    if (validated && typeof validated === 'object' && 'success' in validated && validated.success && (name === 'addModel' || name === 'createAnimation')) {
      return { ...validated, message: '对象已创建；模型资源异步加载，用 getSceneState 核对实际 loaded 状态和动画位置。' };
    }
    return validated;
  }
  dispose() { this.disposed = true; ++this.terrainRequest; if (this.terrainSession) void ionTerrain.close(this.terrainSession.sessionId).catch(() => {}); this.removeTerrainChanged?.(); this.removeTerrainError?.(); this.bridge.dispose(); }
}

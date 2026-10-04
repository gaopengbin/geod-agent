import { t, localize } from "./i18n";
// i18n: presentation strings migrated
import { localStateStore } from "./local-state";
import { useEffect, useRef, useState } from "react";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import ImageLayer from "ol/layer/Image";
import WebGLTileLayer from "ol/layer/WebGLTile";
import XYZ from "ol/source/XYZ";
import VectorSource from "ol/source/Vector";
import ImageStatic from "ol/source/ImageStatic";
import { artifactRasterSource } from "./artifact-raster-source";
import GeoJSON from "ol/format/GeoJSON";
import ImageTile from "ol/ImageTile";
import { fromLonLat, transformExtent } from "ol/proj";
import { Fill, Stroke, Style } from "ol/style";
import { OpenLayersBridge } from "openlayers-mcp-bridge";
import { toolDefinitions } from "openlayers-mcp-protocol";
import DOMPurify from "dompurify";
import { api, desktopAvailable, type ArtifactPreview, type BoundaryGeometry, type Bounds, type PlanTileGrid, type RegisteredSource } from "./api";
import { attachOpenLayers } from "./openlayers-mcp";
import { readMapSession, saveMapSession, type MapCommand } from "./map-session";
import { taskGridLines, taskTileCoverage } from "./task-grid";
import { Button } from "@/components/motion/button/base";
import { X } from "./icons";
import { ManualBoundaries } from "./manual-boundaries";
const vectorStyle = (theme: "light" | "dark", fill = true) => new Style({ stroke: new Stroke({ color: theme === "dark" ? "#78aaff" : "#1769e8", width: 2 }), fill: fill ? new Fill({ color: "rgba(23,105,232,0.12)" }) : undefined });
function nativeImage(encoded: string) { return `data:image/${encoded.startsWith("/9j/") ? "jpeg" : "png"};base64,${encoded}`; }
let runningTiles = 0;
const tileWaiters: (() => void)[] = [];
async function queuedTile(load: () => Promise<string>) {
  if (runningTiles >= 6) await new Promise<void>(resolve => tileWaiters.push(resolve));
  runningTiles++;
  try { return await load(); } finally { runningTiles--; tileWaiters.shift()?.(); }
}

function tileSource(raw: string, sourceId: string | null = null, registered?: RegisteredSource) {
  const source = new XYZ({ url: raw, crossOrigin: "anonymous", tileSize: registered?.endpoint.tileSize ?? 256,
    minZoom: registered?.descriptor.minZoom ?? 0, maxZoom: registered?.descriptor.maxZoom ?? (sourceId === "__osm__" ? 15 : 22), transition: 250,
  });
  if (desktopAvailable) source.setTileLoadFunction((tile, url) => {
    const [z, x, y] = tile.getTileCoord();
    const request = () => sourceId === "__osm__" ? api.osmBasemapTile(z,x,y) : api.mapPreviewTile(sourceId, sourceId ? null : url,z,x,y);
    void queuedTile(request).then(encoded => { ((tile as ImageTile).getImage() as HTMLImageElement).src = nativeImage(encoded); })
      .catch(() => tile.setState(3));
  });
  return source;
}

export function MapView({ conversationId, bounds, boundary, tileGrids, completedTiles, preview, theme }: {
  conversationId: string; bounds: Bounds | null; boundary: BoundaryGeometry | null; tileGrids: PlanTileGrid[];
  completedTiles: number | null; preview: ArtifactPreview | null; missingTiles: number; theme: "light" | "dark";
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [capture, setCapture] = useState("");

  useEffect(() => {
    if (!container.current || !conversationId) return;
    let disposed = false;
    const saved = readMapSession(localStateStore, conversationId);
    const base = new TileLayer({ source: tileSource("https://tile.openstreetmap.org/{z}/{x}/{y}.png", "__osm__"), properties: { id: "osm", name: "OpenStreetMap", geodStatus: "ready" } });
    const map = new Map({ target: container.current, controls: [], layers: [base], view: new View({ center: fromLonLat([108,35]), zoom: 3, maxZoom: 22 }) });
    mapRef.current = map;
    const bridge = new OpenLayersBridge(map);
    const commands: MapCommand[] = [];
    let restoring = true;
    const persist = () => { if (!restoring && !disposed) saveMapSession(localStateStore,conversationId,{ commands, view: bridge.getView() }); };
    const watch = (layer: TileLayer<XYZ>) => {
      const source = layer.getSource()!;
      let succeeded = false;
      source.on("tileloadstart",() => { if (!succeeded) layer.set("geodStatus","loading"); });
      source.on("tileloadend",() => { succeeded = true; layer.set("geodStatus","ready"); });
      source.on("tileloaderror",() => { if (!succeeded) layer.set("geodStatus","error"); });
    };
    async function loadRegistered(sourceId: string, opacity = 1) {
      const stored = await api.sourcesGet(sourceId);
      if (!stored) throw new Error("图源不存在，请先配置图源");
      if (disposed) throw new Error("对话地图已切换");
      const id = `source-${sourceId}`;
      let layer = map.getLayers().getArray().find(item => item.get("id") === id) as TileLayer<XYZ> | undefined;
      if (layer && layer.get("configRevision") !== stored.descriptor.configRevision) { map.removeLayer(layer); layer = undefined; }
      if (!layer) {
        // A native loader resolves XYZ/TMS or ImageServer from the saved record.
        // The browser's URL is just a cache key when an ImageServer is used.
        const raw = stored.endpoint.urlTemplate.endsWith("/exportImage") ? `https://geod.invalid/${sourceId}/{z}/{x}/{y}` : stored.endpoint.urlTemplate;
        layer = new TileLayer({ source: tileSource(raw,sourceId,stored), opacity, properties: { id, name: stored.descriptor.displayName, sourceId, configRevision: stored.descriptor.configRevision, geodStatus: "loading", attribution: stored.endpoint.attribution } });
        watch(layer); map.addLayer(layer);
      } else { layer.setVisible(true); layer.setOpacity(opacity); }
      const zoom = map.getView().getZoom() ?? 3;
      if (zoom < stored.descriptor.minZoom) map.getView().setZoom(stored.descriptor.minZoom);
      if (zoom > stored.descriptor.maxZoom) map.getView().setZoom(stored.descriptor.maxZoom);
      if (!restoring && layer.get("geodStatus") === "loading") {
        await new Promise<void>(resolve => {
          const source = layer!.getSource()!;
          const finish = () => { clearTimeout(timer); source.un("tileloadend",finish); source.un("tileloaderror",finish); resolve(); };
          const timer = setTimeout(finish,8000);
          source.once("tileloadend",finish); source.once("tileloaderror",finish);
        });
      }
      return { layerId: id, sourceId, name: stored.descriptor.displayName, visible: true, state: layer.get("geodStatus"), minZoom: stored.descriptor.minZoom, maxZoom: stored.descriptor.maxZoom };
    }
    async function execute(name: string, input: Record<string, unknown>, replay = false): Promise<unknown> {
      if (disposed) throw new Error("当前地图会话已关闭");
      let args = { ...input };
      let result: unknown;
      if (name === "getCapabilities") result = { ...bridge.getCapabilities(), commands: [...bridge.getCapabilities().commands,"loadSource","loadArtifact"], nativeArtifacts: "loadArtifact(jobId): verified local GeoTIFF" };
      else if (name === "loadSource") result = await loadRegistered(String(args.sourceId),typeof args.opacity === "number" ? args.opacity : 1);
      else if (name === "loadArtifact") {
        const raster = await api.artifactRaster(String(args.jobId), typeof args.assetId === "string" ? args.assetId : undefined);
        if (disposed) throw new Error("对话地图已切换");
        const id = `artifact-${raster.jobId}-${raster.assetId}`;
        let layer = map.getLayers().getArray().find(item => item.get("id") === id);
        if (layer && layer.get("sha256") !== raster.sha256) { map.removeLayer(layer); layer = undefined; }
        if (!layer) {
          const source = artifactRasterSource(raster.resourceId, !!raster.elevationEncoding);
          layer = new WebGLTileLayer({ source, zIndex:750, opacity: typeof args.opacity === "number" ? args.opacity : 1, properties: {
            id, name: typeof args.name === "string" ? args.name : raster.name,
            jobId:raster.jobId, assetId:raster.assetId, sha256:raster.sha256, geodStatus:"loading", kind:"downloaded-geotiff",
            mcpExtent:transformExtent(raster.bounds,"EPSG:4326","EPSG:3857"), sourceType:"geotiff",
          } });
          const target = layer;
          const loading = new Set<string>(), failed = new Set<string>();
          const status = () => { if (!disposed) target.set("geodStatus",failed.size ? "error" : loading.size ? "loading" : "ready"); };
          source.on("tileloadstart", event => { loading.add(event.tile.getKey()); status(); });
          source.on("tileloadend", event => { const key=event.tile.getKey(); loading.delete(key); failed.delete(key); status(); });
          source.on("tileloaderror", event => { const key=event.tile.getKey(); loading.delete(key); failed.add(key); status(); });
          map.addLayer(layer);
          try { await source.getView(); }
          catch (cause) { layer.set("geodStatus", "error"); map.removeLayer(layer); throw cause; }
          if (source.getState() === "error") { map.removeLayer(layer); throw new Error("GeoTIFF 读取失败"); }
        } else { layer.setVisible(true); layer.setOpacity(typeof args.opacity === "number" ? args.opacity : 1); }
        if (disposed) throw new Error("对话地图已切换");
        if (args.fit !== false) map.getView().fit(transformExtent(raster.bounds,"EPSG:4326","EPSG:3857"), { padding:[40,40,40,40], duration: replay ? 0 : 400 });
        if (!replay && layer.get("geodStatus") === "loading") {
          const target = layer;
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); target.un("propertychange", changed); resolve(); };
            const changed = () => { if (target.get("geodStatus") !== "loading") finish(); };
            const timer = setTimeout(finish,8000);
            target.on("propertychange", changed);
          });
        }
        result = { layerId:id, jobId:raster.jobId, assetId:raster.assetId, name:layer.get("name"), state:layer.get("geodStatus"), visible:layer.getVisible(), kind:"downloaded-geotiff", bounds:raster.bounds, crs:raster.crs, width:raster.width, height:raster.height };
      }
      else if (name === "addTileLayer" && ["osm","xyz"].includes(String(args.type))) {
        const id = typeof args.id === "string" ? args.id : crypto.randomUUID(); args.id = id;
        const old = map.getLayers().getArray().find(layer => layer.get("id") === id);
        if (old) return { layerId: id, reused: true };
        const raw = args.type === "osm" ? "https://tile.openstreetmap.org/{z}/{x}/{y}.png" : String(args.url ?? "");
        if (args.type !== "osm" && !(raw.includes("{z}") && raw.includes("{x}") && raw.includes("{y}"))) throw new Error("XYZ 图层需要实际的 {z}/{x}/{y} 地址；已配置图源请用 loadSource");
        const layer = new TileLayer({ source: tileSource(raw,args.type === "osm" ? "__osm__" : null), visible: args.visible !== false, opacity: typeof args.opacity === "number" ? args.opacity : 1, properties: { id,name:args.name || id,geodStatus:"loading" } });
        watch(layer); map.addLayer(layer); result = { layerId:id,state:"loading" };
      } else if (name === "screenshot") {
        const capture = await bridge.screenshot();
        setCapture(capture.dataUrl);
        return { captured:true,width:capture.width,height:capture.height,previewShown:true };
      } else {
        if (["addOverlay","updateOverlay"].includes(name) && typeof args.html === "string") args.html = DOMPurify.sanitize(args.html,{ ALLOWED_TAGS:["div","span","p","b","strong","i","em","br"],ALLOWED_ATTR:[] });
        if (["addVectorLayer","addVectorTileLayer","addGeoTIFFLayer","addImageLayer","addTileLayer","addFeature","addOverlay"].includes(name) && !args.id) args.id = crypto.randomUUID();
        const value = await bridge.execute({action:name,params:args});
        if (!value.success) throw new Error(value.error || "地图操作失败");
        result = value.data;
        if (name === "getLayer" && result && typeof result === "object") {
          const layer = map.getAllLayers().find(layer => layer.get("id") === args.id);
          result = { ...result, state:layer?.get("geodStatus") ?? (result as {state?:string}).state };
        }
        if (name === "listLayers" && Array.isArray(result)) result = result.map(item => {
          const layer = map.getLayers().getArray().find(layer => layer.get("id") === item.id);
          return { ...item, ...(layer?.get("kind") === "downloaded-geotiff" ? { type:"raster" } : {}), state:layer?.get("geodStatus") ?? item.state ?? "ready",sourceId:layer?.get("sourceId") ?? null, jobId:layer?.get("jobId") ?? null, kind:layer?.get("kind") ?? null };
        });
        if (name === "listFeatures" && Array.isArray(result)) result = result.map(item => ({ ...item, properties:Object.fromEntries(Object.entries(item.properties ?? {}).filter(([key]) => key !== "geometry")) }));
        if (name === "getFeatureAtPixel" && result && typeof result === "object" && "properties" in result) result = { ...result,properties:Object.fromEntries(Object.entries((result as {properties:Record<string,unknown>}).properties).filter(([key]) => key !== "geometry")) };
      }
      const definition = toolDefinitions[name as keyof typeof toolDefinitions];
      if (!replay && !definition?.readOnly && !["flyTo","setView","fitExtent","fitLayer","zoomIn","zoomOut"].includes(name)) { commands.push({name,args}); persist(); }
      return result;
    }
    let detach: (() => void) | undefined;
    void (async () => {
      for (const command of saved.commands) {
        try { await execute(command.name,command.args,true); commands.push(command); }
        catch (cause) { if (!disposed) setError(`恢复图层失败：${cause instanceof Error ? cause.message : String(cause)}`); }
      }
      if (disposed) return;
      if (saved.view?.center?.every(Number.isFinite) && Number.isFinite(saved.view.zoom)) bridge.setView({longitude:saved.view.center[0],latitude:saved.view.center[1],zoom:saved.view.zoom,rotation:saved.view.rotation});
      restoring = false; detach = attachOpenLayers(conversationId,execute); setReady(true);
    })();
    map.on("moveend",persist);
    const resize = new ResizeObserver(() => map.updateSize()); resize.observe(container.current);
    return () => { persist(); disposed = true; detach?.(); resize.disconnect(); bridge.dispose(); map.setTarget(undefined); map.dispose(); mapRef.current = null; };
  }, [conversationId]);

  useEffect(() => {
    const map = mapRef.current; if (!map || !ready) return;
    for (const layer of [...map.getLayers().getArray()]) if (layer.get("geodSystem")) map.removeLayer(layer);
    const addVector = (id: string, data: object, style: Style) => map.addLayer(new VectorLayer({ source:new VectorSource({features:new GeoJSON().readFeatures(data,{featureProjection:"EPSG:3857"})}),style,zIndex:900,properties:{id,geodSystem:true} }));
    if (preview) {
      const image = new ImageStatic({url:preview.dataUrl,imageExtent:transformExtent(preview.bounds,"EPSG:4326","EPSG:3857")});
      map.addLayer(new ImageLayer({source:image,zIndex:700,properties:{id:"verified-imagery",geodSystem:true}}));
    } else {
      if (tileGrids.length) {
        addVector("task-grid",taskGridLines(tileGrids),new Style({stroke:new Stroke({color:theme === "dark" ? "#78aaff" : "#1769e8",width:1.7,lineDash:[3,3]})}));
        addVector("task-coverage",taskTileCoverage(tileGrids,completedTiles ?? 0),new Style({fill:new Fill({color:"rgba(36,119,79,0.28)"})}));
      }
    }
    if (boundary) addVector("plan-boundary",{type:"Feature",properties:{},geometry:{type:"MultiPolygon",coordinates:boundary.polygons}},vectorStyle(theme));
    else if (bounds) addVector("plan-extent",{type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:[[[bounds[0],bounds[1]],[bounds[2],bounds[1]],[bounds[2],bounds[3]],[bounds[0],bounds[3]],[bounds[0],bounds[1]]]]}},vectorStyle(theme));
  }, [ready,boundary,tileGrids,completedTiles,preview,theme,bounds]);
  useEffect(() => { if (ready && bounds) mapRef.current?.getView().fit(transformExtent(bounds,"EPSG:4326","EPSG:3857"),{padding:[70,70,70,70],maxZoom:15,duration:500}); }, [bounds,ready]);

  return <div className={ready ? "map-shell" : "map-shell map-fallback"}>
    <div ref={container} className="map-canvas" aria-label={t("当前对话地图")} />
    {ready && mapRef.current && <ManualBoundaries key={conversationId} map={mapRef.current} conversationId={conversationId} theme={theme} planBoundary={boundary && bounds ? { name: "当前任务范围", bounds, geometry: boundary, polygonCount: boundary.polygons.length } : null}/>} 
    {error && <div className="map-tool-error" role="alert">{localize(error)}<Button size="icon" variant="ghost" onClick={() => setError("")} aria-label={t("关闭地图错误")}><X size={16}/></Button></div>}
    {capture && <div className="map-capture-preview"><div><strong>{t("地图截图")}</strong><Button size="icon" variant="ghost" aria-label={t("关闭地图截图")} onClick={() => setCapture("")}><X size={16}/></Button></div><img src={capture} alt={t("当前地图截图")}/></div>}
  </div>;
}

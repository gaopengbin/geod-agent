import { t } from "./i18n";
// i18n: presentation strings migrated
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Map } from "maplibre-gl";
import { api, desktopAvailable, type ArtifactPreview, type BoundaryGeometry, type Bounds, type PlanTileGrid } from "./api";
import { taskGridLines, taskTileCoverage } from "./task-grid";
import { Button } from "@/components/motion/button/base";
import { UiTooltip } from "./ui-tooltip";
import { Minus, Plus } from "./icons";

maplibregl.setWorkerUrl(maplibreWorkerUrl);

if (desktopAvailable) {
  maplibregl.addProtocol("geod-osm", async ({ url }) => {
    const match = /^geod-osm:\/\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url);
    if (!match) throw new Error("Invalid OpenStreetMap tile URL");
    const encoded = await api.osmBasemapTile(Number(match[1]), Number(match[2]), Number(match[3]));
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return { data: bytes.buffer };
  });
}

function emptyStyle(theme: "light" | "dark") {
  return {
    version: 8 as const,
    sources: {
      osm: {
        type: "raster" as const,
        tiles: [desktopAvailable ? "geod-osm://{z}/{x}/{y}.png" : "https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 15,
      },
    },
    layers: [
      { id: "background", type: "background" as const, paint: { "background-color": theme === "dark" ? "#0e0f11" : "#edf4fa" } },
      { id: "osm", type: "raster" as const, source: "osm", paint: { "raster-brightness-max": theme === "dark" ? 0.42 : 1, "raster-saturation": theme === "dark" ? -0.68 : 0 } },
    ],
  };
}

interface Overlay {
  width: number;
  height: number;
  meridians: number[];
  parallels: number[];
  selection: { x: number; y: number; width: number; height: number } | null;
}
const blankOverlay: Overlay = { width: 0, height: 0, meridians: [], parallels: [], selection: null };
const steps = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 45];

function projectOverlay(map: Map, bounds: Bounds | null): Overlay {
  const width = map.getContainer().clientWidth;
  const height = map.getContainer().clientHeight;
  const visible = map.getBounds();
  const west = visible.getWest();
  const east = visible.getEast();
  const south = Math.max(-85, visible.getSouth());
  const north = Math.min(85, visible.getNorth());
  const target = Math.max((east - west) / 8, (north - south) / 8);
  const step = steps.find(value => value >= target) ?? 45;
  const meridians: number[] = [];
  const parallels: number[] = [];
  for (let longitude = Math.ceil(west / step) * step; longitude <= east && meridians.length < 30; longitude += step) {
    const x = map.project([longitude, 0]).x;
    if (x >= 0 && x <= width) meridians.push(x);
  }
  for (let latitude = Math.ceil(south / step) * step; latitude <= north && parallels.length < 30; latitude += step) {
    const y = map.project([map.getCenter().lng, latitude]).y;
    if (y >= 0 && y <= height) parallels.push(y);
  }
  let selection: Overlay["selection"] = null;
  if (bounds) {
    const upperLeft = map.project([bounds[0], bounds[3]]);
    const lowerRight = map.project([bounds[2], bounds[1]]);
    selection = { x: Math.min(upperLeft.x, lowerRight.x), y: Math.min(upperLeft.y, lowerRight.y), width: Math.abs(lowerRight.x - upperLeft.x), height: Math.abs(lowerRight.y - upperLeft.y) };
  }
  return { width, height, meridians, parallels, selection };
}

export function MapView({ bounds, boundary, tileGrids, completedTiles, preview, missingTiles, theme }: { bounds: Bounds | null; boundary: BoundaryGeometry | null; tileGrids: PlanTileGrid[]; completedTiles: number | null; preview: ArtifactPreview | null; missingTiles: number; theme: "light" | "dark" }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const boundsRef = useRef(bounds);
  const [ready, setReady] = useState(false);
  const [imageryState, setImageryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [overlay, setOverlay] = useState<Overlay>(blankOverlay);
  boundsRef.current = bounds;

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({ container: container.current, style: emptyStyle(theme), center: [108, 35], zoom: 3, attributionControl: false, maxPitch: 0 });
    mapRef.current = map;
    const update = () => setOverlay(projectOverlay(map, boundsRef.current));
    map.on("move", update);
    map.on("resize", update);
    map.on("load", () => {
      setReady(true);
      if (boundsRef.current) map.fitBounds([[boundsRef.current[0], boundsRef.current[1]], [boundsRef.current[2], boundsRef.current[3]]], { padding: 70, maxZoom: 15, duration: 0 });
      update();
    });
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("background")) map.setPaintProperty("background", "background-color", theme === "dark" ? "#0e0f11" : "#edf4fa");
    if (map?.getLayer("osm")) {
      map.setPaintProperty("osm", "raster-brightness-max", theme === "dark" ? 0.42 : 1);
      map.setPaintProperty("osm", "raster-saturation", theme === "dark" ? -0.68 : 0);
    }
  }, [theme, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    setOverlay(projectOverlay(map, bounds));
    if (bounds) map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 70, maxZoom: 15, duration: 500 });
  }, [bounds, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (map.getLayer("verified-imagery")) map.removeLayer("verified-imagery");
    if (map.getSource("verified-imagery")) map.removeSource("verified-imagery");
    if (!preview) { setImageryState("idle"); return; }
    setImageryState("loading");
    const [west, south, east, north] = preview.bounds;
    map.addSource("verified-imagery", {
      type: "image",
      coordinates: [[west, north], [east, north], [east, south], [west, south]],
    });
    map.addLayer({
      id: "verified-imagery",
      type: "raster",
      source: "verified-imagery",
      paint: { "raster-opacity": 1, "raster-resampling": "linear", "raster-fade-duration": 0 },
    });
    if (map.getLayer("plan-boundary-fill")) map.moveLayer("plan-boundary-fill");
    if (map.getLayer("plan-boundary-outline")) map.moveLayer("plan-boundary-outline");
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      (map.getSource("verified-imagery") as maplibregl.ImageSource).updateImage({ image });
      setImageryState("ready");
    };
    image.onerror = () => { if (!cancelled) setImageryState("error"); };
    image.src = preview.dataUrl;
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [preview, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const layer of ["task-grid-lines", "task-coverage-fill"]) if (map.getLayer(layer)) map.removeLayer(layer);
    for (const source of ["task-grid", "task-coverage"]) if (map.getSource(source)) map.removeSource(source);
    if (!tileGrids.length || preview) return;
    map.addSource("task-grid", { type: "geojson", data: taskGridLines(tileGrids) });
    map.addSource("task-coverage", { type: "geojson", data: taskTileCoverage(tileGrids, completedTiles ?? 0) });
    map.addLayer({ id: "task-coverage-fill", type: "fill", source: "task-coverage", paint: { "fill-color": theme === "dark" ? "#8fdbaf" : "#24774f", "fill-opacity": 0.28 } });
    map.addLayer({ id: "task-grid-lines", type: "line", source: "task-grid", paint: { "line-color": theme === "dark" ? "#78aaff" : "#1769e8", "line-opacity": 0.9, "line-width": 1.7, "line-dasharray": [2, 2] } });
    if (map.getLayer("plan-boundary-fill")) map.moveLayer("plan-boundary-fill");
    if (map.getLayer("plan-boundary-outline")) map.moveLayer("plan-boundary-outline");
  }, [tileGrids, preview, ready, theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || preview || !tileGrids.length) return;
    (map.getSource("task-coverage") as maplibregl.GeoJSONSource | undefined)?.setData(taskTileCoverage(tileGrids, completedTiles ?? 0));
  }, [tileGrids, completedTiles, preview, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const layer of ["plan-boundary-outline", "plan-boundary-fill"]) if (map.getLayer(layer)) map.removeLayer(layer);
    if (map.getSource("plan-boundary")) map.removeSource("plan-boundary");
    if (!boundary) return;
    map.addSource("plan-boundary", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: boundary.polygons } } });
    map.addLayer({ id: "plan-boundary-fill", type: "fill", source: "plan-boundary", paint: { "fill-color": theme === "dark" ? "#78aaff" : "#1769e8", "fill-opacity": 0.12 } });
    map.addLayer({ id: "plan-boundary-outline", type: "line", source: "plan-boundary", paint: { "line-color": theme === "dark" ? "#78aaff" : "#1769e8", "line-width": 2.5 } });
  }, [boundary, ready, theme]);

  const plannedTiles = tileGrids.reduce((total, grid) => total + grid.tileCount, 0);
  const detail = imageryState === "ready" ? missingTiles ? `本机部分影像 · 缺失 ${missingTiles} 瓦片` : "本机影像 · OSM 底图" : imageryState === "loading" ? "正在加载本地影像" : imageryState === "error" ? "本地影像显示失败" : completedTiles !== null && plannedTiles ? `${completedTiles} / ${plannedTiles} 瓦片已读取 · 待核验` : plannedTiles ? `${plannedTiles} 张计划瓦片 · Z${tileGrids.map(grid => grid.zoom).join("/")}` : ready ? "OpenStreetMap 底图" : "地图正在加载";

  return <div className={`map-shell ${ready ? "" : "map-fallback"}`}>
    <div ref={container} className="map-canvas" aria-label={t("Agent 计划范围预览")} />
    {!ready && <div className="map-fallback-grid" aria-hidden="true" />}
    {ready && overlay.width > 0 && overlay.height > 0 && <svg className="map-data-overlay" viewBox={`0 0 ${overlay.width} ${overlay.height}`} preserveAspectRatio="none" aria-hidden="true">
      {overlay.selection && <rect className={tileGrids.length && !preview ? "map-selection map-selection-with-tiles" : "map-selection"} x={overlay.selection.x} y={overlay.selection.y} width={overlay.selection.width} height={overlay.selection.height} />}
    </svg>}
    {!ready && bounds && <div className="map-fallback-extent" aria-label={t("计划范围示意")}><span>{t("计划范围示意")}</span></div>}
    <div className="map-overlay top-left"><span className="eyebrow">MAPLIBRE GL</span><strong>{imageryState === "ready" ? missingTiles ? t("已校验部分影像") : t("已校验影像") : boundary ? t("边界计划") : bounds ? t("计划范围") : t("地图工作区")}</strong><small>{detail}</small></div>
    <div className="map-controls"><div className="zoom-controls">
      <UiTooltip content={t("放大地图")}><Button variant="secondary" size="icon" aria-label={t("放大地图")} disabled={!ready} onClick={() => mapRef.current?.zoomIn()}><Plus size={16} /></Button></UiTooltip>
      <UiTooltip content={t("缩小地图")}><Button variant="secondary" size="icon" aria-label={t("缩小地图")} disabled={!ready} onClick={() => mapRef.current?.zoomOut()}><Minus size={16} /></Button></UiTooltip>
    </div></div>
    <div className="map-overlay bottom-left"><span className="map-dot" />{bounds ? bounds.map(n => n.toFixed(3)).join(" / ") : t("Agent 生成计划后显示范围")}</div>
    <div className="map-attribution">{preview && <span>{preview.attribution} · </span>}<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a></div>
  </div>;
}

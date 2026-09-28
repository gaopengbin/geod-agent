import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { Map, MapMouseEvent } from "maplibre-gl";
import type { FeatureCollection, Polygon } from "geojson";
import type { Bounds } from "./api";
import { Button } from "@/components/motion/button/base";
import { Crosshair, Minus, Plus } from "lucide-react";

const emptyStyle = {
  version: 8 as const,
  sources: {},
  layers: [{ id: "background", type: "background" as const, paint: { "background-color": "#e9f1f6" } }],
};

function geometry(bounds: Bounds): FeatureCollection<Polygon> {
  const [w, s, e, n] = bounds;
  return { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } }] };
}

export function MapView({ bounds, onBoundsChange }: { bounds: Bounds; onBoundsChange: (value: Bounds) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const boundsRef = useRef(bounds);
  const onBoundsRef = useRef(onBoundsChange);
  const drawRef = useRef(false);
  const [drawing, setDrawing] = useState(false);
  const [ready, setReady] = useState(false);
  boundsRef.current = bounds;
  onBoundsRef.current = onBoundsChange;

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: emptyStyle,
      center: [116.4, 39.9],
      zoom: 6,
      attributionControl: false,
      maxPitch: 0,
    });
    mapRef.current = map;
    map.on("load", () => {
      const grid: FeatureCollection = { type: "FeatureCollection", features: [] };
      for (let lon = -180; lon <= 180; lon += 10) grid.features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[lon, -85], [lon, 85]] } });
      for (let lat = -80; lat <= 80; lat += 10) grid.features.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[-180, lat], [180, lat]] } });
      map.addSource("graticule", { type: "geojson", data: grid });
      map.addLayer({ id: "graticule", type: "line", source: "graticule", paint: { "line-color": "#b8ccdb", "line-width": 1, "line-opacity": 0.62 } });
      map.addSource("selection", { type: "geojson", data: geometry(boundsRef.current) });
      map.addLayer({ id: "selection-fill", type: "fill", source: "selection", paint: { "fill-color": "#1769e8", "fill-opacity": 0.15 } });
      map.addLayer({ id: "selection-border", type: "line", source: "selection", paint: { "line-color": "#1769e8", "line-width": 2.5 } });
      setReady(true);
      map.fitBounds([[boundsRef.current[0], boundsRef.current[1]], [boundsRef.current[2], boundsRef.current[3]]], { padding: 110, maxZoom: 9, duration: 0 });
    });
    let start: [number, number] | null = null;
    const down = (event: MapMouseEvent) => {
      if (!drawRef.current) return;
      start = [event.lngLat.lng, event.lngLat.lat];
      map.dragPan.disable();
    };
    const move = (event: MapMouseEvent) => {
      if (!start) return;
      const next: Bounds = [Math.min(start[0], event.lngLat.lng), Math.min(start[1], event.lngLat.lat), Math.max(start[0], event.lngLat.lng), Math.max(start[1], event.lngLat.lat)];
      (map.getSource("selection") as maplibregl.GeoJSONSource | undefined)?.setData(geometry(next));
    };
    const up = (event: MapMouseEvent) => {
      if (!start) return;
      const next: Bounds = [Math.min(start[0], event.lngLat.lng), Math.min(start[1], event.lngLat.lat), Math.max(start[0], event.lngLat.lng), Math.max(start[1], event.lngLat.lat)];
      start = null;
      map.dragPan.enable();
      drawRef.current = false;
      setDrawing(false);
      if (next[2] - next[0] > 0.00001 && next[3] - next[1] > 0.00001) onBoundsRef.current(next.map(n => Number(n.toFixed(6))) as Bounds);
    };
    map.on("mousedown", down);
    map.on("mousemove", move);
    map.on("mouseup", up);
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const source = mapRef.current?.getSource("selection") as maplibregl.GeoJSONSource | undefined;
    source?.setData(geometry(bounds));
  }, [bounds, ready]);

  return <div className="map-shell">
    <div ref={container} className="map-canvas" aria-label="坐标地图与选择范围" />
    <div className="map-overlay top-left"><span className="eyebrow">SPATIAL WORKSPACE</span><strong>范围与覆盖</strong><small>真实经纬网 · 无在线底图</small></div>
    <div className="map-controls">
      <Button variant={drawing ? "primary" : "secondary"} size="sm" onClick={() => { drawRef.current = !drawRef.current; setDrawing(drawRef.current); }}><Crosshair size={15} />{drawing ? "在地图上拖框" : "地图拖框"}</Button>
      <div className="zoom-controls"><Button variant="secondary" size="icon" aria-label="放大地图" onClick={() => mapRef.current?.zoomIn()}><Plus size={16} /></Button><Button variant="secondary" size="icon" aria-label="缩小地图" onClick={() => mapRef.current?.zoomOut()}><Minus size={16} /></Button></div>
    </div>
    <div className="map-overlay bottom-left"><span className="map-dot" />{bounds.map(n => n.toFixed(3)).join(" / ")}</div>
  </div>;
}

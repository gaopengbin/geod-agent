import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import { fromLonLat } from "ol/proj";
import { ManualBoundaries } from "../src/manual-boundaries";
import { receiveBoundarySelection } from "../src/boundary-selection";
import { api, type BoundaryImport } from "../src/api";
import "ol/ol.css";
import "../src/styles.css";
import "../src/theme.css";
const runtime = window as unknown as Record<string, unknown>;
runtime.__TAURI_INTERNALS__ = { invoke: async (command: string, args: unknown) => { const result = await (await fetch('http://127.0.0.1:1422', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, args }) })).json(); if (result.error) throw result.error; return result.value; } };
const params = new URL(location.href).searchParams;
const conversationId = params.get('conversation') || 'manual-boundary-acceptance-ui';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.dataset.theme = theme;
function Harness() {
  const ref = useRef<HTMLDivElement>(null); const [map, setMap] = useState<Map | null>(null);
  const [boundary, setBoundary] = useState<BoundaryImport | null>(null);
  useEffect(() => { const osm = new OSM(); const instance = new Map({ target: ref.current!, layers: [new TileLayer({ source: osm })], controls: [], view: new View({ center: fromLonLat([116.4, 39.9]), zoom: 10 }) }); setMap(instance); const state = { map: instance, tilesLoaded: 0 }; runtime.__manualBoundaryAcceptance = state; osm.on('tileloadend', () => { state.tilesLoaded++; }); return () => instance.dispose(); }, []);
  useEffect(() => receiveBoundarySelection(conversationId, async found => { const stored = await api.boundariesGet(conversationId, found.boundaryId!); setBoundary(stored); (runtime.__manualBoundaryAcceptance as Record<string, unknown>).attached = stored; }), []);
  return <main style={{ display: 'flex', height: '100vh', background: 'var(--background)' }}><aside style={{ width: 270, padding: 20, borderRight: '1px solid var(--border)' }}><h1 style={{ fontSize: 17, margin: '0 0 16px' }}>地图范围验收</h1><p style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>使用产品绘制组件，范围保存到真实本机存储。</p><div aria-label="对话范围附件" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{boundary ? <><strong>{boundary.name}</strong><p>{boundary.polygonCount} 个面</p><code>{boundary.boundaryId}</code></> : '尚未选择范围'}</div></aside><div className="map-shell" style={{ minWidth: 0, flex: 1 }}><div className="map-canvas" ref={ref}/>{map && <ManualBoundaries map={map} conversationId={conversationId} theme={theme} planBoundary={boundary}/>}</div></main>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);

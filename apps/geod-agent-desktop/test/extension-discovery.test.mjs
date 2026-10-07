import assert from "node:assert/strict";
import test from "node:test";
import { discoverExtensions, discoveredConnector } from "../src/extension-discovery.ts";

const connector = { id: "builtin-openlayers-mcp", name: "OpenLayers MCP", url: "当前对话地图", enabled: true };
const schema = { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] };
const list = { connectorId: connector.id, name: connector.name, tools: [
  { name: "loadArtifact", description: "Load a downloaded raster", inputSchema: schema },
  { name: "listLayers", description: "List map layers", inputSchema: { type: "object" } },
] };
test("connector name and ID queries preserve full tools and schemas", () => {
  for (const query of ["OpenLayers", "openlayers mcp", "builtin-openlayers-mcp"]) {
    const result = discoveredConnector(connector, list, query);
    assert.equal(result.tools.length, 2);
    assert.deepEqual(result.tools[0].inputSchema, schema);
  }
});
test("specific tool queries filter tools rather than emptying matching connectors", () => {
  const result = discoveredConnector(connector, list, "raster");
  assert.deepEqual(result.tools.map(tool => tool.name), ["loadArtifact"]);
  assert.equal(discoveredConnector(connector, list, "unrelated"), null);
});
test("multi-keyword capability queries discover connectors and parameter schemas", () => {
  const scene = { id: 'builtin-cesium-mcp', name: 'Cesium MCP', url: '当前对话三维场景' };
  const tools = { connectorId: scene.id, name: 'Cesium MCP · 3D viewer scene camera basemap globe', tools: [{ name: 'setView', inputSchema: { type: 'object', properties: { heading: { type: 'number' }, pitch: { type: 'number' } } } }] };
  for (const query of ['camera pitch heading tilt 三维相机', 'basemap ground 底图 groundPrimitive', 'tiles3d viewer scene']) {
    assert.equal(discoveredConnector(scene, tools, query)?.tools[0].name, 'setView');
  }
  assert.equal(discoveredConnector(scene, tools, 'heading pitch')?.tools[0].name, 'setView');
  assert.equal(discoveredConnector(scene, tools, 'unrelated tools'), null);
});
test("large schema remains intact and an omitted list explicitly reports its size", () => {
  const huge = { ...schema, description: "Schema documentation".repeat(400) };
  const tools = Array.from({ length: 40 }, (_, i) => ({ name: `tool${i}`, inputSchema: huge }));
  const result = discoveredConnector(connector, { ...list, tools }, "OpenLayers");
  assert.deepEqual(result.tools[0].inputSchema, huge);
  assert.equal(result.toolCount, 40);
  assert.equal(result.omittedToolCount, 8);
  assert.match(result.next, /specific tool/);
});
test("discovery retains matching builtins and isolates connector failures", async () => {
  const installed = { skills: [], connectors: [connector, { id: "broken", name: "Broken MCP", url: "", enabled: true }] };
  const result = await discoverExtensions(installed, "OpenLayers", async id => { if (id === "broken") throw new Error("Offline"); return list; });
  assert.equal(result.connectors.length, 1);
  assert.deepEqual(result.connectors[0].tools, list.tools);
  const failed = await discoverExtensions(installed, "broken", async () => { throw new Error("Offline"); });
  assert.equal(failed.connectors[0].error, "CONNECTOR_UNAVAILABLE");
  assert.equal(failed.connectors[0].message, "Offline");
});
test("registered App queries return only their configured native fallback and retain unavailable account status", async () => {
  const app={pluginId:'qa-plugin',pluginName:'Notes package',name:'notes',registeredId:'asdk_app_notes_qa',category:null,route:'bundledMcp',connectorId:connector.id,enabled:true,registeredAccountRouteAvailable:false,reason:null};
  const unavailable={...app,name:'calendar',registeredId:'connector_calendar_qa',route:'unavailable',connectorId:null,enabled:false,reason:'Account route unavailable'};
  const installed={skills:[],connectors:[connector],registeredApps:[app,unavailable]};
  const actual=await discoverExtensions(installed,'asdk_app_notes_qa',async()=>list);assert.deepEqual(actual.connectors[0].tools,list.tools);assert.equal(actual.registeredApps[0].connectorId,connector.id);
  const missing=await discoverExtensions(installed,'connector_calendar_qa',async()=>list);assert.equal(missing.connectors.length,0);assert.equal(missing.registeredApps[0].route,'unavailable');
  const off=await discoverExtensions({...installed,connectors:[{...connector,enabled:false}],registeredApps:[{...app,enabled:false}]},'asdk_app_notes_qa',async()=>{throw new Error('Should not discover disabled transport')});assert.equal(off.connectors.length,1);assert.equal(off.connectors[0].enabled,false);assert.deepEqual(off.connectors[0].tools,[]);
});

test('saved Amap is visible as not enabled, without probing it or exposing credentials',async()=>{
 const amap={id:'saved-amap',name:'高德地图 MCP',url:'https://mcp.amap.com/mcp',enabled:false,queryNames:['key'],private:true};
 for(const query of ['', 'amap', '高德']){
  let probed=0;const result=await discoverExtensions({skills:[],connectors:[amap]},query,async()=>{probed++;throw new Error('Must not probe a disabled connector');});
  assert.equal(probed,0);assert.equal(result.connectors[0].registered,true);assert.equal(result.connectors[0].enabled,false);assert.equal(result.connectors[0].status,'notEnabled');assert.equal(result.connectors[0].authenticationConfigured,true);assert.deepEqual(result.connectors[0].tools,[]);assert.match(result.connectors[0].next,/Do not re-add/);assert.equal(result.registeredConnectors[0].connectorId,amap.id);assert(!JSON.stringify(result).includes('queryNames'));
 }
 const filtered=await discoverExtensions({skills:[],connectors:[amap]},'raster',async()=>{throw new Error('Must not probe');});assert.equal(filtered.connectors.length,0);assert.equal(filtered.registeredConnectors[0].status,'notEnabled');
 const isolated=await discoverExtensions({skills:[],connectors:[amap,connector]},'高德',async()=>{throw new Error('Must not probe unrelated transports for a direct saved-connector query');});assert.equal(isolated.connectors.length,1);assert.equal(isolated.connectors[0].status,'notEnabled');
});
test('refresh reflects enabling and disabling; an enabled transport failure is not lost registration',async()=>{
 const amap={id:'saved-amap',name:'高德地图 MCP',url:'https://mcp.amap.com/mcp',enabled:true};
 const tools={connectorId:amap.id,name:amap.name,tools:[{name:'maps_geo',inputSchema:{type:'object'}}]};
 const enabled=await discoverExtensions({skills:[],connectors:[amap]},'高德',async()=>tools);assert.equal(enabled.connectors[0].enabled,true);assert.equal(enabled.connectors[0].tools[0].name,'maps_geo');
 const offline=await discoverExtensions({skills:[],connectors:[amap]},'高德',async()=>{throw new Error('Offline');});assert.equal(offline.connectors[0].registered,true);assert.equal(offline.connectors[0].enabled,true);assert.equal(offline.connectors[0].status,'unavailable');
 const disabled=await discoverExtensions({skills:[],connectors:[{...amap,enabled:false}]},'高德',async()=>{throw new Error('Must not probe');});assert.equal(disabled.connectors[0].enabled,false);assert.deepEqual(disabled.connectors[0].tools,[]);
});

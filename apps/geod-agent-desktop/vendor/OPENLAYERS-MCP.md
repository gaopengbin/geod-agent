# OpenLayers MCP integration

- Source: https://github.com/gaopengbin/openlayers-mcp
- Revision: `13459a5a9fcbb488871f4b189288019e36b96533`
- Package: `openlayers-mcp-bridge@0.1.0`, built and packed from that checkout.
- Licence: MIT (included in this folder).

The desktop embeds the original OpenLayersBridge executor and reuses the runtime's Zod tool definitions in `src/openlayers-tool-definitions.ts`. MCP SDK Client/Server communicate through paired InMemoryTransports inside the WebView, without another Node process or network listener. The original stdio/WebSocket deployment is not used here.

Adapter corrections: only implemented OSM/XYZ tile types are exposed; registered GeoD sources use a dedicated source-ID loader with native proxy-aware tile reads. Feature properties omit the OpenLayers geometry object. HTML labels are sanitized. Screenshots compose visible map canvases. Each conversation owns its map and stored commands.

# OpenLayers MCP 0.2.0 本地接入

日期：2026-10-01。上游 G:/code/openlayers-mcp，基线 13459a5a9fcbb488871f4b189288019e36b96533，加本次候选修改。

## 接入内容

- 使用 vendor/openlayers-mcp-bridge-0.2.0.tgz 和 vendor/openlayers-mcp-protocol-0.2.0.tgz，不直接依赖其他工作区源码。
- 精确 SHA-256 见 apps/geod-agent-desktop/vendor/openlayers-mcp-0.2.0-manifest.json。
- 注册上游 38 个工具，加本机 loadSource / loadArtifact，合计 40。
- WMS、WMTS、矢量格式、MVT、GeoTIFF 和 Image/ArcGIS 图层交给真实上游 bridge 执行。
- 工具发现返回全部 availableTools 名称，schema 超过 32 个时可按名称再次检索。
- 本地成果附带 mcpExtent，支持 getLayer / fitLayer；状态沿用本机实际瓦片加载结果。
- 截图采用上游复合 canvas 实现，并保留 GeoD 地图截图预览。
- native CSP 允许已配置网络图源的 HTTP/HTTPS/blob 图片与请求；本机 GeoTIFF 仍使用注册的 opaque 资源和 Range。

## 验证

上游 11 个运行时测试、18 项真实浏览器检查通过。补充 ImageWMS 和 ArcGIS export 实际服务加载为 ready。

GeoD npm run build、cargo build --bin geod-agent-desktop 通过。40 工具清单、WKT 坐标/导出和两份已完成 GeoTIFF 加载通过；native Raster/DataTile 实际解码通过。

真实 Codex app-server 回合用时 39012ms：自主发现 loadArtifact，核验两份成果，执行加载、fitExtent，回读 listLayers/getView 后生成回答。两图层最终均 ready/visible。不是固定答案或伪造工具结果。

上游完整报告与 evidence：G:/code/openlayers-mcp/docs/implementation/2026-10-01-mcp-0.2.md。

## 本地状态

开发模式 127.0.0.1:1420 已启动；只因 native CSP 改动重建了一次程序。没有安装桌面包、发布 npm、更新网关或推送仓库。只读已有成果，没有创建下载任务。

GIS 格式转换、数据库连接和分析仍由独立数据处理连接器提供；地图 MCP 不宣称已包含这些能力。

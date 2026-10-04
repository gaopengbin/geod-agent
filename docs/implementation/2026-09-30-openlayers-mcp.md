# 内置 OpenLayers MCP

## 接入方式

桌面地图使用 OpenLayers 10.5 和 openlayers-mcp-bridge 0.1.0。桥接包从独立
openlayers-mcp 仓库 revision `13459a5a9fcbb488871f4b189288019e36b96533`
构建为本仓库 vendor TGZ；运行时不依赖其他工作区。

MCP SDK Client/Server 通过 WebView 内的 InMemoryTransport 完成真实
initialize、tools/list、tools/call 协议。连接器 ID 为
`builtin-openlayers-mcp`，默认启用，共 30 个工具：原有 29 个地图动作和
GeoD `loadSource`。无需启动终端、Node 子进程或开放地图服务端口。

模型通过现有 extensions_list 和 mcp_call 使用地图；本次接入不需要网关部署。
本机技能索引向模型提供地图工具入口。图源 ID 来自 sources_list，loadSource
读取原有图源注册表，支持 XYZ、TMS 和 ImageServer/exportImage。
瓦片读取使用本机代理设置；MapServer 的已配置缓存瓦片 URL 也能直接预览。

## 会话与界面

地图图层动作和视野以 conversationId 分开保存。切换会话时销毁旧地图及 MCP
会话，再恢复目标会话。旧会话的工具调用不能操作新会话地图。
地图右上角的组件图层菜单提供显示、透明度和移除操作。保留计划格网、下载
进度和已核验成果叠加；新对话仍使用居中输入布局。

浏览器桥接的适配修正：暴露真实实现的 OSM/XYZ 类型；移除要素属性中的
不可 JSON 序列化 Geometry；净化 HTML 标注；合成全部地图画布截图。
截图工具返回尺寸和预览状态，图片展示在地图中，避免将大段 base64 塞入模型上下文。

## 2026-09-30 验证

- 真实 MCP 握手列出 30 个工具；实际调用视野、图层、透明度和矢量要素。
- 本机托管模型实际执行 sources_list → extensions_list →
  mcp_call/loadSource(esri-world-imagery) → setView → listLayers/getView。
  已保存的 Esri World Imagery 经本机原生瓦片接口加载，回读状态 ready；
  天津中心 [117.2,39.1]、zoom 11，画面显示真实影像。
- 第二个测试会话只有 OSM 底图；切回首个会话恢复 Esri 图层及天津视野。
  不匹配的会话 ID 被拒绝。
- 截图工具实际生成 1280×720 地图预览。
- 28 个桌面测试通过；原生 URL 测试覆盖 TMS 行翻转、越界坐标，以及
  ImageServer 预览与下载共用的 Web Mercator tile bbox。
- TypeScript/Vite 构建及 Tauri release/NSIS 构建通过。

验收画面：[map-loaded.png](evidence/openlayers-2026-09-30/map-loaded.png)。
测试页面及 localhost 原生 IPC 测试适配器位于桌面 test/ 目录，不打入发行版。

以上真实模型测试使用隐藏的本地地图验收页和运行中的桌面原生 IPC；
未模拟模型、MCP 传输或图源瓦片。最终桌面交互仍可由用户直接复测。

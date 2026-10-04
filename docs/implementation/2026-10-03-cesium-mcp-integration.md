# Cesium MCP 接入当前三维窗口

日期：2026-10-03。范围：GeoD Agent 本机开发版；没有重新安装或发布服务。

## 修复原因

原三维成果窗口只有 `Cesium3DTileset` 预览，没有登记到可被 Agent 调用的连接器，且关闭了 `globe`。二维 OpenLayers 的底图操作不会改变这个窗口。因此模型只能查看下载成果，无法操作三维相机、地面底图或三维图层。

真实模型验收还暴露了扩展搜索问题：`camera pitch heading tilt 三维相机` 等查询曾被当成一个完整字符串匹配，返回空列表。现在兼容多个能力关键词，保留准确工具名、参数和完整 schema，并显式提示被截断的工具列表。

## 接入方式

- 复用正式发布的 `cesium-mcp-bridge` 1.146.0 与 `cesium-mcp-contracts` 0.7.0。包未修改，版本化归档在应用 `vendor/`；来源、SHA-256 与许可证见 `vendor/cesium-mcp.json` 和 `THIRD_PARTY_NOTICES.md`。
- 使用 MCP SDK 的 Client、Server 与 InMemoryTransport，不启动一个与实际窗口分离的地图实例。
- `builtin-cesium-mcp` 在扩展列表中作为内置连接器显示；场景未打开时也能发现工具。提供 61 个共享工具及 `getSceneState`、`fitScene`、`loadSource`，共 64 个定义。
- React 挂载时绑定当前 Viewer 和 conversationId；关闭窗口或切换会话时释放桥接。MCP 请求携带本机会话元数据，不能操作另一会话窗口；旧窗口的迟到结果不会作为新窗口结果返回。
- 已下载模型作为 `download-<taskId>` 登记进 Bridge 的实际图层管理器。相机、对象和图层操作直接作用于这个 Viewer。
- 三维地球默认加 OSM 地面底图。影像请求走 GeoD 现有的本机代理、缓存及凭据通道，正确解码原生返回的 base64；每个 provider 最多同时发出 8 个请求。OSM 保留现有本机缓存的 Z0–15 范围。
- `loadSource(sourceId)` 读取已保存图源和本机凭据，支持叠加和透明度；`getSceneState` 返回实际瓦片加载/失败/待处理数量。底图进入图层列表不等同于瓦片已加载。
- Codex 和现有引擎均获得三维工具发现说明。二维和三维保持独立执行目标。

## 兼容处理

Bridge 的 peer declaration 当前列出 Cesium 1.143/1.145，应用已经使用 Cesium 1.146.0。npm override 复用应用的唯一 Cesium 实例，避免重复引擎。下面的本机验收确认本次实际路径可用；这不是上游对全部工具的兼容保证。

Bridge 1.146.0 的 `removeEntity` 成功返回包含 `error: undefined`，默认输出验证器会误报字段类型错误。GeoD 保留输入验证，将结果序列化成实际 MCP JSON 后再用同一 contracts 校验输出；没有把错误结果改写成成功。回归测试同时覆盖可选字段省略与真实错误结果拒绝。

## 验收

### 实际桌面窗口和真实 MCP

脚本：`apps/geod-agent-desktop/test/cesium-native-integration.mjs`。

使用用户当前会话已有的名古屋任务 `30d9fb3c-00fe-43dd-a106-a21ff60dd204`（53 个资源），没有创建新的下载任务。通过生产 `data_download_load` 打开实际成果，生产 `api.mcpCall` 经过 MCP SDK 调用后验证：

1. 相机设置后读回 heading 约 30°、pitch 约 -65°。
2. 标记创建、属性读取和删除。
3. 已下载建筑图层隐藏、读回可见性、恢复显示。
4. `fitScene` 使用下载范围定位。
5. 已配置 Esri 图源通过原生通道实际加载，再恢复 OSM。
6. OSM 地面瓦片实际加载，最终 86 张、失败 0。
7. 其他 conversationId 调用相机工具返回 `SCENE_NOT_OPEN`。
8. 浏览器页面错误为 0。

证据：`evidence/cesium-mcp-2026-10-03/native-acceptance.json` 与 `native-scene.png`。

### 真实 AI 对话

脚本：`apps/geod-agent-desktop/test/cesium-real-model.mjs`，通过生产聊天输入框、实际托管模型和当前 Codex 会话执行，没有伪造回答或工具结果。

请求：在当前名古屋三维建筑场景中加载 OSM 地面底图，镜头从南侧约 45° 斜看；读取真实状态，不操作二维地图、不重新下载。

2026-10-03 04:54:28 UTC 验收完成，耗时约 22 秒。模型实际调用：

`getSceneState → setBasemap(osm) → setView → getSceneState → getView`

均通过 `builtin-cesium-mcp` 执行。OSM 已加载 78 张、失败 0、待处理 0；相机 longitude 136.90253776、latitude 35.16548282、height 1500.18 m、heading 约 0°、pitch -45.013°。镜头位置在场景中心以南，建筑与地面底图已目视核验，场景保留在窗口中。

证据：`evidence/cesium-mcp-2026-10-03/real-model.json` 与 `real-model.png`。

### 构建与回归

- `npm run build` 成功（现有体积警告仍在；Cesium 采用三维窗口动态加载）。
- Cesium MCP、结果序列化、扩展搜索与 Codex host 回归：15 项通过，1 项既有可选联网测试跳过。真实模型另由上面的生产界面验收覆盖。
- `git diff --check` 成功。

## 验证边界

64 个工具定义已接入，不代表每个工具都已逐项执行。此次实际验证了当前下载成果的相机、对象、建筑图层、OSM 和已注册 Esri 图源，以及真实模型操作链。其他在线地形、动画、外部模型等保留 Bridge 能力，尚未在本次验收中逐项测试。当前下载成果仍是 OSM 建筑体块，不会因接入控制工具变成倾斜摄影实景数据。

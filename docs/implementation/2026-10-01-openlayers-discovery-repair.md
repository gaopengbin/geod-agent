# OpenLayers 工具发现与本地成果加载修复

## 问题

按 `OpenLayers` 查询扩展时，旧逻辑把连接器名称当成工具名称过滤条件。
连接器被列出，但工具列表为空；模型随后尝试 `help`、`list_tools`、
`add_layer`、`load_geotiff_layer` 等不存在的工具。另一个实际缺口是地图
连接器没有读取已下载 GeoTIFF 成果的工具。

## 修改

- `extension-discovery.ts` 区分连接器匹配和工具匹配，保留工具的完整 schema。
  超过 32 项时明确返回省略数量和进一步查询提示，不再用空对象替换较大 schema。
- 内嵌 OpenLayers MCP 新增 `loadArtifact(jobId, assetId?, name?, opacity?, fit?)`。
  当前共 31 个工具。未知工具调用返回真实可用工具名称及重新发现的入口。
- Codex 开发者指令与内置 Skill 说明当前地图 MCP 的发现方式；它通过桌面内嵌
  MCP 运行，由 `mcp_call` 调用。无需在终端中查找该地图实例的 MCP 配置。
- Native `artifact_raster` 校验已完成任务、清单和成果 SHA-256，再解析文件位置。
  本机文件通过随机资源 ID 注册到 `geod-raster` 协议，只能读取已注册文件。
  模型工具结果不返回本机路径、资源 URL 或文件内容。
- 新协议支持完整的单段 Range 读取，修复默认资产协议约 1 MB 的截断问题。
  I/O 在后台线程执行。
- `artifact-raster-source.ts` 统一 GeoTIFF 数据源配置：固定 0..255 的 RGBA
  映射，128 MB 的 LRU 读取缓存。默认约 6 MB 缓存在并发读取条带时会导致缺块。
  图层状态累计处理加载中和失败的块，后续成功不能掩盖其他块的失败。
- 下载成果图层使用稳定的任务/资源 ID，支持同时显示和按会话保存、恢复。

## 验证

### 单元与构建

- 工具发现、会话隔离、模型结果路径过滤：7 项通过。
- 本机 Range 协议：2 项通过，包含完整读取超过 2 MB 的范围、非法范围、
  文件末尾截断和拒绝读取未注册文件。
- `cargo build --bin geod-agent-desktop`、`npm run build`、Codex host 语法检查通过。

### 真实模型和文件

使用开发版的真实 Codex app-server，未预设模型答案。最终回合在约 33.7 秒内完成：

`jobs_get → extensions_list(query: OpenLayers) → artifacts_inspect →`
`loadArtifact × 2 → fitExtent → getView → listLayers → screenshot`

该回合的工具均成功，无猜测工具名称或模拟回答。

| 成果 | 任务 ID | GeoTIFF 尺寸 | 状态 |
| --- | --- | --- | --- |
| 驻马店市 | `24d0c5b5-8276-4e2f-a73a-fe38a00117e9` | 6184 × 4352 | ready |
| 信阳市 | `519a34f9-c709-4ac8-a382-b77c55882be0` | 3255 × 2199 | ready |

后台浏览器验证页使用产品的同一个 MapView、MCP SDK 和工具执行逻辑，并通过
本机 IPC 测试适配器读取实际成果文件。原始 GeoTIFF 的颜色、裁剪透明区域和
两幅成果的合并定位均已目视核对。恢复原会话后保留 3 层；独立会话只有底图。

另在桌面 WebView 内直接读取 `geod-raster` 协议，并使用产品的数据源函数加载
实际 GeoTIFF 数据块。两份成果都返回有效的 Uint8 数据及非零像素，验证本机
范围读取和解码链路；浏览器验证页的文件读取通过本机 HTTP 适配器转接。

## 证据和运行状态

证据位于 `evidence/openlayers-discovery-2026-10-01/`：

- `discovery.json`：31 个实际工具及完整 schema。
- `unknown-tool.json`：未知名称的结构化恢复提示。
- `codex-live-final.json`：真实模型最终回合及工具结果。
- `native-raster.json`：桌面原生协议、实际像素和数据块验证。
- `restored-session.json`、`isolated-session-final.json`：会话恢复和隔离。
- `map-loaded.png`：两份实际成果的地图截图。

开发版本地引擎已经重新编译并启动，前端继续使用 1420 端口的热更新。
本次没有制作或安装新安装包，也没有发布服务器改动。

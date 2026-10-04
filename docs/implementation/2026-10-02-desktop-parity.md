# GeoD Agent 桌面能力补齐与验收

日期：2026-10-02。本轮对照旧 GeoD 桌面确认的差项已在独立 Agent 仓库实现，完成下述开发版验收。未重新安装、未发布服务器。

## 完成清单

| 能力 | 已接入内容 | 验收依据 |
| --- | --- | --- |
| 大范围影像 | 分块落盘、流式 BigTIFF、有限条带内存、取消 | 516 MiB 解码量 release 压力样例；条带上限 32 MiB；GDAL 读回 |
| 输出格式和参数 | GeoTIFF、MBTiles、PNG、JPEG、GeoPackage、原始瓦片；压缩、金字塔、辅助坐标文件 | 原生六格式 18 个资产，独立坐标与像素核验 |
| 多级别与注记 | AI 级别区间、多个任务、影像与注记合成 | 真实模型规划并启动 Z10–11 六格式注记任务 |
| Wayback | 版本目录、拍摄日期、历史下载、区域元数据比较与增量范围 | 196 版本；实际下载 4 瓦片，缺失 0；GeoTIFF 234×305、EPSG:3857 读回 |
| DEM | Terrarium 解码为 Float32 米制高程、NoData、金字塔与地图读取 | 真实模型任务及实际文件读回 |
| 矢量 | MVT/PBF、OSM；PBF、MBTiles、GeoJSON、GPKG；bbox / 多边形含洞筛选 | 真实 MVT、OSM；新版筛选输出读回；实际 OpenLayers 显示 |
| 3D Tiles | 显式/隐式、递归资源、范围筛选、离线预览；Ion / Token / 自定义头 | 4 套官方样例离线渲染；多边形/洞筛选；保存连接实际下载 8 资源 |
| 图源配置 | 18 个栅格/DEM 与 2 个 MVT 预设；子域轮换、GCJ-02、认证设置 | Google 3 种与高德 2 种真实样本；高德导出 9 个位置独立核验像素差 0 |
| 缓存与补救 | 共享缓存、核验/清理/迁移、跨任务复用、补漏、仅缓存导出 | 缓存导出零网络请求；损坏/过期恢复；迁移和取消测试 |
| 手动范围 | 矩形、多边形、编辑、命名、书签、对话边界接入 | 12 项真实交互及刷新保留 |
| Agent 与任务 | 工具发现、当前权限、归属、任务列表、批量处理、后台监控、定时模板 | 真实模型多类数据闭环；原生权限与真实定时下载；WebView HMR |

## 实际模型与主应用证据

- `evidence/imagery-real-model-2026-10-02.json`：Codex + DeepSeek Flash 两轮、9 次工具调用。模型规划并启动六格式影像与 DEM，再读取实际任务和成果。启动后交给本机后台，无持续模型轮询。
- `evidence/data-app-real-model/acceptance.json`：实际对话中矢量与三维 plan → start → inspect → load；OpenLayers 和 Cesium 实际显示、截图。
- `evidence/tiles3d-connections-real-model-2026-10-02.json`：实际模型 prepare → test → list → plan，计划持久保存连接 ID 和版本。
- `evidence/vector-range-native-2026-10-02.json`：重新编译后真实 MVT 请求，保存精确三角形范围；GeoJSON/GPKG/预览只含 1 个相交 Germany 国界要素。此前模型样例的 221 要素是旧版整瓦片行为，保留为历史证据，不代表新版导出行为。
- `evidence/data-schedules-native-2026-10-02.json`：真实时钟触发、下载、待确认、权限降级、工作区变更和取消；新版范围筛选后再次回归。
- `evidence/data-schedules-ui/acceptance.json`：保存、暂停、启用、刷新、亮暗色及窄面板。
- `evidence/native-hmr-2026-10-02.json`：实际 WebView 模块热更新，页面导航标识与 timeOrigin 不变。

实际验收发现并修复了新矢量图层创建、三维相对资源 URL 编码、Wayback 同源跳转、计划归属绑定和异步工具错误消息丢失等集成问题。

## 专项记录与成果

- [缓存管理](2026-10-02-cache-management.md)
- [补漏、缓存导出、Wayback 与坐标核验](2026-10-02-imagery-recovery.md)
- [矢量下载](2026-10-02-vector-parity.md)
- [3D Tiles 与离线预览](2026-10-02-tiles3d-parity.md)
- [3D 多边形筛选](2026-10-02-tiles3d-polygon-aoi.md)
- [Ion 与三维认证](2026-10-02-tiles3d-connections.md)
- [图源预设](2026-10-02-source-preset-parity.md)
- [手动范围](2026-10-02-manual-boundaries.md)
- [矢量与三维定时任务](2026-10-02-data-schedules.md)

其它实际成果证据：

- `evidence/desktop-parity-native-2026-10-02.json`：六格式、注记与 DEM；`../../artifacts/desktop-parity/formats-live-20261002/gdal-readback.json`：独立 GDAL 核验。
- `evidence/wayback-native-2026-10-02.json`：历史影像 4 瓦片、实际 GeoTIFF 和预览。
- `evidence/imagery-recovery-native-2026-10-02.json`：原成果、缓存导出和补漏分别保存。
- `evidence/tiles3d-connection-download-2026-10-02.json`：保存连接 + Referer 下载官方样例，8 资源、5,581,561 字节；删除测试连接后成果仍可核验。
- `evidence/tiles3d-connections/acceptance.json`：Windows 凭据库、连接版本失效、请求头增删、真实连通性及 390px/亮暗色界面。
- `evidence/source-presets-public-probes-2026-10-02.json`、`evidence/gcj-source-export-2026-10-02.json`：公开图源、坐标处理。
- `evidence/cache-manager/acceptance.json`、`evidence/cache-audit-2026-10-02.json`、`evidence/manual-boundaries/acceptance.json`：缓存、手动范围。

## 使用边界

- 用户随后提供服务端天地图 Key 与 Cesium Ion Token，均已通过本机凭据库保存。天地图影像+注记 3 瓦片实际合成下载通过；Ion OSM Buildings 北京小范围实际下载 18 资源、9,343,290 字节并核验通过。证据分别为 `evidence/tianditu-user-native-2026-10-02.json` 与 `evidence/tiles3d-ion-native-2026-10-02.json`，实际 Cesium 显示北京 CBD 建筑，缩放后重新定位通过；画面及交互记录见 `evidence/tiles3d-ion-preview/acceptance.json`。
- 矢量选择相交的完整要素，不沿边界切断几何；PBF/MBTiles 保留选中的完整瓦片。三维按包围体筛选整块模型，不切割网格；保守包络可能多保留边缘瓦片。
- Wayback 增量使用区域影像元数据，不是逐像素变化检测。元数据不明的区域保守保留；本次样例旧版该区元数据不明，不能宣称省掉下载量。
- 三维实现不含 S2 隐式包围体、glTF 1 和非标准旧 b3dm 头，未将这些计入已支持项。
- 矢量预览有数量上限，完整导出保留全量；MVT 跨瓦片/层级重复切片不自动融合。
- 定时与下载依赖 GeoD Agent 本机进程运行；重开后未完成任务显示可恢复状态。并非另行安装的常驻系统服务。

## 最终开发状态

- TypeScript / Vite 构建通过；前端 122 项通过、1 项 live smoke 在常规单测中跳过（实际模型另有上述证据）。
- 模型网关 19 项通过；矢量核心 10 项、三维核心 24 项、预设原生合同及凭据/归属定向测试通过。
- 任务引擎、影像核心、大栅格 release 压力检查已在本轮通过；Wayback 重定向另有 4 项测试。
- 已重编并启动开发版，Vite 热更新启用。保留本机测试网关，不修改线上服务。
- Windows 配置的代理 10808 无监听；应用现使用运行中的 FlClash `http://127.0.0.1:7890`。未修改 Windows 系统代理。
- 旧 GeoD 桌面仓库仅作参考，新增模块、依赖与来源记录均在独立仓库内。

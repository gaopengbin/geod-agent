# 数据任务与实际 Agent / 地图验收

真实桌面 WebView + bundled Codex + 网关模型完成 MVT 和 3D Tiles 的规划、启动、原生后台下载、完整性校验和地图加载。不是模拟工具或独立演示组件。

## 实际发现并修复

- 新矢量成果用 `addVectorLayer` 创建稳定 ID 的图层；`addGeoJSON(layerId)` 只适用于已有图层，之前导致实际模型加载失败。
- 本地三维 URL 逐段编码，保留 token / entrypoint 目录层级；之前 `convertFileSrc` 编码斜线使 Cesium 子资源相对 URL 丢失 token。
- 模型加载结果在实际 OpenLayers 要素数量一致 / Cesium initialTilesLoaded 后才返回 `loaded:true`。

## 证据

- `evidence/data-app-real-model/acceptance.json`：真实模型调用、原生 manifest 与最终模型回答。
- `evidence/data-app-real-model/vector-app.png`：实际 OpenLayers 图层截图。
- `evidence/data-app-real-model/tiles3d-app.png`：实际 Cesium 离线三维渲染截图，已目视核验。
- 三维官方固定提交样例：8 个资源，5,581,561 字节，包含 b3dm、pnts 与嵌套 tileset。第一次网络请求失败后实际模型重试成功，加载故障修复后同一任务重检通过。

## 后续范围筛选语义变更

上述初次模型验收的 MVT 示例导出整瓦片 221 个要素。现在导出的 GeoJSON、GeoPackage 和预览按请求 bbox 或完整 Polygon / MultiPolygon 精确筛选相交要素，保留完整要素几何，不切断跨界几何；洞内和边界外要素排除。PBF / MBTiles 保存入选的完整源瓦片。旧证据保留用于记录实际发现的故障，不作为新版筛选数量。

同一 MapLibre `countries` 图层与柏林范围的新输出为 **1 个 Germany 国界要素**，不是建筑或柏林行政边界；真实输出在 `artifacts/desktop-parity/vector-filtered-20261002`。源瓦片经哈希核验缓存重用，GeoJSON / GeoPackage / PBF / MBTiles 及索引逐一读回验证。

新增 core 测试涵盖实际文件中的范围外记录、洞内记录、多面岛屿、跨界线、覆盖范围的面以及输入要素自身的洞；原瓦片保留与筛选导出的区别也有测试。更新后的 native / 模型脚本期望计数为 1，须在重编原生程序后运行。

## 本地定时任务

`2026-10-02-data-schedules.md` 与 `evidence/data-schedules-native-2026-10-02.json` 记录真实时钟触发、权限降级、待确认取消、暂停、目录隔离和执行校验。定时执行要求应用运行；不会伪装成操作系统服务。

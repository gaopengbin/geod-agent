# 三维场景操作与旧格式兼容验收

日期：2026-10-03。本机开发候选，保持热更新。

## 场景工具

实际生产 Viewer 和 MCP 桥接完成 8 项验收：公开 ArcGIS 在线地形返回真实山地瓦片和珠峰附近高程，切回椭球后实测高程为 0；无效经纬度被拒绝。官方外部 GLB 经 HTTPS 加载，模型 ready 状态和相机视锥均核对，并目视确认画面中的模型。动画按真实时钟创建、跳转、播放和暂停，实际插值位置随时钟改变。切回二维再进入三维保留场景状态。其他会话不能操作此 Viewer。

新增 `sampleTerrain`，返回服务实际高程；`getSceneState` 返回当前地形、时钟、加载模型、动画位置以及已下载瓦片状态。模型的 `show` 是配置的可见性，`loaded` 是真实 Cesium Model 的 ready，`inCameraFrustum` 仅代表进入相机视锥，不能用来声称没有遮挡。创建对象成功不等于资源加载完成。

真实 Codex 与托管模型通过生产对话调用 Cesium MCP，读回平面地形、已加载外部模型和暂停中的动画。没有替换模型回答或注入假工具结果。

证据：[8 项场景验收](../../artifacts/cesium-scene-tools-20261003/acceptance.json)、[实际模型画面](../../artifacts/cesium-scene-tools-20261003/actual-external-glb.png)、[实际地形画面](../../artifacts/cesium-scene-tools-20261003/actual-arcgis-terrain.png)。脚本：`scripts/accept-cesium-scene-tools.mjs`。

私有 Cesium Ion 地形通过本机已保存凭据加载的流程仍待接入验收。公开 ArcGIS 和外部 GLB 的成功不能替代该项。

## S2 与旧格式

本仓库独立的 `geod-tiles3d` 新增：

- S2 64 位 token、6 个面、0–30 层地址；考虑曲边纬度极值、南北极和日期变更线的保守范围。按规范忽略瓦片 transform 对 S2 包围体的影响。
- S2 隐式四叉树和八叉树展开，支持非根面起点；正确区分 Morton 可用性索引与 Hilbert token，八叉树细分高度区间。
- glTF 1 JSON 字典资源、GLB 1 二进制头、外部 shader/image/buffer 引用；保留嵌入二进制数据。
- 两种旧 b3dm 20/24 字节头转换为标准 28 字节头，保留 BATCH_LENGTH 和 batch table；拒绝截断或无效资源。

35 组冻结的 Cesium S2 参考事实验证中心、顶点与子 token；库测试 30 项通过。真实 Rust 下载器保存并严格核验 5 组离线成果，生产 Viewer 实际加载全部所选内容，10 项下载/渲染验收通过。glTF 1 几何来自固定提交的 Khronos Box；两种旧 b3dm 来自固定 Cesium 提交。S2 隐式夹具为本地协议样例，每个模型位于其实际水平与高度区间；不是公开地理数据源。

真实测试定位到 Cesium 1.146 动态细节误差的兼容缺口：S2 包围体配合根 transform 时，动态高度估算产生 NaN，停止子瓦片遍历。生产预览对声明 S2 扩展的成果关闭动态优化，继续使用普通细节误差；不改变模型或包围体。

证据：[10 项完整验收](../../artifacts/tiles3d-compatibility-20261003-final/acceptance.json)、[S2 八叉树画面](../../artifacts/tiles3d-compatibility-20261003-final/actual-implicit-oct.png)。脚本：`scripts/accept-tiles3d-compatibility.mjs`。测试复用夹具前核对 SHA-256，夹具变更需要新的证据目录。

原生任务账本另通过 3 项完整链路验收：从固定 Cesium 提交实际下载两种旧 b3dm，完成转换、SHA-256 核验、原生成果检查和生产 Viewer 显示；真实 Codex 与托管模型再调用 MCP 读取已加载场景。证据：[原生链路 3 项](../../artifacts/tiles3d-native-legacy-20261003/acceptance.json)。S2 的 10 项流程使用实际 Rust 库和生产 Viewer，与公开旧 b3dm 原生任务证据分别记录。

## 来源与边界

算法与样例来源记录在 [PROVENANCE](../../crates/geod-tiles3d/PROVENANCE.md)。未修改旧 GeoD 产品，也没有增加指向旧仓库的运行依赖。30 项库测试和公开/本地样例验收不代表所有第三方 3D Tiles 扩展、所有模型材质或私有在线服务均完成验证。

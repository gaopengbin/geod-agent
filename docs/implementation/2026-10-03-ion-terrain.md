# 已保存 Ion 连接的真实地形验收

本地开发候选，未发布服务器或安装更新。

## 实际接入

Cesium MCP `loadTerrain(provider:cesiumion)` 使用本机已保存的 Ion 连接，可指定 `connectionId`、`cesiumIonAssetId`；全球地形默认为 Asset 1。账号 Token 从 Windows 凭据库读取，Ion 端点授权、签名参数及请求头留在 native，场景得到可撤销的 `geod-terrain` 本机资源地址。

读取真实地形元数据并初始化 provider 后才替换当前地形。错误 Asset 类型、无效连接或读取失败会保留原地形。关闭场景或切换其他地形释放本机资源注册。每次资源请求重新检查账号、连接版本及所属工作区。

401 时重新解析 Ion 端点并最多重试一次。同一批过期请求共享刷新锁；授权请求头与继承的签名查询参数一同刷新。不同来源的 parent 地形不会收到 Ion 授权。端点来源或路径改变时返回失败，需要重新加载。

## 验收证据

- `artifacts/ion-terrain-20261003-visible/acceptance.json`：6 项实际桌面验收通过，原有保存凭据未重新输入。
- `actual-ion-terrain.png`：等待真实地形瓦片完成加载后的生产场景截图，山体及 OpenStreetMap 底图已显示。
- `actual-ai.json`：真实托管模型经 Cesium MCP 加载 Ion Asset 1、执行高程采样，回答真实采样结果。
- level 12：珠峰附近 86.925,27.988 为 8772.219 米；勃朗峰附近 6.865,45.8328 为 4825.555 米。这是网格采样值，不是山峰测量报告。
- 浏览器网络没有直接 Ion API/资产请求或 `access_token` 查询参数；本机元数据包含不透明瓦片模板，撤销注册后返回 404。
- `terrain_protocol` 3 项测试通过，实际 HTTP 夹具验证过期 401、请求头和签名参数刷新、一次重试及跨来源隔离。真实 Ion 账号的人工过期/撤权未另行操作。
- `geod-tiles3d` 的 Ion 解析测试 4 项通过，覆盖真实 HTTP 协议及 Asset 类型。

接口依据：当前 Cesium 1.146 实际实现及 [CesiumTerrainProvider](https://cesium.com/learn/cesiumjs/ref-doc/CesiumTerrainProvider.html)。

# 三维数据认证连接

## 桌面能力对齐

核对旧桌面 `src-tauri/src/tiles3d/tileset.rs` 的 `CesiumIon` / `DirectUrl` 配置与 `fetcher.rs` 的端点解析后，为 Agent 独立实现：

- Cesium Ion Asset ID + Access Token；调用官方资产 endpoint，使用服务返回的独立 Token 下载。
- 自定义 3D Tiles 地址 + Referer、Authorization、X-API-Key 等请求头。
- 原生连接列表、AI 创建待填写连接、手动填写凭证、保存并测试、删除。
- Agent 下载使用 `connectionId`，原生计划绑定连接 revision。更换凭证/请求头后需重新规划；空值保留原凭证且不改变 revision。
- 模型可读取连接状态、创建待填写配置及测试已保存连接；模型工具不接收凭证值。

## 凭证与成果边界

凭证值仅存于 Windows Credential Manager 与下载进程内存。SQLite 仅保存连接元数据和随机凭证引用；任务保存连接 ID、revision、公有源身份与范围。Ion 动态端点 URL 不写入任务或成果清单，成果的来源 fingerprint 绑定稳定连接版本。

Ion 账号 Token 仅发往官方 endpoint API，不跟随 API 重定向。服务返回的 Token 和自定义头仅发送到数据源同源资源。同源子 tileset 引入的 session 参数会向后继资源传递，跨源不继承。错误信息不回显服务器响应体、认证头或签名网址。

连接测试检查真实根 tileset JSON。无用户 Ion Key 时，不能把公开样例下载或合成测试称为用户 Ion 资产下载成功。

## 验证

- `geod-tiles3d` 全 16 项测试通过，包括三维范围与离线包原有测试。
- Ion 合成 HTTP 流程：账号 Token → endpoint Token → 带 Referer 的子 tileset → session 子资源，下载和离线文件核验通过。
- Ion API 302 不跟随，响应体内的合成秘密不进入错误信息。
- 自定义头在源同源资源上生效，外部资源域名不收到凭证。
- Windows Vault 实际写读测试通过；SQLite 不含合成 Token / header 值；其他账号和错误连接版本无法解析凭证。
- 原生任务 ledger 2 项归属/恢复测试通过；TypeScript 检查通过。
- 新版 native 上 `test/tiles3d-connections-native-ui.mjs` 通过：AI 同型待填写连接→原生计划引用、Windows Vault 保存且不回读秘密、修改凭证使旧计划失效、请求头增删、公开官方 tileset 真实检查、连接删除；浅色/深色/390px 窄屏截图已人工查看。证据位于 `evidence/tiles3d-connections/acceptance.json`。
- 真实模型已实际调用 `tiles3d_connection_prepare` → `tiles3d_connection_test` → `tiles3d_connections_list` → `data_download_plan`，使用保存连接生成原生计划；证据 `evidence/tiles3d-connections-real-model-2026-10-02.json`。
- 保存连接 + Referer 的完整原生后台下载通过：官方样例得到 8 个资源、5,581,561 字节，连接 revision 对应的来源 fingerprint 一致；删除测试连接后，成果仍能独立校验。证据 `evidence/tiles3d-connection-download-2026-10-02.json`。这是真实公开样例，不冒充用户 Ion 资产。
- 用户已提供可用 Cesium Ion Token，连接测试已通过；真实资产下载与预览以对应原生验收证据为准。

新增 UI 复用当前 LibreChat 风格和 Radix 表单/对话框，常规宽度 600px，窄屏内容可滚动。

## 用户真实 Ion 接口发现的 gzip 问题

提供用户凭证后的原生测试发现，服务响应声明 `Content-Encoding: gzip`，此前禁用默认 feature 的 reqwest 未解压响应，导致合法 tileset 被误报为无效 JSON。已为原生连接测试、Ion endpoint 解析及三维文件下载统一开启流式 gzip 解码。所有响应体上限均继续统计解压后的字节，不采用压缩包的较小 Content-Length 代替内存限制。

Core 新增真实 HTTP gzip 根节点与内容回归，以及高压缩比响应超出解码上限时拒绝并不发布半成品的回归，完整 18 项通过。用户资产的实际下载结果由后续原生证据记录；本节不把合成 gzip 回归当作真实资产下载。

## 用户真实 Ion 资产的 GLB 格式规范化

真实 Cesium OSM Buildings 响应包含一个 97,682 字节的 b3dm：内嵌 GLB 起点为 10,988，末尾 BIN 长度 85,034，JSON 中 `buffers[0].byteLength` 和最大 bufferView 末端同为 85,034。原始几何完整，但批次 JSON 和最后 BIN 缺少对应的对齐填充。

下载重写仅在唯一末尾 BIN、长度边界完整、无外部 URI、声明 buffer 长度等于实际 BIN 长度时补足 1–3 个零；更新 chunk、GLB、容器长度。其他未对齐块、重复 BIN、截断数据、异常尾部继续拒绝。b3dm/i3dm 根据内嵌 GLB header.length 分离外层最多 7 个零填充，并对尾表和容器重新补齐；同一解析方式用于离线核验。无需改写资源 URI 时保留原始 GLB JSON 字节，避免浮点元数据重新序列化。

官方样本经过本地 HTTP 下载与严格离线核验，输出 97,688 字节；批次 JSON 加 4 个空格，BIN 加 2 个零，所有 JSON 值和原有几何字节保持一致，几何 SHA-256 前后一致。证据：`evidence/tiles3d-ion-format-normalization-2026-10-02.json`。完整核心 24 项通过；最终 JSON 原样保留改动后，6 项定向二进制回归再次通过。此样本验证不代替随后完整范围的原生下载与可视化验收。

规则依据：[glTF 2.0 二进制块规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#chunks)、[3D Tiles b3dm 填充规则](https://github.com/CesiumGS/3d-tiles/blob/main/specification/TileFormats/Batched3DModel/README.adoc#padding)。

## 用户 Ion 原生完整下载复测

用户提供 Token 后保存到本机凭据库，连接 Cesium OSM Buildings（Asset 96188）。修复 gzip 响应和实际官方 GLB/B3DM 格式填充兼容后，北京 CBD 小范围完整下载通过：18 资源、9,343,290 字节、逐文件 SHA-256 与离线引用核验成功，耗时约 9 秒。

证据：`evidence/tiles3d-ion-native-2026-10-02.json`；连接 `65aad306-8dcc-453f-a01b-123efc55a64d`、任务 `560bcca1-fe3e-416c-9341-38d9a4a6b792`。以上不包含用户秘密值。当前 Token 的资产列表接口返回 404，但该资产 endpoint 和数据读取成功；不将此结果扩大为所有私人资产均可访问。

### 真实成果画面复核

生产 DataPreviewHost 通过 data_download_load 加载上述北京 CBD 成果，Cesium 显示实际建筑。初始定位采用下载范围；滚轮改变镜头后，“定位三维成果”可恢复该区域。原始全球根包围球未影响定位。

- 证据：`evidence/tiles3d-ion-preview/acceptance.json`
- 截图：`evidence/tiles3d-ion-preview/beijing-cbd.png` 与 `beijing-cbd-reset.png`

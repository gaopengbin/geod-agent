# 内置图源预设对齐

旧桌面 `src-tauri/src/config.rs` 有 20 个预设：18 个栅格/DEM、2 个 MVT。Agent 原有 8 个普通栅格/DEM 与 4 个天地图连接，本轮补齐：

| 差项 | Agent 中的接入 |
| --- | --- |
| Google 卫星、地图、混合 | 原 HTTPS 模板、0–3 子域、Z0–20 |
| 高德地图、卫星 | 原 HTTPS 模板、1–4 子域、Z0–18 |
| 天地图地形注记 | `cta_w`；由本机凭证设置提供用户 Key |
| CARTO Light / Dark | 从固定 a 域改为 a–d 子域 |
| OpenTopoMap | 从固定 a 域改为 a–c 子域 |
| 天地图 AI 发现结果 | 与界面保持 0–7 子域一致 |
| OpenFreeMap MVT | 每次发现读取官方 TileJSON，取得有效版本地址；失败明确返回 unavailable |
| VersaTiles OSM MVT | 公开 XYZ MVT 模板，使用矢量下载任务 |

当前可发现 **18 个栅格/DEM预设 + 2 个矢量预设**。MVT 不放进栅格图源表单；模型通过 `source_presets.vectorPresets` 发现，并调用 `data_download_plan(kind=mvt)`。

坐标字段依据旧桌面明确标记的 `GCJ02_SOURCES`：Google 地图、高德地图、高德卫星为 `gcj02`，其他保持旧配置的默认。Agent 已有的 GCJ-02 栅格重采样处理会使用该字段，不能在生成表单草稿时丢弃。Google 混合已经取得可解码样本；其坐标字段沿用旧桌面配置，本轮独立地理配准验收针对高德执行，未猜测修改 Google 混合的旧配置。

没有把 Key 或 Token 写入预设。原已登记源保持原配置；新增或用户主动编辑时才应用新模板。

## 验证

- 前端合同测试 3/3：URL 凭证分离、5 个天地图模板、子域与 GCJ 字段保留。
- Native `cargo check` 通过。
- Native 预设配置合同测试已执行通过。
- 实际通过本机可用代理 `127.0.0.1:7890` 验证 Google 三种、高德两种预设，均返回 200、256×256 可完整解码图片；高德另通过六瓦片真实导出及九点独立坐标和像素核验。
- OpenFreeMap 官方 TileJSON 返回版本 `20260927_080001_pt`，已证实旧桌面硬编码的 `20260429_001001_pt` 不适合作为新的固定版本。
- 最初直连 Google 超时；随后核对发现 Windows 代理 10808 已无监听，现存 FlClash 实际监听 7890。以上结果使用应用网络设置的手动代理验证，不代表任何网络环境都能直连。
- 用户随后提供服务端 Key，天地图影像和影像注记真实预览与合成 GeoTIFF 下载通过，3 瓦片、缺失 0。证据：`evidence/tianditu-user-native-2026-10-02.json`。

证据：`evidence/source-presets-public-probes-2026-10-02.json`；样本位于 `artifacts/desktop-parity/source-preset-probes/`。

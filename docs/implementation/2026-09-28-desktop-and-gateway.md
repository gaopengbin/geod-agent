# GeoD Agent 桌面与模型网关实施记录

2026-09-28，本地开发状态；此文不代表已上线。

## 已接通的本地链路

- 独立 Tauri 2 桌面程序：左侧本机对话列表、中间 Agent 对话与地图预览、右侧可展开成果页；Agent 提交有类型的计划参数，本机估算并按计划哈希批准，随后可启动/暂停/继续/取消作业、查看事件进度和检查成果。没有手动任务参数表单。
- `geod-core` 从 XYZ/TMS 与 ArcGIS ImageServer `exportImage` 读取 256/512 像素瓦片；GeoTIFF 按 WGS84 请求框对应的 Web Mercator 像素边界裁剪，MBTiles 保留完整瓦片，manifest 保存各资产实际足迹与 SHA-256。输出目录存在时拒绝覆盖。
- GeoD 身份服务的 `/api/geod/oauth/*` 路由复用现有账号存储；桌面客户端采用授权码与 PKCE、本机回环回调、Windows 凭据库保存刷新令牌。已有网站 Cookie 继续有效。该路由目前位于 `G:\code\GIS-AI\geostyle-web` 的本地工作树，尚未发布。
- 桌面授权回调按完整 HTTP 请求头读取，可处理分段到达；浏览器启动失败会立即释放回调监听。身份和模型请求均禁止自动重定向，避免授权令牌或上游密钥跟随重定向发往其他地址。桌面查询登录状态时尝试刷新到期令牌；授权码错误、401 或 403 会撤销本地凭据，服务暂时不可达则保留凭据并显示错误。
- Agent 模型网关逐次向身份服务检查令牌，按用户持久预留与结算 token。只把模型建议和只读工具调用返回桌面端；下载批准、图源保存和作业启动只由桌面界面执行。模型结果在网关数据库中使用 AES-GCM 加密，原始用户消息不存网关。
- 模型响应或网络状态不明时保留额度并标为 `pending_reconcile`；运营须依据上游记录用 `reconcile.mjs` 审核结算或释放。重启后未完成的上游请求也会进入此状态。

## 真实影像验收

- 图源：USGS `USGSNAIPPlus/ImageServer/exportImage`；测试范围为美国本土华盛顿区域 `[-77.05, 38.85, -77.04, 38.86]`，Z12。源服务返回 `image/png`，本机成功下载、拼接并重新检查 GeoTIFF、MBTiles、预览和 manifest。
- 裁剪后 GeoTIFF 为 30×38 像素；像素边缘足迹 `[-77.0502090454, 38.8498686695, -77.0399093628, 38.8600282742]`。MBTiles 含 1 个原始完整瓦片；manifest `missingTiles=0`。
- 512 像素同源样本用 `cargo run --example usgs_naip -- <new-absolute-output-directory> 512` 验证，最新结果在 `artifacts/usgs-naip-20260928-dc-512-georef/`。GeoTIFF 59×76 像素，预览保持相同尺寸；重新打开后对 GeoTIFF 坐标系、比例尺、定位点、manifest 足迹与 SHA-256 做一致性检查，MBTiles 完整性检查通过，`missingTiles=0`。这是核心引擎的真实图源验证。
- 同桌面后端的账本路径另用 `cargo run --example usgs_approved_job -- <new-output-dir> <new-sqlite-file> [256|512]` 完成真实图源登记→计划→批准→作业→成果按作业 ID 检查。256/512 两档均得到 `Completed`、1 瓦片、3 项成果、`missingTiles=0`；本地证据分别在 `artifacts/usgs-approved-20260928-256/`、`artifacts/usgs-approved-20260928-512/` 和同名 SQLite 文件。示例中的批准由测试程序显式执行，不等于桌面界面人工批准已验收。
- 复现：`cd crates/geod-core; cargo run --example usgs_naip -- <new-absolute-output-directory>`。每次输出目录须不存在，避免覆盖。样本成果在本地 `artifacts/usgs-naip-20260928-dc-cropped/`，已从 Git 忽略。
- [USGS National Map 许可说明](https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map)说明地图服务与数据属于公共领域并请求署名；[影像服务元数据](https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer)描述了覆盖与来源。这个预设仅用于美国本土，其他地区及图源由用户核对授权。

## 本地运行与构建

```powershell
cd G:\code\geod-agent\apps\geod-agent-desktop
npm ci
npm run tauri:dev
npm run tauri:build
```

安装包在 `apps/geod-agent-desktop/src-tauri/target/release/bundle/nsis/GeoD Agent_0.1.0_x64-setup.exe`。早期包已在隔离目录完成 NSIS 安装、启动和卸载冒烟；用户批准的 USGS 样本随后通过原生窗口和安装后程序重开核验。当前安装包已包含 GeoD 远端账号请求使用 Windows 用户代理的修复，SHA-256 为 `e64e076586095737429bd3e615982488ac622a2fa3ebcb7eae1d82a3abd8ad63`。此前已从 Release 可执行文件检查界面，尚未对这个最新安装包重复安装验收。浏览器 `npm run dev` 只提供界面预览，Tauri IPC 不可用。

用户另行批准了 USGS NAIP 公共领域小样本：`[-77.05, 38.85, -77.04, 38.86]`、Z12、256 px、1 瓦片，输出到新目录 `artifacts/native-approved-usgs-20260928`。原生桌面界面已登记图源、生成计划、按计划哈希批准、执行下载并到达 `completed`；安装后程序重开也显示了同一作业。作业 ID `9b53d49f-3880-4e4d-b5e2-8564cbcb8244`，1/1 瓦片、3 项成果、`missingTiles=0`。`artifacts/verify-native-approved.py` 独立检查 SQLite 审批与事件、文件 SHA-256、GeoTIFF 的 30×38 像素与 EPSG:3857、MBTiles 完整性及 1 瓦片。

最新 Release 原生 WebView2 已检查左侧对话列表、对话与地图主区、右侧成果页展开、蓝白亮色和黑色暗色切换；1024 px 与 390 px 视口没有整页横向溢出。MapLibre 实际请求 OSM 当前视窗瓦片，在 Windows 用户代理下成功显示街道底图；用户批准的 USGS 30×38 裁剪预览由本地成果清单校验后作为 MapLibre 影像图层，按坐标叠加在计划范围。由于该样本只有 Z12 一瓦片，放大影像模糊属于源分辨率限制。OSM 请求设置 GeoD User-Agent，在本机缓存至少 7 天，不进入任务成果或离线包；地图显示 OSM 和 USGS 署名。授权图源弹窗使用 Radix Dialog/Select；在 390 px 下拉能避让边缘，Esc 关闭后焦点返回触发器。截图保存在本地忽略目录 `artifacts/native-window.png`、`native-theme-dark.png`、`native-inspect-completed.png`、`native-source-select.png`。本轮视觉检查没有重新下载 USGS 图源。开发预览曾因安装新依赖后 Vite 预构建缓存过期而返回 504；重启 1420 端口开发服务后已恢复。

模型网关需先配置本地环境变量：`GEOD_IDENTITY_ORIGIN`、`GEOD_AGENT_GATEWAY_SECRET`（与身份服务相同且至少 32 字符）、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`（默认 `deepseek-flash`）、`GEOD_AGENT_TOKEN_LIMIT` 与数据库路径。`DEEPSEEK_BASE_URL` 默认 `https://api.deepseek.com`，仅允许官方 API 或用于测试的本机回环地址。网关以非思考模式调用 DeepSeek Chat Completions 工具接口，供应商密钥只保存在服务端。[DeepSeek 模型文档](https://api-docs.deepseek.com/quick_start/pricing/)列出 `deepseek-flash` 及工具调用支持；[Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)定义 `thinking` 参数。参考 `services/geod-agent-model-gateway/.env.example`，密钥不得写入仓库。设置后运行 `npm ci; npm test; npm start`。桌面应用只呈现 GeoD 账号登录；身份站点和网关地址由打包时或开发环境的 `GEOD_AGENT_IDENTITY_ORIGIN`、`GEOD_AGENT_GATEWAY_ORIGIN` 提供，旧的本机 `agent-services.json` 仍可读取以保留已有开发配置。当前线上 `/api/geod/oauth/authorize` 返回 404，服务路由尚未发布；未配置的构建明确禁用登录按钮，不显示用户填写服务地址的表单。

运营对账：`node reconcile.mjs --list` 查询待核对生成；根据供应商实际记录编写决定 JSON，使用 `node reconcile.mjs --decision-file <path>`。释放必须有未计费证据；结算必须有上游请求 ID 和实际输入/输出 token。所有决定进入 `reconciliation_audit`。勿凭超时自动释放或重复提交上游。

## 验证与未完成项

- 已通过：`geod-core` 12 测试、`geod-task-engine` 17 测试、模型网关 7 测试、桌面服务 3 测试、GeoD OAuth 3 测试；桌面前端构建、Rust Clippy `-D warnings`、NSIS 安装包构建与隔离安装/启动/卸载冒烟。原生窗口中用户批准的计划已走完图源登记、批准、下载和成果核验。作业恢复及成果查看会核对成果的作业 ID，不会将其他作业的有效目录误认作自己的结果。
- 网关单元测试使用本地假身份服务和假 DeepSeek 响应。另用旧 GeoD 网关本地配置中已有的 DeepSeek 密钥，只在一次测试进程内调用官方 API：真实 `deepseek-flash` 先发出 `sources_list` 工具调用，接收测试图源结果后续答；两次请求实际结算 1,552 token，保留额度归零。密钥未写入本仓库。可在服务端设置 `DEEPSEEK_API_KEY` 后运行 `npm run smoke:deepseek` 复验。该测试的账号鉴权和本机图源结果仍为模拟，真实 GeoD 登录及桌面会话尚未验收。
- 桌面任务已保存带计划和图源版本绑定的瓦片检查点；恢复时逐片核对大小、SHA-256 与像素尺寸，已校验瓦片不重复请求。网络暂时故障可在同一批准和作业 ID 下重试；主动暂停与崩溃后恢复均保留原批准和作业 ID。多边形导入、复杂边界掩膜、更多数据类型、源凭据引用与干净 Windows 安装回归尚未完成。
- 安装包未签名，尚未向用户发布或部署身份服务、网关。

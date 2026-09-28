# GeoD Agent 桌面与模型网关实施记录

2026-09-28，本地开发状态；此文不代表已上线。

## 已接通的本地链路

- 独立 Tauri 2 桌面程序：登记授权来源、地图拖框和经纬度输入、计划估算、按计划哈希批准、作业启动/暂停/继续/取消、事件进度、成果检查。
- `geod-core` 从 XYZ/TMS 与 ArcGIS ImageServer `exportImage` 读取 256/512 像素瓦片；GeoTIFF 按 WGS84 请求框对应的 Web Mercator 像素边界裁剪，MBTiles 保留完整瓦片，manifest 保存各资产实际足迹与 SHA-256。输出目录存在时拒绝覆盖。
- GeoD 身份服务的 `/api/geod/oauth/*` 路由复用现有账号存储；桌面客户端采用授权码与 PKCE、本机回环回调、Windows 凭据库保存刷新令牌。已有网站 Cookie 继续有效。该路由目前位于 `G:\code\GIS-AI\geostyle-web` 的本地工作树，尚未发布。
- 桌面授权回调按完整 HTTP 请求头读取，可处理分段到达；浏览器启动失败会立即释放回调监听。身份和模型请求均禁止自动重定向，避免授权令牌或上游密钥跟随重定向发往其他地址。桌面查询登录状态时尝试刷新到期令牌；授权码错误、401 或 403 会撤销本地凭据，服务暂时不可达则保留凭据并显示错误。
- Agent 模型网关逐次向身份服务检查令牌，按用户持久预留与结算 token。只把模型建议和只读工具调用返回桌面端；下载批准、图源保存和作业启动只由桌面界面执行。模型结果在网关数据库中使用 AES-GCM 加密，原始用户消息不存网关。
- 模型响应或网络状态不明时保留额度并标为 `pending_reconcile`；运营须依据上游记录用 `reconcile.mjs` 审核结算或释放。重启后未完成的上游请求也会进入此状态。

## 真实影像验收

- 图源：USGS `USGSNAIPPlus/ImageServer/exportImage`；测试范围为美国本土华盛顿区域 `[-77.05, 38.85, -77.04, 38.86]`，Z12。源服务返回 `image/png`，本机成功下载、拼接并重新检查 GeoTIFF、MBTiles、预览和 manifest。
- 裁剪后 GeoTIFF 为 30×38 像素；像素边缘足迹 `[-77.0502090454, 38.8498686695, -77.0399093628, 38.8600282742]`。MBTiles 含 1 个原始完整瓦片；manifest `missingTiles=0`。
- 512 像素同源样本用 `cargo run --example usgs_naip -- <new-absolute-output-directory> 512` 验证，最新结果在 `artifacts/usgs-naip-20260928-dc-512-georef/`。GeoTIFF 59×76 像素，预览保持相同尺寸；重新打开后对 GeoTIFF 坐标系、比例尺、定位点、manifest 足迹与 SHA-256 做一致性检查，MBTiles 完整性检查通过，`missingTiles=0`。这是核心引擎的真实图源验证，尚不是安装后桌面全链验收。
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

安装包在 `apps/geod-agent-desktop/src-tauri/target/release/bundle/nsis/GeoD Agent_0.1.0_x64-setup.exe`。2026-09-28 已在本机以 NSIS 静默模式安装到隔离测试目录：安装目录包含应用与卸载程序，HKCU 有 GeoD Agent 卸载记录；从安装目录启动后主窗口标题为 GeoD Agent、进程可响应，应用创建了 schema v2 的本地任务数据库。随后正常关闭窗口，静默卸载返回 0，安装目录与卸载记录消失；确认只含本次测试数据库后清理了测试 AppData。此项证明安装和启动，不证明原生界面的图源登记、批准、地图与下载交互已通过。浏览器 `npm run dev` 只提供界面预览，Tauri IPC 不可用。

模型网关需先配置本地环境变量：`GEOD_IDENTITY_ORIGIN`、`GEOD_AGENT_GATEWAY_SECRET`（与身份服务相同且至少 32 字符）、`LAOGAO_BASE_URL`（优先本机加密隧道）、`LAOGAO_API_KEY`（本产品独立的 New API 下游密钥）、`LAOGAO_MODEL`、`GEOD_AGENT_TOKEN_LIMIT` 与数据库路径。参考 `services/geod-agent-model-gateway/.env.example`，密钥不得写入仓库。设置后运行 `npm ci; npm test; npm start`。桌面应用首次在智能助手内设置身份站点和模型网关的 HTTPS 地址；本地联调可用 `127.0.0.1` HTTP。

运营对账：`node reconcile.mjs --list` 查询待核对生成；根据供应商实际记录编写决定 JSON，使用 `node reconcile.mjs --decision-file <path>`。释放必须有未计费证据；结算必须有上游请求 ID 和实际输入/输出 token。所有决定进入 `reconciliation_audit`。勿凭超时自动释放或重复提交上游。

## 验证与未完成项

- 已通过：`geod-core` 12 测试、`geod-task-engine` 17 测试、模型网关 7 测试、桌面服务 3 测试、GeoD OAuth 3 测试；桌面前端构建、Rust Clippy `-D warnings`、NSIS 安装包构建与隔离安装/启动/卸载冒烟。浏览器预览已检查助手抽屉；原生窗口仍需交互测试。作业恢复及成果查看会核对成果的作业 ID，不会将其他作业的有效目录误认作自己的结果。
- 模型网关的工具调用与续答目前使用本地假身份服务和假上游模型验证。尚缺产品独立 New API 密钥、选定真实模型的工具调用/用量测试以及部署后的真实 GeoD 登录验收。
- 桌面任务已保存带计划和图源版本绑定的瓦片检查点；恢复时逐片核对大小、SHA-256 与像素尺寸，已校验瓦片不重复请求。网络暂时故障可在同一批准和作业 ID 下重试；主动暂停与崩溃后恢复均保留原批准和作业 ID。多边形导入、复杂边界掩膜、更多数据类型、源凭据引用与干净 Windows 安装回归尚未完成。
- 安装包未签名，尚未向用户发布或部署身份服务、网关。

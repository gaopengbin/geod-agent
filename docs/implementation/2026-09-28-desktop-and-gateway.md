# GeoD Agent 桌面与模型网关实施记录

2026-09-28，本地开发状态；此文不代表已上线。

## 已接通的本地链路

- 独立 Tauri 2 桌面程序：左侧本机对话列表、中间 Agent 对话与地图预览、右侧可展开成果页；Agent 提交有类型的计划参数，本机估算并按计划哈希批准，随后可启动/暂停/继续/取消作业、查看事件进度和检查成果。没有手动任务参数表单。
- `geod-core` 从 XYZ/TMS 与 ArcGIS ImageServer `exportImage` 读取 256/512 像素瓦片；GeoTIFF 按 WGS84 请求框对应的 Web Mercator 像素边界裁剪。用户在对话输入框可附加最多 1 MiB 的 WGS84 GeoJSON Polygon、MultiPolygon 或 FeatureCollection；本机计算范围并在 GeoTIFF 与预览中把边界外像素设为透明，支持多面及洞。MBTiles 保留完整源瓦片，manifest 明示这一差异并保存边界文件、各资产实际足迹与 SHA-256。输出目录存在时拒绝覆盖。
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

安装包在 `apps/geod-agent-desktop/src-tauri/target/release/bundle/nsis/GeoD Agent_0.1.0_x64-setup.exe`，SHA-256 为 `0c2428b79f6ce209c968f24330199258b863373ff61109f3f4b07850e0cc22e0`。早期包已在隔离目录完成 NSIS 安装、启动和卸载冒烟；用户批准的 USGS 样本随后通过原生窗口和安装后程序重开核验。最新 NSIS 包在已有的隔离安装目录 `artifacts/install-native-approved/` 静默升级，本次安装器退出码为 0；安装后已用原生程序启动和成果复检确认升级；已核对安装后程序含本次前端与 MapLibre worker 资源；未打开浏览器授权页。较早一版可执行文件保存在 `artifacts/install-before-auth-isolation-20260928.exe`。此前安装后的程序完成本地模拟账号授权、GeoJSON 附件导入/移除和真实 DeepSeek 工具调用，结算后模型额度预留为 0；当前包新增任务格网、读取覆盖层、模型成果工具隐私过滤及执行前磁盘空间检查。最新包已通过无 OAuth 的原生只读成果复检，但尚未重新执行会打开授权浏览器的真实模型联调。当前构建默认使用 `https://geod.laogao.xyz` 作为身份与模型服务来源；登录前先检查 GeoD OAuth 路由，尚未上线时立即提示，不打开会等待超时的浏览器授权页。浏览器 `npm run dev` 只提供界面预览，Tauri IPC 不可用。

用户另行批准了 USGS NAIP 公共领域小样本：`[-77.05, 38.85, -77.04, 38.86]`、Z12、256 px、1 瓦片，输出到新目录 `artifacts/native-approved-usgs-20260928`。原生桌面界面已登记图源、生成计划、按计划哈希批准、执行下载并到达 `completed`；安装后程序重开也显示了同一作业。作业 ID `9b53d49f-3880-4e4d-b5e2-8564cbcb8244`，1/1 瓦片、3 项成果、`missingTiles=0`。`artifacts/verify-native-approved.py` 独立检查 SQLite 审批与事件、文件 SHA-256、GeoTIFF 的 30×38 像素与 EPSG:3857、MBTiles 完整性及 1 瓦片。

最新安装版使用 `node apps/geod-agent-desktop/test/native-installed-readonly.mjs <installed-exe> <approved-job-id>` 启动原生 WebView2，只调用 `auth_status`、`jobs_get`、`artifacts_inspect` 和 `artifact_preview`，不点击登录或下载。2026-09-28 对上述已批准作业重检：账号状态 `disconnected`、作业 `completed`、3 项成果、`missingTiles=0`、PNG 预览有效；测试退出后调试端口已关闭。同轮再次运行独立文件校验，GeoTIFF 30×38/EPSG:3857、MBTiles 1 瓦片、全部文件 SHA-256 与 SQLite 审批哈希均通过。此检查证明当前安装版可读取旧真实成果，不代表线上账号和模型链路已可用。

前一版 Release 原生 WebView2 已检查左侧对话列表、对话与地图主区、右侧成果页展开、蓝白亮色和黑色暗色切换；1024 px 与 390 px 视口没有整页横向溢出。MapLibre 实际请求 OSM 当前视窗瓦片，在 Windows 用户代理下成功显示街道底图；用户批准的 USGS 30×38 裁剪预览由本地成果清单校验后作为 MapLibre 影像图层，按坐标叠加在计划范围。新 GeoJSON 附件通过原生 WebView2 文件输入、本机 Rust 校验、附件显示与移除联调；合成瓦片测试验证边界掩膜，尚未为新边界下载真实 USGS 样本。由于现有样本只有 Z12 一瓦片，放大影像模糊属于源分辨率限制。OSM 请求设置 GeoD User-Agent，在本机缓存至少 7 天，不进入任务成果或离线包；地图显示 OSM 和 USGS 署名。授权图源弹窗使用 Radix Dialog/Select；在 390 px 下拉能避让边缘，Esc 关闭后焦点返回触发器。截图保存在本地忽略目录 `artifacts/native-window.png`、`native-theme-dark.png`、`native-inspect-completed.png`、`native-source-select.png`、`native-boundary-attachment.png`。本轮视觉检查没有重新下载 USGS 图源。开发预览曾因安装新依赖后 Vite 预构建缓存过期而返回 504；重启 1420 端口开发服务后已恢复。

地图任务覆盖层现用计划的真实 Web Mercator 瓦片足迹绘制蓝色格网，并按下载 worker 的先列后行顺序将已读取瓦片绘制为绿色；核验完成后显示本机影像，格网隐藏。格网与覆盖层只代表计划和读取状态，绿色仍需成果核验。独立 2×2 合成计划在本地浏览器中以 3/4 进度目视验证亮色和黑色主题，没有下载图源。发现 Vite 下 MapLibre 默认 worker URL 失效后，按其官方 Vite 用法以 `?worker&url` 生成独立资源，并把图层初始化放在地图 `load` 事件后；新的前端和 NSIS 构建均包含该 worker。

成果清单的 `asset.path` 由本机核验器限制为包内相对文件名，但模型不需要文件名。`artifacts_inspect` 工具结果现只传作业 ID、质量、类型、角色、字节数、SHA-256、范围和来源；未知的本机警告折叠为成果页查看提示。再次发送旧对话时，同类历史工具消息也按该白名单重建，桌面成果页仍保留文件名供用户检查。2 项测试以含绝对路径的旧工具结果验证了模型上下文不会再包含该路径；尚未重新运行会弹出浏览器的原生 OAuth/DeepSeek 冒烟。

模型网关需先配置本地环境变量：`GEOD_IDENTITY_ORIGIN`、`GEOD_AGENT_GATEWAY_SECRET`（与身份服务相同且至少 32 字符）、`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`（默认 `deepseek-flash`）、`GEOD_AGENT_TOKEN_LIMIT` 与数据库路径。`DEEPSEEK_BASE_URL` 默认 `https://api.deepseek.com`，仅允许官方 API 或用于测试的本机回环地址。网关以非思考模式调用 DeepSeek Chat Completions 工具接口，供应商密钥只保存在服务端。[DeepSeek 模型文档](https://api-docs.deepseek.com/quick_start/pricing/)列出 `deepseek-flash` 及工具调用支持；[Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)定义 `thinking` 参数。参考 `services/geod-agent-model-gateway/.env.example`，密钥不得写入仓库。设置后运行 `npm ci; npm test; npm start`。桌面应用只呈现 GeoD 账号登录；默认身份站点和网关均为 `https://geod.laogao.xyz`，开发环境仍可使用 `GEOD_AGENT_IDENTITY_ORIGIN`、`GEOD_AGENT_GATEWAY_ORIGIN` 或旧的本机 `agent-services.json` 覆盖。当前线上 `/api/geod/oauth/authorize` 返回 404，服务路由尚未发布；按钮可点击，但预检会明确提示授权接口尚未上线，不显示用户填写服务地址的表单。

运营对账：`node reconcile.mjs --list` 查询待核对生成；根据供应商实际记录编写决定 JSON，使用 `node reconcile.mjs --decision-file <path>`。释放必须有未计费证据；结算必须有上游请求 ID 和实际输入/输出 token。所有决定进入 `reconciliation_audit`。勿凭超时自动释放或重复提交上游。

## 验证与未完成项

- 同一计划的作业启动现以本机账本中的计划 ID 再去重。桌面在再次批准前先查询已有作业，切回历史对话也直接读取该计划关联的作业；即使启动响应丢失、用户重新生成审批或请求编号，任务引擎仍返回原作业，不排入第二个下载。现有账本测试覆盖重启后的不同请求编号、不同审批及跨计划请求编号冲突，18 项通过。最新 NSIS 包 SHA-256 见上文；隔离目录静默安装退出码为 0，安装后原生 IPC 的 `jobs_for_plan` 返回同一已批准 USGS 作业，成果仍为 `completed`、3 项资产、缺失瓦片 0、有效 PNG。未打开账号授权页或下载新图源。
- 本次重新构建的 Windows 安装包加入图源 HTTP 429/5xx 的 `Retry-After` 等待，等待期间可及时取消或暂停；若图源要求的等待超过本次作业剩余时限，则保留限流错误，不提前重试。只用本机合成瓦片服务验证了两秒等待、30 秒等待期间的取消和暂停，未重新访问第三方图源。`geod-core` 19 项、`geod-task-engine` 18 项测试与两者 Clippy `-D warnings` 通过；桌面 Rust `cargo check`、NSIS 构建、隔离安装目录升级通过。升级后的原生程序仍能只读核验作业 `9b53d49f-3880-4e4d-b5e2-8564cbcb8244`：`completed`、3 项成果、缺失瓦片 0、有效 PNG；独立文件校验复查 GeoTIFF 30×38/EPSG:3857 与 MBTiles 1 瓦片。未打开授权浏览器，也未发起新影像任务。较早版隔离安装的可执行文件已备份至本地忽略目录 `artifacts/install-native-approved-pre-retry-20260928.exe`。
- 最新本地包加入保守的磁盘空闲预算。计划展示预算，开始下载前检查输出和缓存位置；不足时给出 `DISK_INSUFFICIENT`，空间恢复后沿用原作业和审批重试。旧计划字段缺失时仍可读取，预算不作为精确文件大小承诺。`geod-core` 20 项、`geod-task-engine` 19 项、桌面服务 6 项测试及前端构建通过；隔离目录静默升级后，原生程序只读复检同一已批准 USGS 作业：`completed`、3 项成果、缺失瓦片 0、有效 PNG。本轮不运行会弹出浏览器的交互 OAuth 冒烟，也不下载新瓦片。
- 模型请求现在在发往网关前同步保存请求编号、账号与完整上下文。响应丢失或应用重启后，先按原编号查询网关；确认服务端尚无该编号时，才以相同编号和上下文重试。最终回答先写入可恢复快照，再写入本机对话记录，以免结算后崩溃丢失答案。前端 9 项、桌面服务 7 项测试与前端构建通过；新 NSIS 包在隔离目录升级，原生只读复检已批准作业仍为 `completed`、3 项成果、缺失瓦片 0、有效 PNG。测试没有打开账号授权页；生产网关尚未发布，因此没有验证线上模型请求恢复。
- 作业在成果目录发布后、最终账本提交前中断时，现在可在应用启动时自动重验本机文件并补记 `completed`；发现文件损坏或作业 ID 不符则记为 `failed`，不重新下载。成果页也提供停留在 `verifying` 时的手动重验入口。任务引擎 19 项测试中模拟一份完好、一份损坏的已发布成果，重启恢复只完成完好作业，HTTP 请求数未增加；桌面服务 7 项、前端 9 项测试通过。新安装包在隔离目录升级后只读核验旧 USGS 作业：`completed`、3 项成果、缺失瓦片 0、有效 PNG；未打开账号授权页或下载新瓦片。
- 明确的 HTTP 404/410 单瓦片缺失现在会生成 `partial` 成果：GeoTIFF 对缺块保留透明像素，MBTiles 不写入缺失瓦片，manifest 保存缺失数量与 Z/X/Y；成果页和地图均标明部分完成，并提示在对话中改用其他图源或范围重新规划。所有瓦片都缺失时不发布空成果；401/403、429 与断网仍保留各自错误路径。`geod-core` 21 项、任务引擎 19 项合成图源测试通过，其中部分成果与完整、损坏成果均经过重启账本核验。新版安装包在隔离目录只读复检旧 USGS 完整成果仍为 `completed`、3 项成果、缺失瓦片 0、有效 PNG；此次没有请求新的外部图源，也没有打开网页登录。
- 已通过：`geod-core` 19 测试、`geod-task-engine` 18 测试、模型网关 7 测试、桌面服务 6 测试、GeoD OAuth 3 测试、地图格网几何 2 测试、模型成果上下文 2 测试；桌面前端构建、Rust Clippy `-D warnings`、NSIS 安装包构建及最新包的隔离升级。桌面服务新增测试在独立回环身份源和独立 Windows 凭据槽中，让过期访问令牌静默刷新，并在重建状态后复用新令牌；结束时检查测试凭据已删除，全程不打开浏览器。旧版安装包另通过隔离卸载冒烟。合成图源覆盖 GeoJSON 多边形、洞、透明 GeoTIFF/预览与完整瓦片 MBTiles；边界形状变化会改变审批哈希。此前原生窗口中用户批准的旧矩形计划已走完图源登记、批准、下载和成果核验；安装后复检同一作业时读取到 3 项成果、缺失瓦片为 0，预览为有效 PNG 数据。作业恢复及成果查看会核对成果的作业 ID，不会将其他作业的有效目录误认作自己的结果。
- 网关单元测试使用本地假身份服务和假 DeepSeek 响应。另用旧 GeoD 网关本地配置中已有的 DeepSeek 密钥，只在测试进程内调用官方 API：真实 `deepseek-flash` 先发出 `sources_list` 工具调用，接收测试图源结果后续答；两次请求实际结算 1,552 token，保留额度归零。密钥未写入本仓库。可在服务端设置 `DEEPSEEK_API_KEY` 后运行 `npm run smoke:deepseek` 复验。
- 原生桌面先用本地模拟 OAuth 服务联调，再连接本地真实 GeoD 账号 Next 服务、隔离注册的测试账号与真实 DeepSeek API：匿名登录跳转、同意授权、PKCE 换令牌、网关令牌检查、撤销均通过 HTTP；浏览器回跳进入 Windows 凭据库。桌面界面读取本机 1 个已授权 USGS 图源，并完成 `sources_list → 本机工具结果 → DeepSeek 续答`，最后一次真实账号联调结算 1,650 token，保留额度为 0。测试未发起下载，结束时调用登出并清理测试对话和账号数据。原生联调会打开系统浏览器，每次运行都需要显式设置 `GEOD_NATIVE_ALLOW_BROWSER_AUTH=1`；不再作为无提示的例行验证。本地测试身份来源使用与正式 GeoD 来源不同的 Windows 凭据槽。完整账号路线的隔离测试脚本位于本地忽略目录 `artifacts/oauth-server-smoke.mjs`。线上 GeoD OAuth 路由仍未发布，生产账号登录后的完整链路尚未验收。
- Linux x64 本地构建产物：`artifacts/linux-gateway-build/geod-agent-gateway-linux-x64-20260928-geojson-validated.tar.gz`，SHA-256 `69a6c52d87936f384b0763016531bb98c829ec80b92dc81b0a4ff9c819d5b405`，以 Node 22.23.2 在 Ubuntu WSL 安装生产依赖，更新 GeoJSON 工具合同后用 Node 22.22.3 再运行 7 项网关测试通过；`geod-oauth-studio-linux-x64-20260928.tar.gz`，SHA-256 `65b5e65d8d18d4a32c15980a587d4e68a534ab7e8a1e0fc4d6523fe5e226dc88`，基于现网 GeoD Studio 提交 `0984aed` 加两项 OAuth/品牌提交 `3ae9b71`、`9fb6f9d` 构建，20 项账号测试通过。Linux standalone 本地启动后，匿名跳转 303、用户同意 200、授权码交换 200、令牌检查 200、撤销后失效均通过；隔离账号数据在测试后清理。`geod-login-static-overlay-20260928.tar.gz`，SHA-256 `1425f0e594a89bbec9d035540a7fa3f4b40fa71dd8b13f344281d52504e8c425`，含 GeoD 品牌登录页及其 14 个引用的静态资源，引用完整性已检查。三个包均未上传生产服务器。
- 桌面任务已保存带计划和图源版本绑定的瓦片检查点；恢复时逐片核对大小、SHA-256 与像素尺寸，已校验瓦片不重复请求。网络暂时故障可在同一批准和作业 ID 下重试；主动暂停与崩溃后恢复均保留原批准和作业 ID。GeoJSON 目前仅处理不跨日期变更线的 WGS84 Polygon/MultiPolygon，未做自相交等完整拓扑验证；更多数据类型、源凭据引用与干净 Windows 安装回归尚未完成。
- 安装包未签名，尚未向用户发布或部署身份服务、网关。
- 新版桌面壳先注册 Tauri 单实例插件。`test/single-instance.ps1` 分别对 Release 程序和隔离安装目录程序执行双启动：第二进程退出码均为 0，原进程保持唯一；测试只停止自己启动的进程。NSIS 包在隔离目录静默升级，安装后只读 IPC 复检已批准 USGS 作业仍为 `completed`、3 项成果、缺失瓦片 0、有效 PNG。未打开账号授权页或发起影像下载。窗口唤回代码已编译，焦点变化未单独做自动化断言。
- 模型 `plan_imagery` 工具调用现在用生成请求 ID 与工具调用 ID 绑定本机计划 ID；应用崩溃后重新处理同一已结算工具调用时，先取回原计划，保留原输出目录、计划哈希与审批目标。账本测试跨进程重开、改变重放参数及另一工具调用，20 项通过；桌面 Rust 7 项、前端构建通过。新版 NSIS 在隔离目录安装后与包内程序一致，原生只读 IPC 复检旧 USGS 作业仍为 `completed`、3 项成果、缺失瓦片 0、有效 PNG。未运行会打开浏览器的模型联调，也未下载影像。

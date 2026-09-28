# GeoD Agent 账号与 DeepSeek 服务发布候选

状态：仅本地准备与只读生产核对；尚未上传、修改服务器、切换服务或对外发布。发布操作须取得当前用户授权。

## 对齐现网

- `geod.laogao.xyz` 已指向腾讯云主机 `62.234.147.130`。GeoD Studio 当前发布基线为 `0984aed`，服务在 `127.0.0.1:9114`；网站静态发布仍提供 `/login.html`。现网 `/api/geod/oauth/authorize` 为 404。
- 账号数据位于 `/srv/laogao/data/geod-studio/accounts/`，含 `store.json` 和受限权限目录。新 OAuth 路由复用此数据，不迁移或重建账号。
- 新模型网关拟绑定未占用的 `127.0.0.1:9115`，SQLite 放在 `/srv/laogao/data/geod-agent/agent-model.sqlite`。模型直接调用官方 DeepSeek API，供应商密钥只在服务端；桌面只取得 GeoD 授权令牌。
- 既有 Nginx 对 `/api/account/*` 仅开放列明的入口，其他 `/api/*` 返回 404。须仅给公众显式开放 `/api/geod/oauth/authorize`、`/api/geod/oauth/token`、`/api/geod/oauth/revoke` → 9114，以及 `/api/agent/` → 9115；内部令牌检查 `/api/geod/oauth/introspect` 只通过 9114 loopback 调用，不放开整个 `/api/`。`/api/agent/` 请求体上限至少 64 KiB，后端仍逐请求校验 GeoD 令牌与限额。

## 已验证候选

| 产物 | SHA-256 | 本地验证 |
| --- | --- | --- |
| `artifacts/linux-gateway-build/geod-oauth-studio-linux-x64-20260928.tar.gz` | `65b5e65d8d18d4a32c15980a587d4e68a534ab7e8a1e0fc4d6523fe5e226dc88` | 基于现网 `0984aed` 加 OAuth `3ae9b71` 与 GeoD 品牌 `9fb6f9d`；账号测试 20/20；Linux standalone HTTP 匿名跳转、同意、授权码、换令牌、检查与撤销全通过 |
| `artifacts/linux-gateway-build/geod-agent-gateway-linux-x64-20260928-geojson-validated.tar.gz` | `69a6c52d87936f384b0763016531bb98c829ec80b92dc81b0a4ff9c819d5b405` | Linux x64 生产依赖；GeoJSON 边界规划工具合同已更新；Node 22.22.3 网关测试 7/7；桌面使用真实 DeepSeek 联调通过 |
| `artifacts/linux-gateway-build/geod-login-static-overlay-20260928.tar.gz` | `1425f0e594a89bbec9d035540a7fa3f4b40fa71dd8b13f344281d52504e8c425` | GeoD 品牌登录页与静态资源；HTML 引用 14/14 存在。须叠加到现有网站的**新**不可变发布目录，保留其他页面 |
| `apps/geod-agent-desktop/src-tauri/target/release/bundle/nsis/GeoD Agent_0.1.0_x64-setup.exe` | `9ce6248aaf0d9ae91cb3e8150354a36df835ef363ed5bb746dee60a227fb0e0e` | Windows 构建；桌面服务 7 项、前端 9 项、核心 21 项、任务引擎 19 项测试；加入缺块部分成果、磁盘检查、模型请求和成果核验恢复；隔离安装后无 OAuth 启动，只读复检已批准 USGS 作业：`completed`、3 项成果、缺失瓦片 0、有效 PNG 预览 |

上表 Linux 包是本机可信 Ubuntu WSL 构建，不从生产服务器下载依赖。静态覆盖包只含登录页及其资源；部署前还需在服务器新目录中验证页面资源与现有 Nginx 静态路径配合，并在域名上做浏览器登录冒烟。

2026-09-28 再次只读核对：腾讯云主机剩余空间约 57 GiB，`nginx -t` 通过；`/srv/laogao/current/geod-studio` 仍指向 `geod-sources-20260927-0984aed`，`/srv/laogao/current/geod-website` 仍指向 `geod-source-sync-20260927-abc4b9b`。Studio 本机健康接口返回 200，OAuth 授权接口返回 404，9115 未监听；账号 `store.json` 解析通过、权限为 600，新 Agent 网关数据库尚不存在。三个本地包的 SHA-256 与上表一致；归档成员名无绝对或 `..` 越界路径，网关包内 3 个相对软链接均指向归档中的文件。模型网关 7 项测试与桌面服务 6 项测试再次通过。此检查只说明发布基线未漂移，不代表生产发布已获授权或完成。

安装包在此次候选审查后重新构建，加入 HTTP 429/5xx `Retry-After` 等待期间的取消与暂停。`geod-core` 和 `geod-task-engine` 分别 19、18 项测试及 Clippy 通过；在本地隔离安装目录升级后，原生程序只读复检已批准 USGS 作业为 `completed`、3 项成果、缺失瓦片 0、有效 PNG，独立文件校验再次通过。本次未打开授权浏览器或下载新瓦片；线上 OAuth 与 DeepSeek 仍未发布。

桌面任务账本再加固了同计划去重：不同请求编号或第二次审批仍返回原作业；历史对话按计划 ID 读取本机作业。任务引擎 18 项与桌面服务 6 项测试、桌面前端构建通过；新 NSIS 包在隔离目录静默安装退出码为 0，原生 `jobs_for_plan` 读取到已批准 USGS 作业及完整成果。此次仅更新本地 Windows 包，三个 Linux 服务包未变，线上服务未改。

随后增加磁盘空间预检：计划给出缓存与成果的保守空闲空间预算；下载前检查输出和缓存所在位置，低于预算报 `DISK_INSUFFICIENT`，用户释放空间后可沿用原审批和作业 ID 重试。旧 0.1 计划仍可读取。核心 20 项、任务引擎 19 项、桌面服务 6 项测试与前端构建通过；NSIS 包重新构建并在隔离目录静默升级，原生只读复检再次得到已批准作业的 3 项成果、缺失瓦片 0 和有效 PNG。此轮没有打开网页登录页，也没有下载新影像。空间预算只做开始前的保守检查，不保证运行期间磁盘可用量不变。

桌面请求恢复现保留模型请求编号、账号与上下文。响应丢失时先查询网关，确认未接收后用原编号重试；结算后的回答同步落盘。本次重新构建的安装包 SHA-256 已更新至上表；桌面前端 9 项、服务 7 项测试通过，在隔离目录安装后只读检查既有 USGS 作业仍为 `completed`、3 项成果、缺失瓦片 0、有效 PNG。该检查不触发浏览器授权；生产 OAuth 和 DeepSeek 仍未上线验收。

应用启动时会重验发布后停在 `verifying` 的本机成果，完整且属于原作业才补记完成；损坏则记失败。模拟重启的任务引擎测试验证两种结果，未增加瓦片请求。重新构建的安装包已在隔离目录升级，并只读复检已批准的 USGS 成果；最新 SHA-256 见上表。生产服务仍未更改。

明确的 HTTP 404/410 单瓦片缺失会发布标为 `partial` 的本机成果，manifest 记录缺失坐标；GeoTIFF 缺块透明、MBTiles 缺块不入库。全部瓦片缺失仍失败且不发布。合成图源完成该分支及重启账本验证；真实 USGS 完整样本在新版安装程序中仍能读取。未用外部图源制造缺块，线上账号与模型服务未改。

桌面版已加入单实例保护：重复启动不会创建第二个独立的登录回调或下载 worker。新 NSIS 包在隔离目录静默升级，Release 程序及安装后程序的双启动检查均得到一个留存进程；安装后原生 IPC 只读核验了既有 USGS 成果。未打开浏览器或访问图源；生产账号和模型服务仍未更改。

模型工具的 `plan_imagery` 重放现复用原计划 ID、目录与审批目标，避免崩溃恢复生成第二份计划。账本重启测试、前端构建、桌面 Rust 测试和隔离安装后的既有成果只读复检通过；NSIS SHA-256 已更新至上表。此轮没有生产部署、网页登录或新影像下载。

桌面 OAuth 的并发入口已收紧：预检前占用授权流程，第二次触发直接返回进行中；失败路径释放占用。无浏览器测试、NSIS 隔离升级和已批准 USGS 成果只读复检通过，安装包哈希已更新。此检查不代表生产账号服务上线。

2026-09-28 19:49（北京时间）再次只读核对：Studio 与网站 release symlink 仍为上文基线；9114 的 OAuth 授权接口返回 404，9115 没有监听；Studio 健康接口返回 200，`nginx -t` 通过，服务器可用空间约 56 GiB。Nginx 网站配置通过 `/srv/laogao/config/geod/routes.conf` 仅公开列明的账号与 Studio 路径，并保留 `/api/` 的 404 兜底。本地已准备 [限定路由配置](../../deploy/nginx/geod-agent-routes.conf)：只开放三个桌面 OAuth 入口与 `/api/agent/`，`introspect` 继续不公开；须在服务本机验收后、备份 routes.conf 后追加，并由生产 `nginx -t` 验证再 reload。此配置尚未上传或在生产 Nginx 中试装。

只检查了服务器 `/srv/laogao/secrets/geod-studio.env` 及同目录顶层 `*.env` 的变量**名称**，未发现 `DEEPSEEK_API_KEY` 或 `GEOD_AGENT_GATEWAY_SECRET`；没有读取或打印密钥值。这不证明其他位置不存在 DeepSeek 密钥。部署前仍须确认官方 DeepSeek 密钥来源，在受限服务端环境文件中设置它，并为 Studio 与 Agent 网关生成独立共享密钥；不得把它们写入归档或仓库。三个 Linux 发布包和本轮 NSIS 包的 SHA-256 已重新核对，与上表一致。

## 获批后的顺序

1. 再次核对当前 GeoD Studio、网站 symlink 及 Nginx 配置未漂移。对账号 `store.json` 做 JSON 解析检查；在有写入可能时先做一致性备份。备份现有 PM2 与 Nginx 配置。新网关 SQLite 创建后运行 `PRAGMA quick_check`。保留完整旧发布与回滚链接。
2. 从固定主机密钥的本地 SSH/SCP 上传三个 Linux 包到新的 `/srv/laogao/staging/` 子目录；服务器复核 SHA-256 与归档成员路径。只在各自新的 `/srv/laogao/releases/` 目录解包。不得在生产服务器或其 runner 上下载 GitHub 资源。
3. 保留现有账号会话、支付和其他服务环境，给 GeoD Studio 增加一个独立共享的 `GEOD_AGENT_GATEWAY_SECRET`。新网关使用同一密钥、`GEOD_IDENTITY_ORIGIN=http://127.0.0.1:9114`、`DEEPSEEK_BASE_URL=https://api.deepseek.com`、默认 `deepseek-flash`、服务端 `DEEPSEEK_API_KEY` 和持久数据库路径。密钥文件放 `/srv/laogao/secrets/` 并限权；不得进入包、Git、PM2 输出或日志。
4. 先在 loopback 启动新网关并验证 `/health` 与错误令牌 401。将 OAuth 版 Studio 作为新的不可变 release 切换 9114，验证既有 `/api/account/session`、`/api/geod-studio/health`、支付及图源入口无回归。账号 OAuth 路由先做 loopback 预检，再修改 Nginx；备份配置、`nginx -t` 通过才 reload。
5. 将登录页覆盖包叠加到**由当前网站 release 复制而成**的新目录，核对 14 个引用、页面 GeoD 品牌与 `returnTo`。切换网站 symlink。随后验证 `https://geod.laogao.xyz/api/geod/oauth/authorize` 对缺参请求返回约定 400、浏览器登录与授权回跳、`/api/agent/usage` 的认证行为以及真实 DeepSeek 对话；下载功能仍须用户逐计划批准。
6. 观察账号、网关、Nginx 的健康与错误、SQLite 完整性和额度结算；只报告已核实的上线功能。新的 Windows 安装包已完成隔离升级与启动，公开分发前仍需用户本机体验确认与最新版卸载回归。

## 回滚

记录切换前两个 release symlink 与 PM2 启动配置。异常时先停止新网关，恢复 Nginx 备份并执行 `nginx -t` 后 reload；将 GeoD Studio 与网站 symlink 原子指回旧 release，仅重启受影响服务。保留新网关数据库、账号备份与日志供对账；不盲目以旧 `store.json` 覆盖上线期间新写入的账号。恢复后再验收旧登录、账号会话、Studio 与静态网站。无需 DNS 变更。

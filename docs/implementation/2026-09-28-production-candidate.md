# GeoD Agent 账号与 DeepSeek 服务发布记录

状态：2026-09-28 经用户授权后，GeoD 账号 OAuth、DeepSeek 网关及 GeoD 登录页已切换到 `geod.laogao.xyz`。公开接口、服务端密钥、数据库与旧账号匿名接口已核验；最新桌面安装包已在隔离目录升级并只读复检。正式账号授权回跳和“登录后调用模型”的生产全链路仍待一次用户参与的验收。

## 上线前基线

- 切换前 `geod.laogao.xyz` 已指向腾讯云主机 `62.234.147.130`。GeoD Studio 发布基线为 `0984aed`，服务在 `127.0.0.1:9114`；旧网站提供 `/login.html`，当时 `/api/geod/oauth/authorize` 为 404。
- 账号数据位于 `/srv/laogao/data/geod-studio/accounts/`，含 `store.json` 和受限权限目录。新 OAuth 路由复用此数据，不迁移或重建账号。
- 新模型网关拟绑定未占用的 `127.0.0.1:9115`，SQLite 放在 `/srv/laogao/data/geod-agent/agent-model.sqlite`。模型直接调用官方 DeepSeek API，供应商密钥只在服务端；桌面只取得 GeoD 授权令牌。
- 既有 Nginx 对 `/api/account/*` 仅开放列明的入口，其他 `/api/*` 返回 404。须仅给公众显式开放 `/api/geod/oauth/authorize`、`/api/geod/oauth/token`、`/api/geod/oauth/revoke` → 9114，以及 `/api/agent/` → 9115；内部令牌检查 `/api/geod/oauth/introspect` 只通过 9114 loopback 调用，不放开整个 `/api/`。`/api/agent/` 请求体上限至少 64 KiB，后端仍逐请求校验 GeoD 令牌与限额。

## 已验证候选

| 产物 | SHA-256 | 本地验证 |
| --- | --- | --- |
| `artifacts/linux-gateway-build/geod-oauth-studio-linux-x64-20260928.tar.gz` | `65b5e65d8d18d4a32c15980a587d4e68a534ab7e8a1e0fc4d6523fe5e226dc88` | 基于现网 `0984aed` 加 OAuth `3ae9b71` 与 GeoD 品牌 `9fb6f9d`；账号测试 20/20；Linux standalone HTTP 匿名跳转、同意、授权码、换令牌、检查与撤销全通过 |
| `artifacts/linux-gateway-build/geod-agent-gateway-linux-x64-20260928-pm2-entry.tar.gz` | `2e8d846933705c51c9261b9008b31ad515c4be6399cd331ffc9a1ab0194994b4` | Linux x64 生产依赖与显式 `start.mjs` 入口；GeoJSON 边界规划工具合同已更新；网关测试 7/7，生产 PM2 在 9115 监听，健康接口和匿名 401 已验证 |
| `artifacts/linux-gateway-build/geod-login-static-overlay-20260928.tar.gz` | `1425f0e594a89bbec9d035540a7fa3f4b40fa71dd8b13f344281d52504e8c425` | GeoD 品牌登录页与静态资源；HTML 引用 14/14 存在。须叠加到现有网站的**新**不可变发布目录，保留其他页面 |
| `apps/geod-agent-desktop/src-tauri/target/release/bundle/nsis/GeoD Agent_0.1.0_x64-setup.exe` | `23929a16ee1f6c55010139728e715589bf763ea56e5377d8fd1df54c73945abe` | Windows 最新构建；启动时先检查本机凭据，不短暂误报“授权接口尚未上线”；隔离安装后无 OAuth 启动，只读复检已批准 USGS 作业：`completed`、3 项成果、缺失瓦片 0、有效 PNG 预览。旧版核心和任务引擎测试记录仍见下文 |

上表 Linux 包由本机可信 Ubuntu WSL 构建、补入显式 PM2 入口并在本地重新打包，不从生产服务器下载依赖。静态覆盖包只含登录页及其资源；新目录中的 14 个引用已验证，域名上的真实浏览器账号授权仍待验收。

2026-09-28 上线前再次只读核对：腾讯云主机剩余空间约 57 GiB，`nginx -t` 通过；`/srv/laogao/current/geod-studio` 当时指向 `geod-sources-20260927-0984aed`，`/srv/laogao/current/geod-website` 当时指向 `geod-source-sync-20260927-abc4b9b`。Studio 本机健康接口返回 200，OAuth 授权接口返回 404，9115 未监听；账号 `store.json` 解析通过、权限为 600，新 Agent 网关数据库尚不存在。当时候选包的 SHA-256 已核对；归档成员名无绝对或 `..` 越界路径，网关包内 3 个相对软链接均指向归档中的文件。模型网关 7 项测试与桌面服务 6 项测试再次通过。此检查只说明发布基线未漂移，不代表当时已上线。

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

上线前只检查了服务器 `/srv/laogao/secrets/geod-studio.env` 及同目录顶层 `*.env` 的变量**名称**，当时未发现 `DEEPSEEK_API_KEY` 或 `GEOD_AGENT_GATEWAY_SECRET`；没有读取或打印密钥值。这不证明其他位置当时不存在 DeepSeek 密钥。随后已按下文发布记录取得用户提供的密钥并配置受限环境文件；密钥没有写入归档或仓库。

## 2026-09-28 生产发布记录

- 按本次用户授权，使用固定主机密钥的 SCP 上传三个 Linux 包和限定路由配置到 `/srv/laogao/staging/geod-agent-20260928-65b5e65d-69a6c52d`。服务器 SHA-256 与本地候选一致，归档成员和三个软链接均限制在解包目录。发布前备份位于 `/srv/laogao/backups/geod-agent-20260928-65b5e65d`，含账号 `store.json`、原路由、原 Studio 环境文件、原 PM2 dump 及旧 Studio 回滚配置；备份账号 JSON 可解析。备份目录权限 700。
- 用户提供的 DeepSeek Key 经不回显的标准输入写入 `/srv/laogao/secrets/geod-agent.env`；独立服务间密钥由服务器生成，写入 Agent 与 Studio 两个环境文件。文件权限均为 600，密钥值不在仓库、包、命令参数或日志中。服务器向官方 DeepSeek 发送一条不含用户数据的短请求，返回有效回答并计费 9 token。
- 最初网关在 PM2 中显示在线但未监听：旧 `server.mjs` 只在直接执行时启动。补入显式 `start.mjs`、重打包并复核新哈希后，`geod-agent-deepseek-20260928` 稳定监听 `127.0.0.1:9115`。`/health` 为 200，未授权 `/api/agent/usage` 为 401，SQLite `PRAGMA quick_check` 为 `ok`。
- OAuth 版 Studio 先在 `127.0.0.1:9116` 作为临时候选运行，关闭影像恢复 worker。与旧 9114 的匿名健康、会话、图源与额度接口状态一致；无参 OAuth 授权请求为 400 `INVALID_OAUTH_REQUEST`，服务间检查接受共享密钥并判定未知令牌无效。随后删除临时候选、切换 9114；生产 Studio `geod-studio-geod-oauth-20260928` 健康为 200，旧账号匿名会话仍为 200、图源入口仍为 401。原 Studio PM2 记录已移除，旧发布和回滚配置保留。
- 静态网站从原发布复制到新目录后叠加 GeoD 登录页，14 个本地资源全部存在。`current` 链接现在分别指向 `geod-oauth-20260928-65b5e65d`、`geod-deepseek-20260928-2e8d8469` 和 `geod-agent-login-20260928-1425f0e5`。Nginx 仅加入 [限定路由](../../deploy/nginx/geod-agent-routes.conf)，`nginx -t` 通过后 reload；PM2 新进程均在线、重启次数为 0，`pm2 save` 已写入两个新进程。
- 从服务器及 Windows 客户端直接核对 `https://geod.laogao.xyz`：OAuth 无参入口 400 `INVALID_OAUTH_REQUEST`，匿名模型额度 401，内部 `/api/geod/oauth/introspect` 为 404；登录页包含 GeoD 品牌。公开 Studio 健康为 200，匿名账号会话为 200、图源入口为 401。账号 JSON 仍可解析，网关 SQLite 完整性检查为 `ok`。这些检查没有打开浏览器授权页，也未使用正式账号令牌进行生成请求；因此生产账号登录、PKCE 回跳和登录后的 DeepSeek 对话仍需验收。
- 有效但匿名的公开 OAuth 请求曾返回 `https://localhost:9114/login`，原因是现有 Studio 构建按内部请求地址拼接了绝对跳转。已备份当前路由到 `routes.before-oauth-redirect.conf`，只在授权入口加入 Nginx `proxy_redirect`，`nginx -t` 通过并 reload；Windows 客户端再次请求得到 HTTP 303 和站点内 `/login`。Studio 源码同步改成相对跳转并通过 3 项 OAuth 测试；该源码修复尚未重新打入当前生产 Studio 包，当前线上由限定路由修正。
- Windows NSIS 包重新构建为上表哈希，隔离安装目录升级后已通过原生 IPC 只读复检：已批准 USGS 作业仍为 `completed`，3 项成果、缺失瓦片 0、有效 PNG 预览。安装后的 EXE 与 Release EXE 同尺寸，二进制仅有 3 字节不同；构建日志显示 Tauri 对 Release EXE 写入 NSIS 包类型信息。检查未触发新授权或下载。

## 2026-09-28 账号页面与 OAuth 修正

- 网站登录页改用 GeoD 官网横向标识、蓝白视觉和一致的响应式布局，保留邀请码注册与安全的站内 `returnTo`。网站发布为 `geod-account-20260928-81122cd8`，原网站 release 记录在 `/srv/laogao/backups/geod-agent-20260928-65b5e65d/website-before-geod-account.txt`。桌面与 390px 真移动视口均完成视觉和表单交互检查，公开 `/login` 与静态资源返回 200。
- 用户实际授权时遇到 `ORIGIN_REJECTED`。旧确认页返回 `Referrer-Policy: no-referrer`，导致浏览器的同站表单提交携带 `Origin: null`，被服务端的 CSRF 校验拒绝。先备份并限定修复 Nginx OAuth 路由的响应头；公开匿名同源 POST 随后返回预期的 `401 AUTH_REQUIRED`。
- 正式身份服务改用 GeoD 官网视觉的授权确认页、HTML 转义后的账号及 OAuth 表单值，以及 `Referrer-Policy: origin`。GeoD Studio 源码位于 `geostyle-web` 提交 `b54686a`，独立 Linux 发布工作树提交 `21157c1`。4 项 OAuth 测试和 TypeScript 检查通过；授权页在 390px 与桌面视口无横向溢出。
- 新 Linux Studio 包 `geod-oauth-studio-consent-linux-x64-20260928.tar.gz` 的 SHA-256 为 `d408012d2c89ac94f8781c1e64a10d8a5597c7008eb644794438637d2e4e810b`。服务器复核哈希并解包到 `geod-oauth-consent-20260928-d408012d`；9116 候选通过 OAuth 站内跳转、同源 POST 守卫与旧账号会话检查。备份当前账号 JSON 与旧 release 指针后，9114 切换到新 release，PM2 在线且重启次数为 0。公开 OAuth 匿名 GET 为站内 303，匿名同源 POST 为 `401 AUTH_REQUIRED`，公开 `/login` 为 200。旧 Studio release 与备份保留。
- 桌面本机对话已按 GeoD 账号隔离；旧版未归属对话只在用户点击“导入到当前账号”后复制，旧版未完成生成不会自动归属。桌面构建及 11 项测试通过。这一源代码修正尚未重新封装为安装包；目前运行中的安装版仍是上一版。
- 以上不代表真实账号完成 PKCE 回跳或 DeepSeek 对话。需要用户在已安装的桌面应用中重试一次授权并发送一条普通对话，才能验收完整闭环；不得自动弹出新的授权网页。

## 原定获批发布顺序（供复盘）

1. 再次核对当前 GeoD Studio、网站 symlink 及 Nginx 配置未漂移。对账号 `store.json` 做 JSON 解析检查；在有写入可能时先做一致性备份。备份现有 PM2 与 Nginx 配置。新网关 SQLite 创建后运行 `PRAGMA quick_check`。保留完整旧发布与回滚链接。
2. 从固定主机密钥的本地 SSH/SCP 上传三个 Linux 包到新的 `/srv/laogao/staging/` 子目录；服务器复核 SHA-256 与归档成员路径。只在各自新的 `/srv/laogao/releases/` 目录解包。不得在生产服务器或其 runner 上下载 GitHub 资源。
3. 保留现有账号会话、支付和其他服务环境，给 GeoD Studio 增加一个独立共享的 `GEOD_AGENT_GATEWAY_SECRET`。新网关使用同一密钥、`GEOD_IDENTITY_ORIGIN=http://127.0.0.1:9114`、`DEEPSEEK_BASE_URL=https://api.deepseek.com`、默认 `deepseek-flash`、服务端 `DEEPSEEK_API_KEY` 和持久数据库路径。密钥文件放 `/srv/laogao/secrets/` 并限权；不得进入包、Git、PM2 输出或日志。
4. 先在 loopback 启动新网关并验证 `/health` 与错误令牌 401。将 OAuth 版 Studio 作为新的不可变 release 切换 9114，验证既有 `/api/account/session`、`/api/geod-studio/health`、支付及图源入口无回归。账号 OAuth 路由先做 loopback 预检，再修改 Nginx；备份配置、`nginx -t` 通过才 reload。
5. 将登录页覆盖包叠加到**由当前网站 release 复制而成**的新目录，核对 14 个引用、页面 GeoD 品牌与 `returnTo`。切换网站 symlink。随后验证 `https://geod.laogao.xyz/api/geod/oauth/authorize` 对缺参请求返回约定 400、浏览器登录与授权回跳、`/api/agent/usage` 的认证行为以及真实 DeepSeek 对话；下载功能仍须用户逐计划批准。
6. 观察账号、网关、Nginx 的健康与错误、SQLite 完整性和额度结算；只报告已核实的上线功能。新的 Windows 安装包已完成隔离升级与启动，公开分发前仍需用户本机体验确认与最新版卸载回归。

## 回滚

记录切换前两个 release symlink 与 PM2 启动配置。异常时先停止新网关，恢复 Nginx 备份并执行 `nginx -t` 后 reload；将 GeoD Studio 与网站 symlink 原子指回旧 release，仅重启受影响服务。保留新网关数据库、账号备份与日志供对账；不盲目以旧 `store.json` 覆盖上线期间新写入的账号。恢复后再验收旧登录、账号会话、Studio 与静态网站。无需 DNS 变更。

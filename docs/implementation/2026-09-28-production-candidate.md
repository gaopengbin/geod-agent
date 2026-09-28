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
| `apps/geod-agent-desktop/src-tauri/target/release/bundle/nsis/GeoD Agent_0.1.0_x64-setup.exe` | `e7c4b57e05f76b42db1168b44b1501aef75ef01e9d96856b92ae8fdb3808f8b2` | Windows 构建、桌面服务测试 5/5；MapLibre 格网、覆盖与模型上下文共 4 项测试；隔离目录静默升级后，最新原生程序无 OAuth 启动并重新核验已批准 USGS 作业：`completed`、3 项成果、缺失瓦片 0、有效 PNG 预览；独立文件校验通过 |

上表 Linux 包是本机可信 Ubuntu WSL 构建，不从生产服务器下载依赖。静态覆盖包只含登录页及其资源；部署前还需在服务器新目录中验证页面资源与现有 Nginx 静态路径配合，并在域名上做浏览器登录冒烟。

2026-09-28 再次只读核对：腾讯云主机剩余空间约 57 GiB，`nginx -t` 通过；`/srv/laogao/current/geod-studio` 仍指向 `geod-sources-20260927-0984aed`，`/srv/laogao/current/geod-website` 仍指向 `geod-source-sync-20260927-abc4b9b`。Studio 本机健康接口返回 200，OAuth 授权接口返回 404，9115 未监听；账号 `store.json` 解析通过、权限为 600，新 Agent 网关数据库尚不存在。三个本地包的 SHA-256 与上表一致；归档成员名无绝对或 `..` 越界路径，网关包内 3 个相对软链接均指向归档中的文件。模型网关 7 项测试与桌面服务 5 项测试再次通过。此检查只说明发布基线未漂移，不代表生产发布已获授权或完成。

## 获批后的顺序

1. 再次核对当前 GeoD Studio、网站 symlink 及 Nginx 配置未漂移。对账号 `store.json` 做 JSON 解析检查；在有写入可能时先做一致性备份。备份现有 PM2 与 Nginx 配置。新网关 SQLite 创建后运行 `PRAGMA quick_check`。保留完整旧发布与回滚链接。
2. 从固定主机密钥的本地 SSH/SCP 上传三个 Linux 包到新的 `/srv/laogao/staging/` 子目录；服务器复核 SHA-256 与归档成员路径。只在各自新的 `/srv/laogao/releases/` 目录解包。不得在生产服务器或其 runner 上下载 GitHub 资源。
3. 保留现有账号会话、支付和其他服务环境，给 GeoD Studio 增加一个独立共享的 `GEOD_AGENT_GATEWAY_SECRET`。新网关使用同一密钥、`GEOD_IDENTITY_ORIGIN=http://127.0.0.1:9114`、`DEEPSEEK_BASE_URL=https://api.deepseek.com`、默认 `deepseek-flash`、服务端 `DEEPSEEK_API_KEY` 和持久数据库路径。密钥文件放 `/srv/laogao/secrets/` 并限权；不得进入包、Git、PM2 输出或日志。
4. 先在 loopback 启动新网关并验证 `/health` 与错误令牌 401。将 OAuth 版 Studio 作为新的不可变 release 切换 9114，验证既有 `/api/account/session`、`/api/geod-studio/health`、支付及图源入口无回归。账号 OAuth 路由先做 loopback 预检，再修改 Nginx；备份配置、`nginx -t` 通过才 reload。
5. 将登录页覆盖包叠加到**由当前网站 release 复制而成**的新目录，核对 14 个引用、页面 GeoD 品牌与 `returnTo`。切换网站 symlink。随后验证 `https://geod.laogao.xyz/api/geod/oauth/authorize` 对缺参请求返回约定 400、浏览器登录与授权回跳、`/api/agent/usage` 的认证行为以及真实 DeepSeek 对话；下载功能仍须用户逐计划批准。
6. 观察账号、网关、Nginx 的健康与错误、SQLite 完整性和额度结算；只报告已核实的上线功能。新的 Windows 安装包已完成隔离升级与启动，公开分发前仍需用户本机体验确认与最新版卸载回归。

## 回滚

记录切换前两个 release symlink 与 PM2 启动配置。异常时先停止新网关，恢复 Nginx 备份并执行 `nginx -t` 后 reload；将 GeoD Studio 与网站 symlink 原子指回旧 release，仅重启受影响服务。保留新网关数据库、账号备份与日志供对账；不盲目以旧 `store.json` 覆盖上线期间新写入的账号。恢复后再验收旧登录、账号会话、Studio 与静态网站。无需 DNS 变更。

# 0.2.1 正式网关上线

状态：2026-10-04 经用户「那就更新一下」授权，正式 GeoD Agent 网关已更新；真实账号、模型工具协议、Credits 发放/扣费及重启持久化通过。没有安装或重装本机桌面程序。

## 固定版本与部署范围

- 源提交：`b6d4ea5d326c227f3d6c351c4bf1ba2e3a4255bc`，发行标签 `v0.2.1`。
- 归档：`geod-agent-gateway-0.2.1-linux-x64.tar.gz`，5,611,175 字节。
- SHA-256：`c90df9dec46c8e9d9b2c694bb2392558d7302c4de16826f2a839bbee40b26f62`。
- 线上目录：`/srv/laogao/releases/geod-agent/geod-agent-0.2.1-20261004-b6d4ea5`，由 `/srv/laogao/current/geod-agent` 选择。
- 新 PM2 服务：`geod-agent-0.2.1-20261004`，Node 22.23.2，监听 `127.0.0.1:9115`。旧服务 `geod-agent-source-config-20260930` 停止并保留。
- 只更新 Agent 网关及必要的既有域名路由；GeoD 账号、其他服务、DNS、证书和本机下载进程没有切换。

使用已在本机 Linux 环境构建并测试的包，通过固定主机密钥 SSH 上传。服务器未下载 GitHub 或 npm 资源。解包前验证归档摘要和成员路径，实际核对 1,786 个文件及四个内部链接。旧账本一致性副本在空闲 loopback 端口完成启动和迁移验证；未认证请求返回 401，没有发放虚构生产账号额度。

## 配置与数据

正式环境从原来的全局不限额测试配置切到体验钱包：

```text
GEOD_AGENT_QUOTA_MODE=enforced
GEOD_AGENT_WELCOME_CREDITS=20000
GEOD_AGENT_WELCOME_POLICY_ID=geod-agent-welcome-v1
```

现有 GeoD 登录、上游凭证、模型和持久目录沿用。供应商密钥没有复制到包、仓库或部署输出。

- 既有用量：`/srv/laogao/data/geod-agent/agent-model.sqlite`。
- 体验钱包：`/srv/laogao/data/geod-agent/agent-model.sqlite-credits.sqlite`。
- SQLite 完整性检查均为 `ok`；上线后按旧数据库列逐行核对，原有 184 条模型请求和 550 条用量记录均保留。
- 钱包目录权限 700，数据库和配置权限 600；赠送记录与余额保持在持久目录，不能随发布目录清理。
- 充值配置未启用，没有支付订单、充值入口或真实现金扣款。本机不限额开发网关继续使用原配置。

Nginx 增加三个经过 GeoD OAuth 验证的只读接口：`/v1/payments/status`、`/products`、`/wallet`；其余支付路径返回 404。OAuth `introspect` 仍只供内部使用，公众返回 404。Codex 流式入口单独配置 48 MiB 请求体上限，由网关继续执行 48,000,000 字节校验；常规 Agent 请求上限为 192 KiB。代理关闭响应缓冲，保留流式输出。`nginx -t` 通过后才 reload。

## 正式验证

使用本机现有 GeoD 授权，通过正式 HTTPS 地址验证，没有新建测试账号、传出令牌或调用替代身份服务：

1. 身份及钱包端点未认证访问均返回 401。
2. 当前账号首次启用钱包实际到账 20,000 Credits；重复查询只有一条赠送记录。
3. 正式 DeepSeek Flash 通过 Codex 流式合同返回 `deployment_ping` 工具及正确参数。供应商计量为 364 输入 token、109 输出 token，服务端实际结算 3.2 Credits，余额为 19,996.8 Credits；预留余额已释放。
4. 使用相同请求编号重放，余额不变、扣费记录仍一条。
5. 重启正式 PM2 网关后再次读取钱包并重放请求：仍一条赠送、一条扣费、19,996.8 Credits。
6. 未认证的超过旧 64 KiB 上限请求通过新版路由后仍被拒绝为 401，不触发模型费用；现金订单路由和公开身份检查端点保持 404。

发布期间发现隔离端口占用、路由目录权限和 PM2 配置文件识别问题并完成修正；一次切换未通过健康检查后自动恢复旧服务，未删除或回滚数据库。最终服务启动、重启、公开接口及账本检查通过。

## 备份与回退

- 部署前一致性数据库、旧环境文件、路由和 PM2 配置：`/srv/laogao/backups/geod-agent-0.2.1-20261004-b6d4ea5`，目录权限 700。
- 真正到账和扣费后的两份 SQLite 一致性副本：同目录 `after-live-acceptance/`。
- 旧入口：`/srv/laogao/releases/geod-agent/geod-agent-source-config-20260930-0f42eb2d/start.mjs`。
- 回退时只停止新 Agent 服务，恢复旧配置及链接，启动保留的旧服务并验证 Nginx 和健康端点。保留最新数据库；不要用部署前副本覆盖已经到账或结算的余额。

本地验收凭据在 `artifacts/gateway-deploy-0.2.1-20261004/public-acceptance.json`；服务器对应 staging 目录保存候选、部署和重启回执。发行资产清单保存的是构建时状态，此记录说明随后实际上线的结果。原始发布包、标签和校验值不变。

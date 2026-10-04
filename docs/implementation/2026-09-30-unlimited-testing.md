# GeoD Agent 测试不限额度（2026-09-30）

用户要求测试功能时取消额度限制。本次改为真正关闭模型额度准入拦截，保留真实用量、请求预留/结算、幂等请求和结果恢复。

- 网关配置 `GEOD_AGENT_QUOTA_MODE=unlimited`；默认和非法配置仍受校验。测试模式的用量接口返回 `quotaEnforced: false`，`limitTokens` 与 `remainingTokens` 为 `null`，不伪装成一个更大的有限额度。
- 原有 200K 配置可用于以后显式恢复 enforced 模式，本次不清零用量或删除历史。
- 客户端显示「测试模式 · 不限额度」，以 K 展示已用及当前请求记账，不显示余额不足门槛。
- 本地网关/账本 12 项测试通过，覆盖用量已超预算仍允许新请求、真实结算、重复请求不重计费、恢复 enforced 后原用量保留、原有未知上游恢复和权限合同。前端 TypeScript 与生产构建通过。
- 已发布 `/srv/laogao/releases/geod-agent/geod-agent-testing-unlimited-20260930-5b084885`；更新 server.mjs、ledger.mjs、reconcile.mjs，沿用依赖与现有数据文件，无数据库结构迁移。
- 数据库与额度配置备份：`/srv/laogao/backups/geod-agent-testing-unlimited-20260930-1300`（目录 700，数据库/配置 600）。SQLite quick_check、发布文件 SHA-256 与 9115 健康检查通过。
- 回滚：恢复备份的配置、将 current/geod-agent 指回 `geod-agent-extensions-20260930-3ab70aea`，停止新 PM2 服务并重启旧服务；不回滚用量数据库。
- 新版桌面程序已构建并启动，窗口响应正常。原生用量接口确认无限模式、limitTokens/remainingTokens 均为 null；实际剩余额度原本不足固定 20K 门槛的账号已成功发出真实模型请求，返回「测试通过」，状态 settled，用量从 187,049 增至 190,555，请求中额度回到 0。
- 真实证据保存在 `artifacts/unlimited-native-evidence-20260930.json`，账号用量面板截图 `artifacts/unlimited-account-20260930.png` 已确认显示「测试模式 · 不限额度」。

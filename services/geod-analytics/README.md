# GeoD 独立运营报表

新版同时读取 GeoD `authAudit`、桌面 `download_task_state`、Agent
`agent_events`。采集元数据缺失时显示不可用，而不是零。账号分类由管理员
设置，内部、外部与未分类分开显示。
见[接入与验证说明](../../docs/implementation/2026-10-02-geod-telemetry-improvements.md)。

GeoD 的运营查询统一从这里运行。账户始终来自 GeoD Studio 的账号服务，
和微信工具箱的平台账户分开。只生成本地聚合快照，不迁移账户、不写生产库。

## 一次刷新

在本仓库运行：

```powershell
rtk proxy powershell -NoProfile -File scripts/Get-GeoDAnalytics.ps1 -Days 7
```

结果在 `artifacts/analytics/<时间>/`：

- `snapshot.json`：机器可读聚合数据，含来源、状态、北京时间和统计口径。
- `report.html`：本地可打开的 GeoD 独立报表。
- `report.md`：可复用的文字摘要。

可指定 `-OutputDirectory`；`-Until '2026-10-02T10:00:00+08:00'` 固定截止时间。
默认覆盖最近 7 个北京时间自然日，最后一天截至采集开始时刻。
脚本复用本机腾讯云技能的固定主机密钥 SSH helper；只通过 stdin 执行 Python
标准库读取器，不上传文件、不装依赖、不重启服务。所有 SQLite 使用只读模式。

## 数据边界

| 内容 | 唯一来源 | 口径 |
|---|---|---|
| GeoD 账号 | `/srv/laogao/data/geod-studio/accounts/store.json` | GeoD Studio / Agent 账号；邀请注册、会话和 OAuth |
| 旧桌面匿名使用 | `/srv/laogao/data/geod-telemetry/geod-telemetry-v2.sqlite` | 同意上报的匿名安装 ID、会话和事件 |
| GeoD 官网 | 平台数据库的 `product_events` 表 | **强制 `product='geod-web'`**，过滤包括最新事件时间在内的所有查询 |
| Agent 模型用量 | `/srv/laogao/data/geod-agent/agent-model.sqlite` | 请求状态和已结算 input/output token |

平台库读取器有 SQLite authorizer，禁止读取 `accounts`、`account_sessions`、
`completed_exports`、支付和微信表。官网使用共享事件基础设施，不共享账户统计。
不把微信工具箱的用户数、导出数、关注数或订单混入 GeoD。
不使用匿名 ID 关联账号或跨产品关联，也不将三类 ID 相加为“总用户”。
来源缺失、损坏或 schema 不兼容时返回 `unavailable` 与 `metrics=null`，
不会回退到另一个产品账户库，不会显示零活动。

## 解释限制

- 新注册以 GeoD 账户 `createdAt` 为准；现存记录包含可能的内部测试账号。
- 会话包含注册后自动登录；登出会删除记录，所以“保留会话”不是完整历史登录次数。
- OAuth grant 没有创建时间；只展示当前保留 grant 涉及的账号，不按条数当登录次数。
- 模型 token 仅计算 `settled` 请求，失败和待对账单列；不能据此认定外部用户或付费。
- 本机开发网关未部署的调用，不在生产网关报表内。
- 桌面下载创建不等于完成；CLI/MCP 和 Agent 本机下载结果仍是统计缺口。
- 来源独立读取，采用相同截止时间，但不是跨库原子快照。
- 账号/会话/OAuth 尚无完整历史审计，因此过去截止时间是现存记录的筛选，
  不是当时权限、邮箱验证或账号状态的历史恢复。
- 不导出邮箱、用户名、账户/设备/会话 ID、token/hash、模型内容或本机路径。

## 验证

```powershell
rtk proxy python -X utf8 -m unittest discover -s services/geod-analytics -p "test_*.py" -v
```

测试将大量微信账户与事件写入共享库，确认 GeoD 结果不变；同时验证禁止跨表读取、
只读、北京时间边界、缺源不当成零、敏感数据不输出及 HTML 转义。

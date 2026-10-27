# GeoD Agent 0.2.13 发布回执

正式版本：[v0.2.13](https://github.com/gaopengbin/geod-agent/releases/tag/v0.2.13)，源码提交 `92a4e39520f2a0c77bb948da3bbf7e6caa0cba60`。本次包含谷歌历史影像本机下载、窗口同步调用阻塞修复，以及已验证的任务前置条件、状态复用、反馈和恢复改进。

- 使用原签名身份，指纹 `fb26751b09df20b891ac62f2971bdefcef72c7c0485ffa38a3641676707bc655`；没有生成替代密钥。加密恢复文件从旧 Codex 应用隔离路径复制到当前用户的规范发布目录，源文件保留并核对摘要。
- 全量安装包 SHA-256：`2cf883d51cf4fceb0a2871cdb7815e22c7d7eb71a421a363e7d7fc590feea083`，257,550,757 字节。
- 本地签名、公开文件白名单、13,318 个运行时载荷文件和真实 Tauri updater SDK 9 项测试通过；SDK 从本机 HTTPS 读取真实候选包，没有执行安装。
- COS 上传回执和 GitHub 附件摘要核对通过，GitHub 正式发布 21 个附件。官网中英文页面及官网/CDN 两个小更新索引均已实际读回并与本地预期核对。
- 新在线索引 SHA-256：`78c48ae78132e179b4a56d6ffa8671438005069e64f26661ddc2b3ade97a770a`；旧索引 `46aea5c32223fccc760b5722de07d89763da3df95a823933b05586fab8c5d221` 已保留。
- 公告 `geod-agent-release-033` 已发布，priority=important，action=update，适用 0.2.0–0.2.12。读取筛选确认 0.2.12 可见、0.2.13 不显示旧升级提醒、旧 GeoD 不在受众中。
- 当前开发客户端读取公告返回 `IDENTITY_UNAVAILABLE`，因此该客户端实际收到通知保持未确认；不把服务端发布和版本筛选核验当作每个客户端已经送达。
- 本次验证未下载完整 CDN 安装包；网关代码和额度规则未改变。没有触发本机安装或替换用户配置。

网站与原更新入口备份：`/srv/laogao/backups/geod-agent-033-20261027`。公告发布前 SQLite 备份：`/srv/laogao/backups/geod-agent-release-033-notice-20261027-132909/agent-model-before.sqlite`。本地回执在 `artifacts/release-033-20261027/`，包含 `release-complete.json`、`public-verification.json`、`message-notification.json`、`sdk-acceptance/result.json` 和可断点恢复的 `flow/journal.json`。

回滚使用对应 staging 的 `release_activate.py --rollback`，先核对当前指针仍属于这次发布；CDN 索引另用备份和当前 SHA 条件恢复。没有删除旧正式文件，不能跨系统宣称原子回滚。

# 本地任务账本

日期：2026-09-28。状态：计划、批准和排队作业的持久化已实现；下载 worker 和完成状态尚未实现。

`crates/geod-task-engine/src/ledger.rs` 在独立 SQLite 数据库中保存计划、用户批准、作业和有序事件。首次打开建表；遇到比程序更新的数据库版本拒绝继续写入。作业启动在 `BEGIN IMMEDIATE` 事务内检查计划哈希、过期时间、当前图源指纹、对应批准和幂等键，然后写入唯一作业与首条事件。重复请求返回同一个作业 ID；同一批准不能用不同键再次创建作业。

批准接口必须由用户点击确认的桌面 UI 调用，不能注册为模型工具。当前账本只创建 `queued` 状态，不会因为入队就下载或宣称完成。下载 worker 接入后必须只通过任务引擎推进状态，并在成果文件检查后发布终态。

验证：

```powershell
rtk cargo test --manifest-path crates/geod-task-engine/Cargo.toml
rtk cargo clippy --manifest-path crates/geod-task-engine/Cargo.toml --all-targets -- -D warnings
```

测试覆盖重启后读取、相同幂等键返回原作业、重复使用批准被拒、过期计划、来源配置变化、错误哈希、缺失批准和较新数据库版本。

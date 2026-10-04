# GeoD Agent 下载缓存管理

## 已接入的能力

- 当前缓存统计：历史任务数、共享瓦片数量、实际磁盘占用、超过七天的共享瓦片、不可读目录。
- 完整性核验：索引字节数、SHA-256、图片格式与像素解码；异常只记录，不自动删除用户文件。
- 历史缓存整理：依据任务账本读取原计划、图源与注记版本，核对 checkpoint 的完整 binding；通过后复制进正确 source revision 的共享目录。
- 目录迁移：预检目标、文件数、体积、磁盘余量；分块复制、逐文件 SHA-256 比较、保留文件修改时间、核验 SQLite；最后原子写入缓存位置配置。旧目录保留。
- 后台进度、取消、关闭后继续、重新打开恢复进行中的状态。
- 同一进程内维护互斥；有运行中的影像任务时不能开始维护，维护过程中也不能开始或恢复影像任务。

旧桌面 `cache_migration.rs` 作为行为参考只读检查，确认其主要能力是更改存储目录。本实现没有复制旧仓库代码或绑定旧产品运行路径。旧桌面缓存格式不与 Agent 的已验证图源 binding 等价，因此不猜测图源后直接导入旧桌面任意缓存。

## 数据与时间规则

新配置存于任务数据库同目录的 `cache-location.json`。没有该文件时继续使用原 `tile-cache`。该位置是运行设置，不进入用户计划哈希；TaskStore 的下载和完成后清理都读取同一个解析函数。

历史 checkpoint 文件没有独立的远程获取时间字段。整理新共享条目时使用保留的 checkpoint 修改时间，不能把整理时间写作新下载时间；已存在且有效的相同哈希不会更新 `saved_at`，已有更新条目也不被旧文件覆盖。普通共享缓存七天过期后重新联网获取；用户明确要求只用缓存的导出可继续读取过期缓存。

目录迁移保持 checkpoint 修改时间以及共享数据库中的 `saved_at`。迁移失败或取消时不切换原配置，临时复制目录清理；若最终目录已提交而设置写入失败，仍保留原配置及已复制的目标目录供检查。

## 文件与接口

- `crates/geod-core/src/cache_maintenance.rs`：统计、校验、历史整理、目录预检与迁移。
- `apps/geod-agent-desktop/src-tauri/src/cache_management.rs`：后台操作状态与活动任务互斥。
- `apps/geod-agent-desktop/src/cache-manager.tsx`：账号设置中的紧凑缓存面板。

原生命令：`cache_inventory`、`cache_maintenance_start`（`verify` / `migrate`）、`cache_maintenance_status`、`cache_maintenance_cancel`、`cache_relocation_preflight`、`cache_relocation_start`。

AI 可查询/核验及取消维护；目录选择和迁移从用户界面明确触发。

## 验收证据

- Core 四项测试通过：绑定改变拒绝、SHA/大小/像素尺寸拒绝、注记版本隔离、共享时间不刷新、迁移后 SQLite 可读、文件保留、取消不切换目录。
- 对本机真实缓存只读检查：41 个索引条目、2,464,038 字节、0 个无效条目。见 `evidence/cache-audit-2026-10-02.json`。
- 原生互斥测试通过：正在运行的下载和另一维护操作均被拒绝；维护结束释放入口。
- 实际原生命令 UI 验收通过：真实统计、首次后台核验完成、目标已存在预检拒绝、亮/暗/390px 窄屏与重新打开。下载中的任务开始后，核验/整理/迁移入口禁用；后续截图测试使用只读模式，不打断其他实际下载。
- `evidence/cache-manager/acceptance.json` 与三张截图已保存并逐张检查。窄屏按钮原先换行，已修为固定操作宽度。

验证入口：`rtk cargo test --manifest-path crates/geod-core/Cargo.toml --lib cache_maintenance`；`apps/geod-agent-desktop/test/cache-manager-native-ui.mjs`。

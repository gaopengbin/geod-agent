# 矢量与三维数据定时任务

## 实现

- `data_schedules.rs` 使用同一原生 SQLite 中的独立 `data_schedules` / `data_schedule_runs` 表，未借用影像任务类型。
- 创建时保存原任务的请求快照、账号、会话及工作区。每次触发调用真实的数据任务规划器，生成独立目录、计划摘要及 occurrence 幂等键。
- 原生后台每 3 秒检查。应用必须保持运行。错过的重复周期合并为一次；仍在执行、待确认或正在取消的 occurrence 不会叠加新的运行。
- 完全访问允许启动；逐次确认只生成待确认任务。每次启动重新读账号、工作区和权限。改变工作区会停止此次运行并给出错误。
- 暂停只停止未来触发。取消本次会取消对应原生任务；工作线程确认取消前仍保留“正在取消”，不提前报告停止。
- 每次定时下载使用独立缓存命名空间，避免新周期沿用旧矢量快照；同一次运行重试保留已核验缓存。
- 重启后未完成的数据任务成为中断状态，不会凭旧授权静默恢复；任务卡片可重试。
- 影像和矢量/三维各自的定时面板复用现有控件和样式。矢量/三维运行可直接定位到统一任务列表。

## 原生命令

| 命令 | 参数 |
| --- | --- |
| `data_schedules_create` | `conversationId`, `taskId`, `name`, `nextRunAt`, `repeatSeconds?`, `executionId` |
| `data_schedules_list` | `conversationId` |
| `data_schedules_runs` | `conversationId` |
| `data_schedules_set_enabled` | `scheduleId`, `enabled`, `nextRunAt?` |
| `data_schedules_cancel_run` | `runId` |

注册后在原生 setup 中调用 `data_schedules::start(app.handle().clone())`。

## 已有数据任务验收

`evidence/vector-native-2026-10-02.json` 记录真实 Tauri IPC：

- MapLibre 公共 MVT：221 个要素，PBF / MBTiles / GeoJSON / GPKG 四种输出。
- OSM 柏林范围：13 个建筑，GeoJSON / GPKG；记录服务端数据时间。
- 幂等、计划摘要校验、跨会话隔离、确认模式、完全访问、后台立即返回、运行中取消、待办丢弃，共 11 项通过。

## 定时验收

- `data_schedules::tests` 2/2 通过，覆盖 SQLite 持久化、账号隔离、错过周期合并、运行不重叠、暂停、一次性取消及权限决策。
- `test/native-data-schedules.mjs` 6/6 通过，使用实际系统时间、原生循环和公共 MVT 服务，覆盖逐次确认、完全访问、动态权限降级、不可变工作区及取消。实际下载 221 个要素，证据 `evidence/data-schedules-native-2026-10-02.json`。
- `test/data-schedules-ui.mjs` 通过，生产面板连接实际原生存储，鼠标创建每天任务、暂停、启用及刷新。已查看深色及 300px 浅色窄面板截图，无横向溢出。证据 `evidence/data-schedules-ui/acceptance.json`。
- 实际 App 中的模型、下载与预览整体验收独立记录，不由上述面板测试替代。

## 成果完整性

原子目录提交后若应用退出而 SQLite 尚未写入完成，恢复时必须重新核验全部文件并匹配请求。矢量核对 plan hash，三维核对源指纹与范围；不会覆盖已有目录。允许部分导出时，原生任务显示 `partial`，不宣称完整下载。

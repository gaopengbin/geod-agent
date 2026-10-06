# 开发进程与打包宿主分离

## 当前证据

- 原隔夜任务已停止，统一终端 `63559` 和 QA 桌面进程均不存在。保留原 `result.json`，另写 `external-interruption-20261006.json`；9/26 次真实运行成功，18 项真实用量已结算且已知，测试身份续期 4 次。完整恢复、重开及清理未完成，不能视为完整隔夜验收通过。具体停止原因尚未证明。
- 当前终端属于带关闭即清理限制的 Windows Job。原开发启动脚本只隐藏窗口并建立进程组，不能据此保证进程独立存活。
- `GetFinalPathNameByHandleW` 实际返回原生数据在 `OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Roaming`，日志在 `LocalCache/Local`。迁移前独立进程只读检查证实，普通用户的 GeoD 原生数据目录和 WebView 目录均不存在；原资料位于 Codex 私有目录。随后已按下述流程复制到普通用户目录，保留来源。

Windows 的 [AppData 虚拟化说明](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization) 与这一文件观察一致。父进程和桌面应用策略使用官方 [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) 接口，并核对本机 SDK 的属性定义。

## 已验证的修补

`windows_detached_process.py` 和 `windows_explorer_launch.py` 为开发辅助进程建立隐藏启动流程。启动请求放在仓库产物目录，避免宿主 AppData 重定向；日志使用实际文件句柄解析出的物理路径。环境变量直接通过进程创建接口传入内存，不写入启动请求、参数或回执。

启动流程核对 Windows 用户、子进程身份、Job 归属及包身份。桌面应用策略允许引导程序建立独立子进程；没有修改账户权限、应用注册或安装目录。

实际测试：`artifacts/windows-independent-launch-20261006/probe-278a207ca482ca02/result.json`。

- 创建受控宿主 Job，并实际关闭该 Job。
- 宿主进程退出后，子进程保持运行并继续写入心跳。
- 子进程不属于 Windows Job，也没有继承宿主的包身份。
- 两个测试进程最终退出；没有模型请求或用户数据写入。

开发桌面和本地网关启动脚本已采用这一辅助模块，并在读取 AppData、日志和本地网关库之前自动分离整个启动入口。两个真实入口的 `--inspect-launch-context` 只读检查通过，回执分别为 `development-desktop-entrypoint-de649bb5d15d432e.json` 和 `development-gateway-entrypoint-264e8907be4c008b.json`：普通用户 AppData、无宿主包身份、不属于 Windows Job，随后正常退出；没有访问供应商凭据或启动产品副本。

实际产品窗口、本地网关及长时控制器已用独立路径恢复启动；前面失败的启动尝试回执保留。长时验收仍在进行，启动通过不代表完整跨日运行通过。

## 数据保留与下一步

`inspect-independent-profile-context.py` 的实际独立检查回执为 `profiles-readonly-c951fc11f3209188.json`。

`migrate-development-host-profile.py` 先检查每个目的目录均不存在，拒绝自动覆盖或合并。复制时保留原目录，逐文件比对目标与来源校验值，并再次检查来源未变。原生数据、WebView 数据和本地开发网关记录分别处理；不会替换安装产物或修改注册表。

只读预检 `profile-preflight-febce3e3771d26fa.json` 已实际完成：三个目的目录都不存在，来源分别为 424,003、12,401 和 20 个文件，合计约 8.7 GB。外层 50 秒观察超时后没有重启进程；原进程最终正常结束并写入通过回执。

复制与完整校验已通过：`profile-copy-aaf25f33f07f5f29.json`。独立进程 74124（创建时间 1791265715.259199）于 2026-10-06 05:48:37 UTC 开始，06:21:50 UTC 完成，随后退出。三个目录共 436,424 个文件、8,695,535,071 字节，目标逐文件哈希相符，来源再次校验均未改变。启动前系统盘可用空间约 67.5 GB；没有删除来源、替换安装产物或修改注册表。

开发窗口已恢复。`development-restoration.json` 通过实际 WebView 和原生接口核对：31 会话原始 JSON、活动会话、待恢复条目和语言与原备份逐项一致；16 个图源和四个数据库连接一致；本地不限额、现金充值及历史路由开关保持。后台没有自动启动 AI、命令或下载。截图为 `development-restored.png`，已实际检查渲染。

当前开发前台 75684、后台 96872、本地网关 86904 均不属于 Windows Job，也没有继承包身份，创建时间与可执行文件已记录。原生版本仍是 0.2.0，前端使用当前开发源码热更新，这不是 0.2.2 安装升级。`profiles-restored-c620fd19db338b89.json` 的独立只读观察确认普通用户的原生及 WebView 目录存在，Codex 私有来源保留。

前端开发服务器 26584 和测试 Node 控制进程 59040 在后续观察中各属于一个 Job。`node-job-owners-3218937baa209d9a.json` 进一步读取实际 Job 成员及持有者：两个已观察 Job 的成员均仅有各自 Node，句柄也由对应 Node 持有，限制标志为 15360；没有观察到 Codex 持有这两个 Job 的句柄。不能将 Node 称为所有 Job 之外，但这两个实际 Job 没有显示宿主归属。

归属检查只复制 Job 查询句柄，未分配进程、修改限制、终止用户进程或读取进程内存。公开查询接口依据 [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject) 和 [DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle)，私有句柄结构参考 [System Informer 的 phnt 源码](https://github.com/winsiderss/phnt/blob/master/ntexapi.h)。两项其他 Job 持有者查询权限不足已保留在回执，不将观察扩大为系统所有 Job 的完整验收。

完整 26 次半小时测试已重新启动：`fixture-35e44abefd2f7567`，2026-10-06 06:34:18 UTC 开始，会经过北京时间午夜。独立控制器 66008（创建时间 1791268452.0874765）和专用后台 36592 均无宿主包身份、不属于 Windows Job；专用窗口已关闭，第一轮真实 DeepSeek/工作区工具完成。沿用 585 项当前源码逐项相符的 0.2.2 QA，不安装普通候选，不修改系统时间或到期时间。仍须全部周期、续期、停机、异常恢复、重开及清理完成后才能更新通过状态。

旧 QA 的合成身份、个人渠道及本轮计划已清理，原始失败回执和运行历史保留。`finish-interrupted-schedule-qa.py` 先核对测试账户、60331 的明确本机身份来源及原拥有进程都不再存活；备份两个测试 SQLite 库后，按原生渠道移除合同删除明确拥有的系统凭据、渠道及默认选择，并禁用该测试计划，不改到期时间。删除后确认两个系统测试凭据不存在，没有读取真实登录或供应商凭据值，没有模型调用。

实际回执位于 `fixture-b7af3bbafc2c137c/`：`interrupted-identity-cleanup-20261006.json`、`interrupted-owned-state-cleanup-20261006.json` 和 `interrupted-unowned-state-preserved-20261006.json` 均通过。152 个用量代、73 次运行及 5,497 项事件内容不变；13 份保留的会话选择和 23 项其他测试计划与备份逐行一致。个人用户资料未改动，清理结果不代表原 26 次跨日验收通过。

0.2.2 固定发行候选没有重新构建、安装或发布。正式路由、现金充值与外部多模型费用测试的授权边界继续保持。

# 开发进程与打包宿主分离

## 当前证据

- 原隔夜任务已停止，统一终端 `63559` 和 QA 桌面进程均不存在。保留原 `result.json`，另写 `external-interruption-20261006.json`；9/26 次真实运行成功，18 项真实用量已结算且已知，测试身份续期 4 次。完整恢复、重开及清理未完成，不能视为完整隔夜验收通过。具体停止原因尚未证明。
- 当前终端属于带关闭即清理限制的 Windows Job。原开发启动脚本只隐藏窗口并建立进程组，不能据此保证进程独立存活。
- `GetFinalPathNameByHandleW` 实际返回原生数据在 `OpenAI.Codex_2p2nqsd0c76g0/LocalCache/Roaming`，日志在 `LocalCache/Local`。独立进程只读检查证实，普通用户的 GeoD 原生数据目录和 WebView 目录均不存在；原资料仍在 Codex 私有目录，尚未复制或合并。

Windows 的 [AppData 虚拟化说明](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization) 与这一文件观察一致。父进程和桌面应用策略使用官方 [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) 接口，并核对本机 SDK 的属性定义。

## 已验证的修补

`windows_detached_process.py` 和 `windows_explorer_launch.py` 为开发辅助进程建立隐藏启动流程。启动请求放在仓库产物目录，避免宿主 AppData 重定向；日志使用实际文件句柄解析出的物理路径。环境变量直接通过进程创建接口传入内存，不写入启动请求、参数或回执。

启动流程核对 Windows 用户、子进程身份、Job 归属及包身份。桌面应用策略允许引导程序建立独立子进程；没有修改账户权限、应用注册或安装目录。

实际测试：`artifacts/windows-independent-launch-20261006/probe-278a207ca482ca02/result.json`。

- 创建受控宿主 Job，并实际关闭该 Job。
- 宿主进程退出后，子进程保持运行并继续写入心跳。
- 子进程不属于 Windows Job，也没有继承宿主的包身份。
- 两个测试进程最终退出；没有模型请求或用户数据写入。

开发桌面和本地网关启动脚本已采用这一辅助模块。实际产品窗口和长时控制器尚未用这条路径恢复启动，不能扩大为全部运行验收通过。前面失败的启动尝试回执保留。

## 数据保留与下一步

`inspect-independent-profile-context.py` 的实际独立检查回执为 `profiles-readonly-c951fc11f3209188.json`。

`migrate-development-host-profile.py` 先检查每个目的目录均不存在，拒绝自动覆盖或合并。复制时保留原目录，逐文件比对目标与来源校验值，并再次检查来源未变。原生数据、WebView 数据和本地开发网关记录分别处理；不会替换安装产物或修改注册表。

当前仅启动了只读预检：`profile-preflight-febce3e3771d26fa.json`，进程 43584，创建时间 1791264621.8457751。50 秒的外层观察等待已结束，独立校验进程经再次核对仍存活；未因此重启校验。

预检完成后才能复制并恢复开发版，再核对 31 会话原始记录、活动会话、待恢复条目、语言、16 个图源及本地计费状态。随后清理原 QA 所有的测试身份和渠道，并重新执行完整跨日验收。新的 26 次运行尚未启动。

0.2.2 固定发行候选没有重新构建、安装或发布。正式路由、现金充值与外部多模型费用测试的授权边界继续保持。

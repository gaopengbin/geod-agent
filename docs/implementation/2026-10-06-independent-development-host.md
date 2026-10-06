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

恢复时的开发前台 75684、后台 96872、本地网关 86904 均不属于 Windows Job，也没有继承包身份，创建时间与可执行文件已记录。该阶段原生版本是 0.2.0，前端使用当前开发源码热更新；后续 0.2.2 开发切换另记于本页收尾章节。`profiles-restored-c620fd19db338b89.json` 的独立只读观察确认普通用户的原生及 WebView 目录存在，Codex 私有来源保留。

迁移后的原连接已实际读取：`restored-postgis-connections.json`。先确认 Docker 引擎处于停止状态，通过独立入口启动现有 Docker Desktop；启动回执为 `docker-start-d559a7fa52ad6970.json`。原 `geod-agent-postgis-test` 自动恢复为健康状态，仍使用固定镜像摘要和 `127.0.0.1:55438`，没有新建容器、修改连接配置或读取管理密码。

真实开发 WebView 经 Rust IPC 使用四个保存的连接，调用内置 pgEdge MCP 对 `demo.boundaries_3857.geom` 分别读取一条样例、字段及坐标系。四项均只读、返回 `EPSG:3857`，实际 MCP 工具调用成功，样例摘要相同；无需重新输入系统保存的连接密码。31 会话原始 JSON、待恢复记录、活动会话、语言、图源数、连接配置及后台 PID 前后保持。没有模型请求、边界导入或数据库写入；这四个原连接没有启用 TLS，不将本轮称为迁移后全部证书类型验收。

前端开发服务器 26584 和测试 Node 控制进程 59040 在后续观察中各属于一个 Job。`node-job-owners-3218937baa209d9a.json` 进一步读取实际 Job 成员及持有者：两个已观察 Job 的成员均仅有各自 Node，句柄也由对应 Node 持有，限制标志为 15360；没有观察到 Codex 持有这两个 Job 的句柄。不能将 Node 称为所有 Job 之外，但这两个实际 Job 没有显示宿主归属。

归属检查只复制 Job 查询句柄，未分配进程、修改限制、终止用户进程或读取进程内存。公开查询接口依据 [QueryInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject) 和 [DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle)，私有句柄结构参考 [System Informer 的 phnt 源码](https://github.com/winsiderss/phnt/blob/master/ntexapi.h)。两项其他 Job 持有者查询权限不足已保留在回执，不将观察扩大为系统所有 Job 的完整验收。

新测试 `fixture-35e44abefd2f7567` 于 2026-10-06 06:34:18 UTC 启动，沿用 585 项当前源码逐项相符的 0.2.2 QA。用户随后收紧发布目标并要求停止重复测试，故在三次真实半小时周期和一次测试身份续期后提前结束，不把它记作完整 26 周期或跨日通过。`user-requested-early-stop.json` 记录范围调整；使用明确测试身份的原生接口禁用其计划并正常停止空闲后台，控制器随即执行原有清理流程。12 阶段清理全部通过，测试凭据/本轮计划/进程均已安全清理，原窗口、网关和历史保持。复用已有完整八周期、续期与异常恢复结果，不再追加整夜等待。

旧 QA 的合成身份、个人渠道及本轮计划已清理，原始失败回执和运行历史保留。`finish-interrupted-schedule-qa.py` 先核对测试账户、60331 的明确本机身份来源及原拥有进程都不再存活；备份两个测试 SQLite 库后，按原生渠道移除合同删除明确拥有的系统凭据、渠道及默认选择，并禁用该测试计划，不改到期时间。删除后确认两个系统测试凭据不存在，没有读取真实登录或供应商凭据值，没有模型调用。

实际回执位于 `fixture-b7af3bbafc2c137c/`：`interrupted-identity-cleanup-20261006.json`、`interrupted-owned-state-cleanup-20261006.json` 和 `interrupted-unowned-state-preserved-20261006.json` 均通过。152 个用量代、73 次运行及 5,497 项事件内容不变；13 份保留的会话选择和 23 项其他测试计划与备份逐行一致。个人用户资料未改动，清理结果不代表原 26 次跨日验收通过。

0.2.2 固定发行候选没有重新构建、安装或发布。正式路由、现金充值与外部多模型费用测试的授权边界继续保持。

## 当前源码的开发原生程序

原恢复窗口运行 0.2.0 原生代码，前端热更新来自 0.2.2；因此另行构建当前源码的开发程序。按用户收紧要求，开发切换不再等待跨日测试，仅在实际确认用户程序空闲、保存旧程序后执行。

`build-current-development-native.py` 已于 2026-10-06 07:10:01–07:16:14 UTC 完成一次独立构建。使用新的目标目录、锁定依赖、离线缓存和两个编译并行任务，没有运行安装器、替换运行中的程序或向编译器传入测试供应商凭据。

实际回执：`artifacts/development-native-current-20261006/build-b49aeaa1117d5bc3/build.json`。

- 585 项产品源码与正在进行的完整 QA 相同，构建前后没有产品输入变化。
- Windows 文件版本为 `0.2.2.0`，应用标识为 `dev.geod-agent.desktop`；独立开发程序 105,569,280 字节，SHA-256 为 `773853afb601321979283e6765e9346e814dc024c9efad2b302e813c067cc6d4`。
- 原开发程序字节摘要不变；原前台、后台、网关、跨日顶层控制器及专用后台的 PID、创建时间和可执行路径保持。
- 编译进程正常退出。构建回执捕获时尚未启动，故其 `runtimeVerified=false` 保留；后续实际登录/历史与核心读取检查以 `development-switch-after.json` 为准，不追改构建时的事实。

这份程序用于下一次开发原生验证，不改变固定的 0.2.2 安装包、免安装 ZIP 或 Linux 网关归档。新的用户资料恢复、原生用量历史及既有连接能力须在实际切换后再核对。

## 保存引用与附件补验

独立进程检查 510 份当前原生 JSON 配置/附件元数据，共约 1.2 MB。`profile-json-reference-audit-324821dbb597fb13.json` 最初发现 17 个工作区的目录字段引用 Codex 私有原生目录；按真实 `SHA-256(owner:conversation)` 规则与当前 31 会话交叉核对，均为旧记录，没有属于当前会话的绑定。这一检查排除 SQLite 历史、备份归档、重建依赖及加密凭据文件，不扩大为所有历史内容的路径审计。

先备份 17 个目的目录配置，再核对旧/新工作区目录中的 30 个文件内容相同；只把目的目录配置的 `directory` 字段改为已经复制到普通用户目录的对应路径。每项其他字段保持，旧目录及原文件保留，新目录文件没有改动。实际通过回执为 `workspace-reference-rebase-3ccfdcc627e3a4ee/result.json`，原配置备份位于同一目录。

第一次修补被路径门禁拒绝：Rust 保存的 `\\?\` 路径前缀与普通路径表示不同。该次没有任何备份或配置改写，错误日志 `workspace-reference-rebase-3fe99fae2bbdac12.log` 保留；随后明确仅规范本机盘符路径，再执行完整归属/目录/内容检查，没有跳过路径边界。

修补后的同范围检查 `profile-json-reference-audit-after-809403d0b35d1d72.json` 通过：510 份 JSON 中没有剩余的私有目录绝对引用，也没有不可读/无效 JSON。`workspace-rebase-user-state-preserved.json` 经真实 WebView 再次核对 31 会话原始内容、活动会话、待恢复记录、语言和后台 PID 不变。

`restored-attachment-reads.json` 经当前原生程序实际读取同一账号保留的 51 个已发布文档/音频附件和七张图片，全部通过。原生文档读取校验全文摘要，返回的原文件/文本摘要和字符数与保存的元数据一致；图片读取校验原文件摘要并成功返回预览。检查没有重新解析、修改附件、发送模型请求或把正文/像素写进回执；这些附件也包括不在当前侧栏的原生历史记录，不能将数量当作 31 个会话中可见的附件数。

## 本轮收尾与当前可体验版本

2026-10-06 已完成开发原生切换，运行版本为 **0.2.2**，前端热更新继续保留，没有运行安装包。记录位于 `artifacts/development-native-current-20261006/build-b49aeaa1117d5bc3/`：`development-switch-before.json`、`development-binary-switch.json`、`development-switch-after.json`。前台 21560（创建时间 1791273163.762805）和后台 63532（1791273166.2586265）均无宿主包身份、不属于 Windows Job；原网关 86904 保持。

一次必要的切换检查覆盖启动版本、登录、31 会话原始 JSON、待恢复条目、活动会话、语言、16 个图源、四个保存连接及空闲后台，全部保持。选取一个保存的 PostGIS 连接做一次原生/MCP 只读查询成功。完整记录原生命令已注册；本机旧网关未开放该功能时返回 `PAYMENT_HISTORY_UNAVAILABLE`，界面保留最近记录，不把未发布路由描述为已上线。没有新模型请求或追加全量回归。旧开发程序保存在同目录的 `previous-development-native-0.2.0.exe`；如需恢复，正常退出桌面及后台后将其复制回原 `src-tauri/target/debug/geod-agent-desktop.exe`，再用已有开发启动入口启动。

迁移后的三份操作账本只读检查完成：17 个子任务、53 个计划、47 次运行和 33 个后台命令的当前配置没有旧私有目录引用。138 条历史事件含 935 个当时的路径值，作为历史保留，不改写日志或已确认命令的哈希。原始扫描回执 `sqlite-reference-audit-c24eb984601447b4.json` 的路径存在标记与后续 `classification.operationalPathCheckPassed` 分别表示历史路径存在和当前配置检查通过；不将两者混为全部路径都不存在。

本轮交付范围按产品缺口页的“本轮必须完成 / 延后 / 已取消”执行。固定 0.2.2 发行候选未重建或改写；正式发布、八条只读记录路由上线仍待原有授权，真实收费和正式自动更新继续关闭。

# GeoD Agent 0.2.2 发布审阅

2026-10-05，最近更新 2026-10-06。本轮按用户收紧要求收尾可审阅、可体验的预发行候选；当前开发原生版本为 0.2.2，核心切换检查通过。固定发行候选尚未上传 GitHub 或切换正式服务；实际安装升级/回滚、整夜跨日、真实系统重启和全新 Windows 留作后续，不阻塞本轮候选交付。

## 本版变化

- 完整用量、预留、订单和退款记录，支持时间筛选、分页与全量 CSV；旧服务不支持时明确提示不可用。
- Windows 安装向导加入简体中文和英文。欢迎页与取消已实际检查；初始语言选择框保留 NSIS 英文提示。
- 保持新账号一次 20,000 Credits 赠送、现有模型费率及隐藏的赞助入口；现金充值和退款仍关闭。

## 已完成的验证

| 范围 | 结果 |
| --- | --- |
| 网关与记录 | 84 项 Windows/Linux 检查、实际浏览器及原生记录操作通过；实际 Linux 归档的八条只读路由、重启与完整 CSV 通过。 |
| 正式账本副本 | 两个实际归档完成隔离升级、回退及再升级；185 次请求、553 条用量、赠送和余额保持，正式服务未修改。 |
| 新 Windows 候选 | 991 项构建输入保持；更新签名、9 项实际更新库检查、24,944 个资源逐文件核对及六项向导界面观察通过。更新签名不等于 Windows 代码签名。 |
| 后台定时 | 独立原生 QA 持续约 3 小时 36 分钟；八个半小时周期、三次续期、197 秒实际停机、异常恢复、明确重试和重开界面通过，完整清理完成。 |
| 开发目录整合 | 提交 `4258f57` 已快进合入 `G:\code\geod-agent`。合入前后原 31 个会话的原始 JSON 摘要、当前会话、一个待恢复记录的摘要、语言、两项桌面进程、网关 PID/创建时间和启动项保持。没有重装或重启这些进程。 |

长测使用独立 QA 程序；与普通候选的调度和授权实现关系已核对，二进制不同。开发目录本轮仅整合源码和前端热更新，运行中的原生进程未重新编译/替换；新原生记录能力另由独立 QA 验收。欢迎页检查也不代表安装升级已完成。

## 固定发行文件

文件及完整 SHA-256 见 [完整候选](2026-10-05-payment-history-release-candidate.md)。本机可审阅产物位于独立候选目录：

- [Windows 安装包](<G:/code/geod-agent-payment-history-candidate/artifacts/release-candidate-0.2.2-bilingual-installer-20261005/GeoD Agent_0.2.2_x64-setup.exe>)，510,426,111 字节。
- [Windows 免安装 ZIP](G:/code/geod-agent-payment-history-candidate/artifacts/release-candidate-0.2.2-bilingual-installer-20261005/GeoD-Agent-0.2.2-windows-x64.zip)，687,928,470 字节。
- [Linux 网关归档](G:/code/geod-agent-payment-history-candidate/artifacts/gateway-release-0.2.2-payment-history-20261005/geod-agent-gateway-0.2.2-linux-x64.tar.gz)，5,612,350 字节。
- [固定摘要清单](G:/code/geod-agent-payment-history-candidate/artifacts/release-review-0.2.2-20261005/SHA256SUMS.txt)及 [审阅清单](G:/code/geod-agent-payment-history-candidate/artifacts/release-review-0.2.2-20261005/release-review.json)。清单已重新读取三份归档及更新签名的实际字节，并核对 585 项冻结产品输入和对应回执。后续文档/审阅脚本提交不会追改已构建包。

发行说明为 [中文/英文审阅稿](../releases/0.2.2.md)。该路径尚不是 GitHub 下载链接。

## 下一步待授权范围

建议将本次文件发布为现有私有仓库的 **0.2.2 预发行版本**，并更新正式网关的以下八条已认证、只读路由。正式切换仍需新的备份、隔离端口验证及切换后核验，不用旧备份覆盖新记录。

| 记录 | 分页 | 全量导出 |
| --- | --- | --- |
| 用量 | `GET /v1/payments/history/usage` | `GET /v1/payments/history/usage/export.csv` |
| 预留 | `GET /v1/payments/history/reservations` | `GET /v1/payments/history/reservations/export.csv` |
| 订单 | `GET /v1/payments/history/orders` | `GET /v1/payments/history/orders/export.csv` |
| 退款 | `GET /v1/payments/history/refunds` | `GET /v1/payments/history/refunds/export.csv` |

现金开关、赠送数量和模型费率保持；本次建议不启用正式自动更新、不覆盖本机已有安装。安装升级、Windows 代码签名、真实收费及供应商/企业数据库/OAuth 账号验证各自保留后续验收。

目标约定要求完整候选可审阅后取得正式发布授权。此前仅四条用量路由的待答复问题没有覆盖本次新增的订单、退款及导出范围，不能代替这次授权。

## 复查证据

- 长测：主目录 `artifacts/schedule-stability-native-20261005/fixture-6b042703fa08885c/`，终态与 15 阶段清理均通过。
- 源码关系：候选目录 `artifacts/schedule-release-review-20261005/source-comparison.json`。
- 整合保留：候选目录 `artifacts/main-integration-20261005/before.json`、`after.json`，只保存摘要，不复制用户聊天正文或凭据。
- 发行清单：`scripts/prepare-closeout-review.py --schedule-run <长测证据目录> --output <新的 artifacts 子目录>`；仅本地读取、核验和输出清单，没有安装或发布操作。

随后补齐了 [当前 31 会话完整备份及隔离恢复](2026-10-05-current-profile-backup.md)：维护机制恢复了用户后台，前台与网关保持。整合源码的新独立 QA 的 585 项产品输入与本候选一致（仅行尾差异）；追加长测按用户收紧要求提前结束并清理，详见 [定时稳定性](2026-10-05-schedule-stability.md)。没有替换固定发行文件或改变待授权范围。

## 2026-10-06 开发环境恢复补验

首轮整合源码跨日测试在 9/26 次真实周期后中断，原失败回执保留，测试身份、渠道和计划已按归属清理。已查明开发入口的 Windows 宿主管理及 AppData 重定向问题，补齐独立启动入口；约 8.7 GB 原资料保留来源复制、逐文件校验通过。

实际恢复后的普通用户目录核对通过：31 会话原始 JSON、待恢复条目、活动会话、语言、16 个图源、四个数据库连接及本地不限额状态保持。现有 Docker 测试环境恢复后，四个保存的 PostGIS 连接均通过真实 Rust IPC / pgEdge MCP 只读查询，无需重新输入密码，原连接配置及会话未改动。该恢复阶段原生窗口为 0.2.0；后续开发切换另记于下段。0.2.2 固定候选未重建或安装。

独立启动的新测试 `fixture-35e44abefd2f7567` 按用户收紧目标在三个真实周期、一次测试身份续期后提前结束，12 阶段专用清理通过，不标记为完整 26 周期或跨日通过。复用已有八周期及异常恢复证据。本次补验不代替安装升级、回滚、系统重启或外部供应商账号验收，待授权的发布和正式只读路由范围保持。实际回执和启动归属详见 [独立开发环境记录](2026-10-06-independent-development-host.md)。

另已在新目标目录构建与 QA 的 585 项源码相同的 0.2.2 开发原生程序，实际 Windows 文件版本 `0.2.2.0`。旧程序已备份，当前用户窗口与后台现已运行 0.2.2，保留开发热更新。一次针对版本切换的核心检查通过：原登录、31 会话原始 JSON、恢复记录、语言、16 个图源及四个保存连接保持，单个保存 PostGIS 连接实际只读查询成功。新完整记录命令已注册，本机尚未开放路由时正确返回可查看最近记录的提示。停止追加重复回归。固定发行产物未改写，没有安装升级或正式发布。

保存引用补验发现并修正 17 条旧工作区的私有目录引用，目录内 30 个文件新旧一致，逐项备份后只修改目的配置的目录字段，来源保留。当前 31 会话及其绑定未改动；510 份配置/附件 JSON 的同范围复查通过。51 个已发布文档/音频与七张图片通过原生实际读取和摘要检查，没有新模型调用。随后一次操作账本检查确认当前子任务、计划、运行及后台命令配置没有旧目录引用；含旧路径的历史事件原样保留，不改已确认命令哈希。其他归档未展开全量调查；详见独立开发记录。

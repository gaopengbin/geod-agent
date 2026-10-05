# GeoD Agent 0.2.2：完整记录整合候选

状态：2026-10-05。本地普通 Windows 候选和 Linux 网关归档已生成，并通过下列检查。多小时后台验收已完整结束，独立分支 `codex/payment-history-candidate` 已快进合入主目录；原数据及进程保持。没有安装、上传 Release、部署网关或启用更新渠道。简要范围及下一步授权见 [发布审阅](2026-10-05-release-review.md)。

后续核对发现安装向导只包含英语。已加入简体中文和英文，并完成新候选的首页/取消、签名、实际资源和更新下载独立核验；本页 Windows 摘要已更新为 `bilingual-installer-20261005`，旧 `payment-history-20261005-retry1` 的产物和回执保持。详见 [双语安装向导](2026-10-05-installer-i18n.md)，发行说明审阅稿见 [0.2.2](../releases/0.2.2.md)。

## 范围

包含已有 Credits 全量记录，以及新增的订单、退款完整分页、时间筛选和 CSV。沿用 0.2.1 每个新账号一次的 20,000 Credits 赠送；本轮没有改变赠送、模型费率、订阅权益或现金开关。赞助入口继续隐藏。功能和原生界面证据见 [完整支付记录](2026-10-05-payment-history.md)，计费建议见 [审阅稿](2026-10-05-billing-review.md)。

普通程序身份为 `dev.geod-agent.desktop`，产品名为 `GeoD Agent`，版本 `0.2.2`，前端随包。沿用原 Windows 受保护签名身份，程序内嵌固定 HTTPS 更新地址和公钥；编译、包装使用公开环境，安装包完成后独立签署。渠道地址尚未部署或启用，更新签名不等于 Windows Authenticode 代码签名。

## 已完成的核验

| 检查 | 本次结果与边界 |
| --- | --- |
| 来源冻结 | 最新双语候选的 991 项仓库输入在编译、包装前后保持。此前 CRLF/LF 变化触发停止的失败资料保留；工具定义在冻结前生成，并使用 LF 属性。 |
| 与原生界面验收的关系 | 原 QA 与前一完整记录候选的比对保留；最新包相比该候选只有 NSIS 语言配置变化，585 项其他相关产品文件保持。QA、前一普通候选和新普通候选是不同二进制。 |
| 独立签名复核 | 完整安装包摘要、公钥、更新签名、内嵌渠道、来源和私钥扫描通过，原固定资产保持。 |
| 实际 NSIS 解包 | 8 组环境、24,944 个资源逐文件核验；主程序与免安装程序仅有 Tauri NSIS 标记差异。没有执行安装。 |
| 实际更新库 | Tauri updater 2.13.1 的 9 项检查通过：完整下载/签名、篡改、错误密钥、错误/缺失签名版本、相同/旧版本、截断和不可信 TLS。使用本次完整 510 MB 安装包和回环 HTTPS；MockRuntime 不安装程序或根证书。 |
| 双语安装向导 | 实际新包六项语言选择/欢迎页/取消观察通过，原注册值、安装文件和四个受保护进程保持。只覆盖欢迎和取消；初始选择框沿用 NSIS 英文提示，后续安装阶段仍待实机验收。 |
| 实际包内环境 | 前一候选的六项 GIS、加密文档、CPU OCR、旧 Office、SQL 驱动和 DBHub stdio 检查保留。最新包的八组清单及实际资源字节相同，没有把旧运行检查当作新主程序启动验收。 |
| Linux 实际归档 | 84 项测试、1,787 个文件/4 个内部链接核对，以及 8 条只读路由、重启游标和精确 CSV 通过。无公开网络、真实商户请求或资金操作。 |
| 正式账本副本升级/回退 | 只读取得 0.2.1 快照，用两个实际归档完成本机 0.2.2 → 0.2.1 → 0.2.2：185 次请求、553 条用量和一次赠送/结算保留，余额不变；正式进程、数据和路由前后保持。现有账号采用本机认证适配器，没有解密旧回复或切换正式服务。 |
| 多小时原生后台 | 独立 QA 持续 12,953 秒，8 个真实半小时周期、三次续期、197 秒停机补执行、异常恢复/明确重试和重开界面通过。九项检查及完整清理通过，原 31 会话与原进程保持。调度/授权源码关系已核对；普通发行程序不是本次长测二进制。 |

运行时参照比较如实保留为不完全相同：固定库版本保持，但新工作目录的行尾、锁/补丁原始摘要、生成的 Python 启动器及安装记录改变了部分清单摘要。实际包符合本次生成清单，核心库声明摘要保持；差异记录不等于所有生成启动器二进制相同。完整解包核验和包内加载检查是独立证据。

## 固定产物

Windows：`artifacts/release-candidate-0.2.2-bilingual-installer-20261005/`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `GeoD Agent_0.2.2_x64-setup.exe` | 510,426,111 | `5eef116a77029043e78491ad2a70743b29c249019066f4c8346d0c20fae46dd1` |
| `GeoD-Agent-0.2.2-windows-x64.zip` | 687,928,470 | `5603c941792d7bfe4c53aade437e261d431a6445f380b1b9c9b854465ef1e2c7` |
| 免安装主程序 | 139,770,368 | `d62a5fc879355943f9339d0ef5cc3e94ed672072e69a7ee07d2fa427e1c24052` |

Linux：`artifacts/gateway-release-0.2.2-payment-history-20261005/geod-agent-gateway-0.2.2-linux-x64.tar.gz`，5,612,350 字节，SHA-256 `4fbf9b4367cb6d79dad94f1e5695aec2fb009d08ad8b1d1db7966501db58a72c`。归档不含用户数据库、服务配置、测试工具或密钥。

## 回执

- `artifacts/signed-bilingual-installer-build-20261005/result.json`、`source-freeze.json`、`source-comparison.json`。
- `artifacts/bilingual-installer-post-build-review-20261005/result.json`、`source-provenance.json`。
- Windows 候选内 `candidate.json`、`signing-receipt.json`、`integrated-payload.json`、`.sig`。
- `artifacts/bilingual-installer-sdk-acceptance-20261005/result.json`、`sdk-provenance.json`；沿用已核对的 SDK 验收二进制，未声称本轮重编译工具。
- `artifacts/bilingual-installer-ui-20261005/result.json`、`ui-observations.json`、`before.json`。
- 前候选的 `artifacts/payment-history-runtime-review-20261005-retry1/result.json` 及原生 QA 对照继续保留；本轮新包资源逐文件核对独立通过。
- Linux 归档候选目录下的验收资料 `archive-acceptance-58d7b29e22e445c4/result.json`，未将验收程序或回执装入发行归档。
- 主目录 `artifacts/schedule-stability-native-20261005/fixture-6b042703fa08885c/` 的终态、清理、账本和实际截图；候选目录的 `artifacts/schedule-release-review-20261005/source-comparison.json`。

回执在本机忽略目录中，不含正式账户凭证；查阅时须核对路径和摘要，不能将旧候选的通过记录移用于新文件。

## 后续门槛

1. 多小时后台测试及清理、固定发行清单和主目录整合保留检查已通过。原 31 会话的原始 JSON、待恢复条目及原进程保持，运行中的原生程序没有替换。接下来按上述审阅范围取得发布授权。
2. 对完整候选申请正式发布授权。网关只读范围现在为 Credits、预留、订单、退款及四类 CSV，共八条 GET 路由；旧稿仅列四条用量路由，不能将其视为新增支付记录路由的发布授权。现金操作保持关闭。
3. 部署前核对当前服务与代理、取得一致账本备份、在隔离端口验证迁移/回退；正式切换后核验认证、旧账户和客户端回退。不得用旧备份覆盖新结算记录。
4. 安装向导升级、回滚、真实系统重启及全新 Windows 验收仍未完成；全新 Windows 按用户要求暂缓。真实资金、政策、商户预算、Windows 代码签名及正式更新渠道也仍有各自边界。

本机使用正式账本快照的升级/回退已经通过，见 [隔离演练](2026-10-05-gateway-migration-rehearsal.md)；上面第三项仍指正式部署时新的备份、实际端口与 HTTPS 切换验收。

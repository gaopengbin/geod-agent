# GeoD Agent 0.2.2：完整记录整合候选

状态：2026-10-05。本地普通 Windows 候选和 Linux 网关归档已生成，并通过下列检查。源代码位于同一仓库的独立分支 `codex/payment-history-candidate`，尚未合入正在做多小时后台测试的主目录。没有安装、上传 Release、部署网关或启用更新渠道。

## 范围

包含已有 Credits 全量记录，以及新增的订单、退款完整分页、时间筛选和 CSV。沿用 0.2.1 每个新账号一次的 20,000 Credits 赠送；本轮没有改变赠送、模型费率、订阅权益或现金开关。赞助入口继续隐藏。功能和原生界面证据见 [完整支付记录](2026-10-05-payment-history.md)，计费建议见 [审阅稿](2026-10-05-billing-review.md)。

普通程序身份为 `dev.geod-agent.desktop`，产品名为 `GeoD Agent`，版本 `0.2.2`，前端随包。沿用原 Windows 受保护签名身份，程序内嵌固定 HTTPS 更新地址和公钥；编译、包装使用公开环境，安装包完成后独立签署。渠道地址尚未部署或启用，更新签名不等于 Windows Authenticode 代码签名。

## 已完成的核验

| 检查 | 本次结果与边界 |
| --- | --- |
| 来源冻结 | 987 项仓库输入在编译、包装前后保持；首次 CRLF/LF 变化触发停止，其失败回执保留。后续在冻结前生成工具定义，并使用 LF 属性。 |
| 与原生界面验收的关系 | 584 项产品文件字节相同，一项工具定义只有行尾变化且 JSON 相同；372 个实际前端文件相同。原生专用 QA 与普通候选是不同二进制，不宣称同一程序。 |
| 独立签名复核 | 完整安装包摘要、公钥、更新签名、内嵌渠道、来源和私钥扫描通过，原固定资产保持。 |
| 实际 NSIS 解包 | 8 组环境、24,944 个资源逐文件核验；主程序与免安装程序仅有 Tauri NSIS 标记差异。没有执行安装向导。 |
| 实际更新库 | Tauri updater 2.13.1 的 9 项检查通过：完整下载/签名、篡改、错误密钥、错误/缺失签名版本、相同/旧版本、截断和不可信 TLS。使用本次完整 510 MB 安装包和回环 HTTPS；MockRuntime 不安装程序或根证书。 |
| 实际包内环境 | 6 项检查通过：GIS、加密文档、CPU OCR、旧 Office、SQL 驱动和实际配置下的 DBHub stdio 读取。只使用解包后的运行环境及隔离 SQLite，数据库内容保持，测试进程已退出。 |
| Linux 实际归档 | 84 项测试、1,787 个文件/4 个内部链接核对，以及 8 条只读路由、重启游标和精确 CSV 通过。无公开网络、真实商户请求或资金操作。 |

运行时参照比较如实保留为不完全相同：固定库版本保持，但新工作目录的行尾、锁/补丁原始摘要、生成的 Python 启动器及安装记录改变了部分清单摘要。实际包符合本次生成清单，核心库声明摘要保持；差异记录不等于所有生成启动器二进制相同。完整解包核验和包内加载检查是独立证据。

## 固定产物

Windows：`artifacts/release-candidate-0.2.2-payment-history-20261005-retry1/`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `GeoD Agent_0.2.2_x64-setup.exe` | 510,395,955 | `7ada6d2d42af041a289e84670d5255f5131901e82138f4e1cd5b1ef8b9215a2d` |
| `GeoD-Agent-0.2.2-windows-x64.zip` | 687,928,471 | `548a6d469f4085babfdaeec252cd5f7b78c2b4991161cc347dc2993d9263d028` |
| 免安装主程序 | 139,770,368 | `b75055378f2d4e458e0edac5f0cac412a766bf7c103c9806fe71f5a991a0a818` |

Linux：`artifacts/gateway-release-0.2.2-payment-history-20261005/geod-agent-gateway-0.2.2-linux-x64.tar.gz`，5,612,350 字节，SHA-256 `4fbf9b4367cb6d79dad94f1e5695aec2fb009d08ad8b1d1db7966501db58a72c`。归档不含用户数据库、服务配置、测试工具或密钥。

## 回执

- `artifacts/signed-payment-history-build-20261005-retry1/result.json`、`source-freeze.json`、`native-ui-source-comparison.json`。
- `artifacts/signed-payment-history-post-build-review-20261005-retry1/result.json`、`source-provenance.json`。
- Windows 候选内 `candidate.json`、`signing-receipt.json`、`integrated-payload.json`、`.sig`。
- `artifacts/update-sdk-acceptance-payment-history-20261005-retry1/result.json`、`sdk-provenance.json`；验收工具源码与先前工具按文本一致核对并记录行尾差异，未声称本轮重编译工具。
- `artifacts/payment-history-runtime-review-20261005-retry1/result.json` 及包内运行日志；第一次错误的 `--help` 检查保留在无 `retry1` 的目录。
- Linux 归档候选目录下的验收资料 `archive-acceptance-58d7b29e22e445c4/result.json`，未将验收程序或回执装入发行归档。

回执在本机忽略目录中，不含正式账户凭证；查阅时须核对路径和摘要，不能将旧候选的通过记录移用于新文件。

## 后续门槛

1. 保持当前多小时后台测试运行，取得全部周期、实际停机、异常恢复及清理终态，再合入主目录。本轮观察为 5/8 个真实周期、两次续期，不能提前标为通过。
2. 对完整候选申请正式发布授权。网关只读范围现在为 Credits、预留、订单、退款及四类 CSV，共八条 GET 路由；旧稿仅列四条用量路由，不能将其视为新增支付记录路由的发布授权。现金操作保持关闭。
3. 部署前核对当前服务与代理、取得一致账本备份、在隔离端口验证迁移/回退；正式切换后核验认证、旧账户和客户端回退。不得用旧备份覆盖新结算记录。
4. 安装向导升级、回滚、真实系统重启及全新 Windows 验收仍未完成；全新 Windows 按用户要求暂缓。真实资金、政策、商户预算、Windows 代码签名及正式更新渠道也仍有各自边界。

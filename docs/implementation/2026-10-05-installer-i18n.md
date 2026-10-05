# Windows 安装向导中英文与新候选核验

日期：2026-10-05。此前应用界面支持中英文，但 NSIS 默认只打包英语。本轮为普通 `dev.geod-agent.desktop` / `GeoD Agent` / `0.2.2` 增加 `English`、`SimpChinese` 及语言选择框，重新编译、包装并独立签署，没有安装或发布。

## 实际界面

使用 computer-use 的 Windows API 操作实际新安装包，观察原生截图和控件文本，完成六项记录：初始语言选择、中文欢迎页、中文取消、选择英文、英文欢迎页、英文取消。中文和英文的标题、欢迎正文、下一步及取消按钮显示正确，两次均从欢迎页取消，安装进程已退出。

本机初始选择为 `中文(简体)`。NSIS 会读取已有安装语言；没有记录时跟随系统语言，无法匹配时回落到首项英语。初始语言选择框沿用 NSIS 的英文标题/说明，两个语言选项可用。没有更改系统语言，也没有将后续安装、升级、卸载等全部页面标为已实机覆盖。

一次点击未推进语言框，随后一次截图等待报 `FrameArrived` 超时；重新读取窗口、激活并用键盘确认后完成上述流程。工具观察记录保留这段过程，没有将未观察到的动作记为成功。

取消后，三组原注册值摘要、既有 0.1.0 程序和卸载器的字节摘要、四个受保护进程的创建身份均保持。没有执行安装段、改写原安装目录或运行新主程序。这不是安装升级/回滚验收。

## 新产物及独立检查

位置：`artifacts/release-candidate-0.2.2-bilingual-installer-20261005/`。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `GeoD Agent_0.2.2_x64-setup.exe` | 510,426,111 | `5eef116a77029043e78491ad2a70743b29c249019066f4c8346d0c20fae46dd1` |
| `GeoD-Agent-0.2.2-windows-x64.zip` | 687,928,470 | `5603c941792d7bfe4c53aade437e261d431a6445f380b1b9c9b854465ef1e2c7` |
| 免安装主程序 | 139,770,368 | `d62a5fc879355943f9339d0ef5cc3e94ed672072e69a7ee07d2fa427e1c24052` |

- 991 项源码/构建脚本输入在编译和包装前后保持，没有构建中变更。
- 与前一完整记录候选相比，只有 `tauri.conf.json` 新增 NSIS 语言配置；585 项其他相关产品文件保持。八组运行环境清单相同，但新主程序字节不同，不能把它写成同一二进制。
- 新包独立签名复核通过，沿用 Windows 受保护的签名身份及内嵌固定 HTTPS 地址/公钥。私钥扫描通过，没有上传或启用渠道。
- 实际新 NSIS 包解压核验 8 组环境、24,944 个资源通过；主程序与对应免安装程序只有 Tauri NSIS 标记差异。
- Tauri updater 2.13.1 使用本次完整安装包的九项检查通过，包括下载、签名/版本绑定、篡改、错误密钥、相同/旧版本、截断和 TLS 拒绝。验收工具沿用已核对的既有 SDK 二进制，未声称本轮重编译；使用 MockRuntime，没有安装程序或系统证书。

前一完整记录候选的六项包内运行检查保留在原回执中。本次逐文件核验证明相关运行资源的字节相同；这些旧记录不证明新主程序已经实际启动。Linux 网关没有改动，继续使用已通过真实归档与正式账本副本迁移检查的同一归档。

## 回执

- `artifacts/signed-bilingual-installer-build-20261005/result.json`、`source-freeze.json`、`source-comparison.json`。
- `artifacts/bilingual-installer-post-build-review-20261005/result.json`、`source-provenance.json`。
- 新候选中的 `candidate.json`、`signing-receipt.json`、`integrated-payload.json`、`.sig` 和 `latest.json`。
- `artifacts/bilingual-installer-sdk-acceptance-20261005/result.json`、`sdk-provenance.json`。
- `artifacts/bilingual-installer-ui-20261005/before.json`、`ui-observations.json`、`result.json`。真实截图已在 Computer Use 观察中核对；文件保留页面控件文本与截图标识。
- 只读保护核验工具：`scripts/verify-installer-ui-preservation.py`。

来源比较中相对最早候选的 `productInputsMatchReference` / `runtimeInputsMatchReference` 仍保留为 false；本轮相对前一完整记录候选的精确差异由 `source-comparison.json` 另行记录。没有覆盖早期候选或将它们的校验值移到新包。

后续正式发布和安装升级等门槛见 [整合候选](2026-10-05-payment-history-release-candidate.md)。

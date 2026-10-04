# 启动、更新与本机记录备份

日期：2026-10-04。以下为本机开发程序验收，没有安装、发布或启用收费。

## 实际通过

- Windows 登录启动项包含带引号的程序路径和 `--background-runtime`。按实际注册命令启动时，没有应用窗口或 WebView；框架自己的空白事件窗口已单独识别。
- 关闭应用窗口后，自带 Key 的 DeepSeek 定时任务实际读取随机工作区文件；重开能查看结果。一次性执行和错过周期合并执行通过，没有改变系统时间。
- 更新下载校验真实签名。篡改文件、签名版本与清单版本不同均被拒绝；开发程序禁止执行安装。
- 应用设置可以备份完整界面记录、任务账本、渠道配置引用、工作区设置及 Codex 引擎历史。SQLite 使用包含已提交 WAL 的一致快照，校验完整性、字节数和 SHA-256 后才发布备份目录。
- 真实后台命令执行中返回 `BACKGROUND_BUSY`；真实 DeepSeek/Codex 前台命令执行中返回 `UPDATE_TASKS_ACTIVE`。原命令正常完成，没有被备份中断。
- 实际界面生成的备份包含 578 项原生记录、193 个 SQLite 快照、121 份引擎历史和 99 项界面记录；原有 30 个会话保留。还原到临时隔离目录后，逐项哈希、SQLite 完整性、实际命令记录及界面随机标记均通过。
- 备份完成后，之前运行的独立后台自动恢复；用户明确停止的后台保持停止。异常界面记录在停止后台前拒绝。
- 1000×720 窄窗口下，中文浅色和英文暗色没有横向溢出。设置正文单独滚动，标题、关闭按钮和完成按钮固定可见。

## 记录范围

备份存放在应用数据目录的 `upgrade-backups`。`manifest.json` 映射原文件相对路径、备份文件名、类型、字节数及 SHA-256；`ui-state.json` 保留原始界面记录。采用平铺文件名，避免 Windows SQLite 长路径限制。

工作区数据文件继续留在原位置，不重复复制下载成果。系统凭据库保持原样，渠道数据库保存凭据引用；备份不是可迁移到另一台电脑的密钥包。原始会话内容和相关配置属于用户数据，备份仍应按本机用户数据保存。

随后数据库私钥验收补齐了 `.client-tls` 系统加密身份文件的备份。新备份 1,343 项逐项核对，并在完整程序重启后实际使用备份中的身份文件认证到 PostGIS；原 Windows 用户、账号目录及连接位置仍适用。详见 [加密数据库私钥](2026-10-04-encrypted-database-keys.md)。

## 验收边界

- 隔离恢复验证了备份文件和账本读回，没有覆盖当前用户数据，也没有执行旧版安装程序回滚。
- 正式更新地址、公钥和发布签名流水线仍待建立发行候选；当前界面明确显示渠道尚未发布。
- 没有执行实际系统重启或长期运行；干净 Windows 安装验收按用户要求暂缓。
- Windows 原生测试程序的 Common Controls 清单问题已定位并修复。备份的两项原生单元测试实际运行通过，开发程序编译及启动通过。

## 证据

- `artifacts/product-gaps-20261004/autostart/result.json`
- `artifacts/product-gaps-20261004/autostart/credential-audit.json`
- `artifacts/product-gaps-20261004/desktop-settings/result.json`
- `artifacts/product-gaps-20261004/desktop-settings/layout-result.json`
- `artifacts/product-gaps-20261004/desktop-backup/result.json`
- `artifacts/product-gaps-20261004/desktop-backup/actual-foreground-turn.json`
- `artifacts/product-gaps-20261004/desktop-backup/backup-dark-en.png`

备份验收采用分阶段结果：最初验证程序遇到 Windows 短路径别名比较和 SQLite 句柄清理问题。修复验证程序后，复用已完成的真实门禁证据，完成其余实际界面、隔离恢复和后台状态验收；最初失败记录保留为 `attempt.json`。

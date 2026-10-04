# 最新能力整合发行验收

日期：2026-10-04。目标模式继续推进；这一阶段完成本地 0.2.0 候选整合，没有安装、发布服务或启用正式收费。

## 可审阅产物

目录：`artifacts/release-candidate-integrated-20261004-actual`。

| 产物 | 实际大小 | SHA-256 |
| --- | --- | --- |
| `GeoD Agent_0.2.0_x64-setup.exe` | 510,465,113 字节，约 486.8 MiB | `18eb23e7ee1800bc0c73ca04f2afbcfd9d6d4c70f160eb5dfef680033e10ad31` |
| `GeoD-Agent-0.2.0-windows-x64.zip` | 687,865,266 字节，约 656.0 MiB | `f7db8f50ce6a839a5aeba142324074c0a73496fe0ceb775af3ebdb7c5a384873` |

这次补入之前候选生成后增加的本机音频、扫描识别、旧版 Office、加密文档与数据库私钥支持，以及最新插件和渠道代码。执行程序 SHA-256 为 `8f853a1e1e68bdc670f60bcc6eb2e7c694bb45750da4bc33919c663d45715fda`。

`candidate.json`、`build-receipt.json` 记录构建和封装；`integrated-acceptance.json` 汇总实际运行及恢复结果。以前的五组运行环境候选保留在原目录，不能用它的验收代替这一版。

## 安装包实际资源

直接解包 NSIS，逐文件核对八组固定运行环境的 24,944 个文件。便携程序和安装包内程序的差异只有 Tauri 的 NSIS 标记；其余字节相同。ZIP 完整性检查通过。

| 随包运行环境 | 核验文件 |
| --- | ---: |
| Codex / Node / npm | 1,934 |
| pgEdge MCP | 2 |
| Python / GDAL | 9,117 |
| 文档解析 | 282 |
| DBHub MCP | 11,051 |
| 音频转写引擎 | 15 |
| 本机 OCR | 2,225 |
| 旧版 Office 解析 | 318 |

运行时核验见 `integrated-payload.json`。音频模型是首次使用时的独立下载，不包含在安装包中。

## 实际隔离运行

先保存原会话摘要并正常关闭开发版、伴随进程及其后代，再把准确的 Roaming / Local 应用目录移动到同盘可恢复备份。候选使用新的应用目录和只有 Windows 路径的环境启动；没有依赖系统 Node、Python 或开发 SDK。现有 Windows 账号认证仍可用，因此这不等于新系统首次登录测试。

| 检查 | 实际结果 |
| --- | --- |
| 原生数据库 | 加密 PEM 缺密码和错误密码均拒绝保存；正确密码经随包 Python / cryptography 解密，pgEdge 对真实 PostGIS 完成双向 TLS 和随机标记读取。DBHub / Node 实际读取 SQLite。 |
| 文件与密码表单 | 通过实际上传入口导入加密 PDF、加密 DOCX、扫描 PDF、旧版 DOC、XLS、PPT 和 MP3；错误文档密码清空并重新聚焦，正确输入继续解析。 |
| 本机音频 | 新配置先实际下载标准模型，再通过随包引擎转写 MP3，识别 Beijing 和缩放级别 12。通过真实编辑器添加用户校正标记，原音频摘要不变。该标记是用户编辑内容，不是语音识别出的随机字符串。 |
| 真实前台 Agent | Codex / DeepSeek 调用七次附件工具、新建 PostGIS 连接并读取数据，再读取 SQLite；返回全部九个实际标记。提示词没有提供这些标记或私钥密码。 |
| 完整备份 | 原生备份包含 42 项记录、1,185,142 字节；核对全部摘要，保留七份原文件、解析文本和两个受 Windows 保护的客户端身份文件。 |
| 实际关窗运行 | 窗口关闭后仅伴随进程运行；真实后台模型进行七次附件读取、两次数据库查询，再次返回全部九个标记。 |
| 完整程序重启 | 前台、伴随进程和已记录后代均正常退出，再从同一候选启动；聊天内容严格一致，七份文件摘要和三个保存连接的实际读取通过。 |
| 凭据及清理 | 只移除本轮三个保存连接、测试时间表、准确标识的 Docker 容器和独立工作区临时文件夹。八个实际进程的参数/环境检查通过；501 个可变文件核对四个密码和四种私钥表示，零不可读、零明文残留。 |
| 原数据恢复 | 恢复原应用目录与登录启动项，重新打开开发版。原 30 个会话、活动会话及完整内容摘要一致，原四个数据库连接和模型默认设置一致；授权测试网关进程保持原实例。 |

原生/界面阶段合计 20 项通过；关闭窗口后的结果另由只读读取实际任务账本核对。没有替换 AI 的答案，也没有模拟工具结果。

## 保留的依据

- `integrated-actual-model-chat.json`、`integrated-actual-closed-window-model.json`：真实模型、工具和答案。
- `integrated-init.json`、`integrated-inputs.json`、`integrated-backup.json`、`integrated-restart.json`：分阶段结果。
- `integrated-environment.json`、三个 `*-processes.json`：实际进程与环境；原网关保留。
- `integrated-process-secret-audit.json`、`integrated-credential-audit.json`：凭据检查范围及结果。
- `development-chats-restored.json`、`original-connections-restored.json`：恢复后的原数据核对。
- `profiles.json`：原目录恢复和独立 QA 目录归档位置；完整 QA 备份的当前位置记录在 `integrated-acceptance.json`。
- `integrated-password-retry.png`、`integrated-audio-first-use.png`、`integrated-seven-inputs.png`、`integrated-actual-model-answer.png`：真实界面，已查看。

验收脚本最初只读取 IndexedDB，漏掉 localStorage 中的小型活动会话偏好；音频步骤也曾误用文档入口。这两次脚本失败保留在 `integrated-*-harness-*-failure.json`，修正后继续同一份隔离数据，不重复付费模型请求。夹具生成器第一次使用缺少 reportlab 的系统 Python，改用现有文档依赖环境后成功；该环境只用于造样本，不参与候选解析。

## 验收边界

- 这是本机配置隔离和实际便携程序运行，未运行安装向导；全新 Windows 验收依用户指示暂缓。
- 未执行系统重启、实际安装升级或安装程序回滚；这里的重启指完整程序退出后重开。
- 客户端身份备份受当前 Windows 用户及应用凭据上下文约束，不声称跨设备导入可用。
- 最新运行验证使用已授权的本机测试网关；正式服务兼容、长期签名、更新地址、商户结算及官方供应商账号仍须各自验收。
- 开发窗口已经恢复，继续使用热更新。本候选没有替换已安装版本。

# 本机音频转写与 Agent 附件

日期：2026-10-04。开发模式已接入；没有重新安装或发布。

## 使用方式

输入框的添加菜单 → **添加音频**。首次使用会打开本机转写设置，下载标准或轻量模型；之后可以离线转写。音频转成文字后成为当前会话附件，点击附件名称可在发送前检查和修改。机器识别可能出现地名、数字或术语错误，实际中文测试也出现了误字。

- 选择入口接受 WAV、MP3、M4A、OGG、FLAC、WebM、AAC、Opus；八种均已用实际文件验证本机解码和 CPU 转写。本机 WebM / Opus 使用 Opus 编码，OGG 使用 Vorbis，AAC 使用 ADTS 容器；不泛化为每种容器的所有编码均可解码。
- 每个文件最多 32 MB、10 分钟，支持批量添加。解码能力依赖当前 Windows WebView；不能解码时明确提示，保留已经成功添加的文件。
- 音频在设备上解码、归一化并由 CPU 模型转写；原音频不会上传给转写服务。**转写文本会交给当前选择的 AI 服务**，原文件保存在本机附件目录。
- 自动识别或指定 12 种语言。多语言模型不等于所有语言均已实际验收；本轮测试中文和英文。
- 发送前可以编辑转写；发送后的附件不可再改写或作为草稿删除。草稿移除只删除应用内副本，保留用户原文件。
- 可取消模型下载或正在进行的转写；切换会话后结果仍归属原会话，不插入另一会话。

## 引擎与原生存储

使用官方 [whisper.cpp](https://github.com/ggml-org/whisper.cpp/releases/tag/b5130) 1.9.4 Windows x64 CPU 运行环境，固定 b5130 发行包。15 个运行文件逐一校验；完整 MIT 许可随运行环境保留。归档 SHA-256 和模型版本、大小、SHA-256 记录在 `vendor/audio/runtime-lock.json`，首次模型下载核对大小和完整摘要后才提交。

标准模型约 142 MiB，轻量模型约 75 MiB，存储在设备的 Local 应用缓存，不写入聊天完整备份。系统无需安装 Python、FFmpeg 或 GPU 运行环境。开发验收的音频由本机生成，FFmpeg 仅用于生成其他格式的测试文件。

每个附件按账号和会话保存原音频、当前转写、原始机器转写以及元数据。人工编辑用 `transcriptEdited` 单独记录，避免误标为解析异常。旧记录中的编辑标记在读取时兼容转换；没有重写原聊天内容。

AI 通过现有 `attachment_list` / `attachment_read` 发现和分页读取已发送的转写。草稿不对 Agent 发布，跨会话读取被拒绝。附件内容作为数据参考；文件中的话不会自动成为操作授权。

## 实际验收

证据：`artifacts/product-gaps-20261004/audio-inputs/`。

| 检查 | 结果 |
| --- | --- |
| 官方运行文件、中文/英文自编音频、仅 Windows PATH 的实际 CLI | 通过；实际转写保留，包含机器误字。 |
| 首次准备模型及实际下载取消、中文深色/英文浅色、1000×720 窄窗口 | 通过。 |
| MP3、WAV、FLAC、M4A 解码和本机转写，损坏音频错误恢复 | 通过。 |
| OGG/Vorbis、WebM/Opus、AAC/ADTS、Ogg Opus 的实际批量添加 | 通过；四份原文件摘要一致，真实 Codex/DeepSeek 分别读取四个转写并回复实际文件名、北京和 Z12。 |
| 实际转写编辑，保留原音频摘要，发送后的编辑/跨会话读取拒绝 | 通过。 |
| 真实 Codex/DeepSeek 通过附件工具读取人工修改和随机标记 | 通过；保存真实调用和回答，没有代写模型回复。 |
| 独立后台 Agent 读取转写、原生 Codex 会话分支 | 通过。 |
| 重启后的模型设置、音频、人工修改及分支读回 | 通过。 |
| 实际取消先于 IPC 注册及 CPU 运行中取消 | 通过；没有迟到附件或残留临时转写目录。 |
| 转写过程中实际切换会话 | 通过；结果仍在原会话草稿。 |
| 新版元数据的真实模型读取、原音频/机器转写/人工修改的完整备份 | 通过；两个会话的八份记录及摘要核对一致。 |

`native-result.json` 为首轮九项实际验收；`finish-result.json` 为七项收尾验收。旧失败记录保留在 `harness-failures.json` 与 `finish-failures.json`。

剩余格式验收保存在 `artifacts/product-gaps-20261004/audio-codecs/`：`fixtures.json` 固定原文件、编码、大小及 SHA-256；`result.json` 七项通过，包含四种解码、真实模型附件读取、重载和跨会话隔离、原 30 会话及音频偏好恢复。测试使用本机自编英语语音，没有上传原音频或修改机器转写来促成通过。准备及验收入口为 `scripts/prepare-remaining-audio-fixtures.py`、`scripts/verify-remaining-audio-codecs.mjs`。

收尾验收发现原备份白名单没有包含 `.transcript`，已修复并重新创建实际备份，完整保存机器转写。修复前备份仍保留原音频和人工修改后的文字；不把旧备份称为包含机器转写。相关原生备份两项测试、音频校验与取消两项测试、前端及原生开发构建通过。

## 当前边界

- 音频是文件输入；麦克风录音、实时转写及播放器尚未提供。
- 其余指定语言、容器中的其他编码组合及不同设备性能尚未验收。
- CPU 识别效果与速度依赖音频质量及设备；没有宣称无误识别。
- 扫描 OCR 已完成，见 [扫描文档识别](2026-10-04-document-ocr.md)；常见旧版 Office 已完成，见 [旧版 Office](2026-10-04-legacy-office-inputs.md)。
- 当前 0.2.0 安装候选是在音频接入前生成；它仍包含原五组运行环境。本轮只更新开发版和后续封装规则，没有重新安装或发布。

## 主要实现

`src/audio-attachments.tsx`、`src/document-attachments.tsx`、`src/agent-panel.tsx`、`src-tauri/src/audio_inputs.rs`、`src-tauri/src/attachment_inputs.rs`、`src-tauri/src/desktop_backups.rs`。

准备及验收入口：`scripts/prepare-audio-runtime.py`、`scripts/verify-audio-inputs.mjs`、`scripts/finish-audio-input-acceptance.mjs`、`scripts/finish-audio-backup-repair.mjs`。上述源码路径相对 `apps/geod-agent-desktop`；脚本路径相对仓库根目录。

# Luna 多轮 Responses 兼容修复

## 现象与定位

开发版白名单账号选择社区赞助 Luna 后，第一条回复成功；后续“现在有哪些图源”和继续请求失败。线上账本显示这两条为 `failed / UPSTREAM_REJECTED`，不是额度耗尽或待结算的网络中断。此前客户端将拒绝回执误报为 `PROVIDER_STREAM_INCOMPLETE`。

本机原生会话完整记录仍保存了第一条回复的带 `id`、`encrypted_content` 的 Responses reasoning item。但按需上下文投影将上一轮 reasoning 归档并从请求删除，同时保留依赖它的 assistant message ID。真实供应商接口对同一段会话对照验证：保留配套记录得到 HTTP 200 和可结算用量；删除 reasoning 得到 HTTP 400、`invalid_request_error`、参数 `input`，错误提及 required reasoning。

## 修复

- 运行桥接将实际渠道协议传给上下文投影。Responses 请求保留带 ID 或加密内容的历史 reasoning；保留供应商 message 和 function/custom call 的原始 ID、内容与参数依赖。普通 Chat Completions 的 reasoning 按需读取行为继续沿用。
- 技能目录、工具合同、详细业务规则继续按需加载；工具结果仍可归档并留下原始 call/output 配对和确认事实。Core 自身压缩仍接收完整原始上下文。
- 原生 Responses 完成分支先检查持久化请求回执。供应商拒绝、未知结果、格式错误和非法工具返回按真实原因停止；不会将它们统一冒充流断开，也不会触发 Core 对同一个无效请求自动重发。未知结果保留待核对状态，不声称无费用。
- 本次修改在本地运行桥接，无需修改线上服务、赞助白名单或用户钱包。

## 验证

- 30 项测试全部通过且无跳过，包含实际捆绑 Codex Core：拒绝回执只调用一次模型、不执行工具；Responses 工具完成等待持久化结算；Chat Completions 历史、技能按需加载、权限与已确认需求保持。
- 真实 Luna 连续三轮：你好、查看图源、再次查看图源。5 次供应商请求全部 settled，输入 23,370 / 输出 204 token。第三轮继续携带第二轮产生的加密推理记录。
- 两次 `sources_list` 调用的执行器为明确标记的诊断 fixture，用于模型/工具协议往返；没有把它当成用户已登记图源的真实清单，没有启动下载。
- 真实原会话的原始记录和删减记录各进行一次对照；不修改用户聊天。开发版前台重启以清除旧桥接进程缓存，后台伴随进程保留。

证据：Git 忽略目录 `artifacts/sponsored-vectorport-20261013/`。私人赞助密钥仅从现有 DPAPI 文件读取到子进程内存，不记录供应商明文错误或密钥。

# Codex 接入中的续传工具修复

## 接入职责

本机实际运行 Codex 0.159.2 app-server，模型为既有 GeoD 托管的 DeepSeek Flash。对话展示、GIS 工具执行和任务监控由 GeoD 实现，不能把引擎接入等同于完整 Codex 桌面体验。

官方接口提供会话、审批与流式 Agent 事件，产品负责接收事件并呈现：<https://learn.chatgpt.com/docs/app-server>。

## 缺陷

用户说“继续”后，模型实际调用了 `jobs_start`。但前端发现计划已有任务时，只返回任务记录中的 downloading 和 reused=true，没有调用本机 `jobs_resume`。模型据此报告续传成功，而执行进程仍为空。此问题来自 GeoD 工具适配，不是固定回复拦截再次出现。

## 修改

- 将启动/恢复操作集中于 `src/job-start.ts`，供两个引擎共用。
- 已有任务在执行时复用；中断/暂停任务真正调用原生恢复接口；完成或取消的任务不再启动。
- 完全访问检查在操作前执行；逐次确认模式返回审批需求。
- 操作后读取实际执行进程、当前任务及进度，以这些事实作为工具结果，不返回固定回复或 `nextAction` 答案提示。
- 续传期间重新检查已保存瓦片时，保留已经记录的下载进度，单独显示“检查缓存”，避免进度从 75% 倒退。工具另提供 checkingCache/checkedTiles。

## 本机实际验证

原会话重试“继续”，真实模型先调用 `jobs_get`，再调用 `jobs_start`，之后自行生成最终回答。审计记录确认原生 `jobs_resume` 被调用，原任务 ID 出现在执行进程列表，新进度事件持续写入。恢复保留原计划、任务和瓦片缓存，没有创建第二个任务。

随后任务到达 600/600，经 verifying 转为 completed。实际输出 `imagery-z12.tif` 为 150,523,010 字节、6093×6176，另有边界 GeoJSON 和预览 PNG。独立读取 manifest 并重新计算三份产物的 SHA-256，全部匹配；quality.status=complete、missingTiles=0。界面自动显示完成与成果。

缓存目录只读核对有 462 条 tiles 记录，历史下载检查点为 448/600。重新检查缓存时的轮内计数不表示之前的瓦片丢失。

证据：`evidence/codex-resume-2026-10-01.json`、`evidence/codex-resume-facts-2026-10-01.json`、`evidence/codex-resume-artifacts-2026-10-01.json`、`evidence/codex-resume-2026-10-01.png`。

前端构建通过，续传、状态和后台进度回归测试 13/13 通过。开发版通过热更新生效；未重新安装或发布服务器。

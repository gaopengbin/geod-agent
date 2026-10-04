# 完全访问仍停在待确认计划：本机修复

## 原因

当前权限只在模型主动调用 `workspace_status` 时读取。较早对话中的 Confirm Each 描述可被沿用；Creator 技能的默认参数流程和最终回复示例又无条件要求“待确认”。任务面板也把所有尚无作业的计划固定标为“待确认”。

## 修改

- 每轮请求前读取当前会话的 native workspace 设置，将最新权限及执行规则带入模型上下文；恢复请求时替换之前的权限块。保留原始用户请求和链接。
- 计划工具返回 permission、requiresPlanConfirmation、canStartWithoutPlanConfirmation。
- Creator 按权限和用户意图分支：完全访问的下载请求继续调用 jobs_start；逐次确认使用计划卡片；只要求规划不启动下载。
- 任务面板使用当前会话权限：完全访问下尚无作业显示“待执行”，逐次确认显示“待确认”，权限未加载时显示“计划已生成”。作业创建后显示 native 作业状态。
- 本机 jobs_start_auto 的权限、输出目录、计划有效期及任务记录检查保持执行。

## 验证

- 前端构建通过，agent-workflow 测试 7/7 通过。
- 真实托管模型的三个隔离用例全部通过，包含旧 Confirm Each 对话历史：
  - confirmEach + 下载请求：生成计划，不创建作业。
  - fullAccess + 下载请求：调用 jobs_start，经真实目录校验、grant_approval 和 start_job 在独立 SQLite 创建 queued 作业。
  - fullAccess + 仅规划请求：生成计划，不调用 jobs_start。
- 测试未启动下载 worker，未下载用户的 600 张公共瓦片，也未修改用户任务数据库。
- 初次使用过宽的 live_model 筛选时，额外跑入 GDAL 用例；该用例因未启动其专用测试服务而失败。随后使用 online_boundary::tests::beijing_ 精确筛选，三项通过。日志见 evidence/permission-2026-09-30/model-flow.log。
- 模型个别过程说明仍可能使用英文，沿用边界集成中已记录的语言问题；不属于本次权限修复的已验证范围。
- Vite 1420 返回 200，热更新模块包含新权限处理；Tauri 开发实例响应正常。本次没有安装或服务器发布。

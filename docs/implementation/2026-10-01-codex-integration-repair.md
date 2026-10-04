# Codex 接入整体修复与本机验收

日期：2026-10-01。范围：GeoD Agent 本地开发版及本机模型网关候选。没有部署服务器，也没有重新安装桌面版。

## 已修复

1. **完整模型合同**：保留 Codex 的 instructions、system/developer 指令、运行时工具 schema、namespace、自定义工具、调用结果和实际思考内容。新增协议适配与专用网关接口，模型传输在 Rust 原生层完成，React 不接触供应商密钥。未知模态和工具明确返回错误。
2. **实际上下文**：Codex 路径移除旧 42K 字符／60 条消息压缩和网关 48K 字符／64 条消息限制，展示历史不再自动截成 100 条。引擎负责其会话和压缩；本次网关配置 128K，实际返回有效窗口 121.6K。圆环使用真实 token，用 K 表示。4 MB 传输体积上限是接口边界，不冒充模型窗口。
3. **原生事件展示**：按 turn/item 更新思考、命令、MCP、文件修改、计划和文本流。完成事件合并同一记录，保留真实参数、输出、错误和执行状态。连续工作记录默认折叠，可展开查看，保留进场、展开、流式输出和滚动动效。
4. **执行中交互**：输入框执行中保持可用，补充要求走原生 `turn/steer`；停止走 `turn/interrupt`。原生权限、用户问题及 MCP 表单请求在页内回应，表单保留 boolean/number/array 类型和必填校验。尚未支持的浏览器授权／身份验证明确显示，不能提交空“成功”结果。
5. **完整 Skills**：本地及 GitHub 包保存 scripts/references/assets 和相对目录，GitHub 固定提交；启用后导出到独立 Codex Home，让引擎加载。拒绝越界路径、符号链接及过大的包。停用时清理运行副本。非 GitHub 的 Markdown 链接仍为指令文件。
6. **原生 MCP**：已启用的普通 HTTP 连接器注册到 Codex 原生 MCP，保留工具命名空间、原生事件及完整结果。OpenLayers、GDAL 保留需要地图状态／工作区校验的 GeoD 执行桥接。
7. **进程与发行准备**：原生层按账号监督长驻 Node host 和 Codex 进程，连续轮次复用引擎及 thread，异常退出释放锁，Windows Job Object 收束子进程。固定 Codex 0.159.2、Node 24 LTS、辅助执行文件和完整许可证纳入 Tauri 资源准备；五个二进制 SHA-256 已核对官方资产。
8. **Windows 执行权限**：实测发现未配置 Windows 沙箱会将 workspace-write 降成 read-only，导致命令被 policy 拒绝。现显式配置 unelevated 沙箱，并隔离父 Codex 会话的 CODEX 环境参数；完全访问允许当前工作区执行，逐次确认仍保留其审批流程，没有改成全盘无沙箱执行。

## 实际验收

| 验收 | 结果与证据 |
| --- | --- |
| 原生 Codex + 真实托管 DeepSeek | GeoJSON → GeoPackage，实际文件 98,304 bytes；GDAL 读取 1 个 Point、EPSG:4326；7 个模型请求 settled，第二轮沿用同一 thread；[机器记录](evidence/codex-gdal-native-2026-10-01.json) |
| 完整 Skill 的原生执行 | 导入后删除原始测试 Skill 目录，模型从运行副本读取 references/config.json 并执行 scripts/convert.py；CSV 含实际坐标与 1 个要素，随机 marker 与脚本输出一致；[机器记录](evidence/codex-resources-live-2026-10-01.json) |
| GitHub 完整包 | 原生下载官方 openai/skills 的 skill-creator，固定提交 49f948faa9258a0c61caceaf225e179651397431；保留 6 个辅助文件、38,070 bytes，下载验证后删除测试安装；[机器记录](evidence/codex-github-skill-2026-10-01.json) |
| 原生 HTTP MCP | humaps 的 search_map_layers 实际调用一次 query=China、limit=10，返回 count=0、truncated=false。零结果是服务真实内容，不表示查到了可下载影像；同上记录 |
| 真实界面 + 模型 | 实际文本 delta 流；原生命令等待后返回 UI_NATIVE_OK；执行中输入、补充指令和停止入口可用，steer 已确认并保存到历史；工具组默认折叠且可展开；可见对话文字 >=14px，无原生 title 提示；[机器记录](evidence/codex-ui-live-2026-10-01.json) |
| 展示历史恢复 | 72 条模型历史与 124 条显示记录经 React 自动保存和重载保持完整；同上记录 |
| 实际 Codex 引擎的合同测试 | 6/6 通过：指令及原生工具保留、工具结果回模型、同进程／thread 复用、中断、namespace/custom tools；复用 thread 时实际权限按 read-only → workspace-write → read-only 切换。此项模型响应为测试 fixture，独立于上述真实模型验收 |
| 原生构建 | cargo build 通过，开发桌面重新启动后返回 bundled=true、账号 connected，OpenLayers／humaps／GDAL 保持启用 |
| 前端测试与构建 | 57 个测试通过，1 个需要显式二进制路径的测试在常规套件中跳过，随后单独真实引擎测试通过；TypeScript/Vite 构建通过 |
| 网关合同／鉴权／账本 | 14 个测试通过，包括完整 Codex 合同、多轮 reasoning、SSE、幂等、真实用量与不限额测试账本 |

截图：[执行中](evidence/codex-ui-running-2026-10-01.png)、[完成](evidence/codex-ui-complete-2026-10-01.png)、[展开记录](evidence/codex-ui-records-2026-10-01.png)。测试使用独立临时工作区，未启动或修改用户下载任务，原有对话列表在界面验收后恢复。

## 当前边界

- 引擎是 Codex；当前实际模型是 DeepSeek Flash，没有接入 OpenAI 模型或套餐。
- 本机新 Codex 网关接口尚未发布到线上；开发桌面当前连本机联调网关。准备运行资源不等同于完成安装包／干净 Windows 验收。
- 当前网关支持文本输入；图片明确返回不支持，不会静默丢弃。
- 普通 HTTP MCP 已实测；通用 stdio 配置、OAuth、密钥请求头及浏览器身份验证尚未接入商店流程。
- Skill 依赖由其内容决定；本次 Python 和 GDAL 实测不等同于每个第三方 Skill 都已可运行。
- 下载监控属于本机任务账本；当前活动 Agent turn 的领域回调仍需桌面视图，应用关闭会停止其引擎子进程。持久 thread 可以恢复，尚未宣称所有 Agent 命令都能脱离桌面长期运行。
- 旧引擎保留兼容分支，其上下文策略未用本次 Codex 结果冒充。

后续修改前端继续使用 Vite 热更新；原生代码改动才需要重建并启动开发桌面。发布与安装另行按用户要求执行。

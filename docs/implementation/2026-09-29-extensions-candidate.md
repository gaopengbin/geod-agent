# GeoD Agent 扩展能力本地候选（2026-09-29）

## 2026-09-30 图源管理页

- “图源与授权”改为主区域的页内页面，侧边栏保留；已登记服务使用紧凑列表，支持本地搜索和编辑，添加／审核草稿使用页内表单。
- 对话、图源和技能／连接器共用一个页面选择状态；管理页面隐藏地图与成果区域，同时保留当前对话和后台任务状态。
- 原生增加仅供本地管理界面读取的 `sources_get`，用于取回已有图源配置；不加入模型工具集。新建表单阻止相同 ID 的隐式覆盖，编辑保存仍须明确勾选授权。
- 浏览器预览检查了添加／取消、示例填充、Radix 下拉选项、模块切换、浅色／深色及 390px 窄屏。页面无模态遮罩、无横向溢出，可见文本不低于 14px。预览未连接 Tauri，不在用户数据中登记测试图源，保存后继续模型任务的链路本次未实际触发。
- `cargo test --locked source_registration`：2 个现有测试通过；前端构建、Tauri release 和 NSIS 构建成功。本次仅更新本地桌面版。

## 本机变更

- 对话中仅在请求中断或状态未知时显示“检查状态”；正常执行不再出现请求 ID 按钮。
- 左侧增加“技能与连接器”。可导入符合 Agent Skills 格式的 `SKILL.md`，按对话需要读取已启用的指令；不执行附带脚本。
- MCP 连接器可从官方 Registry 搜索无需额外请求头的 Streamable HTTP 服务，或手动添加 HTTPS／本机 HTTP 地址。列出实际工具后，用户确认启用。应用沿用网络代理设置，使用官方 Rust SDK 连接、列工具和调用工具。
- 网关增加固定扩展工具；桌面端在多轮循环中执行，并把工具过程写入工作记录。MCP 服务不会因此成为有批量下载授权的 GeoD 图源。
- 本地追加对话接入流程：Agent 可调用 `workspace_skills_list → workspace_skill_import` 或 `mcp_registry_search → mcp_connect`。桌面端限制 Skill 路径在选定工作区内，连接器只接受本轮搜索结果或用户本轮明确给出的 URL；先验证可用工具，再在对话中展示首次启用卡片。工作区下载“完全访问”不会自动启用第三方扩展。
- 修正 Skill 发现范围：默认从网络目录 `skill_catalog_search` 查找；用户给出 Skill 页面、GitHub 仓库／文件夹或公开 HTTPS `SKILL.md` 时，`skill_source_inspect → skill_connect` 从源站获取。目录条目可能失效，实际 `SKILL.md` 校验通过后才在本机保存为停用状态；GitHub 搜索结果绑定读取到的提交版本，来源与内容 SHA-256 可在对话卡中核对。工作区扫描仅用于用户明确要求本地 Skill 的情形。
- “技能与连接器”面板的 Skill 标签同步改为在线搜索和粘贴链接主入口；获取后展示完整 `SKILL.md`、来源和 SHA-256，确认启用后才供 Agent 读取。本地文件夹导入保留在已保存列表旁。

## 本地验证

2026-09-30 页内布局：技能与连接器从模态弹窗改为主工作区页面，保留侧边栏及当前对话组件实例；地图与成果面板切换时隐藏，任务轮询继续。顶部采用紧凑的技能／连接器导航、搜索及添加入口，下方为自适应卡片网格。标签、搜索内容和连接器操作状态在返回对话后保留，页面新增初始读取状态。浏览器在 1280px、1024px、390px 下检查了亮暗主题、页内导航返回、自定义表单展开收起及搜索状态保留，无模态遮罩、无横向溢出，可见字号不小于 14px。浏览器不执行 Tauri 扩展操作，本次未通过浏览器测试真实连接器启用。桌面 release 和 NSIS 安装包构建通过。

- 桌面 `npm run build`、前端 22 项测试、Rust `cargo check` 与扩展单元测试通过。
- 本机模拟 Streamable HTTP MCP：连接、`tools/list`、`tools/call` 并回读 `GeoD MCP OK` 通过。同一调用编号在重启后复用已保存结果；结果不明时停止自动重试，参数变更则拒绝。
- 通过当前应用代理发起的 MCP Registry 搜索返回有效 `servers` 数组。
- 模型网关 8 项测试通过；新增本地四轮模拟，依次完成扩展发现、Skill 读取、MCP 工具调用和最终回复。
- 本机正式 DeepSeek `deepseek-flash` 验证通过：使用本机已有的受限环境配置，仅将密钥注入临时测试进程；假身份服务、本机模型网关和 `echo` MCP 服务全在回环地址。模型依次调用 `extensions_list → skill_read → mcp_call`，第 4 轮根据真实 MCP 返回给出最终答复。网关记录本次结算 9,770 token、预留 0；临时网关数据库已清理，未写入密钥或改动生产服务器。
- 桌面调试程序已重新构建并启动；浏览器预览核对了侧边入口与弹窗布局。浏览器预览不执行 Tauri 命令。

本机对话检查入口：在桌面应用输入“从网络查找 React 最佳实践 Skill 并准备接入”，或直接贴 `https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices`。Agent 应搜索或检查链接、从 GitHub 源站获取 `SKILL.md`，在对话卡显示来源、内容 SHA-256 和可展开的完整说明，确认后才启用。MCP 可输入 `http://127.0.0.1:43121/mcp` 并要求用 `echo` 回显；本机测试服务由 `node apps/geod-agent-desktop/test/mcp-mock.mjs` 提供。

2026-09-29 本地交互验收：`dev/local-desktop-gateway.mjs` 在回环地址 `127.0.0.1:43123` 运行新版网关，使用本机已有 DeepSeek 配置；身份桥只通过生产 `/api/agent/usage` 读接口验证桌面现有令牌，不改身份服务。桌面调试进程通过 `GEOD_AGENT_GATEWAY_ORIGIN` 指向本地网关，账号站点仍为正式 GeoD，未触发新的网页授权。用本机凭据向本地 `/api/agent/generations` 提交“先调用 extensions_list”的请求，真实 DeepSeek 返回 `settled` 且工具为 `extensions_list`。本地额度数据库独立于线上账号额度；此测试仍需在桌面界面中手动完成 Skill 导入、MCP 启用和对话展示验收。

2026-09-29 对话接入补充验收：前端构建、22 项前端测试、8 项网关测试、Rust 工作区路径单测以及真实本机 MCP 列工具与调用均通过。本机真实 DeepSeek 分别完成 `workspace_skills_list → workspace_skill_import` 和 `mcp_registry_search → mcp_connect` 工具选择；这两轮由测试桩提供候选和结果，用于验证模型循环与工具契约，不能替代桌面界面点击启用卡的人工验收。本机网关和桌面应用已换成新版并保持运行，生产服务器未改动。

2026-09-29 网络 Skill 修正验收：本机从 `skills.sh` 获取真实目录结果，并从 `vercel-labs/agent-skills` 当前 GitHub 仓库读取 `SKILL.md`，核对文件内容、名称、来源、SHA-256、默认停用与重复接入幂等性；GitHub 仓库链接列出的候选与 `skills.sh` 页面链接也通过。真实 DeepSeek 用测试桩依次选择 `skill_catalog_search → skill_connect`、`skill_source_inspect → skill_connect`；本机实际下载和存储由 Rust 网络测试验证，工具选择由模型测试验证。对话卡点击仍待桌面界面验收。

## 生产网关发布范围（本轮暂缓）

- 目标仅为腾讯云 `127.0.0.1:9115` 的 GeoD Agent 模型网关，不改账号服务、Nginx、DNS 或其他 PM2 服务。
- 当前 release：`/srv/laogao/releases/geod-agent/geod-agent-loop-20260929-11e3db31`；当前 `server.mjs` SHA-256：`11e3db31782510d98c69af8abf065efd09a5a0e2ae53006a08cf90a76af0bd85`。
- 新候选文件为 `services/geod-agent-model-gateway/server.mjs`。此前记录的候选 SHA-256 已随本地功能修正失效；发布前须重新计算并重新制作可审查的候选。
- 计划在本机校验后通过固定主机密钥上传该文件；服务器先备份现有 SQLite，再由当前 release 复制到新的不可变目录，仅替换 `server.mjs`，核对 SHA-256 后切换 `/srv/laogao/current/geod-agent` 并重启受影响 PM2 服务。验证 loopback `/health`、无令牌 401、SQLite `quick_check`、网关工具合同与一次真实账号对话。失败则切回旧 symlink 并重启原 PM2 服务，保留新目录和数据库供排查。
- 当前状态：**服务器尚未修改**。用户要求先进行本地测试，本轮不推进发布。

## 已知范围

- 本机 GDAL MCP 专用连接已增加 `workspace_gis_files_list → gdal_connect → mcp_call` 路径。使用 `gdal-mcp==1.1.3`，当前本地候选公开 10 项：`raster_info`、`raster_stats`、`raster_convert`、`raster_reproject`、`vector_info`、`vector_convert`、`vector_clip`、`vector_buffer`、`vector_simplify`、`vector_reproject`。Confirm Each 模式可读取信息与统计；转换、裁剪、缓冲区、简化和重投影需该对话 Full Access。输入、裁剪蒙版和新输出均限制在对话绑定工作区。新网关工具仅在本地，尚未发布。
- 重投影 schema 增加 `methodology`：AI 提供目标 CRS 依据，栅格还提供重采样依据，包含目的、理由、取舍和置信度。它是 AI 方法说明，不是用户审批。桥接层只在上游明确返回执行前的 reflection 拒绝时调用 `store_justification` 并重试，真实处理失败或结果未知不自动重试；已有缓存直接复用。未调用 `prompts/get`，所需方法指导直接在公开 schema 中提供。CRS 参数限制为 EPSG 代码；缓存目录也检查工作区范围。
- `src-tauri/src/gdal_stdio.py` 是内嵌启动适配层：用隔离的 Python 入口启动固定版本 MCP，修复上游 `sha256:<hash>.json` 文件名在 Windows 下无法写入的问题，并使用原子替换保存说明。缓存仍保存在当前工作区 `.preflight/justifications`，不会修改 uv 的包缓存。只读工具不会因此创建缓存目录。
- 栅格重投影保留源驱动格式，改文件后缀不等于转换格式；schema 提醒 Agent 先检查格式，如需不同格式则另行调用 `raster_convert`。无源地理变换的普通图片不能仅靠指定 CRS 成为有效地理栅格。
- 2026-09-30 本机实际 GDAL 验证：GeoJSON→GeoPackage、PNG→GeoTIFF、GeoJSON 范围裁剪通过；新增矢量和带 world file 的栅格重投影到 EPSG:3857 通过，核对投影后坐标、实际 SQLite/TIFF 文件头、方法缓存及相同调用编号复用结果。矢量与栅格在分别启动的进程中共享同一 CRS 缓存。实际返回的两项增补 schema 均在模型工具发现的 4,000 字符预算内；GDAL 工具发现完整提供 10 项。
- 2026-09-30 本机真实 DeepSeek 闭环：`test/gdal-live-smoke.mjs` 启动假身份服务和独立本机网关，使用已有受限配置调用官方 `deepseek-flash`；Rust 测试提供临时工作区的模拟账号权限元数据，实际列出 GDAL schema 并通过生产原生桥执行工具。模型完成 `raster_info → vector_info → vector_reproject → raster_reproject → vector_info → raster_info`，自行生成 CRS 和重采样说明，核对实际 GeoPackage／GeoTIFF 输出。补齐上游自由字符串 schema 中缺少的重采样枚举后通过；临时文件及网关数据库已清理，密钥未传给原生测试子进程，生产服务未修改。此验收覆盖真实模型与原生工具链，不代表完成了桌面界面的人工交互验收。
- 通用 MCP 目前仅支持无需额外认证的 Streamable HTTP；本机 GDAL 格式转换有固定版本的专用 stdio 接入。OAuth、密钥请求头和任意 stdio 进程配置尚未接入。Skill 只加载 `SKILL.md` 文本。
- Registry 搜索结果是服务发布者的元数据，启用前仍需检查实际工具和服务方权限。

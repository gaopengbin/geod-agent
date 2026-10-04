# LibreChat 风格的 Agent 工作区

## 本轮范围

用户授权以 LibreChat 为整体视觉参考、AionUi 为工作区与成果组织参考，并将方案沉淀到 `frontend-design-codex`。仅修改前端和本机 UI skill，通过现有开发模式预览。

## 实现

- `apps/geod-agent-desktop/src/theme.css`：统一白色 / `#212121` 阅读区、浅灰 / `#171717` 导航，中性色承载主面积；保留 GeoD 蓝色操作。正文 16px，窄屏 15px；导航 14px。输入框 24px 圆角，消息气泡 22px。
- `src/workspace.css`：对话内容和输入框限制阅读宽度；地图与成果使用独立轻边框表面，保持原有面板调宽和视图切换。右侧列表独立滚动，聊天内多任务保持两行入口。
- `src/workspace-layout.ts`：宽屏默认导航 224px、对话 480px、任务 336px，剩余给地图。保留已保存的用户宽度。
- `src/workbench.tsx`：补齐窄屏图标视图按钮的可访问名称。
- `src/components/motion/popover-position.ts`、`popover-morph.tsx`：修复窄屏上下文浮层越过左边界；按视口约束位置、必要时翻转方向。保留 Morph 动效。
- `public/fonts`：内置 Noto Sans SC 可变字库，字重 100–900，保留 SIL OFL。完整 WOFF2 为 7,783,532 字节，构建产物包含该文件；避免中文依赖系统字体。

未更改 AI 回复生成、任务确认、数据库、MCP 或下载引擎行为。

## Skill 沉淀

已更新本机 `C:/Users/Administrator/.codex/skills/frontend-design-codex/SKILL.md` 和 `agents/openai.yaml`。

新增 `references/librechat-agent-ui.md`，包含来源、布局、浅深主题参数、字号、输入框、任务与成果、思考与执行、动效和验收。无既定风格的 Agent 新项目可直接采用该常用方案，无需四选一；局部维护已有页面仍保持其既有风格，用户明确参考优先。

## 验证

- `npm run build` 成功。现有主 JS 体积警告仍存在。
- `node --test test/popover-position.test.mjs test/workspace-layout.test.mjs test/chat-work.test.mjs test/task-queue.test.mjs test/plan-presentation.test.mjs`：33 项通过。
- `skill-creator/scripts/quick_validate.py`：Skill is valid。
- 浏览器检查 1440 × 900 和 390 × 844，浅 / 深色，对话、连接器、图源、任务页；模型与上下文浮层、思考折叠、多选与丢弃、键盘调宽。
- 32 项演示任务：聊天入口 58px 高；右侧列表拥有独立滚动，未造成整页横向溢出。
- 实际计算颜色：抽查正文、选中导航、任务状态、次文字、输入文字和启用的主按钮，对比度最低 4.97:1。证据见 `computed-contrast.json`，不宣称全站审计通过。
- 字体加载状态为 loaded；`document.fonts.check` 对中文检查通过。字库 cmap 包含图源、行政区、数据库及成果示例文字。
- 本机 GeoD Agent 进程运行于 `src-tauri/target/debug/geod-agent-desktop.exe`；继续使用开发模式热更新，未安装或发布。

界面使用隔离的 `test/workbench-v2-harness.html` 演示数据。截图仅证明前端排版和交互，不代表真实模型、数据库连接或下载测试。

## 截图

- [深色四栏](evidence/ui-librechat-2026-10-02/workbench-dark-1440.png)
- [浅色 32 项任务](evidence/ui-librechat-2026-10-02/workbench-light-32-tasks.png)
- [连接器](evidence/ui-librechat-2026-10-02/connectors-dark-1440.png)
- [窄屏上下文](evidence/ui-librechat-2026-10-02/context-narrow-390.png)
- [窄屏任务](evidence/ui-librechat-2026-10-02/tasks-narrow-390.png)

## 第二轮：字体与图标

用户指出上一版仍缺少字体、图标的一致性。检查发现主字体仍优先 Segoe，功能图标仍使用 Phosphor。本轮补齐这些细节：

- `src/icons.ts` 统一为 Lucide，移除 Phosphor 依赖。保持 24px 网格 / 2px 描边，主导航显示 18px；新对话采用书写图标，左右面板图标按位置与展开状态表达动作。
- `public/fonts` 自托管 LibreChat 上游六个 Inter 常规 / 斜体文件，保留 `OFL-Inter.txt`。`src/theme.css` 使用上游 Regular 400、SemiBold 500、Bold 600、`size-adjust: 94%` 的声明。
- 字体顺序调整为 Inter → 本地 Noto Sans SC → 系统回退，Tailwind `font-sans` 同步到产品变量。正文保持 16px，窄窗 15px；管理页和标题的 650 / 690 字重归一到 600。
- UI skill 的 `references/librechat-agent-ui.md` 新增字体和图标规范、来源、字体许可与实际字形验收方法。

来源：[字体声明](https://github.com/LibreChat-AI/LibreChat/blob/main/client/src/style.css)、[字体配置](https://github.com/LibreChat-AI/LibreChat/blob/main/client/tailwind.config.cjs)、[图标依赖](https://github.com/LibreChat-AI/LibreChat/blob/main/client/package.json)。这是视觉适配，不代表整个 LibreChat 产品功能已接入。

### 第二轮验证

- 构建通过，相关 33 项回归检查通过，UI skill 校验通过。
- 浏览器 CDP `CSS.getPlatformFontsForNode` 确认混合段落实际由自托管 Inter-Regular 和 Noto Sans SC 渲染；不是仅检查 CSS 声明。
- 1440 × 900 深浅主题、连接器管理页、390 × 844 对话排版检查通过，未发现整页横向溢出；多个任务的聊天入口仍为 58px。最终深色截图采集前确认 `data-theme=dark`，主要操作已启用。
- 浏览器未记录 error 日志。桌面开发进程运行于 `src-tauri/target/debug/geod-agent-desktop.exe`，使用现有 Vite 热更新。
- 截图继续使用隔离演示数据，字体与图标改动没有进行新的真实模型、数据库或下载测试。

第二轮证据目录：`evidence/ui-librechat-2026-10-02/typography-icons/`。

- [深色字体与图标](evidence/ui-librechat-2026-10-02/typography-icons/workbench-dark-1440.png)
- [浅色字体与图标](evidence/ui-librechat-2026-10-02/typography-icons/workbench-light-1440.png)
- [连接器](evidence/ui-librechat-2026-10-02/typography-icons/connectors-light-1440.png)
- [窄窗](evidence/ui-librechat-2026-10-02/typography-icons/workbench-narrow-390.png)
- [实际字体与尺寸](evidence/ui-librechat-2026-10-02/typography-icons/font-verification.json)

## 第三轮：共享控件与工具详情

用户截图仍包含旧蓝色提示气泡、混用胶囊圆角的按钮、默认等宽字体以及大块工具输入 / 结果。已对照 LibreChat 共享控件源码继续调整：

- 共享普通按钮改为 8px 圆角矩形，次按钮与菜单选中态使用中性色；发送和停止仍为圆形。保留现有按钮、菜单和折叠动效，执行行 hover 保持稳定尺寸。
- 提示气泡采用主表面颜色、小圆角、4 / 8px 内边距和轻阴影；统一账户、工作区和模型菜单的阴影及悬浮颜色。
- 新增 Radix ScrollArea 包装，对话、任务队列、任务详情和长代码输出使用自定义覆盖式滑块。对话原有跟随与滚动事件保持接入；嵌套长内容不撑开列宽。
- 工具详情增加标题、格式说明和复制操作，空输入显示“无参数”。长结果保留完整内容，在 240px 高的区域内独立滚动。自托管 LibreChat 使用的 Roboto Mono 常规 / 粗体 / 斜体文件，保留 OFL。
- 本机 UI skill 补充共享控件、提示气泡、滚动及工具详情规范。

参考来源：[Button](https://github.com/LibreChat-AI/LibreChat/blob/main/packages/client/src/components/Button.tsx)、[Tooltip.css](https://github.com/LibreChat-AI/LibreChat/blob/main/packages/client/src/components/Tooltip.css)、[CodeBlock](https://github.com/LibreChat-AI/LibreChat/blob/main/client/src/components/Messages/Content/CodeBlock.tsx)。四区域工作台及下载任务详情是 GeoD 的业务适配，本轮不宣称全部页面与 LibreChat 逐像素一致。

### 第三轮验证

- 开发服务新增依赖后出现过 Vite 优化缓存缺失（模块请求 504），已仅重启 1420 端口的 Vite 并强制刷新依赖缓存；桌面进程保持运行，未安装或发布。
- 浏览器核对深浅色 1440 × 900 和 390 × 844，无整页横向溢出。正文实际为 16px / 400。
- 32 项演示任务：任务列表视口 205px、内容 1838px；展开任务参数后详情视口 437px、内容 691px。两处保持独立滚动。
- 长工具结果视口 240px、内容 2255px，键盘 End 到达 scrollTop 2015；任务列表键盘 End 到达末尾。代码完整文本 1611 字符，复制操作显示“已复制结果”；IAB 剪贴板读取未返回文本，因此不把该检查声明为系统剪贴板内容回读通过。
- CDP 确认代码实际渲染使用自托管 RobotoMono-Regular 与 Noto Sans SC。提示气泡键盘焦点触发正常，实际浅色为白底、深字、4px 圆角及 16px 字号。
- 对话分隔条 ArrowRight 将宽度从 480px 调整为 492px，未造成页面溢出；勾选核对项后主操作可用。
- 最终构建通过，相关 33 项回归检查通过；主 JS 体积警告仍存在。界面截图仍来自隔离演示数据，只证明前端布局与交互。

第三轮证据：

- [浅色控件与工具详情](evidence/ui-librechat-2026-10-02/controls-details/details-light-1440.png)
- [深色控件与工具详情](evidence/ui-librechat-2026-10-02/controls-details/details-dark-1440.png)
- [提示气泡](evidence/ui-librechat-2026-10-02/controls-details/tooltip-light-1440.png)
- [窄窗长输出](evidence/ui-librechat-2026-10-02/controls-details/details-narrow-390.png)
- [实际代码字体](evidence/ui-librechat-2026-10-02/controls-details/font-verification.json)

## 第四轮：布局开关、分隔条与设置

用户指出拖动时全部分割线高亮、缺少左侧伸缩按钮，以及账户、网络设置和连接状态的细节不一致。此轮继续在开发模式修补：

- 删除桌面标题栏的“本地引擎已连接”。原判断仅为 `desktopAvailable = isTauri()`，没有检测引擎健康，不能表示后端或模型连接成功。浏览器才显示“界面预览”，并解释本地操作由桌面应用提供。
- 品牌旁增加始终可用的会话列表开关。宽屏收成 64px 图标栏，展开恢复原有宽度；收起和展开分别保存列宽，避免互相覆盖。窄窗继续使用 240px 抽屉。补齐 aria-expanded、动作名称和提示。
- 拖动状态改为记录当前分隔条。视觉为 3 × 40px 中性短手柄，实际命中区 12px；未操作的手柄隐藏，拖动时只有当前一条显示。保留键盘调宽、双击恢复和宽度持久化。
- 账号菜单提取为共用 AccountMenu，使用现有 MorphPopover 的锚点、边界避让和动效。宽度 260px；长 ID 截断并保留完整提示，用量按中文千分位显示，不展示零值“请求中”。键盘打开聚焦首项，Esc 返回触发按钮。
- 网络设置宽度 480px，移除英文眉题，统一中性遮罩、圆角、间距、选择框和操作层级。测试与保存分别显示等待动画；保存成功后关闭。测试结果明确为“边界服务可达”，不代表所有外部服务已验证。

### 第四轮验证

- 最终 `npm run build` 通过；主 JS 体积警告仍存在。布局、浮层定位、思考分组、任务队列及计划展示相关 38 项检查通过，其中新增 5 个收起布局的边界检查。
- 1440 × 900 实际按住鼠标拖动：只有当前分隔条的 40px 手柄显示，其余透明；释放后退出拖动状态。收起后侧栏 64px、账号图标中心 32px，展开恢复 224px 及已保存对话宽度。
- 960 × 720 抽屉宽 240px，具有关闭遮罩；390 × 844 网络设置宽 366px、左右各 12px，完整操作区可见。抽查对话、图源管理、菜单和设置，无整页横向溢出。
- 浅深色菜单及网络面板核对完成；实际触发“测试中”和“保存中”的独立等待动画。账号菜单 ArrowDown 聚焦“网络与代理”，Esc 恢复“账号与设置”焦点。
- 隔离演示页面没有记录 error 日志。桌面开发进程 53336 保持运行，1420 服务 HTTP 200；继续 HMR，未重新安装或发布。
- 网络测试和保存验证使用演示页的隔离命令桩，仅修改内存中的演示设置，没有修改用户真实代理配置。这些证据仅证明前端布局、状态和交互，不是新的模型、数据库或下载验证。

第四轮证据：

- [收起的侧栏](evidence/ui-librechat-2026-10-02/layout-settings/collapsed-workbench-light-1440.png)
- [拖动当前分隔条](evidence/ui-librechat-2026-10-02/layout-settings/drag-current-divider-dark-1440.png)
- [浅色账号菜单](evidence/ui-librechat-2026-10-02/layout-settings/account-menu-light-1440.png)
- [深色账号菜单](evidence/ui-librechat-2026-10-02/layout-settings/account-menu-dark-1440.png)
- [深色网络设置](evidence/ui-librechat-2026-10-02/layout-settings/network-dark-1440.png)
- [测试等待状态](evidence/ui-librechat-2026-10-02/layout-settings/network-testing-dark-1440.png)
- [浅色网络设置](evidence/ui-librechat-2026-10-02/layout-settings/network-light-1440.png)
- [窄窗网络设置](evidence/ui-librechat-2026-10-02/layout-settings/network-light-390.png)

## 第五轮：添加与编辑图源

用户截图中的图源表单仍保留整块蓝色示例卡片和旧字段层级。本轮调整实际 `src/source-page.tsx` 及对应样式：

- 表单与编辑页头统一为 720px 阅读宽度，返回动作使用标题旁的图标按钮。输入与选择控件统一 40px，字段标签 13px / 500，辅助说明 12px；ID 和服务地址采用现有 Roboto Mono。
- 常用字段分为“连接信息”和“瓦片设置”，显示名称先于图源 ID。示例改为标题同行的“填入示例”按钮，提示说明具体的 USGS NAIP 示例。
- 将“瓦片坐标系”更正为“瓦片编号方式”，XYZ/TMS 是编号方案。来源、备注、连接类型和请求间隔放进“更多设置”，新建时收起，编辑已有配置或核对 Agent 草稿时展开；折叠不会清空输入。
- 操作区使用次级取消和主要保存按钮，保存显示动画并禁用表单字段及返回入口。保留已有必填、缩放级别和重复 ID 保护，以及原图源保存 API。
- 图源列表和编辑表单使用现有 ScrollArea，窄窗改为单列；删除无调用方的旧蓝色示例样式。

### 第五轮验证

- 最终 TypeScript / Vite 构建通过，既有主包体积警告仍存在。
- 1440 × 900 深浅色核对：表单宽 720px，标签实际字重 500，服务地址计算字体为产品等宽字体；无整页横向溢出。
- 实际操作验证空表单错误、示例填入、重复 ID 禁用保存、XYZ/TMS 下拉选择、更多设置键盘开合，以及折叠后来源与 100ms 请求间隔保留。
- 保存期间 aria-busy 为 true，所有输入与选择触发器匹配 :disabled；完成后返回列表并显示成功提示。编辑入口的 ID 为只读，“更多设置”自动展开。
- 390 × 844：表单宽 294px、单列，无横向溢出；表单视口 719px、内容 944px，键盘 End 最终滚动至 225px，操作区底部在 820px 内可见。展开更多设置后 Tab 到取消按钮，焦点滚入视野。
- 原图源列表 / 详情布局仍为 876px / 340px（1440px 窗口、224px 导航），浏览器未记录 error 日志。桌面进程 53336 与 1420 开发服务保持运行，未安装或发布。
- 保存反馈使用隔离演示页新增的 sources_save 内存桩，不写入真实图源配置，也不表示真实服务可达或下载成功。未改动模型回复、来源发现或后端协议。

第五轮证据：

- [深色添加图源](evidence/ui-librechat-2026-10-02/source-form/add-source-dark-1440.png)
- [浅色添加图源](evidence/ui-librechat-2026-10-02/source-form/add-source-light-1440.png)
- [保存等待状态](evidence/ui-librechat-2026-10-02/source-form/saving-dark-1440.png)
- [窄窗底部操作](evidence/ui-librechat-2026-10-02/source-form/add-source-light-390-bottom.png)

## 第六轮：实际图源缩略图

- 图源卡片增加 96 × 64px 示例缩略图；详情中使用较大的预览及刷新按钮。保留紧凑卡片，1440px 和 390px 验收时卡片高度均为 132px。
- 添加 / 编辑表单增加“预览图源”。未保存的参数通过原生图源适配器读取一张瓦片，不登记临时图源；更改参数会隐藏旧图并提示更新预览。预览成功不是保存的前置条件。
- 复用 XYZ / TMS / ArcGIS 图源的实际读取、代理与参数验证。缩略图按可见区域加载，最多两个并发任务，合并同一图源的进行中请求；成功缓存 10 分钟，失败缓存 20 秒。加载显示动画，非图片、透明空瓦片和网络错误显示占位，详情 / 表单可重试。
- ArcGIS 使用覆盖范围选择样本。ImageServer 的整体 bbox 可能包含大量海洋；缩略图专用只读接口最多查询 8 个实际栅格覆盖区，优先较小范围，最多尝试 3 个透明样本。普通 Agent 的 inspect_source 不增加这次查询，也不要求启用图源 Creator 才能查看缩略图。[ArcGIS Query Image Service](https://developers.arcgis.com/rest/services-reference/enterprise/query-image-service/)

### 第六轮验证

- TypeScript / Vite 构建通过，既有主包体积警告仍在；7 项缩略图坐标和内容检查通过；Rust 图源检查模块 4 项通过，2 项可选网络 / 模型测试保持 ignored。原生开发版重新编译并启动，保持 1420 热更新，未安装或发布。
- 通过运行中桌面的真实 IPC 读取已登记 Esri 与 USGS，以及两份未保存配置。Esri 实际 JPEG 为 19,458 bytes；USGS 实际 PNG 为 96,864 bytes。图片解码及非透明像素检查通过，前后已登记图源完全相同。原始图片和逐项结果保存在 native-readback.json 旁。
- USGS 初次以全球 bbox 中心取样返回透明图，Category 条件查询还出现过超时；已改成有数量上限的普通覆盖区查询并按面积选样，最终已登记和未保存两种调用均成功。USGS 本次采样点为 -67.897°、18.108°，不代表整个覆盖范围或数据时效。
- 浏览器验收使用实际 SourcePage，通过仅允许 4 个只读命令的本机 IPC 适配器访问真实图源；不是图片命令桩。1440 × 900 深浅色列表 / 详情、表单预览、参数过期提示、390 × 844 单列和真实 404 失败反馈通过，没有整页横向溢出。验收适配器和临时浏览器页测试后关闭。
- 缩略图用于辨认图源样式和查看样本，不证明下载任务已执行或图源所有区域可用；未进行新的模型请求、下载作业或授权配置修改。

第六轮证据：

- [深色列表与详情](evidence/ui-librechat-2026-10-02/source-thumbnails/list-detail-dark.png)
- [浅色列表与详情](evidence/ui-librechat-2026-10-02/source-thumbnails/list-detail-light.png)
- [未保存配置预览](evidence/ui-librechat-2026-10-02/source-thumbnails/form-preview-light.png)
- [窄窗列表](evidence/ui-librechat-2026-10-02/source-thumbnails/list-narrow-light.png)
- [实际 404 占位与重试](evidence/ui-librechat-2026-10-02/source-thumbnails/form-narrow-failure.png)
- [原生图源结果回读](evidence/ui-librechat-2026-10-02/source-thumbnails/native-readback.json)

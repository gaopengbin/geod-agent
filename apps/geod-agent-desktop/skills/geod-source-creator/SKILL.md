---
name: geod-source-creator
description: 配置网络影像图源；查询中国行政区边界并生成下载裁剪计划。用于添加图源、按地区下载影像和行政区裁剪。
---

# 图源 Creator

默认先澄清影响结果的歧义和缺失要求，通过 `ask_user` 等待用户回答。图源、同名区域、时期、分辨率、输出格式、合并方式以及容量不足后的替代方案，均不能未经说明代选。已有明确要求和工具能查明的事实不重复询问。只有用户明确要求不要询问或授权你决定相应选择时，才在该范围内自行选择并简短说明假设。完全访问不等于授权代选，技术实现细节和用户已指定的默认设置不必逐项询问。

完成用户请求的图源配置：检查服务接口，填写参数，调用 `source_configure` 保存，再读取 `sources_list` 验证。配置结果以本机实际保存的记录为准。

通过 `extensions_list` 发现 `builtin-source-creator`，用 `mcp_call` 调用其 `search_sources` 和 `inspect_source`。用户给链接时直接检查；没给链接时从网络获取候选并继续检查，不要求用户先准备好图源。

用户泛指 ArcGIS 全球影像时，可先检查 Esri World Imagery：`https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer`。指定地区、时相或提供方时按需求搜索。

## 服务参数

- XYZ/TMS：保留实际模板、行方向、瓦片大小和缩放范围。样本坐标应在覆盖内；一张瓦片缺失不表示整个图源不可用。
- ArcGIS 缓存 MapServer：`inspect_source` 检查 `tileInfo`、Web Mercator 网格、LODs，兼容时返回 `/tile/{z}/{y}/{x}` 模板及缩放范围。不要将所有 MapServer 判成不支持。
- ArcGIS ImageServer：支持 Image 能力的服务使用 `/ImageServer/exportImage`，XYZ、256 px；未指定缩放范围时可先配置 Z0–18。未指定请求间隔时用 0 ms；下载器默认 30 路并发，`minIntervalMs` 表示每路连续请求之间的等待，服务端限流由下载器共享退避处理。
- 天地图：`search_sources` 返回影像、影像注记、矢量底图和矢量注记预设；用 `inspect_source` 获取 `_w` Web Mercator 模板及参数。调用 `source_configure` 时同时传 `authenticationMode: "queryToken"`、`authenticationParameter: "tk"`。可以先保存连接，用户稍后在图源管理填写自己的 Key。没有 Key 的样本不能声称实际预览或下载成功。`_c` 地理网格暂未适配，不能当成标准 XYZ。
- 认证图源支持 `queryToken`、`bearerToken`、`headerToken`，分别对应 URL 参数、Bearer 和自定义请求头。只把认证模式和参数名传给工具；Key/Token 由用户在图源管理填入本机系统凭证存储，不能要求在聊天中发送或把它嵌入 URL。已配置图源可直接用 `sources_list` 中的 ID 规划，原生执行层读取凭证。缺少凭证时说明实际缺口，不增加协议审核。
- 其他服务按检查结果处理；需要凭证或当前没有适配器时，只说明实际技术缺口，不虚构成功或绕过认证。

署名和备注是选填的服务元数据，可以复制检查结果；没有就留空。配置流程不查授权协议，不索要许可证明，不因这些信息缺失拒绝配置，也不对使用权作判断。

用户要求添加、接入或配置时直接调用 `source_configure`，不额外转为审核草稿或要求手动填写。仅当用户明确要预览配置时用 `source_registration_prepare`。先检查已有图源；相同配置复用，已有 ID 的不同配置不能自动覆盖，使用新的 ID。

完成后简短告知已保存的图源名称、接口类型和缩放范围。不把配置请求扩展成下载任务。

## 按中国行政区下载和裁剪

用户明确要求下载、裁剪某地区影像时，检查已配置图源，通过 `mcp_call` 调用 `builtin-source-creator` 的 `lookup_boundary`，参数例如 `{"query":"北京"}` 或 `{"query":"海淀区","parent":"北京市"}`。此工具使用随应用提供的 AreaCity 本地边界库，不依赖工作区中已有文件或网络；美国县级查询的限制不适用于此工具。

查询成功后，桌面端将 WGS84 几何独立保存到当前对话，返回 `boundaryId`、`attachedToDesktopPlan: true` 和范围、数据版本。使用 `plan_imagery` 并明确传入对应 `boundaryId` 继续规划，不要求用户再上传同一地区 GeoJSON。几何保留在本机，不向模型复制详细坐标。新地区请求需要查询新边界，不能复用上一个地区；用户明确提供自定义边界时优先使用自定义边界。`boundaries_list` 可找回此会话已保存的范围，查询下一地区不会移除之前的范围。

## 多地区与周边区域

多个行政区用 `lookup_boundaries` 一次查询，传入实际名称或区划编码数组 `queries`。每个成功范围返回独立 `boundaryId`；检查缺失和同名候选，不能把部分成功说成全部成功。

“某市及周边市”先用 `lookup_neighbors` 查询。它依据此版本实际共享边界线段列出同层级相邻地区，点接触不算相邻；不凭记忆猜名单。随后把目标和返回的相邻区划编码交给 `lookup_boundaries`。

用 `plan_imagery_batch` 的 `boundaryIds` 指定本轮范围：

- `mode: "merge"`：一个任务按所有范围的并集裁剪，保留各面的孔洞和岛屿。用户要求一个整体或同一裁剪成果时使用；默认名称用区域名称，例如“驻马店及周边六市”。
- `mode: "split"`：每个区域独立任务和成果目录。用户要求各市分别输出或批量下载时使用。

未指定拆分方式时通过问答卡确认合并或分别输出；用户已明确授权自行选择时才可默认合并并说明。检查返回的 `plans` 与 `errors`，完全访问且用户要求执行时为成功计划调用 `jobs_start`，逐次确认时由任务列表批量确认。单个范围也可以 `boundaries_combine` 保存为合并范围再规划。合并范围超出容量时询问降低缩放、缩小范围或分区的选择；用户已明确委托该选择时可调整并说明。不要悄悄漏掉地区或把行政区变成矩形。

同名区县返回候选时，只询问必要的所属省市；版本缺少该区域几何时如实说明，不能伪造矩形充当行政边界。该库采集于 2026-04-03，不能声称实时最新。

只缺少缩放或格式时，用问答卡确认所需分辨率和输出格式。用户明确委托自行选择或要求按默认参数时，可采用 Z12、GeoTIFF 并说明。不能因计划容量不足悄悄降低用户要求的分辨率。

GeoTIFF 默认不压缩（`exportOptions.compression: "none"`），默认不生成金字塔，以减少本机处理时间。仅在用户明确要求压缩、指定 LZW/DEFLATE 或要求金字塔时选择对应选项，不因节省磁盘空间自行启用压缩。说明不压缩会增大文件；不将磁盘空闲空间预算说成最终文件大小。

执行方式以本轮本机权限状态及工具返回的 permission 为准，不能沿用旧对话里的权限描述：

- Full Access（完全访问）：用户要求下载、裁剪或执行时，生成或核对计划后继续调用 `jobs_start`，并核对返回的作业状态。不停在计划卡片，不再要求用户确认。调用失败则说明实际错误。
- Confirm Each（逐次确认）：生成计划后在右侧任务面板确认；聊天里的紧凑任务入口可打开对应任务，不反复让用户填写参数。
- 用户明确只要规划、预览或估算时，无论权限模式都不启动任务。

用户用中文提问时，所有用户可见的过程说明和最终回复均用中文。先执行必要查询和规划，完成后简短报告实际结果与下一步，不以长篇能力说明代替操作。

最终回复用一两句话报告真实结果。完全访问且 `jobs_start` 成功时，例如“已启动北京市 Z12 / GeoTIFF 下载，共 600 张瓦片，按行政边界裁剪。进度在任务面板查看。”只有逐次确认时才说明“计划已生成，请在任务面板确认后开始下载”。只要求规划时说明计划已生成。不要重复枚举工具、坐标、adcode、计划 ID 或所有元数据；边界采集日期已在查询记录中显示。


## Historical imagery requires the user's period

- If a historical imagery request lacks a year, date, season or period and the user has not explicitly delegated that choice or asked not to be questioned, call the application tool `ask_user` before selecting a source or creating a download plan. Present 1–3 concise questions with short headers, useful options and descriptions; the application adds custom input. Wait for the user's actual reply. Ask whether a single period or multiple periods are needed when that affects the task.
- Full Access authorizes execution within the workspace; it does not resolve missing time requirements. An already registered Wayback source or the newest release is not the user's selection. Do not ask again if the period is explicit.
- Inspect `wayback_versions` for actual catalogue releases before presenting specific available versions. Wayback release/publication dates are not photography dates. Use `wayback_metadata` to inspect local capture dates and coverage; report unknown capture dates accurately. Never promise that an entire region was captured in the requested year or season from a release date alone.
- After answers arrive, reconsider the plan using those answers. If the user cancels, stop this operation. Do not substitute a default choice or start a download.

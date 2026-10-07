import type { AgentMessage, BoundaryImport, SourceRegistrationDraft, WorkspaceSettings } from "./api";
import type { DisplayMessage } from "./pending-generations";

const permissionPrefix = "【本轮本机权限状态】\n";
const permissionEnd = "\n【权限状态结束】\n";

/** Refresh native permission on every model round, preserving the user's request and URLs. */
export function workspacePermissionContext(messages: AgentMessage[], permission: WorkspaceSettings["permission"], outputCrs?: string | null): AgentMessage[] {
  const current = messages.map(message => ({ ...message }));
  const latest = [...current].reverse().find(message => message.role === "user");
  if (!latest) throw new Error("当前请求缺少用户消息。请重新发送请求。");
  let request = latest.content ?? "";
  if (request.startsWith(permissionPrefix)) {
    const end = request.indexOf(permissionEnd);
    if (end >= 0) request = request.slice(end + permissionEnd.length);
  }
  const state = JSON.stringify({ permission, canStartWithoutPlanConfirmation: permission === "fullAccess", outputCrs: outputCrs ?? null });
  const instruction = permission === "fullAccess"
    ? "当前对话为完全访问。用户要求下载或执行时，生成或核对计划后继续调用 jobs_start，不等待计划卡片确认，不沿用旧消息中的逐次确认状态。仅要求规划、预览或估算时不启动任务。执行结果以本机工具返回为准。完全访问不代表用户授权代选参数。任何影响结果的需求不明确时，先通过 ask_user 询问并等待回答，不能擅自决定范围、时期、缩放、格式、合并方式或降级方案；只有用户明确要求不要询问或在相应范围内授权你决定时，才自行选择并说明假设。已经明确的要求和工具能查询的事实不用重复问。"
    : "当前对话为逐次确认。生成计划后等待用户在右侧任务面板确认，不自动调用 jobs_start。聊天里的任务入口可打开对应任务。";
  latest.content = permissionPrefix + state + "\n" + instruction + "\noutputCrs 是用户明确选择的当前会话默认成果坐标系；非空时沿用，当前请求单次指定可覆盖但不改写默认。为空且本次未指定时，通过询问卡片确认，不擅自默认。需要查看本轮新更改时查询 workspace_status。\n下载由本机后台执行。启动本轮用户要求的全部计划后结束本轮；批量任务需逐个启动成功计划，不能只启动第一个。查询到任务仍在运行时报告一次当前状态，不反复调用 jobs_get/jobs_events 等待完成。" + permissionEnd + request;
  return current;
}

export function pendingPlanLabel(permission?: WorkspaceSettings["permission"] | null) {
  return permission === "confirmEach" ? "待确认" : permission === "fullAccess" ? "待执行" : "计划已生成";
}

/** Attach detailed geometry locally and expose only compact metadata to the model. */
export function boundaryLookupReply(raw: Record<string, unknown>) {
  const { boundary, ...summary } = raw;
  if (raw.found !== true) return { attachment: null, result: summary };
  const attachment = boundary as BoundaryImport | undefined;
  if (!attachment?.geometry || !Array.isArray(attachment.bounds) || attachment.bounds.length !== 4 ||
    !attachment.bounds.every(value => Number.isFinite(value))) throw new Error("INVALID_BOUNDARY_RESULT");
  return { attachment, result: { ...summary, attachedToDesktopPlan: true } };
}

const labels: Record<string, string> = {
  workspace_status: "检查工作区",
  workspace_boundaries_list: "查找工作区边界",
  workspace_boundary_use: "读取工作区边界",
  data_input_read: "读取数据范围",
  online_connections_list: "查看在线数据连接",
  online_services_discover: "发现在线服务图层",
  data_connections_list: "查看数据库连接",
  data_connection_connect: "连接数据库",
  data_layer_inspect: "读取图层数据",
  sql_connections_list: "查看数据库连接",
  sql_connection_connect: "连接数据库",
  sql_objects_search: "发现数据库表与字段",
  sql_query: "读取数据库数据",
  sources_list: "检查已登记图源",
  source_configure: "配置图源",
  source_registration_prepare: "准备图源登记草稿",
  us_county_boundary: "查找行政边界",
  plan_imagery: "计算影像计划",
  plan_imagery_batch: "计算多区域影像计划",
  schedules_create: "创建定时影像任务",
  schedules_list: "检查定时任务与记录",
  schedules_cancel_run: "取消本次定时执行",
  schedules_set_enabled: "更新定时任务状态",
  ai_schedules_create: "创建 AI 定时任务",
  ai_schedules_list: "查看 AI 定时任务",
  background_command_prepare: "准备后台命令",
  background_command_list: "查看后台命令",
  background_command_get: "查看命令状态",
  background_command_start: "启动后台命令",
  background_command_stop: "停止后台命令",
  background_command_write: "发送命令输入",
  agent_memory_list: "读取偏好与记忆",
  agent_memory_save: "保存偏好与记忆",
  agent_memory_remove: "删除记忆",
  agent_tasks_spawn: "启动独立子任务",
  agent_tasks_list: "查看独立子任务",
  agent_tasks_get: "读取子任务结果",
  agent_tasks_read_file: "读取子任务文件",
  agent_tasks_cancel: "取消独立子任务",
  ai_schedules_set_enabled: "更新 AI 定时任务",
  ai_schedules_cancel_run: "取消 AI 定时执行",
  ai_schedules_retry_run: "重试 AI 定时执行",
  ai_schedules_run_events: "查看 AI 定时结果",
  boundaries_list: "查看会话范围",
  boundaries_combine: "合并裁剪范围",
  plans_get: "核对影像计划",
  jobs_list: "检查本机任务",
  jobs_start: "启动本机下载",
  jobs_get: "检查任务状态",
  jobs_events: "读取任务进度",
  artifacts_inspect: "核验成果文件",
  extensions_list: "检查技能与连接器",
  attachment_list: "查看对话文档",
  attachment_read: "读取文档内容",
  workspace_gis_files_list: "查找工作区数据文件",
  workspace_skills_list: "查找工作区 Skill",
  workspace_skill_import: "准备接入 Skill",
  skill_catalog_search: "搜索网络 Skill",
  skill_source_inspect: "检查 Skill 链接",
  skill_connect: "获取并校验 Skill",
  mcp_registry_search: "查找 MCP 连接器",
  mcp_connect: "测试 MCP 连接",
  gdal_connect: "准备本机 GDAL",
  skill_read: "读取 Skill 指令",
  mcp_call: "调用 MCP 工具",
  mcp_result_read: "读取 MCP 结果",
  mcp_result_export: "保存本机数据文件",
  data_download_plan: "规划数据下载",
  data_download_start: "启动后台数据下载",
  data_download_list: "查看数据任务",
  data_download_get: "查询数据任务状态",
  data_download_cancel: "取消数据下载",
  data_download_discard: "丢弃数据计划",
  data_download_inspect: "核验数据成果",
  data_download_load: "加载数据成果",
};

export function sourceRegistrationDraft(args: Record<string, unknown>): SourceRegistrationDraft | null {
  const { id, name, urlTemplate, scheme, tileSize, minZoom, maxZoom, minIntervalMs } = args;
  const attribution = args.attribution ?? "";
  const license = args.license ?? "";
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
      typeof name !== "string" || !name.trim() || name.length > 160 ||
      typeof urlTemplate !== "string" || urlTemplate.length > 1000 ||
      typeof attribution !== "string" || attribution.length > 1500 ||
      typeof license !== "string" || license.length > 3000 ||
      (scheme !== "XYZ" && scheme !== "TMS") || (tileSize !== 256 && tileSize !== 512) ||
      !Number.isInteger(minZoom) || !Number.isInteger(maxZoom) || (minZoom as number) < 0 ||
      (maxZoom as number) > 22 || (minZoom as number) > (maxZoom as number) ||
      !Number.isInteger(minIntervalMs) || (minIntervalMs as number) < 0 || (minIntervalMs as number) > 60_000) return null;
  let url: URL;
  const subdomains = args.subdomains;
  if (subdomains !== undefined && (!Array.isArray(subdomains) || subdomains.length > 16 || subdomains.some(value => typeof value !== "string" || !/^[a-zA-Z0-9-]{1,63}$/.test(value)))) return null;
  if (urlTemplate.includes("{s}") && (!Array.isArray(subdomains) || !subdomains.length)) return null;
  if (args.coordinateSystem !== undefined && !["wgs84", "gcj02"].includes(String(args.coordinateSystem))) return null;
  try { url = new URL(urlTemplate.replaceAll("{s}", Array.isArray(subdomains) ? subdomains[0] : "")); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some(key => /^(tk|token|access_token|api_key|apikey|key|authorization|signature|sig)$/i.test(key)) ||
      (!(urlTemplate.includes("{z}") && urlTemplate.includes("{x}") && urlTemplate.includes("{y}")) &&
      !url.pathname.endsWith("/ImageServer/exportImage"))) return null;
  const authenticationMode = args.authenticationMode;
  const authenticationParameter = args.authenticationParameter;
  if (authenticationMode !== undefined && !["queryToken", "bearerToken", "headerToken"].includes(String(authenticationMode))) return null;
  if (authenticationParameter !== undefined && (typeof authenticationParameter !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(authenticationParameter))) return null;
  if (args.elevationEncoding !== undefined && args.elevationEncoding !== "terrarium") return null;
  return { source: { id, name: name.trim(), urlTemplate, attribution: attribution.trim(), license: license.trim(), scheme,
    ...(args.elevationEncoding === "terrarium" ? { elevationEncoding: "terrarium" as const } : {}),
    ...(Array.isArray(subdomains) && subdomains.length ? { subdomains: subdomains as string[] } : {}),
    ...(args.coordinateSystem === "gcj02" ? { coordinateSystem: "gcj02" as const } : {}),
    tileSize, networkPolicy: "PublicHttps", minIntervalMs: minIntervalMs as number }, minZoom: minZoom as number, maxZoom: maxZoom as number,
    ...(authenticationMode ? { authenticationMode: authenticationMode as SourceRegistrationDraft["authenticationMode"], authenticationParameter: authenticationParameter as string | undefined } : {}) };
}

export function userProvidedUrl(message: string, url: string): boolean {
  return (message.match(/https?:\/\/[^\s<>"'“”，。；、]+/giu) ?? [])
    .some(candidate => candidate.replace(/[，。；、）)\]}]+$/u, "") === url);
}

export function toolDisplay(name: string, output: unknown): Pick<DisplayMessage, "content" | "toolName" | "toolStatus" | "sourceDraft" | "extensionProposal"> {
  const data = output && typeof output === "object" ? output as Record<string, unknown> : {};
  if (name === "ask_user") return { toolName: name, toolStatus: data.error ? "attention" : "success", content: data.knownFacts ? "补充需求 · 已查明本机配置，无需重复询问" : data.error ? "补充需求 · 已取消或未完成" : "补充需求 · 已收到你的选择" };
  const title = name === "mcp_call" && data.kind === "builtin"
    ? ({ search_sources: "搜索网络图源", inspect_source: "检查图源服务", lookup_boundary: "查询行政边界", lookup_boundaries: "查询多个行政区域", lookup_neighbors: "查询相邻区域" }[String(data.toolName)] ?? "调用图源工具")
    : labels[name] ?? name;
  if (data.error === "MCP_RESULT_UNKNOWN") return { toolName: name, toolStatus: "attention", content: `${title} · 结果待核对，已停止自动重试` };
  if (data.error === "MCP_EXECUTION_CONFLICT") return { toolName: name, toolStatus: "attention", content: `${title} · 调用参数与已保存记录不一致` };
  if (data.error === "SKIPPED_AFTER_MCP_UNKNOWN" || data.error === "SKIPPED_FOR_USER_REVIEW") return { toolName: name, toolStatus: "attention", content: `${title} · 等待核对，未执行` };
  if (typeof data.error === "string") return { toolName: name, toolStatus: "attention", content: `${title} · ${data.error}` };
  if (data.error && typeof data.error === "object") return { toolName: name, toolStatus: "attention", content: `${title} · ${String((data.error as { message?: unknown; code?: unknown }).message ?? (data.error as { code?: unknown }).code ?? "未完成")}` };
  if (name === "source_registration_prepare") {
    const draft = data.draft as SourceRegistrationDraft | undefined;
    return { toolName: name, toolStatus: "attention", content: draft ? `${title} · ${draft.source.name}，等待核对参数与保存` : `${title} · 等待核对`, sourceDraft: draft };
  }
  if (name === "source_configure") return { toolName: name, toolStatus: "success", content: `${title} · 已保存 ${String(data.name ?? data.id ?? "")}` };
  if (name === "mcp_connect" || name === "gdal_connect" || name === "workspace_skill_import" || name === "skill_connect") {
    const proposal = data.extensionProposal as DisplayMessage["extensionProposal"];
    if (proposal) return { toolName: name, toolStatus: "attention", content: `${title} · ${proposal.name}，${proposal.requiresKey?'等待本机填写 Key':'等待确认启用'}`, extensionProposal: proposal };
    if(data.requiresLocalConfiguration)return {toolName:name,toolStatus:'attention',content:`${title} · 等待本机配置，请打开已有配置卡`};
    return { toolName: name, toolStatus: "success", content: `${title} · ${String(data.connectorId ?? "已接入")}` };
  }
  if (name === "mcp_registry_search" || name === "skill_catalog_search" || name === "skill_source_inspect") return { toolName: name, toolStatus: "success", content: `${title} · ${Array.isArray(data.candidates) ? data.candidates.length : 0} 个候选` };
  if (name === "workspace_skills_list") return { toolName: name, toolStatus: "success", content: `${title} · ${Array.isArray(data.skills) ? data.skills.length : 0} 个` };
  if (name === "sources_list" && Array.isArray(data.sources)) return { toolName: name, toolStatus: "success", content: `${title} · ${data.sources.length} 个` };
  if (name === "workspace_boundaries_list" && Array.isArray(data.files)) return { toolName: name, toolStatus: "success", content: `${title} · ${data.files.length} 个文件` };
  if (name === "workspace_boundary_use") return { toolName: name, toolStatus: "success", content: `${title} · ${String(data.name ?? "已附加")}，${String(data.polygonCount ?? "?")} 个面` };
  if (name === "workspace_status") return { toolName: name, toolStatus: "success", content: `${title} · ${String(data.name ?? "当前工作区")}` };
  if (name === "plan_imagery") return { toolName: name, toolStatus: "success", content: `${title} · ${String(data.totalTiles ?? "已生成")} 瓦片` };
  if (name === "plan_imagery_batch") return { toolName: name, toolStatus: Array.isArray(data.errors) && data.errors.length ? "attention" : "success", content: `${title} · ${Array.isArray(data.plans) ? data.plans.length : 0} 个计划${Array.isArray(data.errors) && data.errors.length ? `，${data.errors.length} 个未完成` : ""}` };
  if (name === "boundaries_list") return { toolName: name, toolStatus: "success", content: `${title} · ${Array.isArray(data.boundaries) ? data.boundaries.length : 0} 个` };
  if (name === "boundaries_combine") return { toolName: name, toolStatus: "success", content: `${title} · ${String(data.name ?? "已合并")}` };
  if (name === "jobs_start") return { toolName: name, toolStatus: "success", content: `${title} · 作业 ${String(data.jobId ?? "已提交").slice(0, 8)}` };
  if (name === "jobs_get") return { toolName: name, toolStatus: "success", content: `${title} · ${String(data.state ?? "已读取")}` };
  if (name === "artifacts_inspect") return { toolName: name, toolStatus: "success", content: `${title} · 已读取核验清单` };
  if (name === "extensions_list") {
    const groups = Array.isArray(data.connectors) ? data.connectors : [];
    const builtin = groups.filter(item => item.kind === "builtin").length;
    return { toolName: name, toolStatus: "success", content: `${title} · ${Array.isArray(data.skills) ? data.skills.length : 0} 个 Skill、${groups.length - builtin} 个 MCP${builtin ? `、${builtin} 组内置工具` : ""}` };
  }
  if (name === "skill_read") return { toolName: name, toolStatus: "success", content: `${title} · ${String(data.name ?? "已读取")}` };
  if (name === "agent_tasks_list") return { toolName: name, toolStatus: "success", content: `${title} · ${Array.isArray(data.tasks) ? data.tasks.length : 0} 个` };
  if (name === "agent_tasks_spawn" || name === "agent_tasks_cancel" || name === "agent_tasks_get") {
    const task = name === "agent_tasks_get" ? data.task as Record<string, unknown> | undefined : data;
    const state = { queued: "启动中", running: "运行中", completed: "已完成", cancelled: "已取消", interrupted: "已中断", failed: "失败" }[String(task?.status)] ?? "已读取";
    return { toolName: name, toolStatus: task?.status === "failed" || task?.status === "interrupted" ? "attention" : "success", content: `${title} · ${String(task?.name ?? "子任务")}，${state}` };
  }
  if (name === "agent_tasks_read_file") return { toolName: name, toolStatus: "success", content: `${title} · ${String(data.path ?? "已读取")}` };
  if (name === "mcp_call") {
    if (data.toolName === "lookup_boundary") {
      const boundary = data.result as { found?: boolean; name?: string; reason?: string; collectedAt?: string } | undefined;
      return { toolName: name, toolStatus: boundary?.found ? "success" : "attention", content: boundary?.found ? `${title} · ${boundary.name}，数据采集于 ${boundary.collectedAt}` : `${title} · ${boundary?.reason ?? "未找到边界"}` };
    }
    const result = data.result as { error?: string; message?: string; paged?: boolean; bulkData?: boolean; isError?:boolean } | undefined;
    if (result?.error) return { toolName: name, toolStatus: "attention", content: `${title} · ${result.message ?? (result.error === "MCP_RESULT_TOO_LARGE" ? "返回内容超过本机处理上限，请缩小查询范围" : result.error)}` };
    if(result?.isError)return {toolName:name,toolStatus:"attention",content:`${title} · 服务返回错误`};
    return { toolName: name, toolStatus: "success", content: `${title} · ${String(data.toolName ?? "已完成")}${result?.bulkData ? "，完整坐标保存在本机" : result?.paged ? "，正在分段读取" : ""}` };
  }
  if (name === "mcp_result_read") {
    const page = data.result as { offset?: number; totalChars?: number; complete?: boolean; bulkData?:boolean } | undefined;
    if(page?.bulkData)return {toolName:name,toolStatus:"success",content:`${title} · 完整坐标保存在本机`};
    return { toolName: name, toolStatus: "success", content: `${title} · ${page?.complete ? "已读完" : "继续读取"} ${page?.offset ?? 0}/${page?.totalChars ?? "?"}` };
  }
  if(name==="mcp_result_export")return {toolName:name,toolStatus:data.saved===true?"success":"attention",content:`${title} · ${data.saved===true?String(data.relativePath??"已保存"):"未保存"}`};
  return { toolName: name, toolStatus: "success", content: `${title} · 已完成` };
}

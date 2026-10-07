# Mapbox 官方 MCP 预设与本机 Token 配置

## 本次范围

- `mcp_registry_search` 对 Mapbox 名称直接返回经官方文档核验的服务预设，不依赖 MCP Registry 网络状态。
- 服务地址：`https://mcp.mapbox.com/mcp`，Streamable HTTP。
- 来源：https://github.com/mapbox/mcp-server/blob/main/docs/hosted-mcp-guide.md
- 搜索失败时的工具说明要求停止在同一轮反复变换关键词。
- 会话中的 `mcp_connect` 准备本机 Access Token 配置卡；连接器页面也复用相同表单。
- Token 通过本机接口保存在系统凭据库，以 Authorization Bearer 请求头发送给 Mapbox。Token 不进入会话、AI 工具参数或连接器公开元数据。
- 支持新建与轮换；轮换保留其他请求头及查询凭据。显式设置 Authorization 时使用新的本机凭据，关闭旧 OAuth/环境变量认证覆盖。
- 测试通过后仍需用户确认启用。没有 Token 时不声称读取到了 Mapbox 工具或完成了路线规划。
- 本次没有新增运行环境、地图 SDK 或离线路网数据依赖；未制作安装包，不能据此报告安装包的精确增量。

## 验证

- 2026-10-07 对官方地址发送真实 MCP initialize 请求，无认证；官方返回 HTTP 401 / `Bearer token required`。这确认了地址可达，未建立已认证 MCP 会话。
- Rust 测试：Mapbox 官方名称解析不访问 Registry；请求头轮换保留其他凭据并拒绝协议头覆盖。
- Node 测试覆盖 Mapbox 凭据格式、精确候选解析、凭据更新、失败和用户启用边界，并回归高德已有流程。
- 亮/暗主题及 390px 窄屏表单验证：密码输入、关闭重开、失败清空及重试、Esc 关闭、无 localStorage 凭据。表单行为使用模拟传输。
- 前端构建通过。
- 原生开发版重新构建并启动后，实际搜索 `mapbox` / `Mapbox MCP server` / `MAPBOX` 均返回同一官方预设，三次查询及配置准备合计约 20ms；注册列表没有新增条目或启用变化。
- 实际原生凭据测试使用本机回环 MCP 服务与一次性测试凭据，验证请求头认证、轮换、其他请求头保留和公开元数据不含凭据。临时连接器已清理；没有 Mapbox 业务调用。
- 已在当前开发版打开真实的 Mapbox Access Token 配置表单；未填写或编造用户凭据。

证据目录：`artifacts/mapbox-onboarding-20261007/`。原始服务请求只包含客户端初始化信息，没有 Token。

## 待用户凭据验证

本机检查时没有 Mapbox 连接器或 Access Token。需要用户在应用本机表单填写可用 Token，才能继续验证真实 `tools/list`、`directions_tool` 和道路 GeoJSON 返回。本文不把官方源码声明等同于本机真实路由验收。

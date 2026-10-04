# 图源配置流程修正

按用户要求，将图源 Creator 的工作范围收敛为接口识别、参数整理和配置保存。取消配置阶段的授权协议检查、许可证明、强制许可字段及授权勾选。

## 实现

- 新增模型工具 `source_configure`，保存后 `sources_list` 回读验证；用户明确要预览时仍可准备草稿。
- 原生保存仅校验技术参数，署名和备注可为空。相同配置重复调用可复用，已有 ID 的不同配置返回冲突，显式编辑才允许替换。
- 配置记录使用 `configuredAt`，兼容旧 `permissionConfirmedAt`，无需数据库迁移。
- 识别 ArcGIS 缓存 MapServer 的栅格格式、Web Mercator 原点与分辨率网格，生成 `/tile/{z}/{y}/{x}`。特殊网格或动态 MapServer 不虚构成兼容服务。
- 图源管理取消授权确认区，卡片显示“已配置”。

## 验证

- 桌面前端 27 项测试、网关 13 项测试通过；前端生产构建通过。
- TaskStore 21 项测试、核心影像 17 项测试通过；包含无许可配置、幂等复用、冲突不覆盖和旧数据兼容。
- 原生 Creator 单元测试通过；实际访问 USGS ImageServer 与 Esri World Imagery MapServer，返回兼容参数。
- 真实托管模型执行：`workspace_status → extensions_list → skill_read → sources_list → mcp_call(inspect_source) → source_configure → sources_list`。
- 模型从“给我配置一个 ArcGIS 影像图源”完成保存与回读，结果为 Esri World Imagery、XYZ、256 px、Z0–22、500 ms；license 留空。测试使用临时数据库，不改用户图源列表。
- Tauri 发布构建及 NSIS 打包通过。新版桌面进程 56200 已启动并响应；原生 IPC 读取到新版 Skill、兼容 MapServer 参数、侧栏“图源管理”及不限额度状态。

## 网关更新

沿用已授权的 Creator 发布范围，只更新该服务 `server.mjs`；保留测试模式不限额度及用量记录。

- Release: `/srv/laogao/releases/geod-agent/geod-agent-source-config-20260930-0f42eb2d`
- SHA-256: `0f42eb2d0012a6ab22c9831a0ff8ec20422cda778da83e127774558830bfb4b2`
- 备份: `/srv/laogao/backups/geod-agent-source-config-20260930-0f42eb2d`
- 回滚版本: `geod-agent-testing-unlimited-20260930-5b084885`
- 发布前后 SQLite quick_check、9115 health 通过。未改身份服务、Nginx、DNS 或密钥。

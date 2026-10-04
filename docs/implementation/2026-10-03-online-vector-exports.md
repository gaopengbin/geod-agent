# 在线矢量导出与真实 Agent 验收

## 本地候选能力

`data_download_plan` 新增 `kind: online`，由原有任务引擎规划、审批、启动、取消和核验。支持公开 URL 或本机保存的在线连接；连接认证从系统凭据库读取，不经过模型。ArcGIS Feature/Map 服务、OGC API Features 及 WFS 读取沿用已验证的完整分页与坐标系适配。

导出 GeoJSON、GeoPackage，另生成地图预览。保留源要素 ID、属性、点/线/面几何及空值；输出统一为 EPSG:4326。GeoPackage 的嵌套属性、超长整数和源 ID 使用清单记录的文本编码，避免静默丢失。范围筛选保留完整相交要素，不裁断源几何。

在线读取上限为 10,000 要素、32 MiB 原始响应及 200 次请求；超限明确失败，不返回被截断的完整成果。预览最多 1,000 要素，完整文件仍包含所有已读取要素。下载写入独立暂存目录，实际 GDAL 重开核验后提交；取消不提交成果、不覆盖已有目录。保存连接在规划后变更或被移除时需要重新规划。

## 实际验收

| 证据 | 实际结果 |
| --- | --- |
| `artifacts/online-export-worker-20261003/acceptance.json` | 固定版本 GDAL 写出、重开混合几何与空选择；核对 ID、属性、中文、布尔值、空值、嵌套值和保留字段名，2 项通过 |
| `artifacts/online-exports-20261003/acceptance.json` | 实际 native 下载、私有 HTTP 认证、真实 GeoServer WFS 1/1.1/2、分页、坐标轴、带洞面、取消、跨会话拒绝及文件篡改拒绝，10 项通过 |
| `artifacts/online-exports-public-20261003/public-acceptance.json` | 公开 ArcGIS Colorado/Utah 与 pygeoapi lakes 的实际网络导出；源 ID 和属性保留，2 项通过 |
| `artifacts/online-exports-ai-20261003/ai-acceptance.json` | 实际桌面 Codex + 托管模型发现私有服务、规划、启动；关闭窗口后同一后台完成导出，重开对话由真实模型核验并加载到 OpenLayers，3 项通过 |

私有认证使用本机协议测试服务，WFS 使用已部署的真实 GeoServer；未声称测试了外部提供方私有账号。公开服务验收临时使用直连，随后恢复原有网络设置；原代理下再次实际发现 ArcGIS 目录成功。

AI 验收成果含 1 个点及 1 条线，源属性 `score` 分别为 41、42。模型经地图工具读回实际图层 `ready`、`visible: true`、2 个要素；截图 `actual-ai-export.png` 也已核对点线实际显示。成果核验与加载无需重新获取已移除的连接凭据。

## 实现入口

- `src-tauri/src/online_exports.rs`：所属账号/连接绑定、暂存提交、取消、清单及哈希核验。
- `src-tauri/src/online_export_worker.py`：实际 GDAL 格式写出、属性编码、坐标转换及重开核验。
- `src-tauri/src/online_inputs.rs`：既有认证、目录、分页读取；补充 ArcGIS 原始 Object ID 字段。
- `src-tauri/src/data_jobs.rs`：复用独立后台的计划、任务及地图预览。
- `src-tauri/codex-tools.json`、`src/data-download-tools.ts`：真实 Agent 工具协议与桌面分发。

上述路径均相对 `apps/geod-agent-desktop`。开发模式继续热更新；没有安装或发布新版。

# 中国行政区边界数据源核对

核对时间：2026-09-30。范围：GitHub 数据源维护情况、数据年份、下载产物和裁剪接入方式。本文记录候选选择，不代表已接入桌面端。

## 首选候选：AreaCity

- 仓库：https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov
- 固定发布：https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov/releases/tag/2025.251231.260403
- 发布日期：2026-04-03，GitHub API `published_at=2026-04-03T03:26:17Z`。
- 发布提交：`c6c6e35bea3066d674efe2cded189dc57a86e7d8`。
- 边界资产：`ok_geo.csv.7z`，GitHub API 标注 16,518,032 字节，含省、市、区县三级坐标和边界。
- 四级行政区名称数据另行提供；乡镇级几何是独立的付费数据，不属于这份三级边界资产。
- 作者说明：整合国家地名信息库 2025-12-31、腾讯行政区划 2025-11-19 和采集当天的高德数据；边界来源为高德。名称数据年份和几何采集日期需要分别记录。
- 历史数据发布包括 2024-06-16、2025-01-14、2026-04-03；作者说明会不定期检查上游变化，未承诺固定更新周期。
- 明确缺失：当前发布未包含和康县、和安县；因此不能称为全部最新行政区划。
- 原始边界坐标为 GCJ-02。需解析 CSV 中的多地块/孔洞，转换至 WGS84，验证闭合环、几何有效性和本地裁剪引擎的点数限制。
- 仓库声明 MIT。免费三级几何、付费乡镇几何和转换软件的功能限制应分别记录。

## 对照候选

| 项目 | 核对结果 | 用途判断 |
| --- | --- | --- |
| https://github.com/wmgeolab/geoBoundaries | 当前 CHN/ADM1 元数据 `boundaryYearRepresented=2019`；CHN/ADM2 为 2017，构建日期均为 2023-12-12 | 可考虑海外边界；不适合作为更新中国边界的首选 |
| https://github.com/BarbarossaWang/cn-atlas | README 明确为 2023 版，仓库最后推送 2023-11-02，提供省级/地级数据 | 年份可追溯，但覆盖和维护频率不如 AreaCity 符合本次需求 |
| https://github.com/GaryBikini/ChinaAdminDivisonSHP | 仓库最后推送 2024-09-19，来源为高德；README 提醒实际坐标为 GCJ-02 | 可作为格式参考，未证明边界比 AreaCity 新 |
| https://github.com/Supeset/China-GeoData | 最近推送 2026-05-31，但 README 未给出行政边界采集日期 | 仓库更新时间不能用来证明几何时效 |

geoBoundaries 元数据核对入口：

- https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM1/
- https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM2/

## 建议接入方式

维护一份由上游固定发布版生成的本地边界库：按名称、父级、行政代码查询，直接向计划传递 WGS84 几何。每个快照记录来源、release、采集日期、获取时间、原始文件 SHA-256、转换方法及已知缺失。检查上游新版本时先验证差异，成功后替换快照，保留上一版；网络不可用时仍可查询本地库。

这能复用社区的数据采集维护，同时由我们负责稳定查询、格式转换、版本追溯和裁剪兼容。

## 本机验证状态

GitHub Release API、提交历史、README 字段说明和对照数据源元数据已实际读取。发布包经续传下载完成并成功解压，SHA-256 为 `675c3e9b8dec6444994d3ef53259a145304f6a957db8a5e601e55c0b9e61e21a`。

已完成开发版接入：

- 内置 3,635 条区域索引，其中 3,257 条有边界几何，378 条无几何时明确返回未找到边界；查询不依赖网络和工作区已有文件。
- 生成脚本 `scripts/prepare-boundary-library.py` 校验固定原始发布包，并生成索引、压缩几何及含版本/日期/SHA-256 的 manifest；边界保留原始顶点、多地块、孔洞，按裁剪引擎八位小数精度编码。
- 原生 `lookup_boundary` 查询并转换 GCJ-02 至 WGS84。北京市索引去除相同几何的行政层级补齐重复；朝阳区可按父级北京市选择，未指定父级时返回同名候选。
- 北京原始 15,481 个顶点，补闭合点后 15,482 个顶点；已扩展有限的裁剪点数预算，未静默简化几何。
- 已验证全部非空快照几何的格式、坐标范围和闭合环；实际像素遮罩保留天安门位置、让天津位置透明，并持久化含真实北京几何的 Z12 GeoTIFF 计划（600 张瓦片）。
- 真实托管模型完成 `extensions_list / skill_read / sources_list / mcp_call(lookup_boundary) / plan_imagery` 流程，生成上述真实本机计划；详细几何留在本机，模型只获得范围、日期、版本及附加状态。
- 前端测试验证 15,482 点几何未进入模型工具回复，日期与版本保留；TypeScript/Vite 构建通过。
- 保持 Tauri 开发模式与 Vite 热更新；未打包安装、未修改服务器、测试未启动影像下载。下载后的真实 GeoTIFF 成果尚未作为本次验证的一部分。

真实模型日志：`evidence/boundary-2026-09-30/model-flow.log`。

已知模型显示问题：中文最终结果已验证，但模型有时仍输出英文工具前说明。客户端语言要求只能改善，尚不能保证全部过程文本为中文；日志保留该诊断，不将其描述为已完全修复。

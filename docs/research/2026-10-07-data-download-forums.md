# GeoD Agent 对话下载需求与社区问题评估

GeoD Agent 适合把数据选择、参数确认、下载执行和成果核验连接起来。现有开发版已经覆盖范围输入、瓦片下载、后台任务、小规模在线矢量和获授权三维服务的多项基础能力。按用户明确的当前范围，优先补大规模矢量完整导出、现有地图服务下载与成果交付；原始遥感产品检索仅作范围外调研。

评估日期为 2026 年 10 月 7 日。下文的“已有”指当前开发源码及仓库中的验收记录；本轮没有把这 32 个原帖任务逐一实际执行，也不将开发能力等同于公开安装包的能力。

## 产品范围修正（以用户本次确认为准）

当前 GeoD Agent 聚焦地图服务与已有地理数据的获取、整理和查看：图源发现与配置，地图瓦片及历史服务版本，拼接、裁剪与导出，已接入的 DEM 和三维服务，以及矢量文件、在线服务和数据库的读取与处理。

原始卫星景、多波段原始产品、SAR 原始产品及其科研处理链不属于当前产品范围。ERA5、NASA 科研产品、海洋、CMIP 等专门科研下载方向也从本轮推进建议中移出，保留为行业观察。新增专题数据目录、LAS/LAZ 点云和专门 CAD 交付均不因调研而自动纳入产品。

下文的跨领域案例保留研究价值；其中“技术上可组织的流程”不表示当前产品计划接入。所有推进建议以本节和范围筛选后的路线为准。

### 当前应优先解决的需求

| 优先方向 | 用户目标 | 本轮建议 |
| --- | --- | --- |
| 图源发现与配置 | 找到可用服务，配置需要 Key 的图源，知道覆盖和年份 | 图源分类、认证入口、探测与预览缓存；历史服务先问地区与时期 |
| 范围和批量任务 | 地名、手绘、矢量文件、在线服务或数据库作为范围 | 歧义与 CRS 澄清，多区域拆分选择，任务名称、归属与批量管理 |
| 下载与成果交付 | 保存 GeoTIFF、瓦片等可用成果 | 速度、恢复、完整性；下载/拼接/裁剪/核验阶段，成果目录入口 |
| 在线矢量完整导出 | 获取地图服务全部选定记录，保留属性 | 独立流式落盘、检查点、数量与 ID 核验，解决现有 10,000 要素上限 |
| DEM、三维查看与操作 | 下载和查看已有可用服务，Agent 能操作二维/三维 | 数据类型与高程核验，地图工具完整发现，图层/相机/视图切换与场景读回；权限逐源核查 |

用户关于“植被分析需要近红外”的求助，应在当前产品中识别用途不匹配，解释底图不能满足该分析；不能把原始遥感下载作为本轮待补功能。

## 样本与证据范围

核读 31 篇原始提问或故障帖、1 篇社区经验说明，覆盖 GIS Stack Exchange、Stack Overflow、Esri Community、GitHub、OpenStreetMap、Copernicus、Cesium、地信网、Dovetail Games 和 Prospecting Australia。另核对 9 个官方页面。问题横跨历史帖子和 2026 年仍出现的下载故障，适合发现长期需求，不用于计算需求占比。

14 次检索返回 123 个条目，按 URL 初步去重为 120 个候选；“检索返回”与“核读原文”分别记录。Reddit 和知乎没有得到可核读且符合筛选条件的原始求助帖，因此不计入覆盖。推广、资源合集、模型生成的问答正文和无法溯源的统计数字没有作为用户需求证据。

逐条出处、判断和必要提问保存于 [样本清单](G:/code/geod-agent/docs/research/2026-10-07-data-download-forum-cases.json)。

## 跨领域技术评估（当前范围以修正说明为准）

| 用户的目标 | 当前基础 | 需要补齐或保留的条件 | 优先级 |
| --- | --- | --- | --- |
| 按区域与时期获取历史影像 | Wayback 版本发现、区域拍摄元数据、问答卡、下载和核验已有证据 | 不能把版本发布日期当作拍摄日；Google Earth 原帖需求不等于 Wayback 已覆盖；下载用途要满足对应服务条件 | P0 |
| 下载 ArcGIS 或 WFS 的全部要素 | 目录发现、分页、属性保留和 GPKG 导出已验收 | 当前硬上限为 10,000 要素、32 MiB 响应、200 次请求；2.8 万或 9 万记录无法直接完整交付 | P0 |
| 提供一个模糊地名或坐标文件 | 地名和范围工具、问答卡、多格式输入及坐标转换基础可复用 | 同名地区、缺失 CRS、范围来源不清时必须询问；部分格式依赖可选 GIS 技能 | P0 |
| 获取指定区域的 Sentinel 或 Landsat 原始产品 | 范围、任务、缓存、确认和文件核验机制可复用 | 产品目录、级别、波段、云量、资产下载和产品元数据尚未形成已验收接入 | P1 |
| 下载到中途出现 401 或 403 | 本机凭据库、通用认证连接和任务恢复已有基础 | 需要 CDSE 或 S3 提供方适配；瓦片恢复不能代替大文件 Range 续传验收 | P1 |
| 获得整个城市的 OSM 建筑或路网 | 小范围 Overpass、完整几何和属性导出已有真实样例 | 需要区域 PBF 下载及本机提取、稳定对象 ID、去重与属性单位核验；不能依赖公共接口扫全国 | P1 |
| 合并 DEM 并得到正确的高程结果 | Terrarium 转米制 DEM、可选栅格检查和重投影技能已有基础 | 原始 DEM 目录、任意多个 DEM 镶嵌、NoData 与垂直基准一致性需补；LAS 或 LAZ 点云未接入 | P2 |
| 导出 GEE 大范围或时序计算成果 | 本机阶段显示与后台队列可以复用 | GEE 授权、云计算任务、分块或云端导出未接入；不可通过降低分辨率擅自改变要求 | P2 |
| 离线加载自己的三维资产 | 递归资源下载、范围筛选、核验和 Cesium 预览已有证据 | 需要分别判断资产是否可下载、归档或裁剪；范围筛选整块瓦片不等于精确切网格 | P0 |
| 判断 100% 或 0% 不动是不是卡住 | 本机已有下载、生成成果、核验阶段及活动指示 | 云端计算和归档要另接真实状态；没有工作量时不编造百分比 | P0 |

### 全量导出需要超越现有读取上限

Esri Community 用户要下载约 2.8 万条野火记录，实际只得到 2,000 条；Stack Overflow 另有约 9 万条记录的同类问题。原帖里的“调用成功”没有满足全量数据需求。[野火记录问题](https://community.esri.com/t5/arcgis-api-for-python-questions/using-api-doesn-t-return-all-data/td-p/1599976)、[9 万记录问题](https://stackoverflow.com/questions/72747040/arcgis-feature-layer-extract-all-records)。

当前源码 `apps/geod-agent-desktop/src-tauri/src/online_inputs.rs` 明确保留 10,000 要素、32 MiB、200 请求上限；`online_exports.rs` 沿用该读取通道。超限会拒绝，避免伪造完整成果，但尚不能满足上述原帖规模。不是简单把数字调大就完成：应按稳定 ID 分批读取、直接落盘，保留检查点，并核对预期与实际数量、重复及遗漏。

旧社区答案常把 `returnIdsOnly` 描述为无限数量。当前 Esri 文档写明 ID 数组也有 100 万上限；还要检查服务自身能力，不能机械套用旧回答。[当前 Query 文档](https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/)。

### 先决定影像产品再决定下载方式

有用户要指定区域和日期的 Sentinel 数据，希望减少整景下载及裁剪；另有人要 Landsat 每一景的全部原始波段，明确不希望先合成。[Sentinel 区域数据](https://gis.stackexchange.com/questions/254815/simple-way-to-collect-the-sentinel-data-of-a-given-roi)、[Landsat 原始产品](https://gis.stackexchange.com/questions/482312/download-all-landsat-tiles-for-a-specific-data-range-onto-my-computer-using-goog)。

Agent 应先明确用途、时间、产品级别、所需波段和输出方式，再查询实际可用的产品。显示底图、原始多波段、每景独立文件和跨期合成是不同的交付物。现有影像瓦片导出不能证明已经接入科研遥感原始产品。

建议以 STAC 作为目录描述的一种标准，提供方下载仍保留独立适配。Copernicus 官方现有 STAC 与 OData 目录和下载例子，可按区域、时间与产品条件组织检索；旧 STAC 入口自 2025 年 11 月起弃用，接入应使用当前入口。[STAC 官方文档](https://documentation.dataspace.copernicus.eu/APIs/STAC.html)、[官方检索下载示例](https://documentation.dataspace.copernicus.eu/notebook-samples/geo/odata_basics.html)。

### 授权与续传要由本机下载器处理

2026 年的 Copernicus 原帖记录 Sentinel-2 在约 93% 时提示 Token 过期；另一用户批量下载约 5,000 景，长时间运行后刷新失效。目录可检索也不意味着文件下载已得到授权。[93% 失效](https://forum.dataspace.copernicus.eu/t/401-error-message/4954)、[长批次失效](https://forum.dataspace.copernicus.eu/t/access-token-creation-failed-for-large-number-of-image-download/835)、[能检索却下载 401](https://forum.dataspace.copernicus.eu/t/request-for-sentinel2-download-unauthorized-in-python-httperror-401/234)。

官方说明访问 Token 到期后需要刷新或重新生成。应由提供方适配器集中管理有效期，并防止并行线程重复刷新；若需要用户重新授权，保留进度后弹出授权入口。恢复大文件还要验证服务器支持 Range、资源身份和文件完整性，不把新 URL 盲目接到旧文件尾部。[Token 文档](https://documentation.dataspace.copernicus.eu/APIs/Token.html)。

### 大范围 OSM 应选择合适的数据渠道

Tampa 用户希望完整建筑和高度，遇到范围太大及 SHP 导出丢属性；墨尔本道路网络查询也因范围过大失败。[Tampa 建筑问题](https://community.openstreetmap.org/t/using-qgis-but-buildings-not-all-downloading/4361)、[墨尔本道路问题](https://stackoverflow.com/questions/68784648/downloading-osm-data-for-large-area)。

现有柏林 13 个建筑面样例证明小范围闭环，不能外推为整城市或全国可稳定下载。城市级和更大范围可优先使用区域 PBF、本机提取或用户自己的数据库。公共 Overpass 官方明确重载查询会限流，并建议大批量数据使用 dump 或自有实例；不应密集切网格去扫描全球。[Overpass 使用说明](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)。

输出还要核验对象类型加 ID、关系几何和高度单位。范围相交筛选保留完整要素，若用户要求沿边界切断几何，应先说明并使用相应矢量分析工具。

### 数据诊断可以减少反复试错

地信网用户下载标为 WGS84 的影像后仍无法叠合道路；另一用户把全球 DEM 自行定义为某投影后裁剪报错。这些症状不能都归因于 GCJ-02，也不能通过改一个坐标标签自动纠正。[影像偏移](http://bbs.3s001.com/thread-242954-1-1.html)、[无效裁剪范围](http://bbs.3s001.com/thread-361706-1-1.html)。

可复用现有输入和 GIS 技能读取真实范围、CRS、像元大小、单位与几何。缺少依据时询问用户或读取来源说明；区分定义坐标系、重投影和配准，不猜测缺失的 CRS。

QGIS 的高程合并问题还提示：图层显示的最小最大值可能来自估算统计，维护者建议核对实际统计。Agent 可以调用真实栅格统计后解释结果，避免直接宣布数据被破坏。[QGIS Issue](https://github.com/qgis/QGIS/issues/39148)。

### 活动状态应对应真实执行阶段

geemap 用户看到约 1.23 GB 导出一直 0%，维护者说明前置计算仍在运行；Ion 用户也遇到自己的地形归档卡在 0%。这些是云端处理状态需求。[GEE 等待](https://github.com/gee-community/geemap/discussions/1800)、[Ion 归档](https://community.cesium.com/t/downloading-terrain-data-for-offline-use/36833)。

本机已有生成成果和核验的活动状态，可以复用到新的提供方任务。云端应读取实际作业状态、错误和最近更新时间；本机下载按真实字节或对象数显示。进度由后台维护，只有失败、需要选择、授权失效或完成时再让模型参与。

GEE 直接下载本身仍有 32 MB 请求和每边 10,000 像素限制。应选择分块或批处理导出，在用户确认前保留其分辨率要求。[Google 官方说明](https://developers.google.com/earth-engine/apidocs/ee-image-getdownloadurl)。

## 数据权限影响交付路径

历史影像的目录发布日期与实际拍摄日期不同。Wayback 官方说明可通过区域元数据获得拍摄时间；一期地图里不同地点可能由不同时期的影像组成，不能向用户保证全区域同一天拍摄。[Esri 元数据说明](https://www.esri.com/arcgis-blog/products/arcgis-living-atlas/imagery/wayback-with-world-imagery-metadata)。

Esri 官方 Wayback Export 路径有组织账号、输出量及 ArcGIS 内使用的条件；它不能用来证明任意第三方导出途径都已获许可。[Wayback Export](https://www.esri.com/arcgis-blog/products/arcgis-living-atlas/imagery/wayback-export)。

Cesium 的归档和导出文档说明可操作的是用户上传的资产，Asset Depot 资产不能按该方式下载或导出。社区讨论另外涉及指定资产的官方裁剪，不能把归档、导出与裁剪混为一项能力。Google Photorealistic 3D Tiles 的离线诉求在官方社区被明确否定。[归档和导出文档](https://cesium.com/learn/ion/cesium-ion-archives-and-exports/)、[Google 三维离线问题](https://community.cesium.com/t/tiles-for-offline-terrain-server/40557)。

现有引擎获取过 Ion 资源的技术测试，不能替代上述权限确认。Agent 计划应区分在线显示、用户自有或获授权的数据下载、官方归档或裁剪，并保留来源与许可条件。对不支持的离线数据，解释限制并给出允许的替代路径。

## 建议推进顺序

### 第一批复用现有能力并修补规模限制

1. 用已有问答卡确认地名、年份、数据类型和必要参数。模型提出选项，用户提交后再生成计划；未明确参数不静默代选。
2. 将在线全量导出从有界范围读取中拆出独立流式任务，优先 GPKG；分批落盘、检查点恢复和完整性检查同时完成。
3. 将相同阶段状态、成果目录、文件摘要与数据数量核验用于各类任务。
4. 在图源与任务计划中明确当前数据的可用方式，特别是离线三维与历史底图的提供方条件。

### 范围外观察：原始遥感产品（不安排当前接入）

原研究设想为以 Copernicus Sentinel 验证目录分页、地区与时间搜索、产品级别和云量筛选、资产及波段选择、本机授权刷新、真实产品续传。共用任务协议保留产品 ID、拍摄时间、来源、字节数、资产清单、失败原因及核验结果。随后以同一合同扩展 Landsat；不要让“STAC 支持”替代每个提供方的下载验收。

### 第二批完善当前大范围矢量与高程

补区域 OSM PBF 的下载和提取，核验关系与属性；接入原始 DEM 数据目录、镶嵌与 NoData 一致性。LAS/LAZ点云与GEE云任务保留为范围外观察；当前优先维护已有DEM类型和成果检查。

以上优先级是根据现有基础、样本重复出现的需求和交付难度作出的产品判断，不是对市场需求占比的统计排序。

## 调研案例（范围外案例不进入当前验收）

以下保留原研究测试构想。原始多波段、Landsat、Sentinel和GEE相关输入已移出当前验收；范围内案例依用户目标检查，具体范围见样本JSON。

| 场景 | 测试输入示例 | 完成条件 |
| --- | --- | --- |
| 历史参数澄清 | 下载朝阳的历史影像 | 在计划前问清地区和时期；元数据不可确认的拍摄时间明确说明 |
| 完整在线矢量 | 这个服务有 28,000 条野火边界，全部保存为 GeoPackage | 稳定 ID 核对实际总数、无遗漏或重复；取消和恢复后结果仍一致 |
| 原始多波段 | 按我的边界下载 2024 年 6 月 Sentinel 影像，要红光和近红外 | 明确产品级别及云量要求；交付真实对应波段、产品 ID、日期与 CRS |
| 不擅自合成 | 下载这个区域 2005 年 5 月所有 Landsat 原始影像 | 每景单独保存全部选定资产；不能悄悄变成 RGB 合成底图 |
| 多区域批量 | 按这份多面文件给每个行政区独立下载 | 用户确认拆分方式；每个任务有清楚名称、范围、归属及独立成果 |
| 大范围 OSM | 下载墨尔本全部道路及道路类型 | 选择可承载范围的渠道；完整几何、对象 ID 和属性可读回 |
| 缺失坐标系 | 用这个没有投影说明的范围裁剪 DEM | 先询问或获得可信来源信息；不自行猜测 EPSG |
| 体积异常 | 保持原始精度重投影这份高程数据 | 先检查单位、范围和预计像元数；磁盘预算不足不能无提示启动 |
| 令牌过期 | Sentinel 下载中授权到期了，继续原任务 | 正确刷新或等待用户授权；保留检查点；成果身份和校验通过 |
| 成果生成 | 下载结束后仍在合成，我想知道有没有卡住 | 显示真实阶段、更新时间与活动状态；完成后文件可读回 |
| 自有离线三维 | 检查并加载我自己的三维成果目录 | 子 tileset、模型、纹理等依赖齐全；真实离线加载后读回场景 |
| 不支持的离线资产 | 把 Google Photorealistic 3D Tiles 下载为离线包 | 正确解释限制并提供可行替代；不把请求成功当作授权允许 |

## 当前代码和验收依据

- 范围与数据库输入：`docs/implementation/2026-10-03-functional-roadmap.md`、`2026-10-03-connection-and-image-acceptance.md`。
- 在线矢量读取与导出：`apps/geod-agent-desktop/src-tauri/src/online_inputs.rs`、`online_exports.rs`，以及 `docs/implementation/2026-10-03-online-vector-exports.md`。
- OSM、MVT 和三维：`docs/implementation/2026-10-02-vector-parity.md`、`2026-10-02-desktop-parity.md`，后续三维扩展以 `2026-10-03-functional-roadmap.md` 为准。
- 需求确认：`docs/implementation/2026-10-06-agent-user-input.md`。
- 活动状态与成果入口：`docs/implementation/2026-10-06-processing-loading.md`、`2026-10-06-output-folder-default-export.md`。
- 当前可选 GIS 技能：`docs/implementation/2026-10-06-slim-gis-skills.md`。基础包不包含全部 GIS 依赖，多格式和分析工作需对应已安装技能。
- 当前 native Rust 源码没有发现 STAC、CDSE、Sentinel、Landsat、GEE 或 LAS/LAZ 原始产品的专用适配。通用 MCP 或后台命令能扩展能力，但不能视为这些提供方已经验收。

## 社区原帖索引

| 编号 | 社区 | 用户需求摘要 | 类型 | 出处 |
| --- | --- | --- | --- | --- |
| F01 | GIS Stack Exchange | 上传研究区后批量获取历年带坐标影像，而不是手工截图。 | 历史影像 | [原帖](https://gis.stackexchange.com/questions/340605/mass-downloading-google-earth-historical-imagery) |
| F02 | GIS Stack Exchange | 多个多边形逐年或逐月导出栅格，并避免超出 GEE 负载限制。 | 批量时序 | [原帖](https://gis.stackexchange.com/questions/416014/batch-downloading-time-series-of-tiff-images-using-multi-polygons) |
| F03 | GIS Stack Exchange | 只要指定区域、日期和波段的 Sentinel 数据，减少整景下载和手工裁剪。 | 原始遥感 | [原帖](https://gis.stackexchange.com/questions/254815/simple-way-to-collect-the-sentinel-data-of-a-given-roi) |
| F04 | GIS Stack Exchange | 按区域和日期保存 Landsat 的每个原始产品及所有波段，不先合成。 | 原始遥感 | [原帖](https://gis.stackexchange.com/questions/482312/download-all-landsat-tiles-for-a-specific-data-range-onto-my-computer-using-goog) |
| F05 | GIS Stack Exchange | 请求时间区间后只得到一张合成图，实际想获得全部拍摄期次。 | 时序目录 | [原帖](https://gis.stackexchange.com/questions/367192/downloading-all-images-in-time-interval-with-wms-getmap-request) |
| F06 | Esri Community | 约 2.8 万条野火边界只下载到 2,000 条，并有 SHP 属性字段导出问题。 | 矢量完整性 | [原帖](https://community.esri.com/t5/arcgis-api-for-python-questions/using-api-doesn-t-return-all-data/td-p/1599976) |
| F07 | Stack Overflow | 服务有约 9 万条记录，但一次响应只有 2,000 条。 | 矢量完整性 | [原帖](https://stackoverflow.com/questions/72747040/arcgis-feature-layer-extract-all-records) |
| F08 | GIS Stack Exchange | 能浏览 ArcGIS 服务，却找不到原始要素的下载方式。 | 在线服务发现 | [原帖](https://gis.stackexchange.com/questions/40445/download-dataset-from-arcgis-rest-service) |
| F09 | GIS Stack Exchange | 服务只返回 1,000 条，目标超过 3 万条且无法更改服务端限制。 | 矢量完整性 | [原帖](https://gis.stackexchange.com/questions/437456/how-do-i-get-the-rest-of-the-data-in-a-feature-service) |
| F10 | Dovetail Games 论坛 | 两个州的高程数据格式不同，部分数据覆盖全州，下载后合并失败。 | DEM 处理 | [原帖](https://forums.dovetailgames.com/threads/qgis-cannot-merge-layers.75853/) |
| F11 | GIS Stack Exchange | 约 23 MB 的 SRTM 数据在裁剪或重投影后膨胀到数百 GB。 | 栅格体积 | [原帖](https://gis.stackexchange.com/questions/88354/qgis-clipping-and-reprojecting-srtm-data-creates-a-huge-file) |
| F12 | GitHub Issues 或 Discussions | 合并后看到不同的高程最小最大值，怀疑数据被改变。 | 成果核验 | [原帖](https://github.com/qgis/QGIS/issues/39148) |
| F13 | Prospecting Australia | 下载 DEM 后在 QGIS 里的显示不符合预期，不清楚 DEM 与 LiDAR 产品的区别。 | 数据选择与显示 | [原帖](https://www.prospectingaustralia.com/threads/help-lidar-driving-me-nuts.44334/) |
| F14 | GitHub Issues 或 Discussions | 约 1.23 GB 的导出一直 0%；维护者解释前置计算仍未完成。 | 处理进度 | [原帖](https://github.com/gee-community/geemap/discussions/1800) |
| F15 | GitHub Issues 或 Discussions | 导出超过直接下载大小上限，想避免手工切块。 | GEE 导出限制 | [原帖](https://github.com/gee-community/geemap/discussions/775) |
| F16 | GIS Stack Exchange | 大范围栅格超过每边 10,000 像素的直接下载限制。 | GEE 导出限制 | [原帖](https://gis.stackexchange.com/questions/366044/image-getdownloadurl-download-pixel-grid-dimension-limit) |
| F17 | OpenStreetMap 社区 | 想下载整片城市建筑及高度，遇到范围太大、导出丢属性、浏览器崩溃。 | OSM 全量与属性 | [原帖](https://community.openstreetmap.org/t/using-qgis-but-buildings-not-all-downloading/4361) |
| F18 | OpenStreetMap 社区 | 按 Halle 地名查询道路超时，后发现同名地区导致查询了多个范围。 | 地名歧义 | [原帖](https://help.openstreetmap.org/questions/56122/overpass-query-roads-within-polygon/) |
| F19 | Stack Overflow | 下载整个墨尔本道路网络时，在线导出与 Overpass 查询失败。 | OSM 大范围 | [原帖](https://stackoverflow.com/questions/68784648/downloading-osm-data-for-large-area) |
| F20 | GIS Stack Exchange | 想按行政区导出道路、商店、河流、公园等全部 OSM 对象。 | OSM 数据类型 | [原帖](https://gis.stackexchange.com/questions/377499/download-all-data-for-an-area-from-openstreetmap) |
| F21 | Copernicus Data Space | 产品目录能检索，但 Sentinel 下载返回 401。 | 提供方授权 | [原帖](https://forum.dataspace.copernicus.eu/t/request-for-sentinel2-download-unauthorized-in-python-httperror-401/234) |
| F22 | Copernicus Data Space | Sentinel-2 下载到约 93% 出现 Token 过期，用户不清楚慢下载与失败原因。 | 令牌过期与续传 | [原帖](https://forum.dataspace.copernicus.eu/t/401-error-message/4954) |
| F23 | Copernicus Data Space | 一个月的批量 Sentinel 下载中途结束，网页可见的部分产品被遗漏。 | 遥感目录完整性 | [原帖](https://forum.dataspace.copernicus.eu/t/download-process-stops-before-all-the-required-data-have-been-downloaded/3344) |
| F24 | Copernicus Data Space | 约 5,000 景下载长时间运行后 refresh token 无效，反复中断。 | 长批次授权 | [原帖](https://forum.dataspace.copernicus.eu/t/access-token-creation-failed-for-large-number-of-image-download/835) |
| F25 | Copernicus Data Space | 原本可运行的 eodata S3 分波段下载变成 403，重新生成 key 也未解决。 | S3 产品读取 | [原帖](https://forum.dataspace.copernicus.eu/t/403-error-forbidden-get-while-retrieving-sentinel-2-images-from-the-s3-bucket/4749) |
| F26 | Cesium Community | 希望发送范围后直接得到别人的全球三维资产或离线 glTF。 | 离线三维权限 | [原帖](https://community.cesium.com/t/is-it-possible-to-download-3d-tiles-that-i-did-not-upload-via-rest-api/42691) |
| F27 | Cesium Community | 想将 Google Photorealistic 3D Tiles 下载后自托管离线使用。 | 离线三维权限 | [原帖](https://community.cesium.com/t/tiles-for-offline-terrain-server/40557) |
| F28 | Cesium Community | 有离线 tileset.json，但三维模型无法显示。 | 三维依赖与预览 | [原帖](https://community.cesium.com/t/render-the-gltf-3d-model-as-tileset-json/39886) |
| F29 | Cesium Community | 用户将自己的 GeoTIFF 上传 Ion 后归档一直 0%，无法获取离线地形。 | 云端归档状态 | [原帖](https://community.cesium.com/t/downloading-terrain-data-for-offline-use/36833) |
| F30 | 地信网论坛 | 影像标为 WGS84，却无法与道路矢量正确叠加。 | 坐标偏移 | [原帖](http://bbs.3s001.com/thread-242954-1-1.html) |
| F31 | 地信网论坛 | 下载全球 DEM 后自行定义投影，再按掩膜提取报无效范围。 | 范围与投影 | [原帖](http://bbs.3s001.com/thread-361706-1-1.html) |
| F32 | 地信网论坛 | 经验帖记录天地图 Key 类型和 WMTS 参数差异影响桌面加载。 | 国内服务认证 | [原帖](http://bbs.3s001.com/thread-355070-1-1.html) |

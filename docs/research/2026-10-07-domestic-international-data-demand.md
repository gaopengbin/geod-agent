# GeoD Agent 国内外地理数据需求扩大调研

评估日期：2026 年 10 月 7 日。

本轮新增 48 个社区样本，连同首轮共 80 个，覆盖 17 类社区；另核对 26 个提供方、维护者文档及作者论文。需求从影像、在线矢量与三维，扩到气象、海洋、土地覆盖、土壤、人口、点云、CAD、公共设施、灾害遥感和气候模型。

**产品机会是：用户描述用途与范围后，Agent 帮助选对数据、确认参数、组织可靠执行，并交付可读、完整、具有来源说明的数据。** 对话层需要与专门的数据目录、下载器、格式读取器和领域技能配合。

本文的“已有基础”来自当前开发源码及仓库既有验收记录。本轮进行了研究与代码核查，没有逐项重现这些社区下载任务；建议能力也未因本报告而接入或发布。

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

## 一、调研口径

| 项目 | 范围 |
| --- | --- |
| 本轮定向检索 | Exa 26 组，返回 253 条结果，按 URL 去重 242 个候选；另用网页检索 4 组补查 |
| 入选社区样本 | 新增 48 个；累计 80 个 |
| 原文可读程度 | 78 个原始需求、故障或功能讨论正文；1 个只有提问标题与回复；1 个社区经验说明 |
| 问题语境 | 中文 14 个、英文 63 个、法文 3 个；语言不代表作者国籍 |
| 社区 | 地信网、气象家园、小木虫、GIS Stack Exchange、Stack Overflow、GitHub、Esri、OSM、Copernicus Data Space、ECMWF、NASA Earthdata、ESA STEP、Cesium、GeoRezo、Reddit、Dovetail Games、Prospecting Australia |
| 技术核查 | 累计 26 个提供方/维护者/作者原始参考页面，本轮新增 17 个 |
| 地域证据 | 原文涉及中国、法国、加拿大、日本、美国等研究区；人口案例涉及塞拉利昂、莱索托和海地；沿用首轮澳大利亚等案例 |
| 未覆盖 | 私密群、科研内网，以及足够可核读的知乎、小红书、V2EX需求样本 |

这些是定向案例，不是市场统计抽样。可索引英文技术社区与公开 issue 更容易被检索，科研问题也容易被过度采样，因此不能据此估算国内外需求占比、市场规模或付费率。数据卖家、推广帖、AI 生成问答、重复转载、无法核读的原帖和被劫持网站不作为入选需求证据。

旧帖用于识别长期问题；当前 API、数据年份和服务条件以本轮原始文档为准。已关闭的 issue 提供验收场景，不表示现行工具仍有同一缺陷。D08 仅标题与回复可读，确切日期和提问正文不完整，单独标记。

完整的 80 个样本、出处、判断、检索记录和按产品范围标记的建议验收案例见 [机器可读清单](G:/code/geod-agent/docs/research/2026-10-07-domestic-international-data-demand-cases.json)。首轮详细结论见 [首轮报告](G:/code/geod-agent/docs/research/2026-10-07-data-download-forums.md)。

## 二、国内与国际样本分别带来了什么

### 国内：用途与参数选择、数据供给和交付格式

| 真实需求 | 原帖证据 | 可形成的对话流程 |
| --- | --- | --- |
| 小流域植被分析需要近红外，下载的底图只有RGB | [D04：2020年求助](http://bbs.3s001.com/thread-336979-1-1.html) | 先问分析用途与时段，再检索含红光/近红外的真实多波段产品，保留处理级别和质量信息 |
| 新手要30米贵州或全国土地利用 | [D05：2022年求助](http://bbs.3s001.com/thread-358323-1-1.html) | 询问年份、地区与分类体系，列出可用产品，裁剪并附分类表和来源 |
| 黄河流域长时段WRF需要区域ERA5，不想下全球数据 | [D02：2023年求助](http://bbs.06climate.com/forum.php?mod=viewthread&tid=108421) | 选择模拟域、边界缓冲、地面与气压层变量，分批获取并核对时间清单 |
| 2025年5—10月逐小时高空和地面ERA5下载太慢 | [D01：2026年6月求助](http://bbs.06climate.com/forum.php?mod=viewthread&tid=111784) | 保存上游作业、合适分批、后台等待；允许的替代渠道按数据和账号权益核查 |
| 要乡镇、行政村边界 | [D07：有偿求助](http://bbs.3s001.com/thread-344918-1-1.html) | 明确行政层级、年份、地域和用途，先核查供给与许可；数据不可得时返回具体缺口 |
| 道路和行政边界需要SHP、西安80坐标系 | [D06：洱海周边求助](http://bbs.3s001.com/thread-277413-1-1.html) | 读取源CRS，确认目标投影参数与转换依据，导出后检查叠合和单位 |
| CSV边界无法建立数据库空间索引 | [D10：2024年issue](https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov/issues/45) | 识别多面和环格式，转换、检查有效性，再按目标数据库协议处理 |
| 区划名称、撤镇设街未同步 | [D11：2024年issue](https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov/issues/43) | 记录来源与区划年份，匹配用户统计口径，核查变更 |

**对国内产品的推断：** “不知道选什么”和“能否拿到所需层级的数据”需要同样重视。仅让用户填一个瓦片URL，会留下波段、年份、变量、行政层级和坐标参数问题。这是样本引出的产品判断，仍需要不同职业用户实际访谈。

乡镇、村界尤其不能以常见行政查询能力来承诺。高德当前官方文档明确不返回乡镇街道边界 polyline；村级范围需要另找具有适当来源与使用条件的数据。[高德官方行政查询](https://lbs.amap.com/api/webservice/guide/api/district)。

土地利用调查、遥感土地覆盖分类也应分别说明。CLCD 原始论文对应1990—2019年30米中国年度土地覆盖；转载“1985—2025”等标题不能独立证明作者发布了相应新版。后续接入需要核查作者目录和版本。[CLCD作者论文](https://essd.copernicus.org/articles/13/3907/2021/)。

### 国际：跨语言发现、科学维度、云数据与可用成果

| 真实需求 | 原帖证据 | 可形成的对话流程 |
| --- | --- | --- |
| 建筑师需要法国城镇地形与建筑高度，最终用于Rhino/Archicad | [D45：2025年Reddit](https://www.reddit.com/r/gis/comments/1k6xl8m/getting_gis_data_from_france_into_cad/) | 理解目标软件，按范围取合适数据，再交付经过CAD读回验收的文件 |
| 城市规划用户要医院、学校等设施位置，难以从SHP/GML提取 | [D47：2023年Reddit](https://www.reddit.com/r/gis/comments/1601yjo/efficient_methods_to_retrieve_building_locations/) | 把设施类别映射到实际字段或OSM标签，保留名字、坐标、来源与缺漏说明 |
| 数据选择用于分区人口估算 | [D48：人口讨论](https://www.reddit.com/r/gis/comments/bzd8zf/estimating_population/) | 确认年份、区划、人数或密度，选择人口产品，再执行适当的区域统计 |
| 已下载231GB全球建筑，却因错误筛选方式取不出东京 | [D33：Overture issue](https://github.com/OvertureMaps/data/issues/113) | 先按实际空间位置抽取小样，固定发布版本，再做完整空间过滤 |
| 年度土地覆盖要2000—2020，整包太大、候选产品年份不全 | [D28：GIS问答](https://gis.stackexchange.com/questions/402234/is-there-a-land-cover-type-image-collection-on-google-earth-engine-that-covers-t) | 检查真实可用年序列、分类体系与分辨率，在用户选择后下载所需子集 |
| 海洋子集含深度、气候态和额外维度 | [D24：五维数据issue](https://github.com/pepijn-devries/CopernicusMarine/issues/143) | 发现实际变量、维度、单位和参考期，按语义切片 |
| 温度下载出来为负万级数值 | [D26：比例因子issue](https://github.com/pepijn-devries/CopernicusMarine/issues/100) | 按元数据解码比例因子、偏移和缺测，再核验数值与单位 |
| 法国LiDAR入口迁移，用户只能找到TIF而非LAZ | [D31：2026年7月GeoRezo](https://georezo.net/forum/viewtopic.php?pid=377978) | 区分点云和派生高程，查当前分幅目录与链接，再批量取得实际点云 |
| 数千个小区要20年气象序列 | [D14：ECMWF](https://forum.ecmwf.int/t/how-to-download-faster/1391) | 组织共享批次与缓存，再分区提取，避免逐面重复提交 |
| 1610个气候小文件，分页购物车造成重复和遗漏 | [D34：2026年ESGF issue](https://github.com/esgf2-us/metagrid/issues/923) | 自动分页、稳定资源ID、清单去重和数量核对 |

**对国际产品的推断：** 区域数据目录、科学数据子集和最终使用软件很适合形成明确场景。语义正确性需要进入成果验收，尤其是科学维度、分类、单位和文件组织；不能只验HTTP成功与文件存在。

## 三、跨领域研究矩阵（非当前路线）

此表保留研究时的技术拆解，优先级只表示原调研排序。涉及原始遥感和科研平台的行已移出当前路线，不能视作本轮功能缺口；具体范围标记见样本清单。

| 需求组 | 已有可复用基础 | 待补关键能力 | 建议 |
| --- | --- | --- | --- |
| 历史底图与区域影像 | Wayback、范围、问答卡、瓦片执行、核验 | 地区与时期澄清；拍摄元数据；来源使用条件 | P0，先完善现有流程 |
| 边界、道路、设施、普通矢量 | 多格式输入、可选矢量技能、小范围OSM、PostGIS读取 | 来源版本、字段语义、规模、几何有效性、公共设施标签模板 | P0—P1 |
| 在线矢量全量交付 | ArcGIS/WFS/OGC读取与GPKG/GeoJSON导出 | 独立流式导出、稳定ID、检查点、全量计数 | P0 |
| 原始光学遥感与植被 | 范围、确认、后台任务、栅格读回可复用 | Sentinel/Landsat目录、级别、波段、云量、质量掩膜与资产下载 | P1 |
| 土地覆盖与土地利用数据 | 范围裁剪和栅格技能 | 产品目录、真实年份、分类表、算法版本与可比性 | P1 |
| ERA5及气象时序 | 本机后台、缓存、状态与授权入口可复用 | CDS作业、变量/气压层、区域子集、GRIB/NetCDF、时间完整性 | P1，新增重点 |
| 大范围OSM与云端建筑数据 | 小范围Overpass、属性保存基础 | 区域PBF提取、GeoParquet空间过滤、关系与去重 | P1 |
| CAD及建筑设计交付 | 矢量读取、转换、重投影基础 | 分层DXF等交付、高度/单位/垂直基准、目标软件实际读回 | P1，先限定一个场景 |
| DEM与LiDAR | Terrarium DEM、栅格检查/重投影 | 原始DEM与点云目录、LAS/LAZ、分幅索引、镶嵌和高程基准 | P2，可选技能 |
| 土壤与人口 | 栅格读回、范围基础 | SoilGrids/WorldPop目录、土层/统计量/单位、区域统计和方法 | P2，可选技能 |
| 海洋与水文 | 范围、后台任务基础 | Marine变量/深度/时间、跨经线、CF元数据、实际观测与模式数据区分 | P2，可选技能 |
| SAR洪水与变化检测 | 范围、任务机制基础 | SAR产品与同轨/极化选择、处理链、掩膜、科学结果验证 | P2，下载与分析分别验收 |
| CMIP及科研气候情景 | 本机任务和清单基础 | 模型/情景/成员/网格/日历/版本选择、ESGF分页与多节点 | P2，可选技能 |
| 离线三维 | 递归资源核验与Cesium已有开发证据 | 提供方权益、资产归档/裁剪条件、整瓦片与网格裁剪区分 | 继续来源专项核验 |

### 当前规模限制依然是明确缺口

本轮再次查当前源码：在线读取仍限制为 **10,000 要素、32 MiB响应、200次请求**，在线导出沿用该读取流程；数据库选择也限制为最多10,000要素。它能正确拒绝超限，但不能完成2.8万或9万记录的全量目标。

应新增单独的导出作业：稳定ID或服务支持的游标分批，分批落盘，保存检查点，最后核对总数、重复、范围、属性和文件可读性。数据预览和完整成果采用不同规模合同。直接放大内存读取上限不能证明大数据导出完成。

依据：[online_inputs.rs](G:/code/geod-agent/apps/geod-agent-desktop/src-tauri/src/online_inputs.rs:12)、[database_query.rs](G:/code/geod-agent/apps/geod-agent-desktop/src-tauri/src/database_query.rs:17)、[在线矢量验收记录](G:/code/geod-agent/docs/implementation/2026-10-03-online-vector-exports.md)。

## 四、行业技术观察（适用性按当前范围筛选）

### 1. 气象下载要管理远端作业

2026年ECMWF用户已经缩小并合并请求，仍遇到数小时排队。Agent可以减少重复请求、保持任务、解释阶段并按规则恢复；不能许诺消除上游容量不足。[2026年排队讨论](https://forum.ecmwf.int/t/severe-and-persistent-queue-delays-for-era5-hourly-data-pressure-levels-via-cds-api/14836)。

ERA5原生是GRIB，NetCDF涉及服务端转换，因此提供方允许的请求大小可能不同。应按当前数据表单约束规划，用户明确要求NetCDF时不能静默改格式。可提出“原生下载后本机转换”的选项，说明所需空间和处理时间。[ECMWF公告](https://forum.ecmwf.int/t/limitation-change-on-netcdf-era5-requests/12477)。

CDS还要求用户接受数据集条款。账号状态、条款未确认、排队、生成、传输和本机处理需要独立状态。现有cdsapi可复用；新ecmwf-datastores-client仍处于孵化状态，不应因为功能较多就跳过版本固定和恢复验收。[CDS官方接入说明](https://cds.climate.copernicus.eu/how-to-api)。

### 2. 土地覆盖不能默认“最近年份”或直接做差

WorldCover当前产品页提供2020与2021版本，两个年份使用不同算法。跨年差异同时可能包含算法变化；不能直接解释成真实地表变化。它提供COG与分幅索引，适合按研究区选取。[WorldCover官方数据页](https://esa-worldcover.org/en/data-access)。

Dynamic World提供单景对应的九类标签和概率；用户可能要单期、年度合成、主导类别或概率。需要说明可选交付与算法，不自动选择最方便的合成。[Dynamic World官方目录](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1)。

### 3. 同一“土壤数据”可有不同取得方式

SoilGrids当前文档说明REST API临时暂停，且没有恢复时间承诺。文档同时提供WCS、WebDAV等途径。服务发现应记录每种方式的状态，不能只实现一个API就声称长期稳定支持。[SoilGrids官方说明](https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_02.html)。

需先选土壤属性、土层深度、均值或分位数，再处理实际格网与单位。远程VRT还引用其他分幅文件，主VRT保存成功不能等同于离线成果完整。

### 4. 海洋数据需要真正的多维语义

官方Marine Toolbox支持按变量、地理范围、时间和深度取子集，可减少整包传输。[官方Subset API](https://help.marine.copernicus.eu/en/articles/8283072-copernicus-marine-toolbox-api-subset)。

额外的时间边界维度、比例因子、偏移、日历、有效值和跨日期变更线都需要数据读取器核验。模型可以解释和提出选项，数值解码交给确定性工具。历史R库issue已经关闭，案例应变成回归验收而非现行故障声明。

### 5. 云端矢量适合先过滤后传输

Overture官方给出DuckDB远程读取GeoParquet、筛选字段并导出的路径。可按发布版本和研究范围获取数据，避免先下载全球整包。对象ID或某个分片编号不能替代空间查询条件。[Overture官方教程](https://docs.overturemaps.org/getting-data/duckdb/)。

输出仍需核对所选主题、版本、几何、字段、缺失值和最终数量。客户端工具开源许可与数据产品许可分别核查。

### 6. 数据无法公开取得时仍应给明确结果

高德行政服务不返回乡镇街道边界；IGN说明部分LiDAR分幅不会发布。Agent应在计划前明确这些覆盖缺口，不能编造“已找到全国完整村界”或把缺分幅当成重试问题。[高德](https://lbs.amap.com/api/webservice/guide/api/district)、[IGN](https://geoservices.ign.fr/lidarhd)。

本轮能看到中国海洋卫星服务中的水色、动力环境等目录及格式文档，但没有取得任何该服务原始产品；国内海洋和实测水文也未得到足够原始求助样本，暂列后续供给验证与用户访谈方向。[中国海洋卫星数据服务](https://osdds.nsoas.org.cn/)。

## 五、按当前产品范围修正的推进顺序

### 第一批：图源、范围和对话确认

完善地图图源发现与配置，覆盖时间、认证状态与缩略图缓存。地名、历史时期、CRS 和多区域分组不明确时询问用户。计划与卡片归属于实际生成它们的回答，名称使用行政区或数据名称。

### 第二批：可靠下载与完整成果

优化现有瓦片吞吐、缓存与恢复；将下载、拼接、裁剪、保存和核验分阶段显示，完成后能打开成果目录。在线矢量全量导出采用独立流式任务，解决数量限制，保留属性与稳定 ID。多任务能分别确认、丢弃、取消和恢复。

### 第三批：地图、DEM和三维使用闭环

完善二维与三维 MCP 工具发现、图层控制、相机、视图切换和结果读回。对已有可用 DEM 做类型、单位、范围与成果检查。按来源核查三维显示及离线条件，不把请求成功作为权限证明。

原报告推荐的原始遥感、气象时序及其他科研下载流程，现移为范围外观察，不再列为下一批开发。

## 六、范围外复用工具观察（不进入当前接入计划）

| 方向 | 已核读的复用候选 | 接入时的主要验收 |
| --- | --- | --- |
| NASA科研产品 | [earthaccess](https://github.com/nsidc/earthaccess)、[Harmony](https://ladsweb.modaps.eosdis.nasa.gov/learn/using-harmony-tools-in-earthdata-search/) | 产品/资产发现、授权重定向、真实文件格式、服务支持的子集、缺测 |
| ERA5气象 | [CDS API](https://cds.climate.copernicus.eu/how-to-api) | 数据条款、批次约束、远端作业恢复、GRIB/NetCDF、逐时清单 |
| 海洋 | [官方Marine Toolbox](https://help.marine.copernicus.eu/en/articles/8283072-copernicus-marine-toolbox-api-subset) | 变量/深度/参考期、真实维度、数值单位、经线处理 |
| Overture建筑/POI | [DuckDB官方读取路径](https://docs.overturemaps.org/getting-data/duckdb/) | 固定发布版、空间过滤、属性、全量落盘与数量 |
| 土壤 | [ISRIC数据访问文档](https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_02.html) | 可用服务、土层/属性/分位数、远程分幅与投影 |
| 人口 | [WorldPop获取工具](https://github.com/wpgp/get_wp_global) | 产品版本、年份、人数/密度、年龄/性别层、区域统计 |
| LiDAR | [IGN目录](https://geoservices.ign.fr/lidarhd)、[PDAL](https://pdal.io/en/stable/) | 分幅索引、LAS/LAZ与点分类、CRS/垂直基准、点数与边界 |
| CMIP及其他ESGF产品 | [esgpull](https://github.com/ESGF/esgf-download)、[ESGF FAQ](https://esgf.github.io/esgf-user-support/faq.html) | 模型/实验/成员/网格/日历、版本/副本、全量分页、校验与恢复 |
| SAR分析 | 原始Sentinel产品适配后单独选择处理引擎 | 极化/轨道/级别、处理图、掩膜、灾前灾后可比性与结果验证 |

这些是可复用工具的研究清单，本轮未安装或验证它们与GeoD的实际联动。维护者工具的许可、数据集使用条件和二进制分发条件需要分别确认。

当前继续维护已提供的轻量基础包与可选GIS技能。本表的新领域工具仅存为研究资料，不安排安装或接入。既有Java/OCR移除要求继续适用；本报告不要求将Java处理环境重新捆绑。[当前可选GIS技能](G:/code/geod-agent/docs/implementation/2026-10-06-slim-gis-skills.md)。

## 七、共用设计素材（只应用当前数据类型）

### 计划需要表达用户真正选择的内容

当前采用范围、图源、时期、输出、权限、预算、任务与成果核验等共用字段。波段、气压层、科研情景等字段仅为跨领域研究素材，不要求扩展当前工具协议。

建议在共用计划中保留以下信息；没有必要向普通用户展示所有内部字段。

- 研究范围及来源、CRS、跨经线标记、多个区域的分组方式。
- 数据集、提供方、产品ID、发布/观测时间及版本。
- 数据类型与真实用途：显示底图、原始多波段、分类标签、概率、观测值、模式值、人口估算等。
- 必要变量、波段、气压层/深度、情景/成员、单位、时间频率和日历。
- 输出格式、分文件组织、分辨率、压缩选择、保存目录和预算。
- 授权状态与对应数据使用条件；用户凭据由本机安全入口管理。
- 目录预计数量、实际数量、检查点、校验摘要和缺失原因。

缺少会改变交付物的内容就弹出选择卡。提供合理候选和说明，由用户提交，不将预选项视为已回答。用户明确要求自行决定时才按授权选择，并在计划中记录。

### 下载器和检查器负责可靠执行

建议按提供方实现目录发现、权限核查、计划、远端提交、状态查询、资产传输与成果验证。目录结果、预览和真正原始产品状态分别保存。模型负责理解、解释和选择请求；后台负责作业等待、授权刷新、重试、字节传输和清单核验。

作业阶段需要包含：待选择、待授权、待确认、远端排队、远端生成、本机下载、本机处理、核验、完成、部分完成与失败。下载100%不能覆盖生成或验证阶段；有部分失败不能标记完整完成。进度由工具状态提供，无真实比例时显示阶段和活动状态。

### 交付质量进入完成条件

| 数据类型 | 应核验 |
| --- | --- |
| 矢量 | 实际数目、稳定ID、几何有效性、CRS、属性保留、重复与缺漏 |
| 普通栅格 | 范围、分辨率、像元类型、CRS、NoData、读回成功 |
| 遥感 | 产品/观测日期、级别、所需波段、质量资产、覆盖与云信息 |
| 分类栅格 | 分类代码、图例、版本、年份、可比性 |
| 科学多维数据 | 变量、维度、坐标、时间轴/日历、单位、scale/offset、有效数值 |
| 点云与CAD | 点分类/点数或图层、水平/垂直基准、单位、真实目标软件读回 |
| 大批次 | 预计/实际资源清单、校验、检查点、失败项与是否完整 |
| 三维 | 子tileset/模型/纹理依赖、许可路径、实际场景读回 |

“查到目录”“取得预览”“下载接口成功”和“产品完整可用”是不同的状态，最终回复应依据工具中的真实完成条件。

## 八、按产品范围筛选的建议验收

只有标记“当前范围”的案例进入当前建议验收；相邻需求和范围外案例保留为研究记录。这些均未在本轮实际执行。

| 编号 | 范围 | 场景 | 主要通过条件 | 依据 |
| --- | --- | --- | --- | --- |
| A01 | 当前范围 | 含歧义需求 | 在任何有成本的执行前确认朝阳所属地区、时期、用途；不给未经选择的默认期次。 | F01、D04、D11 |
| A02 | 当前范围外，仅保留调研观察 | 近红外产品 | 询问日期、云量与分析要求；候选产品有真实红光/近红外和元数据；RGB底图不得作为完成。 | D04、F03、F04 |
| A03 | 相邻需求，待评估，不进入本轮承诺 | 土地覆盖年份 | 确认产品和分类体系；两期有效覆盖、年份与版本可核验；说明算法变化和可比性。 | D05、D28 |
| A04 | 当前范围 | 全量矢量 | 源ID、预期数和落盘数核对，无静默截断；中断续传结果一致；当前10k上限下应明确未支持。 | F06、F07、D34 |
| A05 | 当前范围 | CSV入库 | 识别格式与CRS；环/多面合法、属性保存；目标库权限与写入确认具备；MongoDB不借用PostGIS支持声明。 | D10 |
| A06 | 当前范围 | 设施交付 | 映射实际标签，读回属性；报告缺失、重复和来源时间；不保证开放数据收录全量真实设施。 | D47 |
| A07 | 相邻需求，待评估，不进入本轮承诺 | CAD交付 | 确认DXF等格式、坐标、米制单位与高度基准；在真实CAD读回图层和高程；不把GIS文件改扩展名。 | D45、D46 |
| A08 | 当前范围外，仅保留调研观察 | WRF数据 | 确认模拟域/缓冲、变量与气压层；每个批次和时刻清单齐全；保存GRIB/NetCDF与来源请求；不能只交地面RGB。 | D01、D02、D14 |
| A09 | 当前范围外，仅保留调研观察 | 云端排队 | 读回已有远端作业状态，不重复提交；显示排队/生成/传输；未知比例显示活动状态而非伪造进度。 | D13、D15、D16 |
| A10 | 当前范围外，仅保留调研观察 | 错误成果 | 识别HTML/JSON错误页，不能记成功；授权恢复使用原清单；真实HDF/NetCDF可打开并匹配产品ID。 | D17、D19 |
| A11 | 当前范围外，仅保留调研观察 | 海洋维度 | 确认深度与日期；读回坐标、维度、单位、scale/offset、有效像元；切片对应实际范围。 | D22、D24、D25、D26 |
| A12 | 当前范围外，仅保留调研观察 | 跨经线 | 显式处理跨经线分块，合并后无缺口或重复边缘；范围与经度规范一致。 | D23 |
| A13 | 当前范围外，仅保留调研观察 | 点云分幅 | 发现真正LAZ而非DEM；相交分幅与清单核对，分类和CRS读取；有缺失分幅则报告。 | D29、D30、D31 |
| A14 | 当前范围外，仅保留调研观察 | 人口与土壤 | 确认年份、区划版本、人数/密度、土层、统计量；人口与土壤的聚合方法分开；保留产品与来源。 | D41、D48 |
| A15 | 当前范围外，仅保留调研观察 | 气候模型 | 确认成员、版本、网格和日历；模型/情景/变量分别组织，清单完整，无重复与缺失。 | D34、D35、D36 |
| A16 | 当前范围外，仅保留调研观察 | SAR洪水 | 确认事件时段、极化/轨道/级别；先核验输入产品；分析需经过已验收技能，并报告验证与不确定性。 | D37、D38、D39、D40 |
| A17 | 当前范围 | 图源与历史时期 | 查询服务实际可用版本，确认地区/时期；区分版本日与拍摄元数据；不能替用户静默选择。 | F01、F05 |
| A18 | 当前范围 | 瓦片成果交付 | 计划匹配用户范围和格式；瓦片与成果核验，读回地理范围；保持用户压缩选择。 | F11、F30、F31 |
| A19 | 当前范围 | 二维三维操作 | 工具发现完整，真实加载并读回图层/场景；相机、图层和视图切换可执行；权限按数据来源检查。 | F26、F27、F28、F29 |
| A20 | 当前范围 | 后台阶段与成果目录 | 真实显示下载/拼接/裁剪/核验阶段，后台不持续占聊天；完成后可打开实际成果目录。 | F11、F12 |
| A21 | 当前范围 | 多区域任务管理 | 先确认分组方式；卡片绑定原回答，任务命名清楚；独立取消/恢复和成果归属可核验。 | D06、D11 |
## 九、需要继续验证的商业与用户假设

1. **先验证“交付省时间”的价值。** 找地图影像下载、规划制图及已有三维数据使用者，带当前产品可承接的真实任务观察他们能否更快获得可用成果。
2. **记录任务完成率和失败原因。** 参数选错、源数据不存在、权限不足、上游等待、传输失败、处理失败、格式不能使用分别记录；不能只统计对话成功。
3. **公开数据和工具价值分别说明。** 用户价值来自发现、批次执行、整理与核验；不能把公开数据包装成产品独占。
4. **模型费用按对话与规划核验记录。** 瓦片、文件传输和排队状态由后台维护，不需要每个资源都请求模型；本报告未重新测量成本或给出收费结论。
5. **付费意愿需独立访谈。** 一条“有偿求助”表明有人在特定场景愿意求助，不能据此推算价格、付费比例或市场规模。
6. **国内高分、实测水文、乡镇村界先查实际供给。** 需合法账号与具体产品完成权限和下载核验后，才能进入可交付目录。国际不同区域公开资料也不能统一保证质量与完整性。

建议下一步围绕当前图源、范围、下载交付和地图操作做可复现验收，原始遥感及科研平台需求不进入当前目标。

## 附录：本轮新增48个样本索引

完整原始标题、日期、对话必要参数、当前能力判断与优先级存于JSON。这里保留简洁需求索引，不保存帖子全文和作者联系方式。

| 编号 | 社区 / 日期 | 类别 | 需求摘要 | 原文 |
| --- | --- | --- | --- | --- |
| D01 | 气象家园 / 2026-06-11 | 气象与WRF | 需要2025年5—10月逐小时高空和地面ERA5，公共下载太慢，希望获得可用数据。 | [原帖](http://bbs.06climate.com/forum.php?mod=viewthread&tid=111784) |
| D02 | 气象家园 / 2023-07-14 | 气象与WRF | 黄河流域长期WRF研究不想下载全球ERA5，且不清楚地面、高空文件组织和缺文件原因。 | [原帖](http://bbs.06climate.com/forum.php?mod=viewthread&tid=108421) |
| D03 | 气象家园 / 2019-04-14 | 认证与环境 | Windows用户建立.cdsapirc后仍无法识别配置，不清楚隐藏扩展名和文件格式。 | [原帖](http://bbs.06climate.com/forum.php?mod=viewthread&tid=90176) |
| D04 | 地信网论坛 / 2020-09-01 | 原始遥感与植被 | 小流域植被覆盖研究下载到RGB底图，却需要红光和近红外多波段影像。 | [原帖](http://bbs.3s001.com/thread-336979-1-1.html) |
| D05 | 地信网论坛 / 2022-04-13 | 土地覆盖 | 新手寻找30米全国或贵州省土地利用栅格。 | [原帖](http://bbs.3s001.com/thread-358323-1-1.html) |
| D06 | 地信网论坛 / 2018-08-28 | 范围与坐标系 | 需要洱海周边道路、注记和行政边界，交付SHP与西安80坐标系。 | [原帖](http://bbs.3s001.com/thread-277413-1-1.html) |
| D07 | 地信网论坛 / 2021-03-16 | 行政边界供给 | 寻找按乡镇组织、包含行政村边界的全国矢量地图。 | [原帖](http://bbs.3s001.com/thread-344918-1-1.html) |
| D08 | 小木虫 / 日期未完整显示 | 高分与授权 | 希望找到GF或SPOT卫星影像的免费下载渠道。 | [原帖](https://muchong.com/t-13708167-1) |
| D09 | GitHub Issues 或 Discussions / 2022-04-05 | 行政边界质量 | 维护者发现部分区县边界组合拓扑异常，测试暂时跳过这些地区。 | [原帖](https://github.com/cnmetlab/cnmaps/issues/17) |
| D10 | GitHub Issues 或 Discussions / 2024-07-10 | 多格式与数据库 | 用户将边界CSV导入MongoDB时，多面分隔和非闭合环导致空间索引失败。 | [原帖](https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov/issues/45) |
| D11 | GitHub Issues 或 Discussions / 2024-05-08 | 行政区版本 | 用户核查到地名错误、撤镇设街及区划变更未同步。 | [原帖](https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov/issues/43) |
| D12 | ECMWF Forum / 2025-03-27 | 气象请求与格式 | 同样的ERA5-Land月数据在NetCDF格式突然超限，GRIB请求可接受。 | [原帖](https://forum.ecmwf.int/t/request-size-has-changed-for-netcdf-files/12282) |
| D13 | ECMWF Forum / 2024-10-24 | 气象批次调度 | 按近两万个时间点逐次请求ERA5，提交后长期停在队列。 | [原帖](https://forum.ecmwf.int/t/cdsapi-era5-download-error/7193) |
| D14 | ECMWF Forum / 2019-06-16 | 区域时序提取 | 数千小区各自下载20年温度降水，每区等待数分钟，成本过高。 | [原帖](https://forum.ecmwf.int/t/how-to-download-faster/1391) |
| D15 | ECMWF Forum / 2025-01-08 | 上游等待与失败 | 多年气压层湿度数据由十分钟变成数小时，并出现服务器500错误。 | [原帖](https://forum.ecmwf.int/t/very-slow-era5-download/10610) |
| D16 | ECMWF Forum / 2026-04-01 | 上游等待与失败 | 已按天合并ERA5请求仍持续长时间排队，希望可诊断真实状态。 | [原帖](https://forum.ecmwf.int/t/severe-and-persistent-queue-delays-for-era5-hourly-data-pressure-levels-via-cds-api/14836) |
| D17 | NASA Earthdata Forum / 2024-08-22 | 认证与成果核验 | 批量下载一年MYD06时保存的文件实际是HTML登录页，wget报401。 | [原帖](https://forum.earthdata.nasa.gov/viewtopic.php?t=5879) |
| D18 | NASA Earthdata Forum / 2025-07-10 | 降水长时序 | 长时间跨度半小时IMERG子集预计需数百小时，HPC单次会话只有48小时。 | [原帖](https://forum.earthdata.nasa.gov/viewtopic.php?t=7014) |
| D19 | NASA Earthdata Forum / 2025-08-01 | 服务迁移 | 旧MODIS自动管线在数据迁移后出现404、401，不清楚新下载入口和授权。 | [原帖](https://forum.earthdata.nasa.gov/viewtopic.php?t=7085) |
| D20 | NASA Earthdata Forum / 2023-04-19 | 大文件与科研数据 | 超过1TB的MERRA-2数据在HPC下载时出现认证错误和重定向问题。 | [原帖](https://forum.earthdata.nasa.gov/viewtopic.php?t=4151) |
| D21 | NASA Earthdata Forum / 2025-05-05 | 海温子集与恢复 | 已生成时空海温子集但Windows客户端下载立即403，担心重置丢失数据。 | [原帖](https://forum.earthdata.nasa.gov/viewtopic.php?t=6769) |
| D22 | GitHub Issues 或 Discussions / 2025-01-13 | 海洋时序与性能 | 多年海流数据按天保存很慢，按月拆开再提取效率更好。 | [原帖](https://github.com/mercator-ocean/copernicus-marine-toolbox/issues/267) |
| D23 | GitHub Issues 或 Discussions / 2026-03-04 | 跨日期变更线 | 跨180度经线的海洋子集被截断，用户希望正确取得完整研究区。 | [原帖](https://github.com/pepijn-devries/CopernicusMarine/issues/141) |
| D24 | GitHub Issues 或 Discussions / 2026-03-06 | 多维数据发现 | 海底温度气候态含额外时间边界维度，读取器假定四维导致发现失败。 | [原帖](https://github.com/pepijn-devries/CopernicusMarine/issues/143) |
| D25 | GitHub Issues 或 Discussions / 2025-11-06 | 坐标与数值核验 | 北海子集看起来是全区域缩放，坐标与格网内容不匹配。 | [原帖](https://github.com/pepijn-devries/CopernicusMarine/issues/102) |
| D26 | GitHub Issues 或 Discussions / 2025-11-05 | 单位与编码 | 海底温度读取为不合理的负万级数值，不清楚比例因子和偏移。 | [原帖](https://github.com/pepijn-devries/CopernicusMarine/issues/100) |
| D27 | Stack Overflow / 2023-02-17 | 土地覆盖与合成 | Dynamic World按时间的集合与单张影像下载函数不匹配，不知如何导出。 | [原帖](https://stackoverflow.com/questions/75489393/how-to-download-a-land-cover-image-using-geemap) |
| D28 | GIS Stack Exchange / 2021-06-23 | 数据年份与覆盖 | 要2000—2020土地覆盖时序，整包超过40GB，可找到的集合年份不完整。 | [原帖](https://gis.stackexchange.com/questions/402234/is-there-a-land-cover-type-image-collection-on-google-earth-engine-that-covers-t) |
| D29 | GeoRezo / 2026-03-05 | 点云分幅与批量 | 已得到研究区所需IGN点云分幅名称，希望自动批量下载或加载QGIS。 | [原帖](https://georezo.net/forum/viewtopic.php?pid=376763) |
| D30 | GeoRezo / 2024-05-20 | 点云目录发现 | 希望获得地理格式的分幅边界，在QGIS内选择需要的点云。 | [原帖](https://georezo.net/forum/viewtopic.php?pid=367589) |
| D31 | GeoRezo / 2026-07-28 | 服务迁移与数据类型 | IGN入口迁移后只能找到TIF，找不到真正LAZ点云下载。 | [原帖](https://georezo.net/forum/viewtopic.php?pid=377978) |
| D32 | GitHub Issues 或 Discussions / 2026-03-22 | 云端矢量与版本 | 加拿大建筑读取随发布版分区变化，需要理解数据分布与下载成本。 | [原帖](https://github.com/OvertureMaps/data/issues/508) |
| D33 | GitHub Issues 或 Discussions / 2024-01-20 | 云端矢量完整性 | 下载231GB全球建筑却提不出东京，原来以对象ID前缀做空间筛选不可靠。 | [原帖](https://github.com/OvertureMaps/data/issues/113) |
| D34 | GitHub Issues 或 Discussions / 2026-05-13 | 气候目录完整性 | 1610个小文件通过多页购物车生成清单后，部分重复、部分遗漏。 | [原帖](https://github.com/esgf2-us/metagrid/issues/923) |
| D35 | Stack Overflow / 2020-02-14 | 气候时段筛选 | CMIP6脚本包含1850—2014，用户只要1980年后的分段文件，不会裁剪清单。 | [原帖](https://stackoverflow.com/questions/60232183/how-do-i-modify-subset-a-wget-script-to-specify-a-date-range-to-only-download-ce) |
| D36 | ECMWF Forum / 2024-10-30 | 气候模型与组织 | 多SSP、多变量、多模型请求太大，结果混在一起，希望按模型变量分文件。 | [原帖](https://forum.ecmwf.int/t/issues-with-api-for-downloading-cmip6-datasets/7329) |
| D37 | ESA STEP Forum / 2017-09-27 | 洪水与SAR处理 | 要Houston洪水范围，知道Sentinel-1 GRD却不清楚处理和导出步骤。 | [原帖](https://forum.step.esa.int/t/flood-map-using-grd/7231) |
| D38 | ESA STEP Forum / 2019-06-11 | 产品级别与SAR处理 | 部分日期只有SLC，希望理解是否及如何转为GRD再进行洪水制图。 | [原帖](https://forum.step.esa.int/t/sentinel-1a-slc-to-grd-product-for-flood-inundation-please-review-the-steps/15897) |
| D39 | ESA STEP Forum / 2025-05-19 | SAR质量与缺测 | 多时相S1处理后水体被当作NoData，下载成功但分析数据不正确。 | [原帖](https://forum.step.esa.int/t/terrain-correction-in-multi-temporal-dual-pol-s1-stack-masks-out-water-despite-nodatavalueatsea-set-to-false/44555) |
| D40 | ESA STEP Forum / 2020-09-04 | 变化检测 | 希望验证多期S1变化检测流程以识别洪水。 | [原帖](https://forum.step.esa.int/t/change-detection-using-sentinel-1-sar-grd-data/25207) |
| D41 | GIS Stack Exchange / 2020-07-16 | 土壤与投影 | 小范围示例可以下载，扩大全球后Homolosine转换失败。 | [原帖](https://gis.stackexchange.com/questions/367925/downloading-soilgrids-data-globally-using-r/368434) |
| D42 | GIS Stack Exchange / 2021-08-02 | 远程栅格与环境 | 生态建模要全球土壤GeoTIFF，远程VRT路径和GDAL版本导致读取失败。 | [原帖](https://gis.stackexchange.com/questions/407408/downloading-the-global-soilgrids-data-using-python) |
| D43 | GIS Stack Exchange / 2021-01-07 | WCS科学栅格 | 曾可用的WCS土壤下载突然报错，不知是服务、投影还是环境问题。 | [原帖](https://gis.stackexchange.com/questions/383755/downloading-soilgrids-data-from-wcs-in-r) |
| D44 | GitHub Issues 或 Discussions / 2021-08-04 | 区域土壤读取 | 维护者希望自动获取任意范围土壤格网，受本机GDAL权限、证书和安装版本影响。 | [原帖](https://github.com/ncss-tech/soilDB/issues/202) |
| D45 | Reddit r/gis / 2025-04-24 | 建筑设计与CAD | 在法国参赛的奥地利建筑师要地形和建筑高度，难以理解整省压缩GIS资料并转给Rhino或Archicad。 | [原帖](https://www.reddit.com/r/gis/comments/1k6xl8m/getting_gis_data_from_france_into_cad/) |
| D46 | Reddit r/gis / 2020-11-16 | 建筑设计与CAD | 建筑学生希望按OSM分类提建筑和道路，并导出DXF用于图底关系分析。 | [原帖](https://www.reddit.com/r/gis/comments/jvghnt/extract_useful_layers_from_osm_file_for_cad/) |
| D47 | Reddit r/gis / 2023-08-24 | 公共设施与POI | 城市规划用户要医院学校等设施位置，试过SHP和GML仍取不出需要字段。 | [原帖](https://www.reddit.com/r/gis/comments/1601yjo/efficient_methods_to_retrieve_building_locations/) |
| D48 | Reddit r/gis / 2019-06-11 | 人口与区域统计 | 要塞拉利昂、莱索托和海地分区人口估算，希望获得替代WorldPop的数据与合理方法。 | [原帖](https://www.reddit.com/r/gis/comments/bzd8zf/estimating_population/) |

## 附录：本轮新增原始技术参考

| 编号 | 来源 | 本轮核实内容 |
| --- | --- | --- |
| S01 | [CDSAPI setup](https://cds.climate.copernicus.eu/how-to-api) | CDS提供Python API，需要账号和数据集条款确认；新客户端仍处于孵化状态。 |
| S02 | [ERA5 NetCDF request constraints](https://forum.ecmwf.int/t/limitation-change-on-netcdf-era5-requests/12477) | ERA5原生为GRIB，NetCDF增加服务端转换工作；限制应以当前数据表单核查，不能固定套旧阈值。 |
| S03 | [NASA Harmony customization](https://ladsweb.modaps.eosdis.nasa.gov/learn/using-harmony-tools-in-earthdata-search/) | 对支持的数据集可在下载前做时间、空间或变量子集；不同集合支持不同工具。 |
| S04 | [Copernicus Marine subset API](https://help.marine.copernicus.eu/en/articles/8283072-copernicus-marine-toolbox-api-subset) | 官方工具支持按变量、空间、时间和深度取得子集。 |
| S05 | [Overture DuckDB data access](https://docs.overturemaps.org/getting-data/duckdb/) | 可远程查询GeoParquet并导出所需范围和字段；应固定发布版与模式。 |
| S06 | [SoilGrids access](https://docs.isric.org/globaldata/soilgrids/SoilGrids_faqs_02.html) | WMS用于显示，WCS与WebDAV可取得数据；当前文档说明REST API临时暂停，没有恢复时间承诺。 |
| S07 | [WorldCover data access](https://esa-worldcover.org/en/data-access) | 提供2020和2021土地覆盖产品；算法版本不同，跨年差异含算法变化；有COG和分幅索引。 |
| S08 | [Dynamic World V1 catalog](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1) | 近实时10米九类土地覆盖产品包含标签与概率，源自单景Sentinel-2；不是任意年度权威土地利用调查。 |
| S09 | [IGN LiDAR HD](https://geoservices.ign.fr/lidarhd) | 点云与地形、地表、高度派生产品分开发布；部分分幅因发布限制缺失。 |
| S10 | [高德行政区域查询](https://lbs.amap.com/api/webservice/guide/api/district) | 使用Web服务Key；不返回乡镇街道边界polyline，不能由该接口承诺全国村界。 |
| S11 | [中国海洋卫星数据服务系统](https://osdds.nsoas.org.cn/) | 有水色、动力环境、监视监测等目录和数据格式文档；能看到目录不代表本轮取得了产品。 |
| S12 | [ESGF user FAQ](https://esgf.github.io/esgf-user-support/faq.html) | 可检查节点状态与副本，并按产品和节点提交诊断；旧FAQ不等于当前所有节点都支持同一认证方式。 |
| S13 | [earthaccess](https://github.com/nsidc/earthaccess) | NASA数据检索、下载与流式读取的可复用Python库；仓库已迁移到earthaccess-dev组织，旧链接可重定向。 |
| S14 | [esgpull](https://github.com/ESGF/esgf-download) | ESGF检索、查询与文件下载管理工具，可作为CMIP类技能候选。 |
| S15 | [WorldPop data acquisition tools](https://github.com/wpgp/get_wp_global) | 按数据版本、年份、国家和图层定位人口栅格并作人口数量汇总；需要核对选定数据集许可。 |
| S16 | [CLCD original paper](https://essd.copernicus.org/articles/13/3907/2021/) | 原始论文描述1990—2019年30米中国年度土地覆盖；不能用转载或售卖帖证明已有2025版。 |
| S17 | [PDAL documentation](https://pdal.io/en/stable/) | 提供点云读取、查询、转换和过滤，可作为可选点云技能处理引擎。 |

## 当前GeoD能力核查依据

- [在线读取源码](G:/code/geod-agent/apps/geod-agent-desktop/src-tauri/src/online_inputs.rs:12)、[数据库选择源码](G:/code/geod-agent/apps/geod-agent-desktop/src-tauri/src/database_query.rs:17)。
- [在线导出验收](G:/code/geod-agent/docs/implementation/2026-10-03-online-vector-exports.md)、[功能路线与既有验证](G:/code/geod-agent/docs/implementation/2026-10-03-functional-roadmap.md)。
- [用户选择卡](G:/code/geod-agent/docs/implementation/2026-10-06-agent-user-input.md)、[生成成果活动状态](G:/code/geod-agent/docs/implementation/2026-10-06-processing-loading.md)。
- [轻量基础包和可选GIS技能](G:/code/geod-agent/docs/implementation/2026-10-06-slim-gis-skills.md)。
- 本轮搜索当前Rust、Python和相关服务实现，没有发现ERA5、Marine、SoilGrids、CMIP、Earthdata、GeoParquet或LAS/LAZ产品的专用闭环。已有通用后台命令和MCP扩展能力，不代替具体提供方接入与验收。


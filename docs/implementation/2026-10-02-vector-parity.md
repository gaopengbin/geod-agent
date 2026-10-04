# 矢量下载补齐记录

## 实现边界

`crates/geod-vector` 是 GeoD Agent 仓库内独立实现。复用本仓库的 `geod-core` 瓦片网格/边界类型与 `geo` 几何运算，不依赖旧 GeoD 的路径、构建或运行进程。检查了旧版 `tile_pack.rs` / `admin.rs` 的功能范围；本模块未复制旧版源码。

### 已实现

- MVT 1/2 protobuf 解码：点、多点、线、多线、多边形、多面、孔洞、图层名、属性和原始 ID。
- 原始 `.pbf` 目录和 TileJSON、MVT MBTiles（TMS 行号、gzip 和 `vector_layers` 元数据）、GeoJSON、GeoPackage。
- Overpass OSM 点/线/面与关系几何组装，保留 tags、OSM ID、数据时间和原始响应。关系不完整或不支持嵌套时明确记录警告，不拼造面。
- GPKG 使用标准 GeoPackageBinary、XY envelope、OGC WKB、EPSG:4326；不需要本机 GDAL 来写出。
- 完整要素导出与有上限的 GeoJSON 地图预览（最多 10,000 要素，截断会明确标记）。
- bbox / Polygon / MultiPolygon 范围筛选：MVT 只请求与边界相交的瓦片，GeoJSON/GPKG/预览保留相交的完整要素；OSM 支持多面查询与同样的本地精确筛选。洞内与范围外要素排除，跨界几何不切断。
- 并发 1–64、HTTP 重试、可取消等待和下载、验证过的分块缓存、原子发布、缺失瓦片记录。默认有失败便不发布完整成果；允许部分输出须显式 `allowPartial`。
- 缓存按计划和运行时鉴权摘要隔离，七天失效；失败重试会复用此前有效瓦片。密钥不进入计划、日志、成果 manifest。
- `inspect` 重读成果哈希、SQLite integrity、瓦片 PBF 解码、要素数、CRS 和预览数；路径必须仍在成果目录内。

### 原生后台层

`apps/geod-agent-desktop/src-tauri/src/data_jobs.rs` 增加独立 `data_download_tasks` 表，保存矢量和 3D Tiles 的计划、工作区、会话、账号、进度及成果。

- `data_download_plan` 生成具体计划及工作区内的新输出目录。
- `data_download_start` 仅用于用户确认；`data_download_start_auto` 每次检查当前工作区完全访问权限。模型入口只调用后者。
- `list/get/cancel/discard/inspect/preview` 均检查当前账号和会话。
- 启动立即返回任务，下载在本机后台执行，进度写入 SQLite。
- 应用重开把未完成状态恢复为 `interrupted`，用户可以继续。
- `preview` 先校验实际成果，再注册给 `geod-data` 协议，以短期本机 token 和白名单文件供地图读取。
- `cancel_all()` 可接应用退出事件；重开恢复并不依赖退出事件成功执行。

原生 IPC、实际模型与真实地图渲染均已验收：`evidence/vector-native-2026-10-02.json`、`evidence/data-app-real-model/acceptance.json`。实际验收发现并修复了新矢量图层创建与三维子资源 URL 两处集成问题。新版边界筛选在重编后再次通过 native 真实请求与文件读回：`evidence/vector-range-native-2026-10-02.json`。

## 已完成的真实请求验收

日期：2026-10-02。

| 数据 | 真实来源 | 结果 | 本地证据 |
| --- | --- | --- | --- |
| MVT 原始瓦片 | MapLibre 官方演示国家瓦片，Z2，一张 | 69,624 字节，原始 221 要素；旧整瓦片解码证据保留 | `artifacts/desktop-parity/vector-mvt-live-20261002` |
| MVT 新版范围导出 | 同一真实瓦片，柏林 bbox / 三角形边界 | GeoJSON/GPKG/预览仅 **1 个 Germany 国界要素**，其余国家和点排除；PBF/MBTiles 原字节保留。真实 native 任务 `cfec5688-5516-42ad-9e9b-f2351e1445e6` | `evidence/vector-range-native-2026-10-02.json` |
| OSM | VK Overpass，柏林小范围建筑 | 21,584 字节，13 个建筑面；数据时间 2026-10-02T13:09:51Z；GeoJSON/GPKG/preview 全部重读通过 | `artifacts/desktop-parity/vector-osm-live-20261002` |

初次独立 Fiona/GDAL 读回：两个 GPKG 均为 EPSG:4326，分别 221 / 13 要素；OSM 13 个几何均为 Polygon。MVT MBTiles 以 `CLIP=NO` 读取，3 个图层为 centroids 104、countries 113、geolines 4，合计 221。新版 GeoJSON/GPKG 会筛选到 1 个 Germany 要素，原始 MBTiles 仍保存上述完整瓦片。这个示例图层为 `countries`，不能称为柏林建筑或柏林行政边界。

本次 Overpass 主站返回 504，Private.coffee 超时；依据 OSM 公布的实例表改用 VK，实际请求成功。默认 endpoint 已设为此实测地址，用户仍可指定自己的 Overpass 服务。

## 几何与范围说明

- MVT 原始目录和 MBTiles 保留入选瓦片的服务器字节（MBTiles 无 gzip 的瓦片仅增加标准 gzip 包装）。GeoJSON/GPKG 按请求 bbox 或完整多边形筛选相交要素，不跨瓦片或缩放级别融合，可能有重复切片。
- `source.layers` 只筛选解码后的 GeoJSON/GPKG/preview；原始 PBF/MBTiles 保留所有原始图层。
- OSM 按请求范围发现要素，并在本地精确筛选；输出相交要素的完整几何，可以越过范围边缘。
- manifest 的 bounds 表示用户请求范围。空间筛选保留相交要素，不声称已沿行政边界切断几何。
- MVT 源的上游无效几何仍可能存在；解析与文件完整性校验不等于源数据拓扑修复。

## 接口

```rust
geod_vector::plan(Request) -> Result<Plan>
geod_vector::run(&Plan, RunOptions, FnMut(Progress)) -> Result<Manifest>
geod_vector::inspect(&Path) -> Result<Manifest>
```

`RunOptions` 包含目标目录、缓存目录、并发、重试、运行时 `NetworkOptions`（代理、请求头、query credentials）与 `Arc<AtomicBool>` 取消信号；目标目录必须不存在。

原生命令计划参数：

```json
{
  "conversationId": "当前会话",
  "title": "柏林建筑矢量",
  "idempotencyKey": "本次操作稳定标识",
  "request": {
    "kind": "vector",
    "spec": {
      "source": {
        "type": "osm",
        "id": "osm-buildings",
        "name": "OpenStreetMap 建筑",
        "tags": [{"key": "building"}]
      },
      "bounds": [13.404, 52.52, 13.406, 52.522],
      "outputs": ["geojson", "gpkg"]
    }
  }
}
```

## 验证命令

```text
rtk cargo test --manifest-path crates/geod-vector/Cargo.toml --target-dir crates/geod-core/target
rtk cargo test --manifest-path apps/geod-agent-desktop/src-tauri/Cargo.toml data_jobs -- --test-threads=1
rtk cargo run --manifest-path crates/geod-vector/Cargo.toml --target-dir crates/geod-core/target --example download_public -- mvt OUTPUT_DIR PROXY
rtk cargo run --manifest-path crates/geod-vector/Cargo.toml --target-dir crates/geod-core/target --example download_public -- osm OUTPUT_DIR PROXY https://maps.mail.ru/osm/tools/overpass/api/interpreter
rtk proxy node test/native-data-download.mjs
rtk proxy node test/native-data-range.mjs
rtk proxy node test/native-data-schedules.mjs
```

## 验收状态

- [x] native IPC + 当前权限、后台进度、预览资源协议。
- [x] 实际 AI 对话完成 plan → start → inspect → 地图预览。
- [x] Agent UI 真实渲染：OpenLayers 矢量、Cesium 离线三维均已截图并目视核验。
- [x] 矢量 / 3D 共用定时运行表、独立目录、权限重检、暂停/取消与错过触发合并；真实计时器已下载 MVT，待确认与权限降级已验收。
- [x] 新版 bbox / 多面含洞筛选：10 个 core 测试与重编后的真实 native 输出读回。

多选批量操作使用主应用统一任务队列；本页证据覆盖模型连续产生多个任务与真实列表展示，不把它算作另一次完整的多选批量交互测试。

## 规范来源

- [Mapbox MVT 2.1 protobuf](https://github.com/mapbox/vector-tile-spec/blob/master/2.1/vector_tile.proto)
- [MBTiles 1.3](https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md)
- [OGC GeoPackage 1.4](https://www.geopackage.org/spec140/index.html)
- [OSM Overpass 实例与查询接口](https://wiki.openstreetmap.org/wiki/Overpass_API)

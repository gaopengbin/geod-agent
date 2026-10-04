# 3D Tiles：下载、范围筛选与离线预览

## 已实现的接口

独立 crate：`crates/geod-tiles3d`，版本 0.1.0。

```rust
let mut request = geod_tiles3d::DownloadRequest::new(tileset_url, new_output_directory);
request.bounds = Some([west, south, east, north]); // WGS84；跨日界线允许 west > east
request.proxy = resolved_proxy;
request.headers = resolved_headers;              // 只在内存中，不能回传模型
let bundle = geod_tiles3d::download(request, cancellation, |progress| {
    // discovered / completed / bytes / stage → 持久任务记录
}).await?;
let verified = geod_tiles3d::inspect(output_directory)?;
```

- `DownloadRequest::new` 默认并发 8、重试 3 次、最多 100000 资源、单文件 256 MiB、总成果 100 GiB；调用方可在计划阶段确定这些参数。
- 下载目标必须不存在。下载先写相邻临时目录，全部资源和离线引用验证成功后原子发布；错误和取消不生成“已完成”目录。
- `headers`、`proxy` 不序列化。认证头只发往原始源站；跳转到其他源站后不会携带这些头。
- `inherit_query` 默认关闭。显式开启时，只为同源子请求补齐根 URL 查询参数；最终资源名、manifest 和重写后的 JSON 不含这些参数。
- 资源名是 URL 与实例变换的哈希，多个外部 tileset 的同名内容和同一 tileset 的不同位置实例不会相互覆盖。

## 下载与筛选

| 项目 | 当前实现与证据 |
| --- | --- |
| 显式 1.0 / 1.1 | `content.uri`、旧 `content.url`、`contents`，保留其他节点字段 |
| 外部 tileset | 递归发现、累计变换、循环检测、引用重写；HTTP 集成测试及官方 RequestVolume 实例 |
| region | 弧度转 WGS84、忽略 tile transform，支持跨日界线；单测覆盖 |
| box / sphere | 累计父子变换后计算保守地理包络；相交的整块三维内容保留 |
| QUADTREE / OCTREE | 读取 JSON / 二进制 subtree，解析常量和位图可用性、Morton 地址、子 subtree 及外部 buffer，展开成显式节点 |
| 隐式 metadata | 属性表展开为显式 JSON metadata；数字、向量、矩阵、布尔、字符串、定长/变长数组、枚举；保留 table offset/scale 的类变体；处理节点包围体和几何误差语义 |
| glTF / GLB | glTF 2、GLB 2，外部 buffer 和图片 URI 递归下载并重写；校验二进制长度和 chunk 边界 |
| b3dm / pnts / i3dm / cmpt | 容器版本、长度和表边界检查；b3dm 内嵌 GLB、i3dm 内嵌/外置 glTF、cmpt 子内容递归处理 |
| 取消 / 重试 | 请求、响应体、退避等待和隐式树展开都观察取消；真实 HTTP 503 后重试和进行中取消的测试通过 |
| 完整性 | 每文件 SHA-256、字节数，所有引用均必须存在于 manifest 且位于成果目录内；篡改测试会失败 |

范围筛选按三维瓦片包围体选择整块内容，不会切断网格三角形。box/sphere 使用保守包络，边缘可能多保留少量瓦片。支持 WGS84 矩形和完整多边形（含洞、离散区与凹边界），详见 2026-10-02-tiles3d-polygon-aoi.md。

隐式树支持 region/box；S2 包围体扩展没有实现。glTF 1、旧的非标准 b3dm 头布局没有实现。遇到这些结构明确返回错误或在不能判定显式包围体时保留整块，不会伪造空数据结果。隐式 subtree metadata 保存在展开节点的 `extras.geodSubtreeMetadata`，节点和内容 metadata 按标准字段保留。

## 本机资源协议

`apps/geod-agent-desktop/src-tauri/src/data_asset_protocol.rs`：

```rust
DataAssets::register_verified(directory, entrypoint, &[DataResource { path, bytes, sha256, kind }])
    -> Result<RegisteredAssets { token, entrypoint, resource_path }, String>
DataAssets::respond(Request<Vec<u8>>) -> Response<Vec<u8>>
data_asset_unregister(token, State<DataAssets>) -> Result<(), String>
```

注册前逐文件流式计算哈希；只开放 manifest 列出的文件，拒绝路径遍历、超出根目录的链接、未登记资源、意外修改和非本机前端来源。GET/HEAD/OPTIONS、单 Range、suffix Range、正确 MIME 均已实现。单次响应最多 256 MiB，Range 只读取选中的片段。Tauri 协议以 `Vec<u8>` 返回响应，因此普通 GET 仍会分配该文件大小的内存；它不是无限大小的 HTTP 流服务。

2 个原生协议测试已通过：合法范围、尾部范围、越界范围、白名单、编码目录穿越、Origin、注销、哈希错误、修改后失效。

## 前端预览

`Tiles3dPreview({ tilesetUrl, title?, onClose?, onReady?, onError? })` 使用产品内 CesiumJS。关闭地球底图、地形、Ion 和搜索；从本机成果 URL 加载所有资源。`onReady` 在 `initialTilesLoaded` 后触发，不能把资源注册成功当成显示完成。

关闭或切换会话时调用 `data_asset_unregister` 回收 token；组件卸载会销毁 viewer、移除事件与 ResizeObserver。成果默认按包围球定位，保留缩放/旋转交互和“定位三维成果”按钮。

## 真实成果验收

Cesium 官方样本固定版本：`a30bfdf2d6cc55f4c3078e8aea3a793af6ebfd56`。真实下载目录位于 `artifacts/desktop-parity/`：

| 目录 | 实际成果 |
| --- | --- |
| tiles3d-request-volume-20261002 | 8 文件，5,581,561 字节；外部 tileset、5 b3dm、1 pnts |
| tiles3d-multiple-contents-20261002 | 3 文件，380,830 字节；同一节点的两个 GLB |
| tiles3d-implicit-quad-20261002 | 33 文件，50,109 字节；稀疏四叉树展开 |
| tiles3d-implicit-oct-20261002 | 32 文件，66,956 字节；稀疏八叉树展开 |
| tiles3d-region-subset-20261002 | 3 文件，10,528 字节；对已下载官方 RequestVolume 样本通过本机 HTTP 应用 AOI 后，只请求选中的一个 b3dm |

公开 URL 的第五次验证遇到系统代理 TLS 握手失败，因此最后一项是官方真实文件的本机回放裁选；没有把它记成再次从公网完整下载。

`crates/geod-tiles3d/examples/preview-acceptance.mjs` 用生产 React 组件和独立无头 Edge 读取前四套成果。所有非 loopback 请求都被拦截；四套均 `initialTilesLoaded`，没有远程请求、没有 JS 异常。截图已逐张检查，模型实际可见。

证据：

- `docs/implementation/evidence/tiles3d-preview-acceptance-2026-10-02.json`
- 同目录四个 `tiles3d-*-20261002-preview.png`
- 各成果目录的 `manifest.json` 和完整资源

执行过的检查：

```text
rtk cargo test --manifest-path crates/geod-tiles3d/Cargo.toml
8 passed
rtk cargo test --manifest-path apps/geod-agent-desktop/src-tauri/Cargo.toml data_asset_protocol --lib
2 passed
rtk npm run build
TypeScript + Vite passed（首次组件接入检查）
rtk proxy node crates/geod-tiles3d/examples/preview-acceptance.mjs
4 official sample previews passed
```

## 主应用集成验收

上述证据证明下载 crate、离线引用和实际预览组件。AI 工具的可发现性、账号/会话归属、后台任务持久化、取消入口、原生资源协议注册和会话切换时的回收，由 `data_jobs.rs` 与主应用集成继续验收。此文不将独立样本通过等同于这些主流程全部完成。

来源与独立性记录见 `crates/geod-tiles3d/PROVENANCE.md`。

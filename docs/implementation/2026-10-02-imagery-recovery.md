# 影像恢复、缓存成果与 GCJ 图源验收

## 恢复任务

`imagery_recovery_plan` 接收当前 `conversationId`、原 `jobId`、`mode` 和幂等 `executionId`。

- `retryMissing`：复制原范围、级别、格式和注记到新计划，`reuseVerifiedCache=true`。即使共享缓存超过通常的 7 天更新周期，也复用哈希、字节数、图像尺寸均正确的旧瓦片，只重新请求缺失或损坏的瓦片。
- `exportAvailable`：`cacheOnly=true`，使用已核验缓存导出，任何瓦片都不请求网络。缺失覆盖明确列入成果质量及缺失计数。
- 两种模式均生成当前工作区内新的直属输出目录，不改变原 job、plan 或成果文件。新计划沿用既有逐次确认 / 完全访问启动流程，规划命令不启动后台执行。
- 图源 fingerprint 与所有注记 revision 必须仍与原计划一致，防止复用不同配置、Token 版本、坐标处理方式或注记组合的缓存。

## 归属

原生 `imagery_plan_owners` 表保存当前账号、会话、工作区和 plan 的不可转移绑定。原 job 通过 plan 继承归属。新计划由 `plans_create` 原生写入后绑定。

历史计划使用 `imagery_plans_claim` 从当前账号保存的聊天 plan IDs 迁移。命令要求该账号会话已经保存工作区，逐项校验原输出目录的真实父目录；不覆盖任何已有归属。返回 `bound` 和逐项 `rejected`，供 UI 呈现无法绑定的任务。

定时任务每次创建的新计划也绑定该定时任务的 native account/conversation；旧 native 定时执行记录据此迁移。

## 自动化验证

- `imagery_recovery::tests`：5 项通过。覆盖旧成果保持、范围格式复制、两种恢复模式、计划幂等、四线程同请求、账号/会话/工作区隔离、活动 worker 拒绝、图源及注记 revision 变化拒绝、当前确认模式。
- `parallel_imagery::export_available_uses_no_network_and_recovery_fetches_only_missing_even_after_cache_expiry`：使用 32 瓦片本地 HTTP 服务，下载 5 张后暂停，将缓存时间置为 2020。缓存导出 0 请求并报告 27 空缺；恢复仅请求 27 张，旧 5 张的时间戳不刷新。另损坏一个内容寻址 blob，恢复只请求 1 张并原子替换损坏文件，再开独立 job 验证 0 请求复用。
- `test/imagery-recovery-native.mjs` 真实桌面验收通过：Esri 实际下载、独立缓存成果、确认模式下的新补漏任务全部完成；并发请求得到同一计划，旧成果哈希保持，跨会话及修改图源后的恢复请求被拒绝。证据：`evidence/imagery-recovery-native-2026-10-02.json`。

## 高德坐标处理真实验证

`crates/geod-core/examples/export_gcj.rs` 从四个配置子域的高德公开道路瓦片服务下载北京王府井范围的 6 张 Z17 瓦片，输出 GeoTIFF、PNG、MBTiles 和预览，成果缺失计数 0。

`scripts/verify-gcj-export.py` 用独立 GDAL/rasterio 读 GeoTIFF 的地理变换，抽取 9 个输出像素对应的 WGS84 坐标，以独立 Python GCJ 正变换和双线性采样重新读取 5 张实际高德源瓦片。9 个样本通道差均为 0；MBTiles 抽样同样匹配配准后的像素，PNG 与 GeoTIFF 完全相同。

证据：`evidence/gcj-source-export-2026-10-02.json`；真实成果：`artifacts/desktop-parity/gcj-direct-20261002-recovery`。已查看实际 PNG。独立核心下载例程经本机已失效代理时请求失败，明确选择直连后成功；此例程未更改应用网络设置。这是公开坐标转换配准验收，不是测绘精度认证。

## Wayback 历史瓦片重定向

实际服务对重复历史瓦片返回同源 301，原下载器禁用所有跳转，导致可用瓦片被当作下载失败。核心下载器现接受最多 5 次同源跳转，保留原图源凭据绑定；跨域、降级协议、不同端口及内嵌用户信息均拒绝。401/403 直接返回凭据错误，不继续跟随响应中的 Location。

`tile_redirects` 的 4 项本地 HTTP 集成测试通过：真实图像解码、同源 query token 去重、跨源 302 的 query/bearer token 零目标请求、401 零目标请求、有限循环请求。

Wayback 返回可下载参数时选用官方生产域名 `wayback-a.maptiles.arcgis.com`，保留 `catalogTileUrl`。此域名由 [Esri 官方 wayback-core 配置](https://github.com/Esri/wayback-core/blob/main/src/config/index.ts)列于生产域名集合。历史目录发布日期与区域拍摄日期分别提供，增量范围按元数据比对，不声称像素变化检测。

## Wayback 最终原生验收

更新后的桌面开发版、真实账号、原生 IPC 与实际 Esri 服务闭环通过：`test/wayback-native.mjs`。

- 发现 196 个版本；目录最新发布日期为 **2026-08-05**，测试北京区域的影像拍摄日期为 **2026-01-26**（Vivid Advanced，元数据标注 0.34 米）。二者没有混用。
- 比较 2014-02-20 与 2026-08-05，生成并持久绑定更新范围。旧版在该范围没有拍摄元数据，未知覆盖比例接近 100%，因此保守保留全范围；这次成功并不证明能从此例中排除未变化像素。
- 从持久边界创建 Z15 计划，实际请求历史瓦片，经同源跳转下载 4 张，生成完整 GeoTIFF、预览及原始边界。缺失瓦片 0，文件清单与哈希检查通过。
- GeoTIFF 为 EPSG:3857、234×305；桌面原生栅格读取返回有效像素；已查看保存的真实预览图。
- 证据：`evidence/wayback-native-2026-10-02.json`，job `ae4e5e4c-498e-4db6-bed9-f016bef97755`。测试全程通过 IPC，没有导航或刷新用户界面。

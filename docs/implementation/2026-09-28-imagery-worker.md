# 本机影像执行切片

日期：2026-09-28。状态：经批准作业可以从受控合成 XYZ 服务取得影像瓦片，导出 GeoTIFF、MBTiles 和 manifest，重新检查后记为完成。尚未通过第三方真实图源、桌面界面、账号或模型验收。

## 已验证的链路

`TaskStore::run_job` 只接受账本里已批准并排队的作业。它重算当前图源与计划指纹，校验端点 ID、署名、许可、瓦片大小、坐标方案和配置修订。作业状态从 `queued` 进入 `downloading`；本机 `geod-core::imagery` 逐张取瓦片并校验 HTTP 状态、响应类型、16 MiB 单瓦片上限和 256/512 像素尺寸。图源响应不经 GeoD 模型服务。

GeoTIFF 带 EPSG:3857 的像素尺度与地理定位标签；MBTiles 写入 TMS 行号和 PNG 瓦片。所有成果在输出目录同级临时目录中生成，manifest 最后写入，同卷目录重命名后整体可见。已有目标目录会在请求图源前被拒绝。`run_job` 在发布后重新打开成果核对大小、哈希、TIFF 尺寸和 MBTiles 完整性，再把账本状态推进到 `completed`。失败保存错误码且不发布成果目录。

合成 HTTP 测试使用 `127.0.0.1` 的两张自生成瓦片，核对请求数、GeoTIFF 像素和投影标签、MBTiles TMS 行号、manifest 哈希、已有文件保护和损坏发现。另有 512 像素 TMS 图源贯通取瓦片、导出及重新检查。它证明本机执行链能运行，不证明第三方图源许可、实际下载性能或发行条件。

## 当前边界

- 本切片只支持矩形范围对应的完整瓦片格网；尚未对导出影像做精确边界或多边形裁剪。
- 下载目前顺序执行，遇到缺瓦片直接失败；来源级并发、429 退避、暂停/取消、检查点恢复与部分成果仍待实现。进程在发布前崩溃时可能遗留临时目录；账本可以根据已发布且可检查的成果恢复终态，未发布的瓦片需要重新获取。
- 首版端点模板必须不含 URL 查询参数或内嵌凭据。公共源需 HTTPS，标准 OSM 瓦片服务被拒；HTTP 仅留给用户明确登记的可信来源。公开域名的 DNS 解析与私网地址防护还需在接入通用用户图源前加固。
- 计划总 RGBA 解码预算上限为 512 MiB；这不是实际峰值内存、网络流量或磁盘大小的保证。大范围流式导出与磁盘预检待实现。
- manifest 采用旧 CLI 可读的 `schemaVersion=1.0`、`kind=geod-bundle` 字段形状，但跨产品读取还需独立兼容样本验收。

验证命令：

```powershell
rtk cargo test --manifest-path crates/geod-core/Cargo.toml
rtk cargo test --manifest-path crates/geod-task-engine/Cargo.toml
rtk cargo clippy --manifest-path crates/geod-core/Cargo.toml --all-targets -- -D warnings
rtk cargo clippy --manifest-path crates/geod-task-engine/Cargo.toml --all-targets -- -D warnings
```

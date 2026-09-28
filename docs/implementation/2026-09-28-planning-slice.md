# 首个实现切片：本地影像计划

日期：2026-09-28。状态：已在本仓库实现并通过本地测试；尚无下载、审批账本、桌面界面、托管模型或安装包。

## 已有能力

- `geod-core` 独立计算 Web Mercator XYZ 瓦片格网。输入为 WGS84 `[west,south,east,north]`，输出每级的瓦片范围、瓦片数、像素尺寸和完整格网足迹。256/512 像素图源分别计算资源量；不分配瓦片数组。
- `geod-task-engine` 接收严格的 `TaskSpec 0.1` 和来自可信本地图源仓库的 `SourceDescriptor 0.1`。它拒绝未知字段、无批量下载许可、越界等级、无效范围、非绝对输出目录和超限计划；规范化坐标到 8 位小数、等级与格式的顺序。
- `Plan 0.1` 给出格网、瓦片总数、RGBA 解码字节上限、来源与许可、来源指纹、有效期和 SHA-256 `planHash`。这里的字节数不代表网络流量、磁盘用量或真实峰值内存；这些需要处理实现和样本测量。
- `contracts/0.1` 保存从 Rust 类型生成的 JSON Schema 和合成样本。`examples/plan.rs` 是开发验证入口，不是供最终用户安装的 CLI。

JSON Schema 描述结构；范围顺序、图源许可和资源预算以 Rust 计划器的校验结果为准。计划输出含本机目录，供本地界面使用；以后传给模型的工具结果必须裁剪掉绝对路径和图源敏感信息。

## 基线与来源

- 对照上游 `geo-downloader` 固定提交 `0938626` 的 `src-tauri/src/tile.rs` 与 `crates/geod-core/tests/pipeline.rs`。本仓库的 `crates/geod-core/src/tile.rs` 独立整理了相同的经纬度到 XYZ 公式与**边界包含式**格网行为，不引用上游目录或其运行时。
- 上游两个 tile 测试边界 `[-1,1,1,2]`、z1、256 像素对应 `x=0..1, y=0`、2 张瓦片、512×256 输出、格网足迹 `[-180,0,180,85.0511287798066]`。这些数值已作为本仓库测试断言。合成图源不会触网，不代表任何第三方图源许可或真实下载通过。
- 上游许可为 MIT（`geo-downloader/LICENSE`），本仓库保留其版权与 MIT 文本。本切片未复制上游的下载器、拼接器、导出器或 manifest 代码。
- 老 GeoD 仓库工作树在实施时有未提交改动；只读取固定提交的文件。本仓库没有对老 GeoD、GeoD Global 或发布渠道做改动。

## 本地复现

在 `G:\code\geod-agent`：

```powershell
rtk cargo test --manifest-path crates/geod-core/Cargo.toml
rtk cargo test --manifest-path crates/geod-task-engine/Cargo.toml
rtk cargo run --quiet --manifest-path crates/geod-task-engine/Cargo.toml --example plan -- contracts/0.1/fixtures/legacy-grid-task.json contracts/0.1/fixtures/synthetic-source.json
```

`outputDirectory` 仅参与校验和计划哈希，当前演示不会创建目录或下载文件。应用服务以后必须从本地图源仓库读取 `SourceDescriptor`，不能接受模型提交的 `bulkDownloadAllowed` 或 `configRevision` 作为权限事实；图源配置变化时必须更新修订号。批准和启动作业还需在本地账本中重新检查计划哈希、来源版本及过期时间。

## 下一步接口工作

1. 为本地来源仓库建立模板、授权、凭据引用和修订管理，并把源 URL/密钥隔离在模型上下文之外。
2. 加入 SQLite 计划、审批、作业与事件账本；批准与幂等启动在同一事务中核验，不能由模型文字代替。
3. 迁入并独立验证图源获取、拼接、裁剪、GeoTIFF/离线包与 manifest，再用有批量下载许可的真实样本验收。仅本地合成测试不作为上线证据。
4. 接入桌面界面、GeoD 身份和托管模型；单独验证 `tool_call → tool_result → final` 与服务端用量结算。

# AreaCity 本地边界快照

来源：https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov

固定 release：`2025.251231.260403`，采集于 2026-04-03。完整来源与 SHA-256 见 `manifest.json`。

- `regions.json`：3,635 条名称、父级、层级和几何偏移索引。
- `geometry.bin`：每个几何独立 gzip 压缩，保留原始多地块和孔洞。用 1e8 精度整数、zigzag LEB128 差分编码经纬度，与裁剪引擎八位小数精度一致，没有形状简化。
- 原始坐标为 GCJ-02。原生查询只解压所选区域，迭代转换至 WGS84 后附到当前对话。
- 378 条区域记录没有几何；和康县、和安县是上游明确列出的版本缺失。
- 这些文件编译进桌面程序，查询不需要 GitHub、网络、Python、7-Zip 或外部服务，也不依赖开发机器的路径。

## 重建与后续更新

从对应 GitHub Release 下载 `ok_geo.csv.7z`，用 7-Zip 解压后，在仓库根目录执行：

```powershell
python -X utf8 scripts/prepare-boundary-library.py --input C:\path\ok_geo.csv --archive C:\path\ok_geo.csv.7z
```

生成脚本校验固定发布包 SHA-256，再解析 CSV 生成上述索引、几何和 manifest。原始发布包不包含在应用里，不执行任何上游脚本。

更新时先核对上游 release 的数据采集日期和已知缺失，在生成脚本中更新固定版本、日期和验证过的 SHA-256；保留上一版快照记录，生成新快照后运行 `cargo test online_boundary --lib` 验证全部非空边界及实际遮罩，再进入应用版本。仓库推送日期和本机获取日期不充当数据采集日期。

仓库许可证为 MIT，Copyright (c) 2019 xiangyuecn。见应用 `THIRD_PARTY_NOTICES.md`。

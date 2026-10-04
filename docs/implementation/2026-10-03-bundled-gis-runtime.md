# 内置 GIS 运行环境

本地候选已把数据导入、在线矢量导出和内置 GDAL MCP 的运行环境随应用打包。用户运行应用时不需要安装 Python、uv、GDAL 或从网络临时下载包；开发和制作发行包仍需要相应构建工具。

## 实际组成

- Windows x64 CPython 3.13.11 官方嵌入包，按官方 Sigstore 中的 SHA-256 校验下载。
- `gdal-mcp` 1.1.3 及其已验收的依赖，精确版本和下载哈希记录在 `vendor/gdal-runtime-1.1.3.lock`。
- 实测 GDAL 版本为 3.12.4。运行目录中的包许可和 Python 许可均保留，应用第三方声明列出运行环境。
- 使用应用资源中的 `python.exe -I -X utf8`。工作进程清理继承环境，只保留必要 Windows 变量，搜索路径由内置 `_pth` 文件限定。
- 源码准备脚本为 `scripts/prepare-gdal-runtime.py`；开发启动和制作发行包都会检查准备结果。资源有逐文件校验清单，构建过程发现不一致时重新准备。

## 实际验收

证据：`artifacts/bundled-gdal-20261003-final/acceptance.json`，4 项通过。

1. 将完整运行目录复制到另一位置，PATH 仅保留 Windows System32，设置不可用的系统 Python 路径；实际读取 GeoJSON、写出 GeoPackage，解释器搜索路径均位于复制后的目录内。
2. 实际桌面 native 导入 GeoPackage，读取正确的面和经纬度范围。
3. 独立后台使用内置运行环境导出 GeoJSON / GeoPackage，并由本机成果核验器读取和校验。
4. 实际内置 GDAL MCP 从内置 Python 启动，调用其真实 `vector_info` 工具读取 GeoPackage。

这证明运行环境可迁移、实际链路不依赖开发机 Python。它不代替全新 Windows 虚拟机上的安装、WebView2 和升级验收；这些纳入发行候选的后续验证。

## 体积

当前完整运行目录约 449 MiB，包含 GIS 原生库、包数据和许可文件。先交付完整已验证环境，后续按真实功能使用情况裁减；不能仅删除看似未用的原生 DLL 来缩小安装包。

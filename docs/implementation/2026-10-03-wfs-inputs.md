# WFS 在线输入候选与实际验收

当前为独立 GeoD Agent 本地开发候选，未发布线上服务。

## 实际接入

- 读取 WFS 1.0.0、1.1.0、2.0.0 的能力目录，保留原服务图层名、标题、输出格式、声明坐标系和范围。
- 指定实际图层后读取 DescribeFeatureType 字段；可复用本机保存的在线连接，请求头和网址中的认证参数由本机凭据库提供。
- GeoJSON、GML2、GML3、GML3.2 分页合并，核对数量、重复 ID、后续页查询条件和地址。服务返回错误或无法证明完整性时返回具体错误。
- WFS 1.1 / 2.0 用 hits 核对总量。WFS 1.0 没有标准 hits / startIndex 保证；已验证 GeoServer 的分页扩展，能力目录会明确标注它不属于标准分页。
- 支持 WGS84 查询范围的协议轴顺序及原数据坐标系转换；保留多面与内环。Content-Crs 可声明返回坐标系，响应头与正文相互矛盾时拒绝读取。
- 请求图层、服务标题与暂存文件中的内部图层名分开记录。通过 handle 重新读取会保留原服务身份。
- 桌面和后台共享的连接配置使用跨进程锁和原子替换，避免并发覆盖或读到半份记录。

## 实际证据

`artifacts/wfs-inputs-20261003/acceptance.json`：19 项通过。数据来自现有 Docker GeoServer + PostGIS：三个协议版本的能力目录和字段、三页筛选读取、范围轴顺序、EPSG:3857 转换、三种 GML、MultiPolygon、10,001 要素数量上限、图层错误均经实际 native 调用验证。Content-Crs 两项使用明确标记的本机响应夹具，几何来自真实 GeoServer，未声称是外部私有服务。

`artifacts/wfs-inputs-20261003/ai-acceptance.json`：真实 Codex 与托管模型通过产品对话发现并读取 WFS，原图层名 geod:boundary 保留，原始坐标系 EPSG:4326，范围 [116.1, 39.6, 116.3, 39.8]、1 个面保存到当前会话。完整实际消息和工具记录见同目录 `actual-ai-conversation.json`。

并发连接记录测试：`connection_registry::tests::concurrent_updates_do_not_lose_connections`，8 个并发写入均保留。

服务限制为当前输入规模：10,000 要素、合计 32 MiB、最多 200 次请求；这是范围输入候选的容量，未声称无限原始数据批量导出。私有在线服务的完整成果导出、外部生产服务差异继续列入待验收清单。

## 协议依据

[GeoServer WFS 请求参考](https://docs.geoserver.org/stable/en/user/services/wfs/reference/)、[坐标轴顺序](https://docs.geoserver.org/stable/en/user/services/wfs/axis_order/)、[输出格式](https://docs.geoserver.org/main/en/user/services/wfs/outputformats/)。

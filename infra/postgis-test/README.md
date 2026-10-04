# GeoD 本地 Docker PostGIS 测试库

使用 PostGIS 项目维护的 `postgis/postgis:18-3.6`，镜像固定到已拉取的 digest。独立容器和数据卷；不使用现有业务数据库。

```powershell
rtk proxy uvx --from gdal-mcp==1.1.3 --with "psycopg[binary]==3.2.12" python -X utf8 scripts/docker-postgis-test.py
```

- 地址：`127.0.0.1:55438`
- 数据库：`geod_test`
- 应用连接账号：`geod_reader`，只读
- 已保存到 GeoD Agent：**Docker PostGIS 测试库**
- 密码：本目录 `.secrets/`，已被 Git 忽略；桌面连接密码另存 Windows 凭据库
- 数据：命名卷 `geod-agent-postgis-test-data`
- 容器：`geod-agent-postgis-test`

推荐选择 `demo.boundaries_3857.geom`，可测试投影转换与孔洞；`demo.multiple_regions.geom` 可测试多个面。`demo.big_area`、`invalid_area`、`points`、`unknown_crs`、`empty_area` 专门验证错误反馈，不是可下载范围。

## GeoServer / WFS

可选 `online` profile 使用官方 GeoServer 2.28.2 镜像，连接同一只读 PostGIS 样例库。首次启动会创建 `geod` 工作区和三个测试图层。

```powershell
rtk proxy python -X utf8 scripts/docker-geoserver-test.py
```

- 地址：`http://127.0.0.1:18083/geoserver`
- 容器：`geod-agent-geoserver-test`
- 数据卷：`geod-agent-geoserver-test-data`
- 图层：`geod:boundary`（带孔洞的面）、`geod:regions`（多面）、`geod:many_regions`（分页/过量要素错误用例）
- 后台管理账号：`geod_admin`，密码在 `.secrets/geoserver-password.txt`；WFS 样例读取不要求登录

在 GeoD 的 **＋ → 添加数据范围 → 在线数据** 粘贴以下地址：

```text
http://127.0.0.1:18083/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=geod:boundary&outputFormat=application/json&srsName=EPSG:4326
```

原生 WFS 测试（同样需要开发桌面和 1421 测试代理）：

```powershell
rtk proxy python -X utf8 scripts/test-docker-wfs.py
```

停止 GeoServer 并保留数据：

```powershell
rtk proxy python -X utf8 scripts/docker-geoserver-test.py --stop
```

## 原生测试

先运行开发桌面，再启动原生 IPC 测试代理：

```powershell
rtk proxy node apps/geod-agent-desktop/test/openlayers-native-rpc.mjs
rtk proxy uvx --from gdal-mcp==1.1.3 --with "psycopg[binary]==3.2.12" python -X utf8 scripts/test-docker-postgis.py
```

测试保留样例连接，重启本容器验证持久化，并输出不含密码的证据。测试代理仅供开发使用，使用完结束该命令。

## 停止

```powershell
rtk proxy uvx --from gdal-mcp==1.1.3 --with "psycopg[binary]==3.2.12" python -X utf8 scripts/docker-postgis-test.py --stop
```

停止保留数据卷，不提供自动清库命令。再次执行启动命令会复用已有数据和本地测试密码。修改初始化 SQL 不会自动覆盖现有数据。

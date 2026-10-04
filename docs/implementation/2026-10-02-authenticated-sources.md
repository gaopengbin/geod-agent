# 认证图源接入与验收

## 本地实现

- 图源认证支持 URL 查询参数 Token、Bearer Token、自定义请求头。天地图提供 `img_w`、`cia_w`、`vec_w`、`cva_w` 四个 WMTS 预设。矢量底图和注记预设返回渲染瓦片，不代表原始矢量要素下载。
- 图源表单单独填写掩码 Key/Token；粘贴的 URL 认证参数会移入认证字段，保留 WMTS 参数和 XYZ 占位符。可以先保存待填写凭证的连接，列表显示“待填写 Token”。
- Windows 系统凭证存储保存秘密值；SQLite 仅保存认证模式、参数名、来源、引用与版本。IPC 读取图源、计划、成果清单以及 Debug 输出不返回 Token。未填写 Key 的记录使用 `pending` 版本。
- 原生执行前读取凭证，预览、缩略图、地图瓦片、并发下载、续传、定时执行走同一认证请求层。凭证绑定图源与 origin，不跟随重定向；网络错误不附带请求 URL。
- 替换 Token 更新配置版本，使旧计划失效；编辑时留空保留已保存的 Token。匿名图源沿用原配置哈希，不使旧计划普遍失效。
- Creator 和 Codex 工具只传认证模式及参数名，模型不能接收或生成保存的秘密值；模型可配置需认证的连接，再由用户在图源管理填 Key。

## 官方元数据核对

2026-10-02 直接读取[天地图影像 GetCapabilities](https://t0.tianditu.gov.cn/img_w/wmts?request=GetCapabilities&service=wmts)：实际 XML 12,289 bytes，TileMatrixSet `w`，CRS `urn:ogc:def:crs:EPSG::900913`，矩阵 1–18，256 × 256，矩阵 1 的宽高为 2 × 2。预设按标准 Web Mercator XYZ 对应列、行和级别。`_c` 网格未适配，不能按标准 XYZ 错配。

## 已通过的验证

| 范围 | 实际结果 |
| --- | --- |
| Rust 核心与任务引擎 | 原有全部活动测试通过；新增 3 个认证集成测试通过 |
| 桌面前端 | 构建通过，119 个测试通过，1 个已有可选真实模型测试跳过 |
| 网关工具合同 | 10 个现有网关测试通过，桌面 38 个工具快照已同步认证参数 |
| 原生认证 | 三种模式实际读取 PNG，分别生成 4 瓦片 GeoTIFF；错误 Token 返回明确拒绝 |
| 暂停与续传 | Query Token 任务暂停后恢复同一作业并完成 |
| Token 替换 | 配置与凭证版本改变；旧计划返回 PLAN_STALE；新凭证实际预览成功 |
| 待填写连接 | 保存成功；预览及启动返回 SOURCE_CREDENTIAL_REQUIRED，不创建下载作业 |
| 定时任务 | Header Token 连接实际触发并生成通过核验的成果 |
| 重启 | 三种已保存凭证在桌面重启后实际预览成功；天地图待填写连接保留 |
| 真实模型 | Bundled Codex 经模型请求、发现 Creator、读取 Skill、检查服务、配置图源、读取列表，保存 `tianditu-cia-w`，明确等待用户 Key；未下载 |
| UI | 原生 API 验收页验证预设选择、缺 Key 提示、保存、重新编辑；浅色/深色检查，480 px 窗口无横向溢出，密码输入使用掩码 |

证据：

- `evidence/authenticated-sources-native-2026-10-02.json`
- `evidence/source-auth-real-model-2026-10-02.json`
- `evidence/tianditu-auth-form-light-2026-10-02.jpg`

这轮创建的 8 个合成测试图源、12 个测试计划、7 个作业和 1 个定时任务已清理，测试凭证通过原生保存生命周期移除。用户已有图源及本轮天地图影像、影像注记连接保留。桌面开发模式继续运行；未安装或发布新版本。

## 用户凭证真实验收（2026-10-02）

用户随后提供自己的 Key，已通过原生保存到本机凭据库。第一枚为浏览器端类型，官方返回 301012；用户提供服务端 Key 后，影像和注记均实际返回图像。

实测还发现天地图返回 image/jpg，已补齐 MIME 兼容，仍检查图片解码、尺寸与大小。JPEG 真图与伪 JPEG 拒绝测试通过。

原生实际下载北京小范围 Z15，合成天地图影像与影像注记；3 张瓦片、缺失 0，生成 EPSG:3857 GeoTIFF，234×305 像素，文件哈希及地图栅格读回通过。用户 Key 未写入代码或验收文件，图源编辑留空会保留已保存 Key。

证据：`evidence/tianditu-user-native-2026-10-02.json`；作业 73ec758b-ccc5-4213-aabd-dadb04bf7c52。

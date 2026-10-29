# 默认诊断修正发布（2026-10-29）

已发布 GeoD Agent 0.2.16 与 GeoD 3.6.22。当前开发版同为 0.2.16，已重启并通过实际 Native IPC 核对三个开关均开启。

- Agent: https://github.com/gaopengbin/geod-agent/releases/tag/v0.2.16
- GeoD: https://github.com/gaopengbin/geo-downloader/releases/tag/v3.6.22
- Agent 源提交：c6990bdb7e0232dac0f1969de4c84a4cf8680abc。
- GeoD 桌面源提交：2878160f780d5160309240ce331e294a8eb0d841。

默认开启最小故障诊断及基础使用统计，首次明确告知，可随时关闭；告知确认不作为开启门槛。修复旧下载和使用统计界面将缺失选择自动写成 false 的迁移问题，保留明确关闭标记，旧隐式关闭按新版默认迁移并显示当前开关。

Agent 延续已在 0.2.15 发布的分盘预算与 Windows 长缓存路径修复。旧版新增批量前逐层访问核验、明确拒绝时的图层反馈和样本缓存复用，并修正无关图源默认携带 Google Referer。客户原始手动注记及网络未取得，未把 12 组本机返回 200 的高德对照或受控 403 当作原问题已复现、根治。

## 实际验收

- Agent Native 228 项通过，24 项显式跳过；引擎/核心及前端检查通过。受控 403、默认无点击上报和明确关闭不发送分别验证。
- 测试账号实际产生 3 个下载终态与 3 条基础事件，线上入库、内部排除通过；使用真实 C/G 两个文件系统，未假冒客户 E 盘环境。
- GeoD Native 209 项通过，4 项显式跳过；首次访问层拒绝时的请求计数与恢复复用得到核验。真实高德瓦片支持透明注记，叠加瓦片实际 Alpha 范围 0–255。
- GeoD 生命周期生产器按默认开启状态发送 4 条测试事件，服务确认接收，生产仪表盘排除该安装 ID。
- 应用告知覆盖默认启用、确认不改变开关、明确关闭跨刷新保留、旧记录迁移、账号隔离、中文/英文窄屏暗色布局。隔离 UI 没有发送生产统计。
- Agent 签名、载荷与更新 SDK 9 项兼容检查通过。GeoD Windows/macOS Intel/macOS ARM/Linux 构建和汇总发布作业全部成功，4 份 Actions 归档 SHA-256 与 5 个 Release 附件 digest 匹配，Windows 内嵌版本 3.6.22。
- 正式更新源、CDN 小清单与 GitHub latest 均核验。消息通知分别覆盖旧版，当前版本不重复提示，已撤回被新公告替代的旧更新通知。
- 中英文官网说明已同步，改动范围以静态叠加与其他页面字节校验约束。未修改模型路线、额度或账本；没有回下载收费 CDN 完整安装包。

## 限制与证据

没有物理安装验收，没有客户移动 E 盘的同机测试，也没有重跑其 40,200 瓦片整任务。主动关闭、离线及未上报的数据仍保持未知。首次观测不作为首次安装。

证据：artifacts/default-diagnostics-20261029/final-public-verification.json、online-default-acceptance.json、legacy-exclusion-final.json，以及 artifacts/release-036-20261029/flow/journal.json。旧版证据位于其独立工作树 artifacts/geod-3.6.22-release。

更新与公告备份按发布回执保留；回退单个产品时应保留另一产品更新过的页面，不能盲目回退整个网站指针。

# 下载诊断修复发布记录（2026-10-29）

已公开发布 GeoD Agent 0.2.15、旧版 GeoD 3.6.21，接收服务已上线。

- Agent: https://github.com/gaopengbin/geod-agent/releases/tag/v0.2.15
- GeoD: https://github.com/gaopengbin/geo-downloader/releases/tag/v3.6.21
- Agent 桌面源提交：b550dbe127541fd3042d199ff35f47b50dda6f74。
- GeoD 桌面源提交：84a1c2f507e3733a093519407590092c7ee329c9。
- 两边真实高德下载及受控注记 403 均保留 HTTP、图层、阶段、测量时间和空间数据；线上诊断入库核对通过。内部账号和安装 ID 排除已验证。
- Agent 224 项本机测试通过，真实网络测试另行执行；更新 SDK 9 项兼容检查通过。签名、安装包载荷及 6 组运行时检查通过。
- Agent 正式更新源与 CDN 小清单一致；GeoD 国内 update.json 与 GitHub latest 为 3.6.21，5 个附件本地和服务器 SHA-256 核验通过，Windows 内嵌版本为 3.6.21。
- 两种产品分别发布公告。测试账号实际获取 Agent 旧版未读更新消息，当前版本不重复提示；GeoD 公告无需登录，两种产品消息不串用。
- 官网仅叠加本产品页面与哈希静态资源，保留另外 40 份文档，包括 Agent、CLI/MCP 页面。
- 没有完整回下载收费 CDN 的安装包；没有进行物理安装或外接 E 盘环境验收。未把受控 403 当作客户历史故障复现，未上报的历史数据仍未知。

## 构建与人工接续

GeoD 四个平台构建及两个 macOS 签名作业均成功。ARM 首次因构建机 Apple 链接器崩溃而失败，仅补跑该作业一次后成功。汇总发布作业因本次说明文件放在另一目录而失败；没有将该作业写成成功。随后下载并核对 4 份 CI 产物归档的 GitHub SHA-256，提取 5 个安装包，创建草稿并逐项比对 GitHub 附件 digest 后发布，未重新编译。工作流约定的 docs/release-notes/release-notes-v3.6.21.md 已补入后续源码提交，未重写发布标签。

接续发布脚本一并保留说明文件和 Windows 版本检查脚本，子进程失败会返回非零退出码。实际发布结果以 public-verification.json 和最终公开接口回读为准，不以作业提交或健康接口代替业务验收。

## 数据与回滚

接收服务备份：/srv/laogao/backups/geod-diagnostics-20261029。账号测试创建使用官方账号库事务锁及备份，未修改托管模型、路由、额度或账本。含私有数据的本次备份权限已收紧。

GeoD 安装包镜像可回退 /srv/laogao/packages/v3.6.20。Agent 更新清单及此前网站位置保留在发布流水线的 origin 回执中。官网后续叠加了另一产品更新，回滚时必须保留另一产品的页面，不能盲目把整个网站指针退回旧位置。

完整本地证据：artifacts/telemetry-20261029/final-public-verification.json、online-qa-verification.json、artifacts/release-035-20261029/flow/journal.json；旧版证据位于其独立工作树 artifacts/geod-3.6.21-release，包括 manual-assembly.json 和 public-verification.json。

# GeoD Agent 发布流程

正式通道沿用现有签名身份、国内 CDN 和 GitHub 备用下载。发布版本与目标提交以当次清单为准，不能将流程示例当作已经上线的版本。

## 日常发布

1. 完成版本内容、中文和英文官网源码及版本说明。运行改动相关的回归；保留成功构建和测试回执。签名、安装包载荷、类型检查仍是发布要求，不能用“快”替代验证。
2. 使用现有 `build-signed-update-candidate.py` 构建签名候选。签名前设置该版本的 CDN 地址；签名后不修改组件索引地址。**发布工具不再重复编译已经完成的候选包。**
3. 根据下列配置生成发布清单，先查看 dry-run，再执行。首次可停在 `public-files` 本地检查；同一个清单重跑即可继续。

```powershell
rtk python -X utf8 scripts/release_pipeline.py artifacts/release-next/spec.json --recipe artifacts/release-next/recipe.json
rtk python -X utf8 scripts/release_flow.py artifacts/release-next/recipe.json --dry-run
rtk python -X utf8 scripts/release_flow.py artifacts/release-next/recipe.json --until public-files
rtk python -X utf8 scripts/release_flow.py artifacts/release-next/recipe.json
```

配置示例（发布前填入这次已核对的路径、提交、上一版 CDN 小索引 SHA）：

```json
{
  "candidate": "G:/code/geod-agent/artifacts/release-candidate-0.2.6-next",
  "output": "G:/code/geod-agent/artifacts/release-0.2.6-next",
  "publisherPython": "G:/code/geod-agent/artifacts/release-tools/Scripts/python.exe",
  "publicConfig": "G:/code/geod-agent/artifacts/release-0.2.6-next/build-public-config.json",
  "notes": "G:/code/geod-agent/docs/releases/0.2.6.md",
  "target": "<reviewed source commit, 40 hexadecimal characters>",
  "validationReceipts": [
    "G:/code/geod-agent/artifacts/release-0.2.6-next/build/result.json",
    "G:/code/geod-agent/artifacts/release-0.2.6-next/changed-area-validation.json"
  ],
  "websiteBuild": "C:/Users/Administrator/.codex/worktrees/geod-account-profile/tif-downloader/website/out",
  "releaseId": "geod-agent-026-next",
  "previousCdnIndexSha256": "<SHA-256 of the current small CDN latest.json>"
}
```

清单依次执行：证据检查 → 签名 → 实际安装包载荷 → 公开文件白名单 → COS 版本文件 → GitHub 草稿 → 官网准备 → GitHub 正式发布 → 官网与原更新入口 → CDN 小索引 → 两个语言页面与两个小索引。

官网仍从源码构建和预览，不能替换编译后的 React Flight 字符串。可在配置的 `websiteSteps` 数组中加入 `release_flow.py` 的本地步骤格式，把官网构建/预览命令接入流程；不在生产服务器下载 GitHub 文件。官网准备会保存服务器原网站和索引信息，激活使用固定主机密钥的 SCP/SSH 批量上传及远端 SHA-256 检查。

## 减少等待与重复工作

- 本地步骤按命令、输入内容及输出内容校验后复用；任意一项变化即失效。每步记录耗时到 `flow/journal.json`。
- 编译和打包共用 Cargo 产物，顺序执行；不同时跑多个编译或组件打包。
- COS 同时上传两个文件，每个文件两个分块线程；官方 SDK 校验已有分块后续传。已完整上传且大小、SHA 标记、缓存头一致的对象会跳过。
- GitHub 草稿只补齐缺少的附件，核对上传回执的大小和 SHA-256，不重复下载附件。
- 云端步骤每次恢复都检查实际状态，不只依赖旧的成功日志。失败后保留草稿、产物、回执和备份，重新执行原清单。
- 仅必要的小索引和页面进行线上读取；脚本没有完整 CDN 包下载入口。COS 的 SHA 标记是客户端上传的指纹，传输使用 MD5 校验；HEAD 不是远端 SHA-256 内容重算。
- 不按固定次数截断发布、不删除旧文件、不轮换更新签名密钥、不修改用户数据或网关。

## COS 最小权限准备

配置文件：`config/release/cos-publisher-policy.json`。参照 [腾讯云 COS API 授权文档](https://intl.cloud.tencent.com/ind/document/product/436/30580) 和 [禁止覆盖条件键](https://cloud.tencent.cn/document/product/436/71307)。

建议创建专用发布子用户，只开通编程访问、不开放控制台登录，**只绑定该自定义策略**：

- `geod-downloads-1301384002` 的版本目录：HEAD、分块列表和分块上传；对象创建/完成必须带禁止覆盖头。
- 同目录的 `latest.json`：读、HEAD、写，用于备份和切换。
- 只读存储桶版本控制状态，用于确认禁止覆盖机制有效。
- 无大包 GetObject、DeleteObject、ACL、CDN 管理、其他存储桶或账本权限。

安装官方 SDK 到独立工具环境，发布清单中上传步骤使用该环境的 Python（或给发布 Python 安装同版本依赖）：

```powershell
rtk python -m venv artifacts/release-tools
rtk artifacts/release-tools/Scripts/python.exe -m pip install -r config/release/requirements.txt
```

密钥直接在本机输入并保存为当前 Windows 用户/机器的 DPAPI 加密文件，不放入聊天或仓库：

```powershell
rtk powershell -NoProfile -File scripts/Set-CosReleaseCredential.ps1
```

默认私密路径为 `%USERPROFILE%/.codex/secrets/geod-cos-publisher.xml`。也支持临时 `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_SESSION_TOKEN`，不要将其写入发布配置或日志。2026-10-14 用户创建专用凭据后，已在本机加密配置并验证下列真实接口。发布清单优先使用已安装官方 SDK 的独立工具环境。

## 切换、恢复与回滚

GitHub、COS 和网站不能合成一个跨服务事务。流程先确认不可变文件，再公开 GitHub 和切换指针；中途失败保留清楚的步骤记录，通过重跑继续完成。

线上同时只允许一个发布者；本地全局发布锁和服务器激活锁防止重入。其他机器/CI 也必须串行（CI concurrency 禁止取消正在发布的任务）。COS 索引更新是单对象写入，检查原 SHA 并先备份；不宣称它与网站/GitHub 跨系统原子切换。

服务器回滚：运行对应 staging 中的 `release_activate.py --stage <this stage> --rollback`，先核对当前指针仍属于本次发布。CDN 回滚另行使用已保留的小索引、先核对当前 SHA，不自动回滚他人后续发布。

旧控制台上传对象没有 SHA 元数据时，脚本会保留并停止；不能仅凭文件大小相同就跳过，也不能覆盖旧正式版来做自动化测试。

## 验证范围

发布脚本的本地回归包含模拟上传故障、已上传对象复用、文件冲突、索引备份/恢复、超大响应拒绝、流程缓存失效、发布锁和网站隔离切换。模拟测试不能替代 COS 真实权限测试；没有上传凭据时，只执行本地步骤和 dry-run，不能报告线上自动上传成功。

2026-10-14 本地验收：23 项回归与官方 SDK 1.9.44 禁止覆盖请求头检查通过；0.2.5 真实产物通过 9 个签名、13,318 个运行时载荷文件和 21 个公开文件核验，第二次执行复用了签名/载荷/文件准备步骤。Windows 无符号链接权限时，测试仅模拟指针适配层，归档、哈希、备份、失败恢复和文件隔离执行在真实临时文件上。生产 Linux 新激活流程尚未实跑。

随后完成 COS 真实验收：DPAPI 凭据读取、存储桶版本状态、正式小索引 HEAD/读取、77 字节简单上传、已上传文件复用、约 2 MiB 分块上传及 HEAD 验证均通过；重复覆盖被 COS 以 409 拒绝，测试文件 GetObject 被权限策略以 403 拒绝。仅在 `agent-updates/windows-x86_64/0.0.0/` 保留两个带随机标识的测试对象，未申请删除权限；正式安装包和更新索引未改动，CDN 大包下载为 0。回执位于 `artifacts/release-flow-qa/{credential-check,cos-live-probe,cos-scope-check}.json`，不包含密钥。

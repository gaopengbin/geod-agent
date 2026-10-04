# 在线插件目录与本机安装验收

日期：2026-10-04。开发模式运行，没有重新安装桌面程序、发布服务或改变真实模型回答。

## 已完成

- 内置 OpenAI 官方与社区插件目录。原生读取真实 GitHub 目录，固定到提交版本；本次官方目录 65 个条目、社区目录 4 个条目。数量代表目录内容，不代表全部组件已经兼容。
- 支持添加公开 GitHub 仓库及指定版本，搜索名称、作者及描述，刷新目录、检查包、仅添加或添加并启用、停用和移除。当前为 GitHub 公开来源；私有仓库及其他托管服务未接入。
- 添加前展示来源提交、Skill、MCP 定义与资源摘要。获取和检查不执行插件脚本。安装时重新检查内容 SHA-256；修改过的预览不能沿用原摘要安装。
- 下载资源保存在账号隔离的应用缓存中。取消和成功安装清理对应预览；安装包保存在独立目录，不依赖下载源目录或用户 Codex 配置。
- Skill 名称保留插件前缀；过长名称使用稳定摘要避免冲突。共享脚本目录通过原生 Skill 读取及 Codex 导出公开给实际模型。
- 完整记录备份包含安装包资源。此前只保留扩展配置、遗漏插件共享脚本的问题已修复。

## 实际验收

| 验收 | 结果 |
| --- | --- |
| 原生与界面 | 9 项通过；实际读取两份目录、拒绝不支持组件、篡改后安装拒绝、中文暗色/英文浅色 1000×720 预览、添加并启用、指定提交目录。 |
| 真实 AI | 3 项通过；原生读取实际资源目录，真实 Codex 0.159.2 / DeepSeek 前台与独立后台定时执行 ReviewOps 样例。 |
| 重启与备份 | 4 项通过；91 个插件资源原文件与实际备份 SHA-256 全部一致，真实程序退出重启后启用状态、资源及目录提交保留。 |
| 原生自动检查 | 插件 6 项及备份 2 项通过。 |
| 用户记录 | 仅移除验收创建的插件和自定义目录，关闭验收定时任务。原有 30 个会话内容摘要保持一致。 |

真实模型两次执行的是社区插件自带的合成样例，返回 `portable-core` 与 `best-system` 各 80 条接受、0 条拒绝、0 条重复；它不是 GeoD 产品运营数据。实际工具输出、模型回答与后台事件单独保留。

验收脚本最初把后台账本的 `succeeded` 误写成 Codex 结果的 `completed`，已依据实际账本修正，并读取保留结果完成检查，没有重复付费模型请求。

## 证据

位于 `artifacts/product-gaps-20261004/plugin-marketplaces/`：

- `native-result.json`、`model-result.json`、`recovery-result.json`。
- `actual-official-catalog.json`、`actual-community-catalog.json`。
- `actual-model-chat.json`、`actual-background-model.json`、`independent-fixture-result.json`。
- 暗色/英文浅色目录与预览截图；真实模型执行截图。
- `restart-state.json` 保存验收资源、原状态及备份路径用于追溯。验收插件已移除，完整备份仍保留。

社区来源提交：`62844ca1cd865b76c7fed7180fc1ffef16e9167b`。

## 继续补齐

Hook、注册 App 映射及部分 MCP 扩展字段尚未接入；此类插件在检查时明确返回兼容错误。在线目录没有自动更新已安装插件，变更版本需检查并替换旧包。目录的安装范围和账号授权分别验收。

来源：[OpenAI 插件规范](https://developers.openai.com/plugins/build/plugins)、[官方目录](https://github.com/openai/plugins)、[社区目录](https://github.com/openai/community-plugins)。

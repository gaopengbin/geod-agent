# PostgreSQL / PostGIS 客户端证书

本地候选沿用未修改的 pgEdge PostgreSQL MCP 1.1.0，增加客户端 PEM 证书与未加密 PEM 私钥。支持 require、verify-ca、verify-full；证书与私钥必须成对，保留已有 CA、密码连接和条件筛选。

## 使用与凭据

- 数据输入的数据库表单新增折叠的“双向 TLS”，选择证书与私钥文件后实际测试并保存。
- Agent 复用已保存连接的稳定 ID。用户指定工作区连接 JSON 时，native 也支持 `sslRootCert`、`sslClientCert`、`sslClientKey`，模型不读取该文件。
- 密码仍使用 Windows 凭据库；客户端身份使用 Windows DPAPI 加密保存，绑定 Windows 用户、GeoD 账号目录及连接 ID。公开注册表只增加 `clientCertificate` 标记，不保存私钥。
- pgEdge 需要文件路径，每个连接操作创建当前 Windows 用户专属 ACL 的独立临时目录。完成、错误、超时或取消均清理；进程租约阻止并发操作误清理，后续访问清除异常退出遗留的临时目录。
- 测试或保存失败时回滚新证书文件和凭据；移除连接同步移除保存的客户端身份。没有更改已有连接的 ID 或密码格式。

## 实际证据

`artifacts/postgis-mtls-20261003/acceptance.json`：16 项实际 native 验收通过，使用 Docker 的独立 PostGIS，强制客户端证书认证且没有 TCP 密码回退。涵盖 4096 位私钥、真实 pgEdge 发现、属性筛选、面范围读取、错误/缺失/过期证书、私钥不匹配、主机及 CA 验证、慢查询超时清理、实际表单选文件保存、关闭并重开桌面读取。

`cancel-acceptance.json`：实际 MCP 已连接后取消正在执行的查询，所属进程停止且临时私钥文件移除。DPAPI 与进程租约测试也在本机通过。

`ai-acceptance.json`：实际表单配置后，真实 Codex + 托管模型通过数据输入工具找到保存的证书连接，读取 `public.regions.geom` 的真实字段、筛选 `certificate-east`，读到 `score=41`，并保存 1 个面的范围。实际对话与截图已保存，私钥未进入工具结果或对话。

表单明暗模式截图及启用按钮的最终合成色对比度通过：暗色最低 5.17:1，浅色最低 4.97:1。截图等待原有颜色过渡结束，未将过渡中的画面作为最终状态。

当前系统凭据适配面向 Windows；未声称已验证其他操作系统或外部企业数据库的证书部署。Docker 测试服务为 `geod-agent-postgis-mtls-test`、本机端口 55440，不改动其他数据库。

## 主要源码

相对 `apps/geod-agent-desktop`：`src-tauri/src/database_tls.rs`、`src-tauri/src/postgis_mcp.rs`、`src-tauri/src/data_inputs.rs`、`src/database-tls-fields.tsx`、`src/data-input-panel.tsx`。开发窗口继续热更新，没有安装或发布。

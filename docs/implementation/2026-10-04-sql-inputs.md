# 通用 SQL 数据库与 Agent 输入

日期：2026-10-04。使用开发桌面及本机独立 Docker 实例验收，没有重新安装或发布线上服务。

## 当前能力

保留已有 PostgreSQL / PostGIS 空间连接，补充通用属性数据库。内置 [Bytebase DBHub](https://github.com/bytebase/dbhub/) 1.4.0，通过真实 stdio MCP 连接数据库。应用包含固定 Node 运行环境、MCP 与驱动，用户不需要安装 Node 或数据库客户端。

| 类型 | 当前接入 | 实际验收 |
| --- | --- | --- |
| SQLite / GeoPackage | 工作区文件、表和字段发现、SQL 读取 | 原生及真实 Codex / DeepSeek 通过 |
| MySQL / MariaDB | 主机、端口、数据库、密码及加密方式 | MySQL 8.4 与 MariaDB 11.8.9，原生及真实 Codex / DeepSeek 通过 |
| SQL Server | 原生驱动、连接表单与 SQL 工具 | SQL Server 2025 RTM-CU9，实际加密连接、原生及真实模型通过 |
| Oracle | Thin 驱动、服务名称及连接表单 | Oracle AI Database Free 23.26.3，原生及真实模型通过 |

入口为对话输入栏的添加数据范围 → 数据库 → 其他数据库，也可以直接让 AI 连接。

Agent 可以使用 sql_connections_list、sql_connection_connect、sql_objects_search 和 sql_query。工具描述及前台与后台合同一致；保存后复用稳定连接编号。普通属性 SQL 连接不自动变成裁剪范围；空间范围继续使用已有 GIS / PostGIS 工具。

## 密码与读取

用户可以提供工作区内的连接 JSON 文件，原生层直接读取并保存凭据；Agent 不通过 shell 或文档工具读取密码。缺少有效密码时，工具等待本机认证表单；用户填写后继续同一轮真实模型流程。

密码进入 Windows 系统凭据库，连接列表及工具结果不返回密码。备份保留连接元数据，凭据继续留在当前设备的系统库。后台任务需要新认证时明确返回 USER_INPUT_REQUIRED。

此连接用于数据输入：MCP 配置开启只读 SQL，查询最多 500 行并返回实际截断标记。大整数超过 JavaScript 精确范围时保留为十进制字符串。表目录返回有限样本，不能据此宣称发现全部数据库内容。

SQLite 的只读约束来自 SQL 工具策略及 query_only；不是文件系统只读句柄。实际源文件哈希保持一致。网络服务的权限仍按所用数据库账号生效。

## 实际验收

- SQLite：6 项原生验收通过。中文文件名、含引号的中文表名、字段发现、分页、64 位整数、制表符/换行、总和及只读拒绝均通过。真实 AI 只通过 SQL 工具读回数据库里的随机标记和实际总和。
- MySQL：8 项原生验收通过。独立 MySQL 8.4 Docker 实例使用中文且含空格的数据库名，使用仅有 SELECT 权限的账号；实际表、字段、中文正文、换行、大整数及总和读取通过。
- MySQL 的真实模型连接、目录发现及查询通过；实际聊天界面弹出密码框，错误密码可重试，正确密码后模型继续读取真实数据。
- 1000×720 下，中文暗色和英文浅色表单、正文滚动与固定操作栏通过，截图已查看。
- 独立后台 AI 定时任务实际查询保存的 MySQL 连接，通过。任务已停用。
- 实际停止并重新启动桌面后，从系统凭据库恢复连接并重新查询数据库，通过。
- 完整原生备份包含 SQL 连接元数据，逐项哈希通过，未包含密码字段。
- 错误分类的 2 项原生测试通过，前端及原生构建通过。
- 验收后已移除本轮连接凭据、独立 Docker 实例与私有连接文件。检查 214,901 个验收及应用文件，未发现本轮密码；运行中的 background.lock 无法读取，报告保留此项。

修复了两项接入问题：Windows SQLite 系统路径前缀与 URL 编码导致读错文件；网络数据库名称被编码后导致选错数据库。当前保持数据库路径的真实 Unicode。认证日志包含 SSL 配置信息时，实际密码错误优先识别为认证错误，避免误报加密失败。

验收控制器曾试图替换已绑定工作区，并在复用真实模型证据后重复删除已清理连接。这些失败记录保留；修正控制器后复用六个已通过的实际用例，完成重启与备份验收，没有重跑已完成的付费模型请求。

## 证据

### 补充的三种实际服务

使用三个独立、仅绑定本机回环地址的 Docker 实例，运行文件来自官方 MariaDB、Microsoft 和 Oracle 镜像。镜像摘要及实际数据库版本保存在 `artifacts/product-gaps-20261004/database-providers/*-fixture.json`。SQL Server 使用 Developer 测试实例；没有向应用捆绑数据库服务。

- MariaDB 5 项、SQL Server 6 项、Oracle 6 项实际验收通过；三种都通过原生 MCP、真实 Codex/DeepSeek 连接与查询，以及独立后台 Agent 读取。
- 表和字段发现、中文城市、制表符/换行、两行求和与 `9223372036854775806` 大整数读回通过；没有通过预先转成文本的 SQL 规避大整数检查。
- 缺少/错误密码产生原生认证请求，工具及日志不返回密码；写入 SQL 明确拒绝。测试读者账号在数据库端也只授予对应测试表/架构的读取权限。
- SQL Server 和 Oracle 的实际聊天均弹出密码窗口，填写后同一轮 AI 继续查询。1000×720 暗色界面截图已查看。
- SQL Server 的 `require` 模式通过实际加密连接，使用实例自签证书并信任服务证书；不等于完成主机或证书链验证。
- 实际关闭并重开桌面后，三个连接从系统凭据库恢复并查询正确；完整备份保存三份连接引用且不含密码。共 5 项收尾检查通过，原有 30 个会话保持一致。

Oracle 测试准备曾遇到 Lite 镜像缺少普通表空间、数据库启动中途开关 PDB，以及 SQLPlus 客户端编码导致测试中文写错。已在独立测试实例中创建表空间，等待完整就绪标记，使用明确的 Unicode 字面量，并通过 Oracle `ASCIISTR` 独立确认测试内容后再做 MCP 验收。没有把这些测试准备错误归因于应用驱动。失败的 Agent 验收记录保留为 `oracle-attempt-*.json`；测试控制器增加结构化错误记录并明确选择托管模型后完成验收。

新增记录：

- `database-providers/mariadb-result.json`、`sqlserver-result.json`、`oracle-result.json`。
- 三份 `*-actual-model.json` 和 `*-actual-background.json`。
- `sqlserver-actual-ui-chat.json`、`oracle-actual-ui-chat.json`。
- `restart-backup-result.json`、`credential-audit.json`。

上述目录相对 `artifacts/product-gaps-20261004`。验收后移除本轮系统凭据、容器及私有配置，保留公开回执。最后扫描 263,458 个验收与应用文件，未发现这三个实例的测试密码；运行中的 `background.lock` 无法读取，此项保留在 `database-providers/credential-audit.json`。

- artifacts/product-gaps-20261004/sql-inputs/native-result.json
- artifacts/product-gaps-20261004/sql-inputs/actual-model-sqlite.json
- artifacts/product-gaps-20261004/sql-inputs/mysql-result.json
- artifacts/product-gaps-20261004/sql-inputs/actual-model-mysql.json
- artifacts/product-gaps-20261004/sql-inputs/actual-ui-mysql-chat.json
- artifacts/product-gaps-20261004/sql-inputs/actual-background-mysql.json
- artifacts/product-gaps-20261004/sql-inputs/mysql-auth-dark-zh.png
- artifacts/product-gaps-20261004/sql-inputs/mysql-auth-light-en.png
- artifacts/product-gaps-20261004/sql-inputs/credential-audit.json

## 继续验收的范围

私有 CA、主机验证及客户端证书已在独立实例补充验收，详见 [通用数据库证书与双向 TLS](2026-10-04-sql-tls.md)。SQL Server 已增加完整证书/主机验证模式及下面的显式 NTLM 域账号；当前不提供客户端证书、以当前 Windows 用户自动登录的 SSPI 或 Azure / Entra 身份认证。既有 PostgreSQL 的 TLS / mTLS 保持原有实现。用户外部实例、企业证书轮换及加密客户端私钥继续验收；此前关闭加密的测试没有被计为 TLS 验收。

DBHub 使用固定锁文件与包校验，依赖许可证保留在内置运行目录。运行目录约 79 MB，使用已有 Node。既有 0.2.0 候选已整合此运行环境并完成本机隔离验收；本轮服务实例测试使用开发模式，没有重新安装。

## 2026-10-06：SQL Server 域账号

开发版的 SQL Server 连接新增「认证方式 → Windows 域账号（NTLM）」，分别填写域名、域用户名和密码。Agent 可以提供非敏感的 `authMode: "windowsDomain"`、`domain` 和 `user`；缺少密码或域名时使用本机认证表单，后台任务返回需要用户输入。密码仍只通过本机表单或用户提供的工作区凭据文件进入原生层；成功连接后按原有方式保存到系统凭据库。旧连接未包含新字段时继续使用数据库账号。

最低必要验收共六项通过：原生工具的本机密码请求、域名缺失提示、内置 DBHub / mssql / tedious 驱动的真实 NTLM Type 1 / Type 3 握手、1000×720 窗口表单、切换认证方式清空密码、关闭表单清空密码。握手使用仅监听本机的受控协议端点与临时合成账号，独立核对密码证明后明确拒绝登录；没有伪造成功查询。该证据不代表已验收真实 AD 企业实例、当前 Windows 用户自动登录或 Azure 身份。复用未变化的数据库账号、只读查询、TLS 和备份证据，没有重复模型调用。

回执位于 `artifacts/development-native-current-20261006/build-b474349fd3e60fab/sql-domain-accepted.json`，保留之前的夹具导入错误与错误断言回执。实际界面截图已查看；未保存测试连接，31 会话、待恢复记录、活动会话及语言保持。当前开发程序已更新，未安装或改写固定 0.2.2 发行候选。该目录的 `previous-native.exe`、`rollback-dbhub-v2/` 和 `rollback-files.json` 保留旧开发程序及准确匹配的 DBHub 运行文件，恢复须在桌面和后台空闲退出后一起替换，不能混用不同版本的运行清单。

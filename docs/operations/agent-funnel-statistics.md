# Agent 获客与首次成功统计

查询：`scripts/Get-GeoDAgentFunnel.ps1 -Hours 168 -OutputFile artifacts/agent-funnel-current.json`。
只读线上账户、Agent 账本和限定 product=geod-web 的官网事件；不读取旧 GeoD 桌面使用。

## 事件含义

- Agent 中英文页面全部安装包入口记录 download_clicked，携带明确的 Agent 下载标记、版本和官网/GitHub 渠道。点击不是传输完成；跨域浏览器下载和实际安装完成仍为 null。
- app_first_seen 为开启现有 Agent 统计后首次观测到客户端运行。按账号在服务端保留期内去重，跨设备、重装和反复开关不会增加该期人数。不是安装日期，也不回填以前的启动。
- 首次下载成功按账号最早保留的 completed 记录计算，不用事件条数冒充用户数。不代表整个数据库到 COG 工作流都验收成功。
- 自有渠道沿用已知 Token 和独立结果事件；未授权、旧版、离线与部署前缺失的历史保持未知。

## 测试与账号排除

账号报表排除已确认的两个主账号、analyticsAudience=internal、isTestAccount=true。
测试网页构建使用 NEXT_PUBLIC_ANALYTICS_INTERNAL=1；运营人员浏览器可在站点模块中调用 setAnalyticsAudience('internal')，标记保存在 geod-web:analytics-audience，不在链接中携带账号或密钥。恢复使用 unclassified。
内部访问使用既有服务端允许的 source=geod-internal 字段；报表排除该匿名访客标识的保留事件（包括标记之前的访问）。不得把匿名访客反向关联到账号，不根据 IP 猜测账号。
没有标记的主账号浏览器和测试浏览器仍可能留在匿名数据中，报表始终提示，不能把未分类访问称为净外部用户。历史无标签不能可靠回补。

## 覆盖与发布

新增注册与 Studio 共用；授权记录可能清理，不能当完整登录历史。完整访问到任务转化率保持 null，不能把匿名访问、共享注册直接串成一条用户链。
官网代码、客户端和新增网关事件合同需配套发布后才开始新增采集。本次代码完善不等于已经部署；现有线上 0.2.9 不会自动获得新事件。

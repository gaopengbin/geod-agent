# 设备身份验证的实际边界

本轮核对随包 Codex 0.159.2 的实验协议，并用独立目录运行真实 app-server 的 `userVerification/status`。没有注册、删除凭证或弹出系统身份验证。

## 核对结果

- Windows 本机返回 `credentialId: null`、`unavailableReason: providerUnavailable`。当前构建或账号无法提供设备验证。
- [官方 app-server 源码说明](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#user-verification-experimental)将此模式限制为受支持的内置 TUI/桌面会话、硬件及账号。其他客户端不能通过改名或实验开关启用；这不是普通浏览器 OAuth。
- GeoD 使用自己的账号及托管/BYOK 模型，不应借用当前 Codex 桌面的 ChatGPT 身份或伪造验证凭证。

## 本轮改动

遇到 `openai/userVerification` 时展示连接器给出的标题、说明及明确的不可用提示，保留取消入口。挑战和扩展元数据不显示在卡片中。原生回复核对账号及原执行归属，并拒绝未由设备提供的接受结果；普通 URL 请求继续要求实际打开系统浏览器。

## 验收

证据目录：`artifacts/product-gaps-20261004/user-verification`。

- 真实引擎本机就绪查询：`actual-platform-status.json`。
- 五项原生单元检查通过：账号/执行隔离、伪造证明拒绝、URL 打开门禁、URL 范围及后台不声明交互能力。
- 四项真实组件界面检查通过：中文/英文、明/暗色、挑战不显示、唯一取消入口。`component-ui.json` 明确标记为协议组件样例，未模拟为真实 MCP 身份验证。
- 桌面前端构建通过。

没有完成设备签名、后端登记、外部账号或真实 MCP 身份挑战成功流程；当前发行候选不宣称支持该能力。后续接入需要实际开放的提供方及账号，再核对独立原生 RPC 取消和迟到证明丢弃。现有浏览器 URL、表单和本机 OAuth 能力不受影响。

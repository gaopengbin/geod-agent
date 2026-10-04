# Claude Messages 与 Gemini 原生接口

日期：2026-10-04。状态：开发版已接入四种模型接口；原生工具往返、后台定时执行及实际桌面重启恢复通过。没有重新安装或发布。

## 产品入口

账号与设置 → 模型与渠道 → 添加渠道。预设新增 Anthropic / Claude、Google Gemini；支持手动填写基础地址、读取目录、配置实际模型 ID，也可连接兼容中转服务。

模型 ID、上下文、输出容量和图片能力由用户按服务配置，不根据预设名称推断。Claude 额外提供自适应思考选项；离开 Claude 预设或接口后会清除该协议专属选项。

## 实现

- Rust 按执行快照生成固定请求地址和原生认证头。Claude 使用 `x-api-key` 与协议版本；Gemini 使用 `x-goog-api-key`，密钥不拼入 URL。密钥仍保存在本机系统凭据库，不提供给 Codex 或协议进程。
- Claude 的文本、思考、签名、工具参数分片和用量事件转换为 Codex 事件；Gemini 的文本、思考、函数调用、函数结果与用量转换为相同内部接口。
- 签名和原生内容保存在 Codex 历史的不透明状态字段，工具往返与重开会话原样恢复。GeoD 的状态包装是 Base64 编码，不声称包装本身加密；供应商提供的签名字段原样保留。
- Gemini 没有返回调用 ID 时生成内部 ID，回传函数结果时使用原生 ID 规则。截断、未完成、不可识别的关键内容及未声明工具不会生成可执行结果。
- 自有渠道请求记录 `personal` 用量；未返回的 Token 保持未知，不扣 GeoD 托管额度、不虚构供应商费用。
- 原生目录当前读取供应商返回的第一页，最多 1,000 项；后续页中的模型仍可手动配置。

协议依据：[Claude 流式接口](https://platform.claude.com/docs/en/build-with-claude/streaming)、[Gemini 内容生成接口](https://ai.google.dev/api/generate-content)。

## 验收

| 项目 | 当前结果 |
| --- | --- |
| Claude / Gemini 请求、流式分片、签名、工具参数、图片编码和异常结束 | 7 个原生协议测试通过；既有协议测试 7 项继续通过 |
| 原生地址、认证头、模型快照与协议专属配置 | 3 项 Windows 原生单元测试通过 |
| 真实 Codex 调用工作区工具并回答随机 GeoJSON 文件名 | 两种接口均通过，回答来自真实模型和实际工具数据 |
| 实际关闭桌面及引擎后重新打开、沿用原线程回忆文件名 | 两种接口均通过，签名状态回传核验通过 |
| 独立后台定时执行、工作区文件读取、渠道快照及用量落盘 | 两种接口均通过 |
| 渠道预设、自适应选项重置、中英文、1000×720 明暗布局 | 通过，已查看实际截图 |
| 临时渠道/系统密钥清理、原会话保留、凭据扫描 | 通过；扫描 3,805 个文件，未发现本轮测试密钥明文 |

证据：[完整结果](../../artifacts/product-gaps-20261004/native-providers/result.json)、[协议往返记录](../../artifacts/product-gaps-20261004/native-providers/wire-evidence.json)、[凭据扫描](../../artifacts/product-gaps-20261004/native-providers/credential-audit.json)。

验收使用真实 DeepSeek，通过本机随机端口的 Claude / Gemini 协议转换夹具，共 10 次上游请求。夹具只转换格式，未生成或替换模型回答；原生密钥头、分片和签名状态在实际桌面、Codex、后台进程中往返。夹具签名用于检查原样保留，不代表 Claude 或 Google 的加密签名验证。

最初控制器误用英文按钮名称 `Back to chat`，七个用例已完成后在返回界面超时。随后修正按钮名称及收起侧栏时的当前会话读取，单独完成最终导航和清理检查，没有重复付费模型请求；失败记录保留。

## 尚未验收的范围

Claude / Gemini 官方账号请求、真实供应商的签名和配额、真实图片理解，以及各第三方中转实现仍需对应凭据逐项测试。图片目前只有编码与请求合同测试。这些边界不写成已通过官方供应商验收。

## 主要文件

- `packages/codex-protocol/provider-native.mjs`、`provider-adapter.mjs`、`codex-contract.mjs`。
- `apps/geod-agent-desktop/src-tauri/src/ai_channels.rs`、`codex-host.mjs`。
- `apps/geod-agent-desktop/src/ai-channels-page.tsx`、`ai-channels.ts`。
- `scripts/verify-native-providers.py`、`verify-native-providers.mjs`、`finish-native-provider-acceptance.mjs`。

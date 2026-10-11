# 配置自己的模型渠道

GeoD Agent 支持托管模型和自有渠道。选择自有渠道时不扣 GeoD Credits，模型服务商按其 API 规则结算；应用内单独记录服务返回的用量。网页版会员不一定包含 API 额度。

1. 在所选模型服务商后台开通 API、取得 API Key，并确认 API 余额。
2. 打开左侧 **模型与渠道 → 添加渠道**。选择服务预设，或填写服务商提供的 API 基础地址、接口类型和 API Key。
3. 点击 **读取模型目录**，从服务实际返回的目录添加模型。没有目录的服务可以按照其文档手动填写模型 ID。Agent 任务需要模型支持工具调用；上下文、输出容量及视觉能力按实际模型规格填写。
4. 点击 **保存渠道**。在对话输入框右下角的模型选择器中选择该渠道和模型，先发送简短消息验证。
5. 如需让后续新对话使用该渠道，设置 **新对话默认模型**。已有会话与已创建的定时任务保留原选择，需要分别调整。

以 DeepSeek 为例：选择 DeepSeek 预设，基础地址为 `https://api.deepseek.com/v1`，接口类型为 **Chat Completions**；模型 ID 从实际返回目录选择。服务支持的基础地址见 [DeepSeek 官方文档](https://api-docs.deepseek.com/)。

API Key 保存在本机系统凭据中，不应粘贴到对话、截图或公开配置文件。连接失败时检查基础地址是否误填成完整调用接口、接口类型是否匹配、模型 ID 是否实际可用，并核对服务商 API 余额及应用的网络代理。

## English

GeoD Agent supports hosted models and personal providers. A personal provider does not consume GeoD Credits; API charges are billed by that provider. Usage returned by the provider is recorded separately in the app. A web chat subscription may not include API credit.

1. Enable API access with your provider, obtain an API key, and check your API balance.
2. Open **Models & channels → Add channel**. Choose a preset or enter the provider's API base URL, protocol, and API key.
3. Click **Read model catalog** and add an available model. If no catalog is provided, enter a model ID from the provider's documentation. Agent tasks need tool calling; configure context/output limits and vision support according to the model's actual specifications.
4. Save the channel, select it in the model picker at the bottom right of the message box, and send a short verification message.
5. Optionally set the default for new chats. Existing chats and saved scheduled tasks keep their original selection and must be changed separately.

For DeepSeek, use the DeepSeek preset, `https://api.deepseek.com/v1`, and **Chat Completions**, then select a model returned by the catalog. See [DeepSeek's official documentation](https://api-docs.deepseek.com/).

API keys are saved in your device's credential store. For connection errors, check the API base URL, protocol, model availability, provider API balance, and application network proxy.

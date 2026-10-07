# 思考详情高度与滚动

## 来源

托管模型网关接收上游 `delta.reasoning_content`，本机兼容桥将其转为 `response.reasoning_summary_text.delta`；界面通过 `item/reasoning/summaryTextDelta` 将文本保存为 reasoning 记录的 details。截图中的坐标文本属于模型接口返回的思考文本，不是本机下载进度或执行日志。

## 界面变更

- 思考详情保持默认收起。
- 展开后使用现有 Radix ScrollArea，最高 `min(280px, 40dvh)`，短内容保留自然高度。
- 完整 Markdown 文本保留，可使用滚轮、滚动条和键盘浏览；共享滚动区域的 overscroll containment 避免滚到边缘后带动会话。
- 同类执行记录详情应用相同高度限制，但使用独立的无障碍名称；模型思考详情提供中英文名称。
- 不修改会话历史、执行结果、待回答问题或模型请求。

## 验证

- `test/reasoning-scroll-ui.mjs`：真实 ChatTranscript 组件的隔离样例，无模型调用。浅色/深色、700×800 与 360×600，验证默认收起、完整 200 段、滚轮隔离、PageDown、末段可达、无横向溢出、短内容自然高度。测得长内容高度 280/240px，短内容 38px。
- `test/chat-activity-ui.mjs`：既有折叠、问题回答后继续处理、固定执行状态和停止/完成回归通过。
- `test/reasoning-scroll-native.mjs`：只在当前桌面无活动 AI、下载和命令时刷新。展开实际中断记录，测得内容高度 11618px、视口 280px；会话历史哈希一致，原有 7 次模型生成数量未变，没有触发继续处理或下载。
- `npm run build` 通过，保留既有大分块提示。
- 实际桌面与窄窗口截图已检查。

证据：`artifacts/reasoning-scroll-20261007/ui-report.json`、`native-report.json`、`native-reasoning-scroll.png`、`expanded-*.png`。

范围：本机开发窗口已刷新；未重新发布安装包或部署线上服务。

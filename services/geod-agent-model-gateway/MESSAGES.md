# 应用内消息

桌面标题栏的铃铛打开消息中心。普通消息显示未读标记；重要消息在应用打开时提示一次。正文展开后同步已读状态，支持全部已读和中英双语。应用关闭期间的公告会在下次登录后获取。

消息使用 GeoD OAuth 身份，由账号隔离已读记录。默认只显示最近 100 条可见消息；可按账号、客户端版本及生效时间定向。消息不会调用模型或扣除 Credits。

## 发布工具

管理员在服务器上使用当前发行目录中的 `messages-admin.mjs`，数据库路径必须明确指定。普通用户没有消息发布接口。`put` 默认保存草稿，发布须明确执行 `publish` 或添加 `--publish`。

```json
{
  "id": "release-023",
  "title": { "zh": "GeoD Agent 更新", "en": "GeoD Agent update" },
  "body": { "zh": "更新内容经确认后填写。", "en": "Add the approved release details here." },
  "priority": "normal",
  "minimumVersion": "0.2.3",
  "action": { "kind": "update", "label": { "zh": "查看应用更新", "en": "View app updates" } }
}
```

```sh
node messages-admin.mjs --db /srv/laogao/data/geod-agent/agent-model.sqlite put --file announcement.json
node messages-admin.mjs --db /srv/laogao/data/geod-agent/agent-model.sqlite publish --id release-023
node messages-admin.mjs --db /srv/laogao/data/geod-agent/agent-model.sqlite retract --id release-023
node messages-admin.mjs --db /srv/laogao/data/geod-agent/agent-model.sqlite list
```

添加 `audienceAccountId` 可只发送给一个 GeoD 账号。`startsAt`、`expiresAt` 使用 ISO 时间；`maximumVersion` 限制最高可见版本。`action.kind="link"` 只接受没有用户名和密码的 HTTPS 链接。正文按纯文本展示。修改相同 ID 会产生新修订、重新成为未读，并默认返回草稿状态。

发布、撤回和草稿状态持久化在 Agent 主账本；已读信息也保存在同一账本。升级前须做 SQLite 一致性备份。客户端缓存按账号分开，服务不可达时仍可查看上次保存的消息。

本功能采用应用内轮询，在可见窗口中每分钟刷新；不是应用关闭时运行的操作系统推送服务。实现功能不等于批准向用户发送具体公告；发布前仍须确认内容和受众。

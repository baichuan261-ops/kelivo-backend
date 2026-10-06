# 服务端主动唤醒

这套唤醒不使用 Kelivo 内置定时任务。Render Cron Job 每小时启动一次脚本，脚本读取 Supabase `messages` 和 `memories`，由模型自行决定发消息或保持安静。

## 一次性数据库设置

在 Supabase SQL Editor 执行 `supabase/proactive_messages.sql`。新增的 `source` 字段只用来让客户端准确识别主动消息，不会改变普通聊天数据。

## Render 设置

新建 Cron Job，并使用与 Web Service 相同的仓库和分支：

- Build Command：`npm install`
- Command：`npm run heartbeat`
- Schedule：`0 * * * *`（Render 使用 UTC，但“每小时”不受时区影响）
- Region：建议与 Web Service 相同

把 Web Service 的 `SUPABASE_URL`、`SUPABASE_KEY`、`TRANSFER_API_URL`、`TRANSFER_API_KEY`、`MODEL_NAME` 放进一个 Environment Group，再同时关联 Web Service 和 Cron Job。然后按 `.env.example` 增加 heartbeat 与 Bark/ntfy 配置。

推荐先设置 `HEARTBEAT_COOLDOWN_HOURS=3`。Cron 仍然每小时醒来，但最近 3 小时刚有 AI 消息时会直接安静退出，避免打扰和浪费模型调用。

代码会额外强制白天至少间隔 30 分钟、02:00–08:00 至少间隔 2 小时，并且只有整点或半点后的前 5 分钟允许自动唤醒。即使 Render 被误设成每 5 分钟执行，也不会造成连续推送。

## 手动验收

在 Render 的 Cron Job Runs 页面点 `Trigger Run`。日志只会出现以下三类结果：

- `action=skip, reason=cooldown`：仍在冷却期；
- `action=skip`：模型判断不联系；
- `action=sent`：消息已写入 Supabase，并已提交给 Bark/ntfy。

`GET /api/proactive/messages?session_id=1&after_id=0` 是 Kelivo 客户端的增量同步接口，认证方式与 `/api/chat` 相同。

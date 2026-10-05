-- 在 Supabase SQL Editor 中执行一次。
-- 用 source 区分客户端已经显示过的普通回复和服务器主动生成的新消息。
alter table public.messages
  add column if not exists source text;

create index if not exists messages_proactive_session_id_id_idx
  on public.messages (session_id, id)
  where source = 'proactive';

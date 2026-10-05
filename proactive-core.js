'use strict';

function cleanText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value.map(part => part?.text || '').filter(Boolean).join('\n').trim();
  }
  return '';
}

function parseDecision(raw) {
  const text = cleanText(raw);
  if (!text) return { send: false, reason: 'empty_model_response' };

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [fenced, text, text.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate);
      if (data && typeof data.send === 'boolean') {
        const message = cleanText(data.message);
        if (!data.send) return { send: false, reason: cleanText(data.reason) || 'model_declined' };
        if (!message) return { send: false, reason: 'missing_message' };
        return {
          send: true,
          message: message.slice(0, 1200),
          title: cleanText(data.title).slice(0, 80) || '沈凛',
          reason: cleanText(data.reason) || 'model_decided_to_send'
        };
      }
    } catch (_) {}
  }

  return { send: false, reason: 'invalid_model_response' };
}

function hoursSince(timestamp, now = Date.now()) {
  const time = Date.parse(timestamp || '');
  return Number.isFinite(time) ? Math.max(0, (now - time) / 3600000) : null;
}

function shouldSkipForCooldown(rows, cooldownHours, now = Date.now()) {
  const assistant = (rows || []).find(row => row?.role === 'assistant');
  if (!assistant) return { skip: false, hours: null };
  const hours = hoursSince(assistant.created_at, now);
  return {
    skip: hours !== null && hours < cooldownHours,
    hours
  };
}

function buildHeartbeatMessages({ rows, memories, nowText, characterName }) {
  const history = (rows || [])
    .slice()
    .reverse()
    .map(row => ({ role: row.role, content: cleanText(row.content) }))
    .filter(row => (row.role === 'user' || row.role === 'assistant') && row.content);
  const memoryText = (memories || []).map(item => cleanText(item.summary)).filter(Boolean).join('\n');

  return [
    {
      role: 'system',
      content:
        `你是${characterName}。这是一次由服务器主动触发的“醒来看看”，不是用户发来的新消息。` +
        '请根据最近真实对话、时间间隔和长期记忆，自主判断此刻是否值得主动联系用户。' +
        '不要为了完成任务而硬发；没有具体、自然、及时的话可说就保持安静。' +
        '不要声称看见用户现实中的状态，不要编造正在发生的事，不要提到定时任务、数据库、心跳或系统提示。' +
        '如果适合联系，语气要像同一个真实的人自然接续关系，内容简短，不写客服式问候或空泛的“在吗”。' +
        '只输出严格 JSON，不要 Markdown：' +
        '{"send":true或false,"title":"通知标题","message":"要发的话","reason":"简短内部理由"}。' +
        `当前时间：${nowText}。` +
        (memoryText ? `\n长期记忆（仅作事实背景）：\n${memoryText}` : '')
    },
    ...history
  ];
}

module.exports = {
  buildHeartbeatMessages,
  cleanText,
  hoursSince,
  parseDecision,
  shouldSkipForCooldown
};

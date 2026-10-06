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

function isHourInWindow(hour, startHour, endHour) {
  if (startHour === endHour) return true;
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

function isHalfHourlyWakeMinute(minute, graceMinutes = 4) {
  const value = Number(minute);
  return Number.isFinite(value) && value >= 0 && (
    value <= graceMinutes ||
    (value >= 30 && value <= 30 + graceMinutes)
  );
}

function pushGapHoursForLocalHour(hour, options = {}) {
  const nightStart = Number(options.nightStart ?? 2);
  const nightEnd = Number(options.nightEnd ?? 8);
  const nightGap = Math.max(0, Number(options.nightGap ?? 2));
  const dayGap = Math.max(0, Number(options.dayGap ?? 0));
  return isHourInWindow(hour, nightStart, nightEnd) ? nightGap : dayGap;
}

function textSimilarity(left, right, gramSize = 3) {
  const normalize = value => cleanText(value)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < gramSize) {
    return a.includes(b) || b.includes(a) ? Math.min(a.length, b.length) / Math.max(a.length, b.length) : 0;
  }
  const grams = text => {
    const result = new Set();
    for (let index = 0; index <= text.length - gramSize; index++) {
      result.add(text.slice(index, index + gramSize));
    }
    return result;
  };
  const aGrams = grams(a);
  const bGrams = grams(b);
  let intersection = 0;
  for (const gram of aGrams) {
    if (bGrams.has(gram)) intersection++;
  }
  return intersection / (aGrams.size + bGrams.size - intersection);
}

function isTooSimilarToRecent(message, rows, threshold = 0.55) {
  return (rows || [])
    .filter(row => row?.role === 'assistant' && cleanText(row.content))
    .slice(0, 6)
    .some(row => textSimilarity(message, row.content) >= threshold);
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
        '如果最近一条消息是你发的、用户还没有回复：可以在足够间隔后继续说，但必须顺着上一条往前推进，加入新的具体内容或想法；不要换一种说法重复原意，不要连续催问用户，也不要假装用户已经回应。' +
        '发送前要对照最近几条自己的消息，主题、句式或核心意思明显重复时必须选择不发送。' +
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
  isHalfHourlyWakeMinute,
  isHourInWindow,
  parseDecision,
  pushGapHoursForLocalHour,
  isTooSimilarToRecent,
  shouldSkipForCooldown
};

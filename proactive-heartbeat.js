'use strict';

const {
  buildHeartbeatMessages,
  hoursSince,
  isHalfHourlyWakeMinute,
  isTooSimilarToRecent,
  parseDecision,
  pushGapHoursForLocalHour,
  shouldSkipForCooldown
} = require('./proactive-core');

const env = process.env;
const SUPABASE_URL = String(env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = String(env.SUPABASE_KEY || '');
const TRANSFER_API_URL = String(env.TRANSFER_API_URL || '');
const TRANSFER_API_KEY = String(env.TRANSFER_API_KEY || '').replace(/^Bearer\s+/i, '');
const MODEL_NAME = String(env.HEARTBEAT_MODEL_NAME || env.MODEL_NAME || 'gemini-2.5-flash');
const SESSION_ID = String(env.HEARTBEAT_SESSION_ID || '1');
const CHARACTER_NAME = String(env.HEARTBEAT_CHARACTER_NAME || '沈凛');
const TIME_ZONE = String(env.TIME_ZONE || 'Asia/Shanghai');
const COOLDOWN_HOURS = Math.max(0, Number(env.HEARTBEAT_COOLDOWN_HOURS || 3));
const CONTEXT_LIMIT = Math.min(100, Math.max(8, Number(env.HEARTBEAT_CONTEXT_LIMIT || 40)));
const TIMEOUT_MS = Math.max(10000, Number(env.HEARTBEAT_TIMEOUT_MS || 120000));

function required(name, value) {
  if (!value) throw new Error(`${name} 未配置`);
}

async function supabase(method, table, params = {}, body) {
  const query = new URLSearchParams(params);
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : undefined
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Supabase ${method} ${table} 失败 (${response.status}): ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function push(title, message) {
  const provider = String(env.PUSH_PROVIDER || 'bark').toLowerCase();
  if (provider === 'none') return { provider, delivered: false };

  if (provider === 'ntfy') {
    required('NTFY_TOPIC', env.NTFY_TOPIC);
    const base = String(env.NTFY_BASE_URL || 'https://ntfy.sh').replace(/\/$/, '');
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
    const response = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: env.NTFY_TOPIC,
        title,
        message
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`ntfy 推送失败 (${response.status}): ${await response.text()}`);
    return { provider, delivered: true };
  }

  required('BARK_KEY', env.BARK_KEY);
  const base = String(env.BARK_BASE_URL || 'https://api.day.app').replace(/\/$/, '');
  const response = await fetch(`${base}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      device_key: env.BARK_KEY,
      title,
      body: message,
      group: env.BARK_GROUP || 'Kelivo',
      sound: env.BARK_SOUND || 'minuet.caf'
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Bark 推送失败 (${response.status}): ${await response.text()}`);
  return { provider: 'bark', delivered: true };
}

async function main() {
  required('SUPABASE_URL', SUPABASE_URL);
  required('SUPABASE_KEY', SUPABASE_KEY);
  required('TRANSFER_API_URL', TRANSFER_API_URL);
  required('TRANSFER_API_KEY', TRANSFER_API_KEY);

  const localMinute = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    minute: 'numeric'
  }).format(new Date()));
  if (!isHalfHourlyWakeMinute(localMinute)) {
    console.log(JSON.stringify({
      ok: true,
      action: 'skip',
      reason: 'outside_half_hourly_wake_slot',
      localMinute
    }));
    return;
  }

  const rows = await supabase('GET', 'messages', {
    select: 'id,role,content,created_at,visible',
    session_id: `eq.${SESSION_ID}`,
    visible: 'eq.true',
    order: 'created_at.desc',
    limit: String(CONTEXT_LIMIT)
  }) || [];

  if (!rows.length) {
    console.log(JSON.stringify({ ok: true, action: 'skip', reason: 'no_context' }));
    return;
  }

  const cooldown = shouldSkipForCooldown(rows, COOLDOWN_HOURS);
  if (cooldown.skip) {
    console.log(JSON.stringify({ ok: true, action: 'skip', reason: 'cooldown', hours: cooldown.hours }));
    return;
  }

  const localHour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hour: 'numeric',
    hourCycle: 'h23'
  }).format(new Date()));
  // Guardrails are enforced in code so an accidentally frequent Render
  // schedule or a zero-valued environment variable cannot cause push bursts.
  const nightGap = Math.max(2, Number(env.HEARTBEAT_NIGHT_PUSH_GAP_HOURS || 2));
  const dayGap = Math.max(0.5, Number(env.HEARTBEAT_DAY_PUSH_GAP_HOURS || 0.5));
  const pushGapHours = pushGapHoursForLocalHour(localHour, {
    nightStart: env.HEARTBEAT_NIGHT_START_HOUR || 2,
    nightEnd: env.HEARTBEAT_NIGHT_END_HOUR || 8,
    nightGap,
    dayGap
  });
  const latestAssistant = rows.find(row => row?.role === 'assistant');
  const sinceAssistant = hoursSince(latestAssistant?.created_at);

  if (sinceAssistant !== null && sinceAssistant < pushGapHours) {
    console.log(JSON.stringify({
      ok: true,
      action: 'skip',
      reason: 'push_window_cooldown',
      localHour,
      requiredGapHours: pushGapHours,
      hoursSinceAssistant: sinceAssistant
    }));
    return;
  }

  const memories = await supabase('GET', 'memories', {
    select: 'summary,created_at',
    session_id: `eq.${SESSION_ID}`,
    order: 'created_at.desc',
    limit: '50'
  }) || [];

  const nowText = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TIME_ZONE, dateStyle: 'full', timeStyle: 'long'
  }).format(new Date());
  const messages = buildHeartbeatMessages({ rows, memories, nowText, characterName: CHARACTER_NAME });
  const configuredMaxTokens = Math.max(256, Number(env.HEARTBEAT_MAX_TOKENS || 1200));
  const maxTokens = /gemini/i.test(MODEL_NAME)
    ? Math.max(8192, configuredMaxTokens)
    : configuredMaxTokens;

  const response = await fetch(TRANSFER_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TRANSFER_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages,
      stream: false,
      temperature: 0.8,
      max_tokens: maxTokens,
      // 不强制 response_format，兼容不支持该字段的 OpenAI 中转。
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`模型请求失败 (${response.status}): ${await response.text()}`);
  const data = await response.json();
  const choice = data?.choices?.[0];
  const modelOutput = choice?.message?.content ?? data?.reply ?? data?.output ?? data?.result;
  const decision = parseDecision(modelOutput);

  console.log(JSON.stringify({
    event: 'model_completed',
    finishReason: choice?.finish_reason || null,
    outputChars: typeof modelOutput === 'string' ? modelOutput.length : null,
    maxTokens
  }));

  if (!decision.send) {
    console.log(JSON.stringify({ ok: true, action: 'skip', reason: decision.reason }));
    return;
  }

  if (isTooSimilarToRecent(decision.message, rows)) {
    console.log(JSON.stringify({
      ok: true,
      action: 'skip',
      reason: 'too_similar_to_recent'
    }));
    return;
  }

  // 先落库，再推送。客户端即使比推送更早拉取，也能拿到完整消息。
  const messageRow = {
    session_id: SESSION_ID,
    role: 'assistant',
    content: decision.message,
    visible: true,
    source: 'proactive'
  };
  let inserted;
  try {
    inserted = await supabase('POST', 'messages', {}, messageRow);
  } catch (error) {
    // 允许 Cron 在数据库迁移前先投入运行；迁移只影响客户端主动消息同步。
    if (!/source/i.test(error.message)) throw error;
    const { source: _source, ...legacyRow } = messageRow;
    inserted = await supabase('POST', 'messages', {}, legacyRow);
  }
  await supabase('POST', 'timeline', {}, {
    session_id: SESSION_ID,
    role: 'assistant',
    content: decision.message
  });

  const pushResult = await push(decision.title, decision.message);
  console.log(JSON.stringify({
    ok: true,
    action: 'sent',
    messageId: inserted?.[0]?.id || null,
    push: pushResult,
    reason: decision.reason
  }));
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});

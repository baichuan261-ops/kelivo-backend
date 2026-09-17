const express = require('express');
const { spawn } = require('child_process');

const app = express();

const PUBLIC_PORT = Number(process.env.PORT || 3000);
const INNER_PORT = Number(process.env.INNER_PORT || 3001);
const INNER_URL = `http://127.0.0.1:${INNER_PORT}`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const MAX_MEMORY_TOOL_ROUNDS = 4;

const MEMORY_TOOL_NAMES = new Set([
  'create_memory',
  'read_memory',
  'update_memory',
  'delete_memory'
]);

app.use(express.json({ limit: '10mb' }));

// ==================================================
// 启动原来的 server.js
// 原 server.js 不对公网直接监听，改到内部端口。
// ==================================================

let shuttingDown = false;

const child = spawn(
  process.execPath,
  ['server.js'],
  {
    env: {
      ...process.env,
      PORT: String(INNER_PORT)
    },
    stdio: 'inherit'
  }
);

child.on('exit', (code, signal) => {
  console.log(
    `ℹ️ 内部 server.js 退出 code=${code ?? '-'} signal=${signal ?? '-'}`
  );

  if (!shuttingDown) {
    process.exit(code || 1);
  }
});

function shutdown(signal) {
  shuttingDown = true;

  try {
    child.kill(signal);
  } catch (_) {}

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ==================================================
// Supabase 基础请求
//
// 这里只使用后端自己的 SUPABASE_KEY。
// Key 永远不会交给模型。
// 模型也不能指定任意表，更不能执行任意 SQL。
// ==================================================

function assertSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Supabase 未配置');
  }
}

function sbUrl(table, params = {}) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ''
    ) {
      query.set(
        key,
        String(value)
      );
    }
  }

  const base =
    SUPABASE_URL.replace(/\/$/, '');

  const qs =
    query.toString();

  return (
    `${base}/rest/v1/` +
    encodeURIComponent(table) +
    (qs ? '?' + qs : '')
  );
}

async function sb(
  method,
  table,
  params = {},
  body
) {
  assertSupabase();

  const headers = {
    apikey: SUPABASE_KEY,
    'Content-Type': 'application/json'
  };

  if (method !== 'GET') {
    headers.Prefer =
      'return=representation';
  }

  const response =
    await fetch(
      sbUrl(table, params),
      {
        method,
        headers,

        body:
          body === undefined
            ? undefined
            : JSON.stringify(body)
      }
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${method} ${table} 失败 ` +
      `(${response.status}): ${text}`
    );
  }

  if (!text.trim()) {
    return [];
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return text;
  }
}

// ==================================================
// 通用辅助
// ==================================================

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampInt(
  value,
  min,
  max,
  fallback
) {
  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(
    Math.max(
      Math.trunc(number),
      min
    ),
    max
  );
}

// ==================================================
// READ MEMORY
// ==================================================

async function readMemory(
  sessionId,
  args = {}
) {
  const params = {
    select:
      'session_id,summary,created_at',

    session_id:
      `eq.${sessionId}`,

    order:
      'created_at.desc',

    limit:
      clampInt(
        args.limit,
        1,
        50,
        20
      )
  };

  const keyword =
    cleanText(args.keyword);

  if (keyword) {
    params.summary =
      `ilike.*${keyword}*`;
  }

  const rows =
    await sb(
      'GET',
      'memories',
      params
    );

  return {
    ok: true,

    count:
      Array.isArray(rows)
        ? rows.length
        : 0,

    memories:
      Array.isArray(rows)
        ? rows
        : []
  };
}

// ==================================================
// CREATE MEMORY
// ==================================================

async function createMemory(
  sessionId,
  args = {}
) {
  const summary =
    cleanText(
      args.summary ??
      args.content ??
      args.memory
    );

  if (!summary) {
    return {
      ok: false,
      error:
        '记忆内容不能为空'
    };
  }

  if (summary.length > 1500) {
    return {
      ok: false,
      error:
        '单条记忆最多 1500 个字符'
    };
  }

  // 防止完全一样的记忆重复保存。
  const existing =
    await sb(
      'GET',
      'memories',
      {
        select:
          'summary,created_at',

        session_id:
          `eq.${sessionId}`,

        summary:
          `eq.${summary}`,

        limit: 1
      }
    );

  if (
    Array.isArray(existing) &&
    existing.length > 0
  ) {
    return {
      ok: true,

      created: false,
      duplicate: true,

      memory:
        existing[0]
    };
  }

  const created =
    await sb(
      'POST',
      'memories',
      {},
      {
        session_id:
          sessionId,

        summary
      }
    );

  return {
    ok: true,
    created: true,

    memory:
      Array.isArray(created) &&
      created.length > 0
        ? created[0]
        : {
            summary
          }
  };
}

// ==================================================
// 查找将要修改 / 删除的记忆
//
// 不依赖 id。
// 直接使用你当前 memories 本来就有的 created_at。
// ==================================================

async function findMemory(
  sessionId,
  args = {}
) {
  const createdAt =
    String(
      args.created_at || ''
    ).trim();

  if (!createdAt) {
    return {
      ok: false,
      error:
        '必须提供 read_memory 返回的 created_at'
    };
  }

  const rows =
    await sb(
      'GET',
      'memories',
      {
        select:
          'session_id,summary,created_at',

        session_id:
          `eq.${sessionId}`,

        created_at:
          `eq.${createdAt}`,

        limit: 1
      }
    );

  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    return {
      ok: false,
      error:
        '没有找到这条记忆，可能已经被修改或删除'
    };
  }

  const row =
    rows[0];

  const oldSummary =
    cleanText(
      args.old_summary
    );

  // 乐观锁。
  // 模型读取后如果这条内容又被改变了，
  // 就拒绝覆盖。
  if (
    oldSummary &&
    cleanText(row.summary) !==
      oldSummary
  ) {
    return {
      ok: false,

      error:
        '旧记忆已经变化，为避免误覆盖，本次操作已取消',

      current_memory:
        row
    };
  }

  return {
    ok: true,
    memory: row
  };
}

// ==================================================
// UPDATE MEMORY
// ==================================================

async function updateMemory(
  sessionId,
  args = {}
) {
  const newSummary =
    cleanText(
      args.new_summary ??
      args.summary ??
      args.content
    );

  if (!newSummary) {
    return {
      ok: false,
      error:
        '新的记忆内容不能为空'
    };
  }

  if (newSummary.length > 1500) {
    return {
      ok: false,
      error:
        '单条记忆最多 1500 个字符'
    };
  }

  const found =
    await findMemory(
      sessionId,
      args
    );

  if (!found.ok) {
    return found;
  }

  const row =
    found.memory;

  if (
    cleanText(row.summary) ===
    newSummary
  ) {
    return {
      ok: true,

      updated: false,
      unchanged: true,

      memory: row
    };
  }

  const changed =
    await sb(
      'PATCH',
      'memories',
      {
        session_id:
          `eq.${sessionId}`,

        created_at:
          `eq.${row.created_at}`
      },
      {
        summary:
          newSummary
      }
    );

  return {
    ok: true,
    updated: true,

    memory:
      Array.isArray(changed) &&
      changed.length > 0
        ? changed[0]
        : {
            ...row,
            summary:
              newSummary
          }
  };
}

// ==================================================
// DELETE MEMORY
// ==================================================

async function deleteMemory(
  sessionId,
  args = {}
) {
  const found =
    await findMemory(
      sessionId,
      args
    );

  if (!found.ok) {
    return found;
  }

  const row =
    found.memory;

  await sb(
    'DELETE',
    'memories',
    {
      session_id:
        `eq.${sessionId}`,

      created_at:
        `eq.${row.created_at}`
    }
  );

  return {
    ok: true,
    deleted: true,
    memory: row
  };
}

// ==================================================
// 执行模型调用的记忆工具
// ==================================================

async function runMemoryTool(
  name,
  args,
  sessionId
) {
  if (
    name ===
    'create_memory'
  ) {
    return createMemory(
      sessionId,
      args
    );
  }

  if (
    name ===
    'read_memory'
  ) {
    return readMemory(
      sessionId,
      args
    );
  }

  if (
    name ===
    'update_memory'
  ) {
    return updateMemory(
      sessionId,
      args
    );
  }

  if (
    name ===
    'delete_memory'
  ) {
    return deleteMemory(
      sessionId,
      args
    );
  }

  return {
    ok: false,
    error:
      `未知记忆工具: ${name}`
  };
}

// ==================================================
// 给模型看的记忆工具
// ==================================================

const MEMORY_TOOLS = [
  {
    type:
      'function',

    function: {
      name:
        'create_memory',

      description:
        '新增一条长期记忆。只记录对未来对话确实有帮助、且用户已经明确表达的信息。不要保存密码、API Key、银行卡号等秘密，也不要重复保存已有内容。',

      parameters: {
        type:
          'object',

        properties: {
          summary: {
            type:
              'string',

            description:
              '简洁、客观的一条长期记忆。'
          }
        },

        required: [
          'summary'
        ],

        additionalProperties:
          false
      }
    }
  },

  {
    type:
      'function',

    function: {
      name:
        'read_memory',

      description:
        '读取当前会话自己的 Supabase 长期记忆。用户询问你记得什么、需要核对旧记忆、准备修改或删除记忆时使用。',

      parameters: {
        type:
          'object',

        properties: {
          keyword: {
            type:
              'string',

            description:
              '可选关键词；为空时读取最近记忆。'
          },

          limit: {
            type:
              'integer',

            minimum: 1,
            maximum: 50,

            description:
              '最多返回多少条，默认 20。'
          }
        },

        additionalProperties:
          false
      }
    }
  },

  {
    type:
      'function',

    function: {
      name:
        'update_memory',

      description:
        '修改一条已有长期记忆。必须先 read_memory 找到准确记录，再传 created_at、old_summary 和 new_summary。',

      parameters: {
        type:
          'object',

        properties: {
          created_at: {
            type:
              'string',

            description:
              'read_memory 返回的 created_at。'
          },

          old_summary: {
            type:
              'string',

            description:
              '修改前的原内容，用来防止误覆盖。'
          },

          new_summary: {
            type:
              'string',

            description:
              '修改后的新记忆。'
          }
        },

        required: [
          'created_at',
          'old_summary',
          'new_summary'
        ],

        additionalProperties:
          false
      }
    }
  },

  {
    type:
      'function',

    function: {
      name:
        'delete_memory',

      description:
        '删除一条已有长期记忆。必须先 read_memory 确认准确记录；用户明确要求忘掉或确认旧记忆无效时使用。',

      parameters: {
        type:
          'object',

        properties: {
          created_at: {
            type:
              'string',

            description:
              'read_memory 返回的 created_at。'
          },

          old_summary: {
            type:
              'string',

            description:
              '将要删除的原内容，用来防止误删。'
          }
        },

        required: [
          'created_at',
          'old_summary'
        ],

        additionalProperties:
          false
      }
    }
  }
];

// ==================================================
// 合并客户端原有工具 + Memory Gateway 工具
//
// 如果客户端本来就有 create_memory，
// 这里会替换成后端版本。
// ==================================================

function mergeTools(
  clientTools
) {
  const normal =
    (
      Array.isArray(clientTools)
        ? clientTools
        : []
    ).filter(
      tool =>
        !MEMORY_TOOL_NAMES.has(
          tool?.function?.name
        )
    );

  return [
    ...normal,
    ...MEMORY_TOOLS
  ];
}

// ==================================================
// 内部 server.js 请求
// ==================================================

function innerHeaders(req) {
  const headers = {
    'Content-Type':
      'application/json'
  };

  if (
    req.headers.authorization
  ) {
    headers.Authorization =
      req.headers.authorization;
  }

  if (
    req.headers['x-api-key']
  ) {
    headers['X-API-Key'] =
      req.headers[
        'x-api-key'
      ];
  }

  return headers;
}

async function callInner(
  req,
  body
) {
  const response =
    await fetch(
      `${INNER_URL}/api/chat`,
      {
        method:
          'POST',

        headers:
          innerHeaders(req),

        body:
          JSON.stringify(body)
      }
    );

  const text =
    await response.text();

  let json = null;

  try {
    json =
      JSON.parse(text);
  } catch (_) {}

  return {
    status:
      response.status,

    ok:
      response.ok,

    text,
    json
  };
}

// ==================================================
// 如果客户端不是 messages 格式，也兼容。
// ==================================================

function initialMessages(
  body
) {
  if (
    Array.isArray(
      body.messages
    )
  ) {
    return [
      ...body.messages
    ];
  }

  const content =
    body.message ??
    body.content ??
    body.prompt ??
    body.text ??
    body.msg;

  if (
    content === undefined ||
    content === null
  ) {
    return [];
  }

  return [
    {
      role:
        'user',

      content
    }
  ];
}

function parseArgs(call) {
  try {
    return JSON.parse(
      call
        ?.function
        ?.arguments ||
      '{}'
    );
  } catch (_) {
    return {};
  }
}

// ==================================================
// 等待原 server.js 就绪
// ==================================================

let innerReadyPromise =
  null;

async function waitForInner() {
  const start =
    Date.now();

  while (
    Date.now() - start <
    30000
  ) {
    try {
      const response =
        await fetch(
          `${INNER_URL}/`,
          {
            signal:
              AbortSignal.timeout(
                1500
              )
          }
        );

      if (response.ok) {
        console.log(
          `✅ 内部 server.js 已就绪: ${INNER_URL}`
        );

        return true;
      }

    } catch (_) {}

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          500
        )
    );
  }

  console.error(
    '❌ 等待内部 server.js 启动超时'
  );

  return false;
}

async function ensureInner() {
  if (!innerReadyPromise) {
    innerReadyPromise =
      waitForInner();
  }

  const ready =
    await innerReadyPromise;

  if (!ready) {
    innerReadyPromise =
      null;
  }

  return ready;
}

// ==================================================
// 核心聊天处理
// ==================================================

async function handleChat(
  req,
  res
) {
  if (
    !(await ensureInner())
  ) {
    return res
      .status(503)
      .json({
        error:
          '内部 server.js 尚未就绪'
      });
  }

  const original =
    req.body || {};

  const sessionId =
    original.sessionId ??
    original.session_id ??
    1;

  const tools =
    mergeTools(
      original.tools
    );

  let messages =
    initialMessages(
      original
    );

  let body = {
    ...original,
    messages,
    tools
  };

  for (
    let round = 0;
    round <=
      MAX_MEMORY_TOOL_ROUNDS;
    round++
  ) {

    const inner =
      await callInner(
        req,
        body
      );

    if (
      !inner.ok ||
      !inner.json
    ) {
      return res
        .status(
          inner.status
        )
        .type(
          'application/json'
        )
        .send(
          inner.text
        );
    }

    const assistant =
      inner.json
        ?.choices?.[0]
        ?.message;

    const calls =
      assistant
        ?.tool_calls;

    if (
      !Array.isArray(calls) ||
      calls.length === 0
    ) {
      return res
        .status(
          inner.status
        )
        .json(
          inner.json
        );
    }

    const memoryCalls =
      calls.filter(
        call =>
          MEMORY_TOOL_NAMES.has(
            call
              ?.function
              ?.name
          )
      );

    // 没有 Memory Gateway 工具，
    // 原样交给 Kelivo 客户端。
    if (
      memoryCalls.length === 0
    ) {
      return res
        .status(
          inner.status
        )
        .json(
          inner.json
        );
    }

    if (
      round ===
      MAX_MEMORY_TOOL_ROUNDS
    ) {
      return res
        .status(500)
        .json({
          error:
            '记忆工具连续调用次数过多，已停止以避免死循环'
        });
    }

    console.log(
      '🧠 Memory Gateway 截获工具:',
      memoryCalls.map(
        call =>
          call
            ?.function
            ?.name
      )
    );

    // 如果同一轮还调用手机、天气等客户端工具，
    // 这一轮先处理记忆。
    // 模型得到记忆结果后可以重新调用其它工具。
    messages = [
      ...messages,

      {
        role:
          'assistant',

        content:
          assistant.content ??
          null,

        tool_calls:
          memoryCalls
      }
    ];

    for (
      const call
      of memoryCalls
    ) {

      const name =
        call
          ?.function
          ?.name;

      let result;

      try {
        result =
          await runMemoryTool(
            name,
            parseArgs(call),
            sessionId
          );

      } catch (e) {
        result = {
          ok: false,
          error:
            e.message
        };
      }

      console.log(
        `🧠 Memory tool ${name}: ` +
        (
          result?.ok
            ? 'ok'
            : 'failed'
        )
      );

      messages.push({
        role:
          'tool',

        tool_call_id:
          call.id,

        name,

        content:
          JSON.stringify(
            result
          )
      });
    }

    // 再把工具结果送回原来的 server.js，
    // 模型就能看到数据库执行结果并继续回答。
    body = {
      ...original,

      messages,

      tools,

      stream:
        false
    };
  }
}

// ==================================================
// 对外 HTTP
// ==================================================

app.get(
  '/',
  (req, res) => {
    res.json({
      status:
        'ok',

      service:
        'kelivo-memory-gateway',

      inner:
        INNER_URL,

      time:
        new Date()
          .toISOString()
    });
  }
);

app.post(
  '/api/chat',

  async (req, res) => {
    try {
      await handleChat(
        req,
        res
      );

    } catch (e) {
      console.error(
        '❌ Memory Gateway 错误:',
        e?.stack ||
        e?.message ||
        e
      );

      if (
        !res.headersSent
      ) {
        res
          .status(500)
          .json({
            error:
              'Memory Gateway 处理失败',

            detail:
              e?.message ||
              String(e)
          });
      }
    }
  }
);

// ==================================================
// 其它未来可能增加的接口全部透传给 server.js
// ==================================================

app.all(
  '*',

  async (req, res) => {
    try {
      if (
        !(await ensureInner())
      ) {
        return res
          .status(503)
          .json({
            error:
              '内部 server.js 尚未就绪'
          });
      }

      const options = {
        method:
          req.method,

        headers:
          innerHeaders(req)
      };

      if (
        req.method !== 'GET' &&
        req.method !== 'HEAD'
      ) {
        options.body =
          JSON.stringify(
            req.body || {}
          );
      }

      const response =
        await fetch(
          INNER_URL +
          req.originalUrl,
          options
        );

      const text =
        await response.text();

      return res
        .status(
          response.status
        )
        .type(
          response
            .headers
            .get(
              'content-type'
            ) ||
          'application/json'
        )
        .send(text);

    } catch (e) {
      return res
        .status(502)
        .json({
          error:
            '内部服务不可用',

          detail:
            e?.message ||
            String(e)
        });
    }
  }
);

// ==================================================
// 启动网关
// ==================================================

const server =
  app.listen(
    PUBLIC_PORT,

    async () => {
      console.log(
        `🚪 Memory Gateway running on port ${PUBLIC_PORT}`
      );

      await ensureInner();
    }
  );

server.keepAliveTimeout =
  120000;

server.headersTimeout =
  130000;

server.requestTimeout =
  0;

server.timeout =
  0;

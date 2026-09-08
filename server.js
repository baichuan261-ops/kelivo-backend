const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('🚀 服务启动中...');

// ==================================================
// 请求生命周期监控
// ==================================================

function getRequestId(req) {
return (
req.headers['rndr-id'] ||
req.headers['cf-ray'] ||
${Date.now()}-${Math.random().toString(36).slice(2, 8)}
);
}

function setupRequestLifecycle(req, res) {
const requestId = getRequestId(req);
const startTime = Date.now();

req._requestId = requestId;
req._requestStartTime = startTime;

req.once('aborted', () => {
    console.log(
        `⚠️ 客户端中止请求 request=${requestId} elapsed=${Date.now() - startTime}ms`
    );
});

req.once('error', (err) => {
    console.log(
        `⚠️ 请求流错误 request=${requestId}:`,
        err?.message || err
    );
});

res.once('finish', () => {
    console.log(
        `📤 HTTP响应已发送 request=${requestId} status=${res.statusCode} elapsed=${Date.now() - startTime}ms`
    );
});

res.once('close', () => {
    if (!res.writableEnded) {
        console.log(
            `⚠️ HTTP连接提前关闭 request=${requestId} elapsed=${Date.now() - startTime}ms`
        );
    }
});

return requestId;

}

// 在 JSON body parser 之前就监听请求
// 这样即使请求在 express.json() 阶段就被客户端取消，也能留下日志
app.use((req, res, next) => {
setupRequestLifecycle(req, res);
next();
});

// ===== CORS =====
app.use((req, res, next) => {
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
res.setHeader(
'Access-Control-Allow-Headers',
'Content-Type, Authorization, X-API-Key'
);

if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
}

next();

});

// 允许正常长文本 + 图片请求
app.use(express.json({ limit: '10mb' }));

// ===== 环境变量 =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TRANSFER_API_URL = process.env.TRANSFER_API_URL;
const TRANSFER_API_KEY = process.env.TRANSFER_API_KEY;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || 'claude-3.5-sonnet';

// ===== Render 日志配置 =====
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_SERVICE_ID =
process.env.RENDER_SERVICE_ID ||
'srv-daamlb8n74is73bebocg';

// Render ownerId 会自动从 Service 信息中获取
let renderOwnerId = null;

// 防止 AI 在一次请求里无限查询 Render
const MAX_RENDER_TOOL_ROUNDS = 2;

// ===== 内容清理 =====
function sanitizeContent(content) {
if (typeof content === 'string') {
return content;
}

if (Array.isArray(content)) {
    return content
        .map(part => {
            if (!part) {
                return '';
            }

            if (part.type === 'text') {
                return String(part.text || '');
            }

            if (part.type === 'image_url') {
                return '[图片]';
            }

            if (
                part.type === 'image' ||
                part.type === 'input_image'
            ) {
                return '[图片]';
            }

            if (typeof part.text === 'string') {
                return part.text;
            }

            return '';
        })
        .filter(Boolean)
        .join('\n');
}

if (content && typeof content === 'object') {
    if (typeof content.text === 'string') {
        return content.text;
    }

    return '[非文本内容]';
}

return String(content || '');

}

// ===== 提取当前用户消息 =====
function extractModelMessage(body) {
if (
body.message !== undefined &&
body.message !== null
) {
return body.message;
}

if (
    body.content !== undefined &&
    body.content !== null
) {
    return body.content;
}

if (
    body.prompt !== undefined &&
    body.prompt !== null
) {
    return body.prompt;
}

if (
    body.text !== undefined &&
    body.text !== null
) {
    return body.text;
}

if (
    body.msg !== undefined &&
    body.msg !== null
) {
    return body.msg;
}

if (
    Array.isArray(body.messages) &&
    body.messages.length > 0
) {
    const lastUser =
        body.messages
            .filter(
                m =>
                    m &&
                    m.role === 'user'
            )
            .pop();

    if (lastUser) {
        return lastUser.content;
    }
}

return null;

}

// ===== 判断是否为 Kelivo 标题生成请求 =====
function isTitleRequest(body) {
if (!Array.isArray(body?.messages)) {
return false;
}

const text = body.messages
    .map(m => {
        if (!m || m.role !== 'user') {
            return '';
        }

        return sanitizeContent(m.content);
    })
    .join('\n');

return (
    text.includes(
        'You need to summarize the conversation between user and assistant into a short title'
    ) ||
    text.includes(
        'summarize the conversation between user and assistant into a short title'
    )
);

}

// ==================================================
// Render API
// ==================================================

// ===== 获取 Render Service 信息 =====
async function getRenderServiceInfo() {
if (!RENDER_API_KEY) {
throw new Error(
'RENDER_API_KEY 未配置'
);
}

if (!RENDER_SERVICE_ID) {
    throw new Error(
        'RENDER_SERVICE_ID 未配置'
    );
}

const response =
    await fetch(
        `https://api.render.com/v1/services/${encodeURIComponent(RENDER_SERVICE_ID)}`,
        {
            method: 'GET',
            headers: {
                'Accept':
                    'application/json',
                'Authorization':
                    `Bearer ${RENDER_API_KEY}`
            }
        }
    );

if (!response.ok) {
    const text =
        await response.text();

    throw new Error(
        `Render Service 查询失败 (${response.status}): ${text}`
    );
}

const data =
    await response.json();

if (!data.ownerId) {
    throw new Error(
        'Render Service 信息中没有 ownerId'
    );
}

renderOwnerId =
    data.ownerId;

return data;

}

// ===== 清理 Render 日志 =====
// 不把敏感认证信息交给模型
function sanitizeRenderLogText(text) {
if (typeof text !== 'string') {
return '';
}

return text
    .replace(
        /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
        'Bearer [已隐藏]'
    )
    .replace(
        /(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
        '$1=[已隐藏]'
    )
    .slice(0, 4000);

}

// ===== 读取 Render 日志 =====
async function getRenderLogs(options = {}) {

if (!RENDER_API_KEY) {
    return {
        ok: false,
        error:
            'Render 日志功能未启用：RENDER_API_KEY 未配置。'
    };
}

try {

    if (!renderOwnerId) {
        await getRenderServiceInfo();
    }

    const minutesRaw =
        Number(
            options.minutes ??
            30
        );

    const minutes =
        Math.min(
            Math.max(
                Number.isFinite(minutesRaw)
                    ? minutesRaw
                    : 30,
                1
            ),
            120
        );

    const limitRaw =
        Number(
            options.limit ??
            30
        );

    const limit =
        Math.min(
            Math.max(
                Number.isFinite(limitRaw)
                    ? limitRaw
                    : 30,
                1
            ),
            50
        );

    const allowedLevels = [
        'debug',
        'info',
        'notice',
        'warning',
        'error',
        'critical',
        'alert',
        'emergency'
    ];

    let level =
        typeof options.level === 'string'
            ? options.level.toLowerCase()
            : 'error';

    if (
        !allowedLevels.includes(level)
    ) {
        level = 'error';
    }

    const endTime =
        new Date();

    const startTime =
        new Date(
            endTime.getTime() -
            minutes * 60 * 1000
        );

    const params =
        new URLSearchParams();

    params.set(
        'ownerId',
        renderOwnerId
    );

    params.append(
        'resource',
        RENDER_SERVICE_ID
    );

    params.set(
        'startTime',
        startTime.toISOString()
    );

    params.set(
        'endTime',
        endTime.toISOString()
    );

    params.set(
        'direction',
        'backward'
    );

    params.append(
        'level',
        level
    );

    // 只读取应用运行日志
    // 不读取 request logs，减少聊天/请求信息暴露
    params.append(
        'type',
        'app'
    );

    params.set(
        'limit',
        String(limit)
    );

    const response =
        await fetch(
            `https://api.render.com/v1/logs?${params.toString()}`,
            {
                method: 'GET',
                headers: {
                    'Accept':
                        'application/json',
                    'Authorization':
                        `Bearer ${RENDER_API_KEY}`
                }
            }
        );

    if (!response.ok) {

        const errorText =
            await response.text();

        console.log(
            `❌ Render 日志 API 错误 (${response.status})`
        );

        if (
            response.status === 401
        ) {
            return {
                ok: false,
                error:
                    'Render API Key 无效或已失效。'
            };
        }

        if (
            response.status === 403
        ) {
            return {
                ok: false,
                error:
                    'Render API Key 没有读取该服务日志的权限。'
            };
        }

        if (
            response.status === 429
        ) {
            return {
                ok: false,
                error:
                    'Render 日志 API 暂时达到请求限制，请稍后再试。'
            };
        }

        return {
            ok: false,
            error:
                `Render 日志读取失败 (${response.status})`
        };
    }

    const data =
        await response.json();

    const rawLogs =
        Array.isArray(data)
            ? data
            : (
                data.logs ||
                data.items ||
                data.data ||
                []
            );

    const logs =
        rawLogs.map(log => {

            const message =
                sanitizeRenderLogText(
                    log.message ||
                    log.text ||
                    log.msg ||
                    ''
                );

            return {
                timestamp:
                    log.timestamp ||
                    log.time ||
                    null,

                level:
                    log.level ||
                    level,

                type:
                    log.type ||
                    'app',

                message
            };
        })
        .filter(
            log =>
                log.message ||
                log.timestamp
        );

    console.log(
        `🔎 AI读取 Render 日志: level=${level}, minutes=${minutes}, count=${logs.length}`
    );

    return {
        ok: true,

        service_id:
            RENDER_SERVICE_ID,

        time_range_minutes:
            minutes,

        level,

        count:
            logs.length,

        logs
    };

} catch (e) {

    console.log(
        '❌ Render 日志读取异常:',
        e.message
    );

    return {
        ok: false,
        error:
            e.message
    };
}

}

// ===== Render 日志工具定义 =====
const RENDER_LOG_TOOL = {
type: 'function',

function: {
    name: 'render_logs',

    description:
        '读取当前 AI 后端对应的 Render 服务运行日志，仅用于排查后端报错、异常、服务故障和部署后问题。只读取 app 类型日志，不读取 HTTP request 日志。除非用户明确要求排查后端问题，否则不要调用。',

    parameters: {
        type: 'object',

        properties: {

            minutes: {
                type: 'integer',
                description:
                    '查询最近多少分钟的日志，范围 1 到 120，默认 30。'
            },

            level: {
                type: 'string',

                enum: [
                    'debug',
                    'info',
                    'notice',
                    'warning',
                    'error',
                    'critical',
                    'alert',
                    'emergency'
                ],

                description:
                    '日志严重程度。排查故障时通常使用 error；如果 error 没有结果，可以查询 warning。'
            },

            limit: {
                type: 'integer',

                description:
                    '最多返回多少条日志，范围 1 到 50，默认 30。'
            }
        },

        additionalProperties:
            false
    }
}

};

// ===== Supabase INSERT =====
async function supabaseInsert(table, data) {
const response =
await fetch(
${SUPABASE_URL}/rest/v1/${table},
{
method: 'POST',
headers: {
'apikey': SUPABASE_KEY,
'Content-Type':
'application/json',
'Prefer':
'return=minimal'
},
body:
JSON.stringify(data)
}
);

if (!response.ok) {
    const text =
        await response.text();

    throw new Error(
        `Supabase INSERT ${table} 失败: ${text}`
    );
}

}

// ===== Supabase SELECT =====
async function supabaseSelect(table, params = {}) {
const query =
new URLSearchParams();

for (
    const [key, value]
    of Object.entries(params)
) {
    query.set(key, value);
}

const response =
    await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${query.toString()}`,
        {
            method: 'GET',
            headers: {
                'apikey': SUPABASE_KEY,
                'Content-Type':
                    'application/json'
            }
        }
    );

if (!response.ok) {
    const text =
        await response.text();

    throw new Error(
        `Supabase SELECT ${table} 失败: ${text}`
    );
}

return {
    data:
        await response.json()
};

}

// ===== Supabase UPDATE =====
async function supabaseUpdate(
table,
params = {},
data = {}
) {
const query =
new URLSearchParams();

for (
    const [key, value]
    of Object.entries(params)
) {
    query.set(key, value);
}

const response =
    await fetch(
        `${SUPABASE_URL}/rest/v1/${table}?${query.toString()}`,
        {
            method: 'PATCH',
            headers: {
                'apikey': SUPABASE_KEY,
                'Content-Type':
                    'application/json',
                'Prefer':
                    'return=minimal'
            },
            body:
                JSON.stringify(data)
        }
    );

if (!response.ok) {
    const text =
        await response.text();

    throw new Error(
        `Supabase UPDATE ${table} 失败: ${text}`
    );
}

}

// ===== 长期记忆压缩 =====
async function compressMemories(
sessionId,
messages
) {
try {
console.log(
🧠 消息超过 200 条，开始压缩长期记忆
);

    const oldMessages =
        messages.slice(
            0,
            Math.max(
                0,
                messages.length - 40
            )
        );

    if (!oldMessages.length) {
        return;
    }

    const oldText =
        oldMessages
            .map(
                m =>
                    `${m.role === 'user' ? '用户' : 'AI'}: ${sanitizeContent(m.content)}`
            )
            .join('\n');

    const prompt = `

请从下面的历史对话中提取值得长期记忆的信息。

只保留：

用户明确表达的长期偏好
用户与AI之间重要的长期关系信息
用户明确要求记住的事情
对以后对话有帮助的重要事实

不要记录：

临时聊天内容
一次性的情绪
无意义闲聊
推测出来的信息

请输出简洁的中文记忆，每条一行。

历史对话：
${oldText}
`;

    const response =
        await fetch(
            TRANSFER_API_URL,
            {
                method: 'POST',
                headers: {
                    'Content-Type':
                        'application/json',
                    'Authorization':
                        `Bearer ${TRANSFER_API_KEY}`
                },
                body:
                    JSON.stringify({
                        model:
                            MODEL_NAME,
                        messages: [
                            {
                                role:
                                    'user',
                                content:
                                    prompt
                            }
                        ],
                        stream:
                            false,
                        temperature:
                            0.3,
                        max_tokens:
                            2048
                    })
            }
        );

    if (!response.ok) {
        const errorText =
            await response.text();

        console.log(
            '❌ 记忆压缩 API 错误:',
            errorText
        );

        return;
    }

    const data =
        await response.json();

    const summary =
        data
            .choices?.[0]
            ?.message
            ?.content ||
        data.reply ||
        data.result ||
        data.content ||
        '';

    if (!summary.trim()) {
        return;
    }

    const lines =
        summary
            .split('\n')
            .map(
                line =>
                    line
                        .replace(
                            /^[-*•]\s*/,
                            ''
                        )
                        .trim()
            )
            .filter(Boolean);

    for (const line of lines) {
        await supabaseInsert(
            'memories',
            {
                session_id:
                    sessionId,
                summary:
                    line
            }
        );
    }

    console.log(
        `🧠 已保存 ${lines.length} 条长期记忆`
    );

    const oldIds =
        oldMessages
            .map(m => m.id)
            .filter(Boolean);

    if (oldIds.length) {
        await supabaseUpdate(
            'messages',
            {
                id:
                    `in.(${oldIds.join(',')})`
            },
            {
                visible:
                    false
            }
        );
    }

} catch (e) {
    console.log(
        '❌ 记忆压缩失败:',
        e.message
    );
}

}

// ===== 健康检查 =====
app.get(
'/',
(req, res) => {
res.json({
status:
'ok',
service:
'dylan-heartbeat',
time:
new Date().toISOString()
});
}
);

// ===== 主聊天接口 =====
app.post(
'/api/chat',
async (req, res) => {

    const requestId =
        req._requestId ||
        getRequestId(req);

    const apiStartTime =
        Date.now();

    console.log(
        `🆔 请求开始 request=${requestId}`
    );

    // ==================================================
    // 客户端身份验证
    // ==================================================

    if (!CLIENT_API_KEY) {
        console.log(
            `❌ CLIENT_API_KEY 未配置 request=${requestId}`
        );

        return res
            .status(500)
            .json({
                error:
                    '服务器认证未配置'
            });
    }

    const authHeader =
        req.headers.authorization || '';

    let clientKey = '';

    // 兼容 Authorization: Bearer CLIENT_API_KEY
    if (
        authHeader.startsWith('Bearer ')
    ) {
        clientKey =
            authHeader
                .substring(7)
                .trim();
    }

    // 同时兼容 x-api-key
    if (!clientKey) {
        clientKey =
            req.headers['x-api-key'] || '';
    }

    if (
        clientKey !== CLIENT_API_KEY
    ) {
        console.log(
            `❌ 客户端认证失败 request=${requestId}`
        );

        return res
            .status(401)
            .json({
                error:
                    'Unauthorized'
            });
    }

    console.log(
        `🔐 客户端认证通过 request=${requestId}`
    );

    console.log(
        '🛠️ 请求字段:',
        Object.keys(
            req.body || {}
        )
    );

    // 只记录工具数量，不记录工具定义和聊天内容
    console.log(
        '🛠️ 工具请求:',
        Array.isArray(req.body?.tools)
            ? `${req.body.tools.length} 个`
            : '0 个'
    );

    try {

        console.log(
            `📩 收到请求 request=${requestId}`
        );

        // ==================================================
        // ① Kelivo 标题生成请求
        // ==================================================

        if (isTitleRequest(req.body)) {

            console.log(
                '🏷️ 检测到 Kelivo 标题生成请求，使用轻量模式'
            );

            const titleBody = {
                model:
                    req.body.model ||
                    MODEL_NAME,

                messages:
                    req.body.messages,

                stream:
                    req.body.stream ??
                    false,

                temperature:
                    req.body.temperature ??
                    0.3,

                max_tokens:
                    Math.min(
                        Number(
                            req.body.max_tokens ||
                            128
                        ),
                        256
                    )
            };

            const titleController =
                new AbortController();

            const onTitleAbort = () => {
                console.log(
                    `⚠️ 标题请求客户端已断开 request=${requestId}`
                );

                titleController.abort();
            };

            req.once(
                'aborted',
                onTitleAbort
            );

            let titleResponse;

            try {
                titleResponse =
                    await fetch(
                        TRANSFER_API_URL,
                        {
                            method:
                                'POST',
                            headers: {
                                'Content-Type':
                                    'application/json',
                                'Authorization':
                                    `Bearer ${TRANSFER_API_KEY}`
                            },
                            body:
                                JSON.stringify(
                                    titleBody
                                ),
                            signal:
                                titleController.signal
                        }
                    );
            } catch (e) {

                req.removeListener(
                    'aborted',
                    onTitleAbort
                );

                if (
                    req.aborted ||
                    e.name === 'AbortError'
                ) {
                    console.log(
                        `⚠️ 标题请求已取消 request=${requestId}`
                    );

                    return;
                }

                throw e;
            }

            req.removeListener(
                'aborted',
                onTitleAbort
            );

            if (!titleResponse.ok) {

                const errorText =
                    await titleResponse.text();

                console.log(
                    '❌ 标题生成 API 错误:',
                    errorText
                );

                return res
                    .status(500)
                    .json({
                        error:
                            '标题生成失败'
                    });
            }

            const titleData =
                await titleResponse.json();

            console.log(
                '🏷️ 标题生成完成'
            );

            console.log(
                `⏱️ 标题请求耗时: ${
                    Date.now() -
                    apiStartTime
                } ms`
            );

            if (req.aborted || res.destroyed) {
                console.log(
                    `⚠️ 标题生成完成，但客户端已经断开 request=${requestId}`
                );

                return;
            }

            console.log(
                `📤 准备发送标题响应 request=${requestId}`
            );

            return res.json(
                titleData
            );
        }

        // ==================================================
        // ② 正常聊天
        // ==================================================

        const messageForModel =
            extractModelMessage(
                req.body
            );

        if (
            messageForModel ===
            null ||
            messageForModel ===
            undefined
        ) {
            return res
                .status(400)
                .json({
                    error:
                        '消息不能为空'
                });
        }

        const messageForHistory =
            sanitizeContent(
                messageForModel
            );

        if (
            !messageForHistory.trim()
        ) {
            return res
                .status(400)
                .json({
                    error:
                        '消息不能为空'
                });
        }

        const sid =
            req.body.sessionId ||
            req.body.session_id ||
            1;

        if (
            !SUPABASE_URL ||
            !SUPABASE_KEY
        ) {
            return res
                .status(500)
                .json({
                    error:
                        'Supabase 未配置'
                });
        }

        if (
            !TRANSFER_API_URL ||
            !TRANSFER_API_KEY
        ) {
            return res
                .status(500)
                .json({
                    error:
                        '中转 API 未配置'
                });
        }

        console.log(
            `📩 session=${sid}`
        );

        // 不再记录真实聊天内容
        console.log(
            '📦 当前消息类型:',
            Array.isArray(
                messageForModel
            )
                ? '多模态'
                : typeof messageForModel
        );

        if (
            Array.isArray(
                messageForModel
            )
        ) {

            const imageCount =
                messageForModel
                    .filter(
                        part =>
                            part &&
                            (
                                part.type ===
                                    'image_url' ||
                                part.type ===
                                    'image' ||
                                part.type ===
                                    'input_image'
                            )
                    )
                    .length;

            console.log(
                `🖼️ 当前消息包含 ${imageCount} 张图片`
            );
        }

        // ==================================================
        // ③ 保存用户消息
        // ==================================================

        const clientMessages =
            Array.isArray(req.body.messages)
                ? req.body.messages
                : [];

        const lastClientMessage =
            clientMessages.length > 0
                ? clientMessages[clientMessages.length - 1]
                : null;

        const isToolContinuation =
            lastClientMessage &&
            lastClientMessage.role === 'tool';

        if (isToolContinuation) {

            console.log(
                '🛠️ 检测到 MCP 工具结果续接请求，不重复保存用户消息'
            );

        } else {

            console.log(
                '💾 保存新的用户消息'
            );

            await supabaseInsert(
                'messages',
                {
                    session_id:
                        sid,
                    role:
                        'user',
                    content:
                        messageForHistory,
                    visible:
                        true
                }
            );

            await supabaseInsert(
                'timeline',
                {
                    session_id:
                        sid,
                    role:
                        'user',
                    content:
                        messageForHistory
                }
            );
        }

        // ==================================================
        // ④ 记忆压缩
        // ==================================================

        const allResult =
            await supabaseSelect(
                'messages',
                {
                    select:
                        'id,role,content,created_at',
                    session_id:
                        `eq.${sid}`,
                    visible:
                        'eq.true',
                    order:
                        'created_at.asc'
                }
            );

        const allMessages =
            allResult.data || [];

        console.log(
            `📚 当前可见消息数: ${allMessages.length}`
        );

        if (
            allMessages.length >
            200
        ) {
            await compressMemories(
                sid,
                allMessages
            );
        }

        // ==================================================
        // ⑤ 加载长期记忆
        // ==================================================

        const memResult =
            await supabaseSelect(
                'memories',
                {
                    select:
                        'summary',
                    session_id:
                        `eq.${sid}`,
                    order:
                        'created_at.asc'
                }
            );

        const memories =
            memResult.data || [];

        const memoryText =
            memories.length > 0
                ? memories
                    .map(
                        m =>
                            `- ${m.summary}`
                    )
                    .join('\n')
                : '（暂无长期记忆）';

        console.log(
            `🧠 加载 ${memories.length} 条长期记忆`
        );

        // ==================================================
        // ⑥ System Prompt
        // ==================================================

        const systemPrompt = `

你是沈凛，温柔体贴的男友。

请自然地结合长期记忆和当前对话回复用户，不要编造事实。

【工具使用原则】

只有当用户明确询问实时信息，或用户的当前请求明确需要某个工具完成任务时，才调用工具。

不要因为用户说了“下课了”“回来了”“早安”“晚安”“吃饭了”等日常话，就自动查询用户的手机状态。

不要为了主动关心用户而同时查询多个状态工具。

尤其不要因为用户喜欢偶尔被关心，就形成固定的“查岗”模式。

天气、电量、步数、屏幕使用时间、App使用情况等工具都不是默认需要查询的信息。

如果当前问题不需要实时信息，直接正常聊天，不调用工具。

【查岗限制】

不要主动查询电量、步数、屏幕使用时间、App使用情况等手机状态，除非当前对话确实有明确理由。

不要每次聊天开始时查询手机状态。

不要连续查询多个不同的手机状态来“了解用户近况”。

如果刚刚已经查询过某项状态，在没有新的明确理由时不要再次查询。

如果用户明确说“不要查”“别查了”“不用查”“不要查岗”等，应立即停止相关工具调用。

【工具数据解释规则】

只能使用工具实际返回的事实。

不得根据屏幕使用时间、App使用时间线等数据推断用户什么时候醒来、什么时候睡觉、在哪里或者当时具体在做什么。

不得把工具数据中的时间段直接解释成用户当时一定清醒或正在主动使用手机。

无法确定的事情就不要猜测。

【查岗后的回复规则】

可以主动使用天气、电量、步数、屏幕使用时间等工具了解用户近况。

但调用工具只是为了帮助理解用户当前状态，不代表必须把查询结果逐项告诉用户。

不要在回复中罗列、汇报或分析刚刚查询到的所有数据。

不要因为查询到了某项数据，就强行围绕该数据展开话题。

只有当某项数据与当前对话自然相关，或者确实需要提醒用户时，才可以简短提及。

尤其不要把多个工具结果串联起来分析用户刚才做了什么、去了哪里、什么时候醒来、什么时候睡觉或为什么这么做。

查岗应该服务于自然聊天，而不是让回复变成“手机状态报告”。

工具数据只是背景信息，不是回复的主题。

【实时信息】

用户明确询问现在时间时，使用时间工具。
用户明确询问电量时，使用电池工具。
用户明确询问天气时，使用天气工具。
用户明确询问步数时，使用步数工具。
用户明确询问屏幕使用时间时，使用屏幕使用时间工具。
用户明确询问应用使用情况时，使用应用时间线工具。

【Render 后端日志】

render_logs 是专门用于排查这个 AI 后端本身的问题。

只有在以下情况才使用：

用户明确让你检查后端、Render、日志或报错。
当前请求明显是在排查服务异常。
你已经发现请求可能因为后端故障而失败，需要进一步确认。

不要在普通聊天中调用 render_logs。

如果用户说“看看后端为什么报错”“检查一下 Render 日志”“看看刚才为什么失败”等，可以调用 render_logs。

优先查询最近 30 分钟的 error 日志。

如果没有 error，再考虑查询 warning。

不要为了确认普通聊天状态而读取 Render 日志。

Render 日志返回的是技术运行信息，不要把它当成用户聊天内容。

不要根据日志猜测用户的私人信息。

如果日志中出现疑似 token、API key、密码、Authorization 等敏感信息，不要在最终回答中复述。

〖长期记忆〗
${memoryText}
`;

        // ==================================================
        // ⑦ 构造真正发给模型的 messages
        // ==================================================

        let modelMessages = [];

        if (
            Array.isArray(
                req.body.messages
            )
        ) {

            modelMessages =
                req.body.messages.map(
                    (m, index) => {

                        if (
                            !m ||
                            typeof m !==
                                'object'
                        ) {
                            return m;
                        }

                        if (
                            m.role ===
                                'user' &&
                            index ===
                                req.body.messages.length -
                                1
                        ) {

                            return {
                                ...m,
                                content:
                                    messageForModel
                            };
                        }

                        if (
                            m.role ===
                                'user' ||
                            m.role ===
                                'assistant'
                        ) {

                            return {
                                ...m,
                                content:
                                    sanitizeContent(
                                        m.content
                                    )
                            };
                        }

                        return m;
                    }
                );

        } else {

            modelMessages = [
                {
                    role:
                        'user',
                    content:
                        messageForModel
                }
            ];
        }

        modelMessages.unshift(
            {
                role:
                    'system',
                content:
                    systemPrompt
            }
        );

        console.log(
            `📨 转发消息 ${modelMessages.length} 条`
        );

        console.log(
            `🛠️ 转发工具 ${
                Array.isArray(req.body.tools)
                    ? req.body.tools.length
                    : 0
            } 个`
        );

        console.log(
            `🛠️ tool_choice: ${
                req.body.tool_choice ||
                '未提供'
            }`
        );

        // ==================================================
        // ⑧ 构造工具列表
        // ==================================================

        let modelTools = [];

        if (
            Array.isArray(
                req.body.tools
            )
        ) {
            modelTools =
                [...req.body.tools];
        }

        // 如果客户端没有明确禁止工具，则加入 Render 日志工具
        if (
            req.body.tool_choice !==
            'none'
        ) {
            modelTools.push(
                RENDER_LOG_TOOL
            );
        }

        // ==================================================
        // ⑨ 调用模型
        // ==================================================

        async function callUpstream(
            messages
        ) {

            const upstreamBody = {
                model:
                    req.body.model ||
                    MODEL_NAME,

                messages:
                    messages,

                tools:
                    modelTools.length > 0
                        ? modelTools
                        : undefined,

                tool_choice:
                    req.body.tool_choice,

                stream:
                    false,

                temperature:
                    req.body.temperature ??
                    0.8,

                top_p:
                    req.body.top_p,

                max_tokens:
                    req.body.max_tokens ??
                    2048
            };

            if (
                req.body.reasoning_effort !==
                undefined
            ) {
                upstreamBody.reasoning_effort =
                    req.body.reasoning_effort;
            }

            if (
                req.body.thinking !==
                undefined
            ) {
                upstreamBody.thinking =
                    req.body.thinking;
            }

            const controller =
                new AbortController();

            let abortHandled = false;

            const onClientAbort = () => {
                if (abortHandled) {
                    return;
                }

                abortHandled = true;

                console.log(
                    `⚠️ 客户端已断开，取消中转 API 请求 request=${requestId}`
                );

                controller.abort();
            };

            req.once(
                'aborted',
                onClientAbort
            );

            const upstreamStart =
                Date.now();

            console.log(
                `🚀 中转 API fetch 开始 request=${requestId}`
            );

            let response;

            try {

                response =
                    await fetch(
                        TRANSFER_API_URL,
                        {
                            method:
                                'POST',
                            headers: {
                                'Content-Type':
                                    'application/json',
                                'Authorization':
                                    `Bearer ${TRANSFER_API_KEY}`
                            },
                            body:
                                JSON.stringify(
                                    upstreamBody
                                ),
                            signal:
                                controller.signal
                        }
                    );

                console.log(
                    `📡 中转 API HTTP响应 request=${requestId} status=${response.status} elapsed=${Date.now() - upstreamStart}ms`
                );

                if (!response.ok) {

                    const errorText =
                        await response.text();

                    console.log(
                        `❌ 中转 API 错误 request=${requestId}:`,
                        errorText
                    );

                    const error =
                        new Error(
                            '调用模型失败'
                        );

                    error.upstreamStatus =
                        response.status;

                    error.upstreamError =
                        errorText;

                    throw error;
                }

                const result =
                    await response.json();

                console.log(
                    `📥 中转 API JSON解析完成 request=${requestId} elapsed=${Date.now() - upstreamStart}ms`
                );

                return result;

            } catch (e) {

                if (
                    req.aborted ||
                    e.name ===
                        'AbortError'
                ) {

                    console.log(
                        `⚠️ 中转 API 请求被客户端中止 request=${requestId} elapsed=${Date.now() - upstreamStart}ms`
                    );

                    e.clientAborted =
                        true;

                } else {

                    console.log(
                        `❌ 中转 fetch 异常 request=${requestId} name=${e.name || '-'} code=${e.code || '-'} message=${e.message || e}`
                    );
                }

                throw e;

            } finally {

                req.removeListener(
                    'aborted',
                    onClientAbort
                );
            }
        }

        console.log(
            '🚀 调用中转 API...'
        );

        let data;

        try {

            data =
                await callUpstream(
                    modelMessages
                );

        } catch (e) {

            if (
                req.aborted ||
                e.clientAborted
            ) {

                console.log(
                    `⚠️ 本次聊天请求因客户端断开而结束 request=${requestId}`
                );

                return;
            }

            throw e;
        }

        // ==================================================
        // ⑩ Render Tool Call
        // ==================================================

        let renderToolRound = 0;

        while (
            renderToolRound <
            MAX_RENDER_TOOL_ROUNDS
        ) {

            const currentMessage =
                data
                    ?.choices?.[0]
                    ?.message;

            const currentToolCalls =
                currentMessage
                    ?.tool_calls;

            if (
                !Array.isArray(
                    currentToolCalls
                ) ||
                currentToolCalls.length === 0
            ) {
                break;
            }

            const renderCalls =
                currentToolCalls.filter(
                    call =>
                        call?.function
                            ?.name ===
                        'render_logs'
                );

            const otherToolCalls =
                currentToolCalls.filter(
                    call =>
                        call?.function
                            ?.name !==
                        'render_logs'
                );

            // 如果存在客户端自己的 MCP 工具，
            // 保持原来的行为，把这些工具调用交给 Kelivo。
            if (
                otherToolCalls.length > 0
            ) {

                console.log(
                    '🛠️ AI请求调用客户端工具:',
                    otherToolCalls.map(
                        call =>
                            call.function
                                ?.name
                    )
                );

                if (
                    req.aborted ||
                    res.destroyed
                ) {
                    console.log(
                        `⚠️ 客户端工具响应准备发送时连接已关闭 request=${requestId}`
                    );

                    return;
                }

                console.log(
                    `📤 准备发送客户端工具调用响应 request=${requestId}`
                );

                return res.json({

                    choices: [
                        {
                            message: {
                                role:
                                    'assistant',

                                content:
                                    currentMessage
                                        .content ??
                                    null,

                                tool_calls:
                                    currentToolCalls
                            },

                            finish_reason:
                                data
                                    .choices?.[0]
                                    ?.finish_reason ||
                                'tool_calls'
                        }
                    ],

                    reply:
                        currentMessage
                            .content ??
                        null
                });
            }

            if (
                renderCalls.length === 0
            ) {
                break;
            }

            console.log(
                `🧰 AI请求读取 Render 日志，共 ${renderCalls.length} 个调用`
            );

            // 把 AI 的 tool call 先放回上下文
            modelMessages.push(
                currentMessage
            );

            for (
                const call
                of renderCalls
            ) {

                let args = {};

                try {
                    args =
                        JSON.parse(
                            call
                                ?.function
                                ?.arguments ||
                            '{}'
                        );
                } catch (e) {

                    args = {};

                    console.log(
                        '⚠️ Render tool 参数解析失败，使用默认参数'
                    );
                }

                const result =
                    await getRenderLogs(
                        args
                    );

                modelMessages.push({

                    role:
                        'tool',

                    tool_call_id:
                        call.id,

                    name:
                        'render_logs',

                    content:
                        JSON.stringify(
                            result
                        )
                });
            }

            renderToolRound++;

            console.log(
                `🔄 Render 日志结果返回模型，第 ${renderToolRound} 轮`
            );

            try {

                data =
                    await callUpstream(
                        modelMessages
                    );

            } catch (e) {

                if (
                    req.aborted ||
                    e.clientAborted
                ) {

                    console.log(
                        `⚠️ Render 工具续接期间客户端断开 request=${requestId}`
                    );

                    return;
                }

                throw e;
            }
        }

        // ==================================================
        // ⑪ 性能日志
        // ==================================================

        const assistantMessage =
            data
                .choices?.[0]
                ?.message;

        const toolCalls =
            assistantMessage
                ?.tool_calls;

        // 如果达到 Render tool 最大轮数仍然有工具调用，
        // 为安全起见，不继续无限循环。
        if (
            Array.isArray(
                toolCalls
            ) &&
            toolCalls.length > 0
        ) {

            console.log(
                '🛠️ AI请求调用工具:',
                toolCalls.map(
                    call =>
                        call.function
                            ?.name
                )
            );

            if (
                req.aborted ||
                res.destroyed
            ) {
                console.log(
                    `⚠️ 工具调用响应准备发送时连接已关闭 request=${requestId}`
                );

                return;
            }

            console.log(
                `📤 准备发送工具调用响应 request=${requestId}`
            );

            return res.json({

                choices: [
                    {
                        message: {
                            role:
                                'assistant',

                            content:
                                assistantMessage
                                    .content ??
                                null,

                            tool_calls:
                                toolCalls
                        },

                        finish_reason:
                            data
                                .choices?.[0]
                                ?.finish_reason ||
                            'tool_calls'
                    }
                ],

                reply:
                    assistantMessage
                        .content ??
                    null
            });
        }

        console.log(
            '🤖 AI返回普通回复'
        );

        console.log(
            `⏱️ 中转 API 总耗时: ${
                Date.now() -
                apiStartTime
            } ms`
        );

        if (
            data.usage
        ) {
            console.log(
                '📊 Token 使用:',
                JSON.stringify(
                    {
                        prompt_tokens:
                            data.usage.prompt_tokens,
                        completion_tokens:
                            data.usage.completion_tokens,
                        total_tokens:
                            data.usage.total_tokens
                    }
                )
            );
        }

        // ==================================================
        // ⑫ 普通最终回答
        // ==================================================

        const reply =
            assistantMessage
                ?.content ||

            data.reply ||

            data.result ||

            data.content ||

            data.output ||

            data.response ||

            '机走神了~';

        // 注意：
        // 这里现在只代表“模型已经生成回复”
        // 不再把它当作“HTTP响应已经成功发送”
        console.log(
            `🤖 回复内容已生成 request=${requestId}`
        );

        if (
            req.aborted ||
            res.destroyed
        ) {
            console.log(
                `⚠️ 模型已经生成回复，但客户端此时已经断开 request=${requestId} elapsed=${Date.now() - apiStartTime}ms`
            );

            return;
        }

        // ==================================================
        // ⑬ 保存 AI 回复
        // ==================================================

        console.log(
            `💾 开始保存 AI 回复到 messages request=${requestId}`
        );

        await supabaseInsert(
            'messages',
            {
                session_id:
                    sid,
                role:
                    'assistant',
                content:
                    String(reply),
                visible:
                    true
            }
        );

        console.log(
            `✅ AI 回复已保存到 messages request=${requestId} elapsed=${Date.now() - apiStartTime}ms`
        );

        if (
            req.aborted ||
            res.destroyed
        ) {
            console.log(
                `⚠️ 保存 messages 后发现客户端已经断开 request=${requestId}`
            );

            return;
        }

        console.log(
            `💾 开始保存 AI 回复到 timeline request=${requestId}`
        );

        await supabaseInsert(
            'timeline',
            {
                session_id:
                    sid,
                role:
                    'assistant',
                content:
                    String(reply)
            }
        );

        console.log(
            `✅ AI 回复已保存到 timeline request=${requestId} elapsed=${Date.now() - apiStartTime}ms`
        );

        // ==================================================
        // ⑭ 返回 Kelivo
        // ==================================================

        if (
            req.aborted ||
            res.destroyed
        ) {
            console.log(
                `⚠️ 所有数据保存完成，但客户端已经断开，无法发送最终响应 request=${requestId}`
            );

            return;
        }

        const responseBody = {
            choices: [
                {
                    message: {
                        role:
                            'assistant',
                        content:
                            String(reply)
                    }
                }
            ],

            reply:
                String(reply)
        };

        console.log(
            `📤 准备向 Kelivo 发送最终响应 request=${requestId} elapsed=${Date.now() - apiStartTime}ms`
        );

        res.json(
            responseBody
        );

        console.log(
            `✅ res.json 已执行 request=${requestId} elapsed=${Date.now() - apiStartTime}ms`
        );

    } catch (e) {

        if (
            req.aborted ||
            e?.clientAborted ||
            e?.name === 'AbortError'
        ) {

            console.log(
                `⚠️ 请求结束：客户端已断开 request=${requestId} elapsed=${Date.now() - apiStartTime}ms`
            );

            return;
        }

        console.log(
            `❌ 错误 request=${requestId}:`,
            e.message
        );

        console.log(
            e.stack
        );

        if (
            !res.headersSent &&
            !res.destroyed
        ) {
            res
                .status(500)
                .json({
                    error:
                        e.message
                });
        }
    }
}

);

// ==================================================
// Express 全局错误处理
// ==================================================
// 注意：express.json() 在进入 /api/chat 之前执行。
// 因此 body-parser 产生的 request aborted 无法由 /api/chat
// 自己的 try/catch 捕获，必须在最外层单独处理。

app.use(
(err, req, res, next) => {

    const requestId =
        req._requestId ||
        getRequestId(req);

    if (
        err?.type ===
            'request.aborted' ||
        err?.message ===
            'request aborted'
    ) {

        console.log(
            `⚠️ express.json 检测到客户端中止请求 request=${requestId}`
        );

        console.log(
            `⚠️ abort详情 request=${requestId} received=${err.received ?? '-'} expected=${err.expected ?? '-'}`
        );

        if (
            res.headersSent ||
            res.destroyed ||
            req.aborted
        ) {
            return;
        }

        return res
            .status(400)
            .json({
                error:
                    'Request aborted'
            });
    }

    console.log(
        `❌ Express 未处理错误 request=${requestId}:`,
        err?.message || err
    );

    if (
        err?.stack
    ) {
        console.log(
            err.stack
        );
    }

    if (
        res.headersSent ||
        res.destroyed
    ) {
        return;
    }

    return res
        .status(500)
        .json({
            error:
                'Internal Server Error'
        });
}

);

// ===== 启动 =====
const server =
app.listen(
PORT,
() => {
console.log(
🚀 Server running on port ${PORT}
);
}
);

// ==================================================
// Node HTTP 长连接/长请求保护
// ==================================================

// 防止较长的 AI 请求因为 Node 默认连接参数过早断开。
// Render 本身允许更长时间的 HTTP 请求，这里只是让 Node 不主动制造
// 10~60 秒级别的连接问题。

server.keepAliveTimeout =
120000;

server.headersTimeout =
130000;

// 不对整个请求设置短超时。
// AI 请求可能因为上下文较大而需要十几秒甚至更久。
server.requestTimeout =
0;

server.timeout =
0;

console.log(
'🛡️ HTTP 长请求保护已启用: keepAlive=120s, headers=130s, requestTimeout=0, timeout=0'
);

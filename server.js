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
        String(Date.now()) + '-' +
        Math.random().toString(36).slice(2, 8)
    );
}

function setupRequestLifecycle(req, res) {
    const requestId = getRequestId(req);
    const startTime = Date.now();

    req._requestId = requestId;
    req._requestStartTime = startTime;

    req.once('aborted', () => {
        console.log(
            '⚠️ 客户端中止请求 request=' +
            requestId +
            ' elapsed=' +
            (Date.now() - startTime) +
            'ms'
        );
    });

    req.once('error', (err) => {
        console.log(
            '⚠️ 请求流错误 request=' +
            requestId +
            ':',
            err?.message || err
        );
    });

    res.once('finish', () => {
        console.log(
            '📤 HTTP响应已发送 request=' +
            requestId +
            ' status=' +
            res.statusCode +
            ' elapsed=' +
            (Date.now() - startTime) +
            'ms'
        );
    });

    res.once('close', () => {
        if (!res.writableEnded) {
            console.log(
                '⚠️ HTTP连接提前关闭 request=' +
                requestId +
                ' elapsed=' +
                (Date.now() - startTime) +
                'ms'
            );
        }
    });

    return requestId;
}

// 在 JSON body parser 之前监听请求
app.use((req, res, next) => {
    setupRequestLifecycle(req, res);
    next();
});

// ==================================================
// CORS
// ==================================================

app.use((req, res, next) => {
    res.setHeader(
        'Access-Control-Allow-Origin',
        '*'
    );

    res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, OPTIONS'
    );

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
app.use(
    express.json({
        limit: '10mb'
    })
);

// ==================================================
// 环境变量
// ==================================================

const SUPABASE_URL =
    process.env.SUPABASE_URL;

const SUPABASE_KEY =
    process.env.SUPABASE_KEY;

const TRANSFER_API_URL =
    process.env.TRANSFER_API_URL;

const TRANSFER_API_KEY =
    process.env.TRANSFER_API_KEY;

const CLIENT_API_KEY =
    process.env.CLIENT_API_KEY;

const MODEL_NAME =
    process.env.MODEL_NAME ||
    'claude-3.5-sonnet';

// ==================================================
// Render 日志配置
// ==================================================

const RENDER_API_KEY =
    process.env.RENDER_API_KEY;

const RENDER_SERVICE_ID =
    process.env.RENDER_SERVICE_ID ||
    'srv-daamlb8n74is73bebocg';

let renderOwnerId = null;

const MAX_RENDER_TOOL_ROUNDS = 2;

// ==================================================
// 内容清理
// ==================================================

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

    if (
        content &&
        typeof content === 'object'
    ) {
        if (
            typeof content.text === 'string'
        ) {
            return content.text;
        }

        return '[非文本内容]';
    }

    return String(content || '');
}

// ==================================================
// 提取当前用户消息
// ==================================================

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

// ==================================================
// 判断是否为 Kelivo 标题生成请求
// ==================================================

function isTitleRequest(body) {
    if (!Array.isArray(body?.messages)) {
        return false;
    }

    const text =
        body.messages
            .map(m => {
                if (
                    !m ||
                    m.role !== 'user'
                ) {
                    return '';
                }

                return sanitizeContent(
                    m.content
                );
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
            'https://api.render.com/v1/services/' +
            encodeURIComponent(
                RENDER_SERVICE_ID
            ),
            {
                method: 'GET',
                headers: {
                    'Accept':
                        'application/json',
                    'Authorization':
                        'Bearer ' +
                        RENDER_API_KEY
                }
            }
        );

    if (!response.ok) {
        const text =
            await response.text();

        throw new Error(
            'Render Service 查询失败 (' +
            response.status +
            '): ' +
            text
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

// ==================================================
// 清理 Render 日志
// ==================================================

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
            /((?:api[_-]?key|apikey|token|secret|password))\s*[:=]\s*[^\s,;]+/gi,
            '$1=[已隐藏]'
        )
        .slice(0, 4000);
}

// ==================================================
// 读取 Render 日志
// ==================================================

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
                    Number.isFinite(
                        minutesRaw
                    )
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
                    Number.isFinite(
                        limitRaw
                    )
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
            !allowedLevels.includes(
                level
            )
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
                'https://api.render.com/v1/logs?' +
                params.toString(),
                {
                    method: 'GET',
                    headers: {
                        'Accept':
                            'application/json',
                        'Authorization':
                            'Bearer ' +
                            RENDER_API_KEY
                    }
                }
            );

        if (!response.ok) {
            const errorText =
                await response.text();

            console.log(
                '❌ Render 日志 API 错误 (' +
                response.status +
                ')'
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
                    'Render 日志读取失败 (' +
                    response.status +
                    ')'
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
            rawLogs
                .map(log => {
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
            '🔎 AI读取 Render 日志: level=' +
            level +
            ', minutes=' +
            minutes +
            ', count=' +
            logs.length
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

// ==================================================
// Render 日志工具定义
// ==================================================

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

// ==================================================
// Supabase INSERT
// ==================================================

async function supabaseInsert(
    table,
    data
) {
    const response =
        await fetch(
            SUPABASE_URL +
            '/rest/v1/' +
            table,
            {
                method: 'POST',

                headers: {
                    'apikey':
                        SUPABASE_KEY,

                    'Content-Type':
                        'application/json',

                    'Prefer':
                        'return=minimal'
                },

                body:
                    JSON.stringify(
                        data
                    )
            }
        );

    if (!response.ok) {
        const text =
            await response.text();

        throw new Error(
            'Supabase INSERT ' +
            table +
            ' 失败: ' +
            text
        );
    }
}

// ==================================================
// Supabase SELECT
// ==================================================

async function supabaseSelect(
    table,
    params = {}
) {
    const query =
        new URLSearchParams();

    for (
        const [key, value]
        of Object.entries(params)
    ) {
        query.set(
            key,
            value
        );
    }

    const response =
        await fetch(
            SUPABASE_URL +
            '/rest/v1/' +
            table +
            '?' +
            query.toString(),
            {
                method: 'GET',

                headers: {
                    'apikey':
                        SUPABASE_KEY,

                    'Content-Type':
                        'application/json'
                }
            }
        );

    if (!response.ok) {
        const text =
            await response.text();

        throw new Error(
            'Supabase SELECT ' +
            table +
            ' 失败: ' +
            text
        );
    }

    return {
        data:
            await response.json()
    };
}

// ==================================================
// Supabase UPDATE
// ==================================================

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
        query.set(
            key,
            value
        );
    }

    const response =
        await fetch(
            SUPABASE_URL +
            '/rest/v1/' +
            table +
            '?' +
            query.toString(),
            {
                method: 'PATCH',

                headers: {
                    'apikey':
                        SUPABASE_KEY,

                    'Content-Type':
                        'application/json',

                    'Prefer':
                        'return=minimal'
                },

                body:
                    JSON.stringify(
                        data
                    )
            }
        );

    if (!response.ok) {
        const text =
            await response.text();

        throw new Error(
            'Supabase UPDATE ' +
            table +
            ' 失败: ' +
            text
        );
    }
}

// ==================================================
// 上下文整理：近期对话 + 最近变化候选
// ==================================================

const RECENT_CONTEXT_MESSAGE_LIMIT = 20;
const RECENT_CONTEXT_CHAR_LIMIT = 8000;
const RECENT_CHANGE_SCAN_LIMIT = 80;
const RECENT_CHANGE_MAX_ITEMS = 8;
const RECENT_CHANGE_CHAR_LIMIT = 5000;
const MEMORY_CONTEXT_MAX_ITEMS = 20;
const MEMORY_CONTEXT_CHAR_LIMIT = 7000;

const CHANGE_MARKERS = [
    '现在', '以后', '之前', '刚刚', '最近', '今天', '昨天', '明天',
    '已经', '决定', '打算', '计划', '改成', '换成', '取消', '恢复',
    '新增', '删除', '更新', '解决', '发生', '开始', '结束', '不再',
    '不要再', '以后不要', '以后要', '记住', '忘掉', '喜欢', '不喜欢',
    '讨厌', '习惯', '关系', '闹矛盾', '吵架', '和好', '考试', '课程',
    '学校', '工作', '项目', '部署', '修好了', '修复', '报错', '上线',
    '搬', '买了', '卖了', '换了', '新增了', '删掉', '改了'
];

function normalizeHistoryMessage(message) {
    if (!message || typeof message !== 'object') {
        return null;
    }

    if (
        message.role !== 'user' &&
        message.role !== 'assistant'
    ) {
        return null;
    }

    const content = sanitizeContent(message.content);

    if (!content.trim()) {
        return null;
    }

    return {
        role: message.role,
        content
    };
}

function trimMessagesByCharBudget(messages, maxChars) {
    const result = [];
    let totalChars = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = normalizeHistoryMessage(messages[i]);

        if (!message) {
            continue;
        }

        const extra = message.content.length + 20;

        if (
            result.length > 0 &&
            totalChars + extra > maxChars
        ) {
            break;
        }

        result.unshift(message);
        totalChars += extra;
    }

    return result;
}

function isLikelyChangeMessage(message) {
    if (!message || message.role !== 'user') {
        return false;
    }

    const text = sanitizeContent(message.content).trim();

    if (!text) {
        return false;
    }

    if (text.length < 8) {
        return false;
    }

    return CHANGE_MARKERS.some(marker => text.includes(marker));
}

function buildRecentChangeContext(messages) {
    const sourceMessages = Array.isArray(messages)
        ? messages.slice(0, -1)
        : [];

    // 近期对话已经会直接送给模型，因此变化补充只扫描
    // “近期对话窗口”之外的较新历史，避免同一内容重复占用上下文。
    const recentBoundary = Math.max(
        0,
        sourceMessages.length - RECENT_CONTEXT_MESSAGE_LIMIT
    );

    const source = sourceMessages
        .slice(
            Math.max(
                0,
                sourceMessages.length - RECENT_CHANGE_SCAN_LIMIT
            ),
            recentBoundary
        );

    const candidates = [];

    for (let i = source.length - 1; i >= 0; i--) {
        const message = source[i];

        if (!isLikelyChangeMessage(message)) {
            continue;
        }

        const current = normalizeHistoryMessage(message);

        if (!current) {
            continue;
        }

        // 尽量把该条用户消息前后的 AI 回复一起带上，避免模型只看到
        // “发生了什么”，却不知道最后得出了什么结论。
        const nearby = [];
        const sourceIndex = source.indexOf(message);

        if (sourceIndex > 0) {
            const previous = normalizeHistoryMessage(source[sourceIndex - 1]);
            if (previous && previous.role === 'assistant') {
                nearby.push(previous);
            }
        }

        nearby.push(current);

        if (sourceIndex + 1 < source.length) {
            const next = normalizeHistoryMessage(source[sourceIndex + 1]);
            if (next && next.role === 'assistant') {
                nearby.push(next);
            }
        }

        candidates.push(...nearby);

        if (candidates.length >= RECENT_CHANGE_MAX_ITEMS * 3) {
            break;
        }
    }

    if (!candidates.length) {
        return '（近期没有检测到明确的变化信息）';
    }

    const deduped = [];
    const seen = new Set();

    for (const message of candidates) {
        const key = message.role + '|' + message.content;

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        deduped.push(message);
    }

    const selected = deduped.slice(0, RECENT_CHANGE_MAX_ITEMS * 2);
    const lines = [];
    let totalChars = 0;

    for (const message of selected) {
        const line =
            (message.role === 'user' ? '用户' : 'AI') +
            ': ' +
            message.content;

        if (
            lines.length > 0 &&
            totalChars + line.length + 1 > RECENT_CHANGE_CHAR_LIMIT
        ) {
            break;
        }

        lines.push(line);
        totalChars += line.length + 1;
    }

    return lines.length
        ? lines.join('\n')
        : '（近期没有检测到明确的变化信息）';
}

function buildMemoryContext(memories) {
    if (!Array.isArray(memories) || !memories.length) {
        return '（暂无长期记忆）';
    }

    // 优先使用最新创建的记忆。旧记忆仍然保存在数据库中，
    // 但不再每次把全部历史记忆塞进 system prompt。
    const selected = memories
        .slice(-MEMORY_CONTEXT_MAX_ITEMS)
        .reverse();

    const lines = [];
    let totalChars = 0;

    for (const memory of selected) {
        const summary = sanitizeContent(memory?.summary).trim();

        if (!summary) {
            continue;
        }

        const line = '- ' + summary;

        if (
            lines.length > 0 &&
            totalChars + line.length + 1 > MEMORY_CONTEXT_CHAR_LIMIT
        ) {
            break;
        }

        lines.push(line);
        totalChars += line.length + 1;
    }

    return lines.length
        ? lines.join('\n')
        : '（暂无长期记忆）';
}

// ==================================================
// 长期记忆压缩
// ==================================================

async function compressMemories(
    sessionId,
    messages
) {
    try {
        console.log(
            '🧠 消息超过 200 条，开始压缩长期记忆'
        );

        const oldMessages =
            messages.slice(
                0,
                Math.max(
                    0,
                    messages.length - 40
                )
            );

        if (
            !oldMessages.length
        ) {
            return;
        }

        const oldText =
            oldMessages
                .map(
                    m =>
                        (
                            m.role === 'user'
                                ? '用户'
                                : 'AI'
                        ) +
                        ': ' +
                        sanitizeContent(
                            m.content
                        )
                )
                .join('\n');

        const prompt =
            '\n\n请从下面的历史对话中提取值得长期记忆的信息。\n\n' +
            '只保留：\n\n' +
            '用户明确表达的长期偏好\n' +
            '用户与AI之间重要的长期关系信息\n' +
            '用户明确要求记住的事情\n' +
            '对以后对话有帮助的重要事实\n\n' +
            '不要记录：\n\n' +
            '临时聊天内容\n' +
            '一次性的情绪\n' +
            '无意义闲聊\n' +
            '推测出来的信息\n\n' +
            '请输出简洁的中文记忆，每条一行。\n\n' +
            '历史对话：\n' +
            oldText +
            '\n';

        const response =
            await fetch(
                TRANSFER_API_URL,
                {
                    method: 'POST',

                    headers: {
                        'Content-Type':
                            'application/json',

                        'Authorization':
                            'Bearer ' +
                            TRANSFER_API_KEY
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

        if (
            !summary.trim()
        ) {
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

        for (
            const line
            of lines
        ) {
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
            '🧠 已保存 ' +
            lines.length +
            ' 条长期记忆'
        );

        const oldIds =
            oldMessages
                .map(m => m.id)
                .filter(Boolean);

        if (
            oldIds.length
        ) {
            await supabaseUpdate(
                'messages',
                {
                    id:
                        'in.(' +
                        oldIds.join(',') +
                        ')'
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

// ==================================================
// 健康检查
// ==================================================

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

// ==================================================
// 主聊天接口
// ==================================================

app.post(
    '/api/chat',
    async (req, res) => {

        const requestId =
            req._requestId ||
            getRequestId(req);

        const apiStartTime =
            Date.now();

        console.log(
            '🆔 请求开始 request=' +
            requestId
        );

        // ==================================================
        // 客户端身份验证
        // ==================================================

        if (!CLIENT_API_KEY) {
            console.log(
                '❌ CLIENT_API_KEY 未配置 request=' +
                requestId
            );

            return res
                .status(500)
                .json({
                    error:
                        '服务器认证未配置'
                });
        }

        const authHeader =
            req.headers.authorization ||
            '';

        let clientKey = '';

        if (
            authHeader.startsWith(
                'Bearer '
            )
        ) {
            clientKey =
                authHeader
                    .substring(7)
                    .trim();
        }

        if (!clientKey) {
            clientKey =
                req.headers[
                    'x-api-key'
                ] || '';
        }

        if (
            clientKey !==
            CLIENT_API_KEY
        ) {
            console.log(
                '❌ 客户端认证失败 request=' +
                requestId
            );

            return res
                .status(401)
                .json({
                    error:
                        'Unauthorized'
                });
        }

        console.log(
            '🔐 客户端认证通过 request=' +
            requestId
        );

        console.log(
            '🛠️ 请求字段:',
            Object.keys(
                req.body || {}
            )
        );

        console.log(
            '🛠️ 工具请求:',
            Array.isArray(
                req.body?.tools
            )
                ? req.body.tools.length +
                  ' 个'
                : '0 个'
        );

        try {

            console.log(
                '📩 收到请求 request=' +
                requestId
            );

            // ==================================================
            // ① Kelivo 标题生成请求
            // ==================================================

            if (
                isTitleRequest(
                    req.body
                )
            ) {
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

                const onTitleAbort =
                    () => {
                        console.log(
                            '⚠️ 标题请求客户端已断开 request=' +
                            requestId
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
                                        'Bearer ' +
                                        TRANSFER_API_KEY
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
                        e.name ===
                            'AbortError'
                    ) {
                        console.log(
                            '⚠️ 标题请求已取消 request=' +
                            requestId
                        );

                        return;
                    }

                    throw e;
                }

                req.removeListener(
                    'aborted',
                    onTitleAbort
                );

                if (
                    !titleResponse.ok
                ) {
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
                    '⏱️ 标题请求耗时: ' +
                    (
                        Date.now() -
                        apiStartTime
                    ) +
                    ' ms'
                );

                if (
                    req.aborted ||
                    res.destroyed
                ) {
                    console.log(
                        '⚠️ 标题生成完成，但客户端已经断开 request=' +
                        requestId
                    );

                    return;
                }

                console.log(
                    '📤 准备发送标题响应 request=' +
                    requestId
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
                messageForModel === null ||
                messageForModel === undefined
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
                '📩 session=' +
                sid
            );

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
                    '🖼️ 当前消息包含 ' +
                    imageCount +
                    ' 张图片'
                );
            }

            // ==================================================
            // ③ 保存用户消息
            // ==================================================

            const clientMessages =
                Array.isArray(
                    req.body.messages
                )
                    ? req.body.messages
                    : [];

            const lastClientMessage =
                clientMessages.length > 0
                    ? clientMessages[
                        clientMessages.length - 1
                    ]
                    : null;

            const isToolContinuation =
                lastClientMessage &&
                lastClientMessage.role ===
                    'tool';

            if (
                isToolContinuation
            ) {
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
                            'eq.' + sid,

                        visible:
                            'eq.true',

                        order:
                            'created_at.asc'
                    }
                );

            const allMessages =
                allResult.data || [];

            console.log(
                '📚 当前可见消息数: ' +
                allMessages.length
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
            // ⑤ 加载长期记忆 + 整理近期上下文
            // ==================================================

            const memResult =
                await supabaseSelect(
                    'memories',
                    {
                        select:
                            'summary,created_at',

                        session_id:
                            'eq.' + sid,

                        order:
                            'created_at.asc'
                    }
                );

            const memories =
                memResult.data || [];

            const memoryText =
                buildMemoryContext(memories);

            // 不再把全部长期记忆注入 system prompt。
            // 当前对话优先，长期记忆只作为辅助背景。
            console.log(
                '🧠 长期记忆: ' +
                memories.length +
                ' 条，实际注入: ' +
                memoryText.split('\n').filter(Boolean).length +
                ' 条'
            );

            const recentMessages =
                trimMessagesByCharBudget(
                    allMessages.slice(0, -1).slice(-RECENT_CONTEXT_MESSAGE_LIMIT),
                    RECENT_CONTEXT_CHAR_LIMIT
                );

            const recentChangeText =
                buildRecentChangeContext(
                    allMessages
                );

            console.log(
                '💬 近期对话: ' +
                recentMessages.length +
                ' 条'
            );

            console.log(
                '🔄 最近变化上下文: ' +
                (recentChangeText === '（近期没有检测到明确的变化信息）'
                    ? '无'
                    : '已提取')
            );

            // ==================================================
            // ⑥ System Prompt
            // ==================================================
            const systemPrompt =
                '\n\n你是沈凛，温柔体贴的男友。\n\n' +
                '请自然地结合当前对话、近期变化候选和长期记忆回复用户，不要编造事实。\n' +
                '上下文优先级：当前用户消息 > 近期连续对话 > 近期变化补充 > 长期记忆。\n' +
                '如果不同上下文之间出现冲突，以更新、明确的内容为准。\n\n' +
                '【近期变化候选】\n' + recentChangeText + '\n\n' +
                '【长期记忆】\n' + memoryText + '\n\n' +
                '【工具使用】\n' +
                '只在用户明确要求或确实需要实时信息时才调用工具，不要主动查岗。\n' +
                '工具数据只是背景信息，回复中不要罗列数据报告。\n' +
                'render_logs 只在用户明确要求排查后端问题时使用。\n';
            // ==================================================
            // ⑦ 构造真正发给模型的 messages
            // ==================================================

            let modelMessages = [];

            // 如果这是 MCP 工具续接请求，必须保留客户端提供的
            // tool_calls / tool 结果上下文，否则模型无法继续工具流程。
            const hasToolContext =
                clientMessages.some(
                    m =>
                        m &&
                        (
                            m.role === 'tool' ||
                            Array.isArray(m.tool_calls)
                        )
                );

            if (hasToolContext) {
                modelMessages =
                    clientMessages.map(
                        (m, index) => {
                            if (
                                !m ||
                                typeof m !== 'object'
                            ) {
                                return m;
                            }

                            if (
                                m.role === 'user' &&
                                index === clientMessages.length - 1
                            ) {
                                return {
                                    ...m,
                                    content:
                                        messageForModel
                                };
                            }

                            if (
                                m.role === 'user' ||
                                m.role === 'assistant'
                            ) {
                                return {
                                    ...m,
                                    content:
                                        sanitizeContent(m.content)
                                };
                            }

                            return m;
                        }
                    );

                console.log(
                    '🛠️ 检测到工具续接，保留客户端工具上下文: ' +
                    modelMessages.length +
                    ' 条'
                );
            } else {
                modelMessages =
                    recentMessages.map(
                        m => ({
                            role: m.role,
                            content: m.content
                        })
                    );

                // 当前请求的真实用户消息永远放在最后。
                // 这样即使 Supabase 查询存在极短暂延迟，也不会漏掉当前消息。
                modelMessages.push({
                    role: 'user',
                    content: messageForModel
                });
            }

            modelMessages.unshift({
                role: 'system',
                content: systemPrompt
            });

            console.log(
                '📨 转发消息 ' +
                modelMessages.length +
                ' 条'
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
                modelTools = [
                    ...req.body.tools
                ];
            }

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

                let abortHandled =
                    false;

                const onClientAbort =
                    () => {
                        if (
                            abortHandled
                        ) {
                            return;
                        }

                        abortHandled =
                            true;

                        console.log(
                            '⚠️ 客户端已断开，取消中转 API 请求 request=' +
                            requestId
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
                    '🚀 中转 API fetch 开始 request=' +
                    requestId
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
                                        'Bearer ' +
                                        TRANSFER_API_KEY
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
                        '📡 中转 API HTTP响应 request=' +
                        requestId +
                        ' status=' +
                        response.status +
                        ' elapsed=' +
                        (
                            Date.now() -
                            upstreamStart
                        ) +
                        'ms'
                    );

                    if (
                        !response.ok
                    ) {
                        const errorText =
                            await response.text();

                        console.log(
                            '❌ 中转 API 错误 request=' +
                            requestId +
                            ':',
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
                        '📥 中转 API JSON解析完成 request=' +
                        requestId +
                        ' elapsed=' +
                        (
                            Date.now() -
                            upstreamStart
                        ) +
                        'ms'
                    );

                    return result;

                } catch (e) {
                    if (
                        req.aborted ||
                        e.name ===
                            'AbortError'
                    ) {
                        console.log(
                            '⚠️ 中转 API 请求被客户端中止 request=' +
                            requestId +
                            ' elapsed=' +
                            (
                                Date.now() -
                                upstreamStart
                            ) +
                            'ms'
                        );

                        e.clientAborted =
                            true;
                    } else {
                        console.log(
                            '❌ 中转 fetch 异常 request=' +
                            requestId +
                            ' name=' +
                            (e.name || '-') +
                            ' code=' +
                            (e.code || '-') +
                            ' message=' +
                            (e.message || e)
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
                        '⚠️ 本次聊天请求因客户端断开而结束 request=' +
                        requestId
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
                    currentToolCalls.length ===
                        0
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

                if (
                    otherToolCalls.length >
                    0
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
                            '⚠️ 客户端工具响应准备发送时连接已关闭 request=' +
                            requestId
                        );

                        return;
                    }

                    console.log(
                        '📤 准备发送客户端工具调用响应 request=' +
                        requestId
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
                    renderCalls.length ===
                    0
                ) {
                    break;
                }

                console.log(
                    '🧰 AI请求读取 Render 日志，共 ' +
                    renderCalls.length +
                    ' 个调用'
                );

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
                    '🔄 Render 日志结果返回模型，第 ' +
                    renderToolRound +
                    ' 轮'
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
                            '⚠️ Render 工具续接期间客户端断开 request=' +
                            requestId
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
                        '⚠️ 工具调用响应准备发送时连接已关闭 request=' +
                        requestId
                    );

                    return;
                }

                console.log(
                    '📤 准备发送工具调用响应 request=' +
                    requestId
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
                '⏱️ 中转 API 总耗时: ' +
                (
                    Date.now() -
                    apiStartTime
                ) +
                ' ms'
            );

            if (
                data.usage
            ) {
                console.log(
                    '📊 Token 使用:',
                    JSON.stringify({
                        prompt_tokens:
                            data.usage
                                .prompt_tokens,

                        completion_tokens:
                            data.usage
                                .completion_tokens,

                        total_tokens:
                            data.usage
                                .total_tokens
                    })
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

            console.log(
                '🤖 回复内容已生成 request=' +
                requestId
            );

            if (
                req.aborted ||
                res.destroyed
            ) {
                console.log(
                    '⚠️ 模型已经生成回复，但客户端此时已经断开 request=' +
                    requestId +
                    ' elapsed=' +
                    (
                        Date.now() -
                        apiStartTime
                    ) +
                    'ms'
                );

                return;
            }

            // ==================================================
            // ⑬ 保存 AI 回复
            // ==================================================

            console.log(
                '💾 开始保存 AI 回复到 messages request=' +
                requestId
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
                '✅ AI 回复已保存到 messages request=' +
                requestId +
                ' elapsed=' +
                (
                    Date.now() -
                    apiStartTime
                ) +
                'ms'
            );

            if (
                req.aborted ||
                res.destroyed
            ) {
                console.log(
                    '⚠️ 保存 messages 后发现客户端已经断开 request=' +
                    requestId
                );

                return;
            }

            console.log(
                '💾 开始保存 AI 回复到 timeline request=' +
                requestId
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
                '✅ AI 回复已保存到 timeline request=' +
                requestId +
                ' elapsed=' +
                (
                    Date.now() -
                    apiStartTime
                ) +
                'ms'
            );

            // ==================================================
            // ⑭ 返回 Kelivo
            // ==================================================

            if (
                req.aborted ||
                res.destroyed
            ) {
                console.log(
                    '⚠️ 所有数据保存完成，但客户端已经断开，无法发送最终响应 request=' +
                    requestId
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
                '📤 准备向 Kelivo 发送最终响应 request=' +
                requestId +
                ' elapsed=' +
                (
                    Date.now() -
                    apiStartTime
                ) +
                'ms'
            );

            res.json(
                responseBody
            );

            console.log(
                '✅ res.json 已执行 request=' +
                requestId +
                ' elapsed=' +
                (
                    Date.now() -
                    apiStartTime
                ) +
                'ms'
            );

        } catch (e) {

            if (
                req.aborted ||
                e?.clientAborted ||
                e?.name === 'AbortError'
            ) {
                console.log(
                    '⚠️ 请求结束：客户端已断开 request=' +
                    requestId +
                    ' elapsed=' +
                    (
                        Date.now() -
                        apiStartTime
                    ) +
                    'ms'
                );

                return;
            }

            console.log(
                '❌ 错误 request=' +
                requestId +
                ':',
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
                '⚠️ express.json 检测到客户端中止请求 request=' +
                requestId
            );

            console.log(
                '⚠️ abort详情 request=' +
                requestId +
                ' received=' +
                (err.received ?? '-') +
                ' expected=' +
                (err.expected ?? '-')
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
            '❌ Express 未处理错误 request=' +
            requestId +
            ':',
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

// ==================================================
// 启动
// ==================================================

const server =
    app.listen(
        PORT,
        () => {
            console.log(
                '🚀 Server running on port ' +
                PORT
            );
        }
    );

// ==================================================
// Node HTTP 长连接/长请求保护
// ==================================================

server.keepAliveTimeout =
    120000;

server.headersTimeout =
    130000;

server.requestTimeout =
    0;

server.timeout =
    0;

console.log(
    '🛡️ HTTP 长请求保护已启用: ' +
    'keepAlive=120s, ' +
    'headers=130s, ' +
    'requestTimeout=0, ' +
    'timeout=0'
);

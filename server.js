const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('🚀 服务启动中...');

// ===== CORS =====
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
const MODEL_NAME = process.env.MODEL_NAME || 'claude-3.5-sonnet';


// ============================================================
// 内容处理
// ============================================================

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


// 从 Kelivo 请求中提取当前消息
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


// ============================================================
// Supabase
// ============================================================

async function supabaseInsert(table, data) {

    const response =
        await fetch(
            `${SUPABASE_URL}/rest/v1/${table}`,
            {
                method: 'POST',

                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization':
                        `Bearer ${SUPABASE_KEY}`,
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


async function supabaseSelect(table, params = {}) {

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
            `${SUPABASE_URL}/rest/v1/${table}?${query.toString()}`,
            {
                method: 'GET',

                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization':
                        `Bearer ${SUPABASE_KEY}`,
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
            `${SUPABASE_URL}/rest/v1/${table}?${query.toString()}`,
            {
                method: 'PATCH',

                headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization':
                        `Bearer ${SUPABASE_KEY}`,
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


// ============================================================
// 长期记忆压缩
// ============================================================

async function compressMemories(
    sessionId,
    messages
) {

    try {

        console.log(
            `🧠 消息超过 200 条，开始压缩长期记忆`
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
1. 用户明确表达的长期偏好
2. 用户与AI之间重要的长期关系信息
3. 用户明确要求记住的事情
4. 对以后对话有帮助的重要事实

不要记录：
1. 临时聊天内容
2. 一次性的情绪
3. 无意义闲聊
4. 推测出来的信息

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


// ============================================================
// 健康检查
// ============================================================

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


// ============================================================
// Chat
// ============================================================

app.post(
    '/api/chat',
    async (req, res) => {

        // 每一次请求单独计时
        const apiStartTime =
            Date.now();

        // ===== MCP / Tool 调试 =====

        console.log(
            '🛠️ 请求字段:',
            Object.keys(
                req.body || {}
            )
        );

        console.log(
            '🛠️ 工具相关字段:',
            JSON.stringify(
                {
                    tools:
                        req.body?.tools,

                    tool_choice:
                        req.body?.tool_choice,

                    tool_calls:
                        req.body?.tool_calls,

                    messages:
                        req.body?.messages
                            ?.slice?.(-5)
                },

                (key, value) => {

                    if (
                        typeof value ===
                        'string' &&
                        value.length > 500
                    ) {

                        return `[字符串 ${value.length} 字符]`;
                    }

                    return value;
                }

            ).substring(
                0,
                10000
            )
        );

        try {

            console.log(
                '📩 收到请求'
            );

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

            console.log(
                '📝 历史消息:',
                messageForHistory
                    .substring(
                        0,
                        150
                    )
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
                    `🖼️ 当前消息包含 ${imageCount} 张图片`
                );
            }


            // ====================================================
            // 保存当前用户消息
            // ====================================================

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


            // ====================================================
            // 获取全部消息
            // ====================================================

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


            // ====================================================
            // 超过 200 条时压缩
            // ====================================================

            if (
                allMessages.length >
                200
            ) {

                await compressMemories(
                    sid,
                    allMessages
                );
            }


            // ====================================================
            // 获取最近 40 条
            // ====================================================

            const recentResult =
                await supabaseSelect(
                    'messages',
                    {
                        select:
                            'role,content',

                        session_id:
                            `eq.${sid}`,

                        visible:
                            'eq.true',

                        order:
                            'created_at.desc',

                        limit:
                            '40'
                    }
                );

            const recent =
                (
                    recentResult.data ||
                    []
                ).reverse();

            console.log(
                `💬 加载最近 ${recent.length} 条消息`
            );


            // ====================================================
            // 长期记忆
            // ====================================================

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


            // ====================================================
            // 系统提示词
            // ====================================================

            const systemPrompt = `
你是沈凛，温柔体贴的男友。

请参考下面的长期记忆和近期对话，在不编造事实的情况下自然地回复用户。

如果用户的问题可以通过你拥有的工具获得真实信息，并且工具可用，请主动调用对应工具，不要凭空猜测。

例如：
- 用户问现在几点 → 使用时间工具
- 用户问电量 → 使用电池工具
- 用户问天气 → 使用天气工具
- 用户问屏幕使用时间 → 使用屏幕使用时间工具
- 用户问步数 → 使用步数工具
- 用户问应用使用情况 → 使用应用时间线工具

当工具能够提供准确的实时信息时，优先使用工具获取真实数据。

〖长期记忆〗
${memoryText}

〖近期对话〗
${
    recent
        .map(
            m =>
                `${m.role === 'user' ? '用户' : 'AI'}: ${sanitizeContent(m.content)}`
        )
        .join('\n') ||
    '（这是第一次对话）'
}

根据记忆和近期对话，自然地回复用户。
`;


            // ====================================================
            // 构造发送给上游模型的 messages
            // ====================================================

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


                            // 当前最后一条用户消息：
                            // 保留原始内容，包括图片
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


                            // 历史用户/AI消息：
                            // 图片只保留 [图片]
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

                            // system / tool 等消息
                            // 保持原样
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


            // 我们自己的系统提示词放最前面
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


            // ====================================================
            // 调用中转 API
            // ====================================================

            console.log(
                '🚀 调用中转 API...'
            );

            const response =
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
                            JSON.stringify({

                                model:
                                    req.body.model ||
                                    MODEL_NAME,

                                messages:
                                    modelMessages,

                                // ★★★ MCP / Tool 关键 ★★★
                                tools:
                                    req.body.tools,

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
                            })
                    }
                );


            // ====================================================
            // 上游 API 错误
            // ====================================================

            if (!response.ok) {

                const errorText =
                    await response.text();

                console.log(
                    '❌ 中转 API 错误:',
                    errorText
                );

                return res
                    .status(500)
                    .json({
                        error:
                            '调用模型失败'
                    });
            }


            // ====================================================
            // 解析模型返回
            // ====================================================

            const data =
                await response.json();


            console.log(
                '🤖 AI返回:',
                JSON.stringify(
                    data
                ).substring(
                    0,
                    10000
                )
            );


            console.log(
                `⏱️ 中转 API 总耗时: ${
                    Date.now() -
                    apiStartTime
                } ms`
            );


            const assistantMessage =
                data
                    .choices?.[0]
                    ?.message;


            // ====================================================
            // ★★★ AI 要求调用工具 ★★★
            // ====================================================

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


                // 不要在 Render 执行工具。
                // 把 tool_calls 原样交回 Kelivo，
                // 由 Kelivo 调用 LoverConnect / MCP。
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


            // ====================================================
            // 普通最终回答
            // ====================================================

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
                '✅ 回复:',
                String(reply)
                    .substring(
                        0,
                        100
                    )
            );


            // ====================================================
            // 保存 AI 回复
            // ====================================================

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


            // ====================================================
            // 返回 Kelivo
            // ====================================================

            res.json({

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
            });


        } catch (e) {

            console.log(
                '❌ 错误:',
                e.message
            );

            console.log(
                e.stack
            );

            if (
                !res.headersSent
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


// ============================================================
// 启动服务器
// ============================================================

app.listen(
    PORT,
    () => {

        console.log(
            `🚀 Server running on port ${PORT}`
        );

    }
);

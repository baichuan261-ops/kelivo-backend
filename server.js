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

// ===== Supabase INSERT =====
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

// ===== 长期记忆压缩 =====
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

        const apiStartTime =
            Date.now();

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

            // ==================================================
            // ① Kelivo 标题生成请求
            // ==================================================
            //
            // 这类请求不是正常聊天。
            // 不读取 Supabase 历史、不加载长期记忆、不发送 MCP 工具。
            // 直接把 Kelivo 原始请求交给模型。
            //
            // 这样可以避免标题请求再次吃掉大量上下文。
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

                const titleResponse =
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
                                )
                        }
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

                // 原样返回 OpenAI-compatible 响应
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

            // ==================================================
            // ③ 保存用户消息
            // ==================================================

         // ==================================================
// 保存用户消息
// ==================================================
//
// 正常请求：
//   最后一条是 user
//   → 保存一次用户消息
//
// MCP 工具续接请求：
//   最后一条是 tool
//   → 这是 Kelivo 把工具结果送回来
//   → 不再重复保存上一条 user 消息
//
// 否则每调用一次 MCP，Supabase 都会多出一条
// 完全相同的用户消息。
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
            // ⑥ 新的 System Prompt
            // ==================================================
            //
            // 重点：
            // 以前这里把最近 40 条聊天再次复制进 system prompt。
            //
            // Kelivo 本身已经把 messages 发过来了，
            // 所以模型实际上看了两遍聊天记录。
            //
            // 现在只放：
            // - 人格
            // - 长期记忆
            // - 工具使用规则
            //
            // 实际聊天内容直接使用 req.body.messages。
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

                            // 当前最后一条 user 消息：
                            // 保留完整图片 Base64，
                            // 让模型这一轮真正看到图片。
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

                            // 历史 user / assistant：
                            // 图片替换成 [图片]，
                            // 防止 Base64 越积越大。
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

                            // tool / system 等消息保持原样
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

            // System Prompt 放最前面
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

            console.log(
                '🚀 调用中转 API...'
            );

            // ==================================================
            // ⑧ 调用模型
            // ==================================================

            const upstreamBody = {
                model:
                    req.body.model ||
                    MODEL_NAME,

                messages:
                    modelMessages,

                // MCP 工具完整透传
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
            };

            // 如果 Kelivo / 上游明确提供了这些参数，
            // 就原样透传。
            // 不主动设置，避免猜测 Gemini 中转 API 的参数格式。
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
                            JSON.stringify(
                                upstreamBody
                            )
                    }
                );

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

            const data =
                await response.json();

            // ==================================================
            // ⑨ 性能日志
            // ==================================================

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

            if (
                data.usage
            ) {
                console.log(
                    '📊 Token 使用:',
                    JSON.stringify(
                        data.usage
                    )
                );
            }

            // ==================================================
            // ⑩ MCP Tool Call
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

            // ==================================================
            // ⑪ 普通最终回答
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
                '✅ 回复:',
                String(reply)
                    .substring(
                        0,
                        150
                    )
            );

            // ==================================================
            // ⑫ 保存 AI 回复
            // ==================================================

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

            // ==================================================
            // ⑬ 返回 Kelivo
            // ==================================================

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

// ===== 启动 =====
app.listen(
    PORT,
    () => {
        console.log(
            `🚀 Server running on port ${PORT}`
        );
    }
);

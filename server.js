const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const apiStartTime = Date.now();
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

// 把 Kelivo 的多模态内容转换成适合保存到数据库的文本。
// 图片只保存成 [图片]，绝不保存 Base64。
function sanitizeContent(content) {

    // 普通文字
    if (typeof content === 'string') {
        return content;
    }

    // 多模态数组
    if (Array.isArray(content)) {
        return content
            .map(part => {

                if (!part) {
                    return '';
                }

                // 文字
                if (part.type === 'text') {
                    return String(part.text || '');
                }

                // 图片
                if (part.type === 'image_url') {
                    return '[图片]';
                }

                // 其他可能的图片格式
                if (
                    part.type === 'image' ||
                    part.type === 'input_image'
                ) {
                    return '[图片]';
                }

                // 其他带 text 的内容
                if (typeof part.text === 'string') {
                    return part.text;
                }

                return '';
            })
            .filter(Boolean)
            .join('\n');
    }

    // 某些客户端可能直接传对象
    if (content && typeof content === 'object') {

        if (typeof content.text === 'string') {
            return content.text;
        }

        return '[非文本内容]';
    }

    return String(content || '');
}


// 从请求中提取“真正给模型看的当前消息”。
// 这里不会 JSON.stringify 图片，所以 Base64 不会被破坏。
function extractModelMessage(body) {

    // 1. message
    if (body.message !== undefined && body.message !== null) {
        return body.message;
    }

    // 2. content
    if (body.content !== undefined && body.content !== null) {
        return body.content;
    }

    // 3. prompt
    if (body.prompt !== undefined && body.prompt !== null) {
        return body.prompt;
    }

    // 4. text
    if (body.text !== undefined && body.text !== null) {
        return body.text;
    }

    // 5. msg
    if (body.msg !== undefined && body.msg !== null) {
        return body.msg;
    }

    // 6. OpenAI / Kelivo messages 格式
    if (
        Array.isArray(body.messages) &&
        body.messages.length > 0
    ) {
        const lastUser =
            body.messages
                .filter(m => m && m.role === 'user')
                .pop();

        if (lastUser) {
            return lastUser.content;
        }
    }

    return null;
}


// ============================================================
// Supabase：插入
// ============================================================

async function supabaseInsert(table, data) {
    try {
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/${table}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify(data)
            }
        );

        if (!response.ok) {
            console.log(
                `⚠️ Supabase 插入失败 [${table}]:`,
                await response.text()
            );
        }

        return response;

    } catch (e) {
        console.log(
            `⚠️ Supabase 插入异常 [${table}]:`,
            e.message
        );

        return null;
    }
}


// ============================================================
// Supabase：查询
// ============================================================

async function supabaseSelect(table, params = {}) {
    try {

        const url = new URL(
            `${SUPABASE_URL}/rest/v1/${table}`
        );

        Object.entries(params).forEach(([key, value]) => {
            url.searchParams.append(key, value);
        });

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
            }
        });

        if (!response.ok) {

            console.log(
                `⚠️ Supabase 查询失败 [${table}]:`,
                await response.text()
            );

            return { data: [] };
        }

        return {
            data: await response.json()
        };

    } catch (e) {

        console.log(
            `⚠️ Supabase 查询异常 [${table}]:`,
            e.message
        );

        return { data: [] };
    }
}


// ============================================================
// Supabase：更新
// ============================================================

async function supabaseUpdate(
    table,
    params = {},
    data
) {
    try {

        const url = new URL(
            `${SUPABASE_URL}/rest/v1/${table}`
        );

        Object.entries(params).forEach(([key, value]) => {
            url.searchParams.append(key, value);
        });

        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify(data)
        });

        if (!response.ok) {

            console.log(
                `⚠️ Supabase 更新失败 [${table}]:`,
                await response.text()
            );
        }

        return response;

    } catch (e) {

        console.log(
            `⚠️ Supabase 更新异常 [${table}]:`,
            e.message
        );

        return null;
    }
}


// ============================================================
// 记忆压缩
// ============================================================

async function compressMemories(
    sessionId,
    messages
) {

    try {

        const toCompress =
            messages.slice(0, -40);

        if (toCompress.length < 20) {
            return null;
        }

        // 数据库里的内容本身已经经过清洗，
        // 这里再次 sanitize 一次作为保险。
        const text =
            toCompress
                .map(m =>
                    `${m.role === 'user' ? '用户' : 'AI'}: ${sanitizeContent(m.content)}`
                )
                .join('\n');

        console.log(
            `📦 开始压缩 ${toCompress.length} 条消息...`
        );

        const response =
            await fetch(
                TRANSFER_API_URL,
                {
                    method: 'POST',

                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization':
                            `Bearer ${TRANSFER_API_KEY}`
                    },

                    body: JSON.stringify({
                        model: MODEL_NAME,

                        messages: [
                            {
                                role: 'system',

                                content:
                                    '你是记忆压缩助手。将对话压缩成300字以内的摘要，保留关键信息：约定、喜好、重要事件和对话背景。不要编造信息，只输出摘要。'
                            },

                            {
                                role: 'user',
                                content: text
                            }
                        ],

                        stream: false,
                        temperature: 0.3,
                        max_tokens: 500
                    })
                }
            );

        if (!response.ok) {

            console.log(
                '❌ 记忆模型调用失败:',
                await response.text()
            );

            return null;
        }

        const data =
            await response.json();
        console.log(
    `⏱️ 中转 API 总耗时: ${Date.now() - apiStartTime} ms`
);

        const summary =
            data.choices?.[0]?.message?.content ||
            data.reply ||
            data.result ||
            data.content ||
            null;

        if (!summary) {

            console.log(
                '⚠️ 没有得到记忆摘要'
            );

            return null;
        }

        // 先写入长期记忆
        const memoryResponse =
            await supabaseInsert(
                'memories',
                {
                    session_id: sessionId,
                    summary: summary.trim()
                }
            );

        if (
            !memoryResponse ||
            !memoryResponse.ok
        ) {

            console.log(
                '❌ 长期记忆写入失败，旧消息不会隐藏'
            );

            return null;
        }

        // 摘要成功后，再隐藏旧消息
        for (const message of toCompress) {

            await supabaseUpdate(
                'messages',
                {
                    id: `eq.${message.id}`
                },
                {
                    visible: false
                }
            );
        }

        console.log(
            `✅ 压缩完成: ${summary.trim().substring(0, 80)}...`
        );

        console.log(
            `🙈 已隐藏 ${toCompress.length} 条已压缩消息`
        );

        return summary.trim();

    } catch (e) {

        console.log(
            '❌ 记忆压缩异常:',
            e.message
        );

        return null;
    }
}


// ============================================================
// 首页
// ============================================================

app.get('/', (req, res) => {

    res.json({
        status: 'ok',
        message: 'Kelivo 后端运行中 💖'
    });
});


// ============================================================
// 核心聊天接口
// ============================================================

app.post('/api/chat', async (req, res) => {
console.log(
    '🛠️ 请求字段:',
    Object.keys(req.body || {})
);

console.log(
    '🛠️ 工具相关字段:',
    JSON.stringify(
        {
            tools: req.body?.tools,
            tool_choice: req.body?.tool_choice,
            tool_calls: req.body?.tool_calls,
            messages: req.body?.messages?.slice?.(-5)
        },
        (key, value) => {
            if (typeof value === 'string' && value.length > 500) {
                return `[字符串 ${value.length} 字符]`;
            }
            return value;
        }
    ).substring(0, 10000)
);
    try {

        console.log(
            '📩 收到请求'
        );

        // ========================================================
        // 1. 提取当前消息
        // ========================================================

        const messageForModel =
            extractModelMessage(req.body);

        if (
            messageForModel === null ||
            messageForModel === undefined
        ) {

            return res.status(400).json({
                error: '消息不能为空'
            });
        }

        // 给数据库保存的版本
        const messageForHistory =
            sanitizeContent(messageForModel);

        if (!messageForHistory.trim()) {

            return res.status(400).json({
                error: '消息不能为空'
            });
        }


        // ========================================================
        // 2. session
        // ========================================================

        const sid =
            req.body.sessionId ||
            req.body.session_id ||
            1;


        // ========================================================
        // 3. 配置检查
        // ========================================================

        if (
            !SUPABASE_URL ||
            !SUPABASE_KEY
        ) {

            return res.status(500).json({
                error: 'Supabase 未配置'
            });
        }

        if (
            !TRANSFER_API_URL ||
            !TRANSFER_API_KEY
        ) {

            return res.status(500).json({
                error: '中转 API 未配置'
            });
        }


        // ========================================================
        // 4. 日志
        // ========================================================

        console.log(
            `📩 session=${sid}`
        );

        console.log(
            '📝 历史消息:',
            messageForHistory.substring(0, 150)
        );

        console.log(
            '📦 当前消息类型:',
            Array.isArray(messageForModel)
                ? '多模态'
                : typeof messageForModel
        );

        if (Array.isArray(messageForModel)) {

            const imageCount =
                messageForModel.filter(
                    part =>
                        part &&
                        (
                            part.type === 'image_url' ||
                            part.type === 'image' ||
                            part.type === 'input_image'
                        )
                ).length;

            console.log(
                `🖼️ 当前消息包含 ${imageCount} 张图片`
            );
        }


        // ========================================================
        // 5. 保存用户消息
        // ========================================================

        await supabaseInsert(
            'messages',
            {
                session_id: sid,
                role: 'user',

                // 重要：
                // 这里保存的是清洗后的内容，
                // 不包含 Base64 图片。
                content: messageForHistory,

                visible: true
            }
        );


        // ========================================================
        // 6. 保存用户 timeline
        // ========================================================

        await supabaseInsert(
            'timeline',
            {
                session_id: sid,
                role: 'user',

                // 同样只保存清洗后的文本
                content: messageForHistory
            }
        );


        // ========================================================
        // 7. 获取所有可见消息
        // ========================================================

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


        // ========================================================
        // 8. 超过200条，进行记忆压缩
        // ========================================================

        if (
            allMessages.length > 200
        ) {

            await compressMemories(
                sid,
                allMessages
            );
        }


        // ========================================================
        // 9. 获取最近40条
        // ========================================================

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
            (recentResult.data || [])
                .reverse();


        // 数据库里现在都是安全的文本，
        // 不会再出现百万字符 Base64。
        const context =
            recent
                .map(m =>
                    `${m.role === 'user' ? '用户' : 'AI'}: ${sanitizeContent(m.content)}`
                )
                .join('\n');

        console.log(
            `💬 加载最近 ${recent.length} 条消息`
        );


        // ========================================================
        // 10. 获取长期记忆
        // ========================================================

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


        // ========================================================
        // 11. 构造系统提示词
        // ========================================================

        const systemPrompt = `
你是沈凛，温柔体贴的男友。

请参考下面的长期记忆和近期对话，在不编造事实的情况下自然地回复用户。

〖长期记忆〗
${memoryText}

〖近期对话〗
${context || '（这是第一次对话）'}

根据记忆和近期对话，自然地回复用户。
`;


        // ========================================================
        // 12. 调用中转 API
        // ========================================================

        console.log(
            '🚀 调用中转 API...'
        );

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

                    body: JSON.stringify({

                        model: MODEL_NAME,

                        messages: [

                            {
                                role: 'system',
                                content: systemPrompt
                            },

                            {
                                role: 'user',

                                // ★★★ 关键 ★★★
                                // 当前这一轮保留原始多模态内容。
                                // 所以图片仍然可以交给支持视觉的模型。
                                content: messageForModel
                            }

                        ],

                        stream: false,

                        temperature: 0.8,

                        max_tokens: 2048
                    })
                }
            );


        // ========================================================
        // 13. API 错误
        // ========================================================

        if (!response.ok) {

            const errorText =
                await response.text();

            console.log(
                '❌ 中转 API 错误:',
                errorText
            );

            return res.status(500).json({
                error: '调用模型失败'
            });
        }


        // ========================================================
        // 14. 解析 AI 回复
        // ========================================================

        const data =
            await response.json();

        const reply =
            data.choices?.[0]?.message?.content ||
            data.reply ||
            data.result ||
            data.content ||
            data.output ||
            data.response ||
            '机走神了~';

        console.log(
            '✅ 回复:',
            String(reply).substring(0, 100)
        );


        // ========================================================
        // 15. 保存 AI 回复
        // ========================================================

        await supabaseInsert(
            'messages',
            {
                session_id: sid,
                role: 'assistant',
                content: reply,
                visible: true
            }
        );


        // ========================================================
        // 16. 保存 AI timeline
        // ========================================================

        await supabaseInsert(
            'timeline',
            {
                session_id: sid,
                role: 'assistant',
                content: reply
            }
        );


        // ========================================================
        // 17. 返回 Kelivo
        // ========================================================

        res.json({

            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: reply
                    }
                }
            ],

            reply: reply
        });


    } catch (e) {

        console.log(
            '❌ 错误:',
            e.message
        );

        if (!res.headersSent) {

            res.status(500).json({
                error: e.message
            });
        }
    }
});


// ============================================================
// 启动
// ============================================================

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `🚀 服务已启动，端口: ${PORT}`
        );
    }
);

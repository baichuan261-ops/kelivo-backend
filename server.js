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

app.use(express.json({ limit: '10mb' }));

// ===== 环境变量 =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TRANSFER_API_URL = process.env.TRANSFER_API_URL;
const TRANSFER_API_KEY = process.env.TRANSFER_API_KEY;
const MODEL_NAME = process.env.MODEL_NAME || 'claude-3.5-sonnet';

// ===== Supabase：插入 =====
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

// ===== Supabase：查询 =====
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

// ===== Supabase：更新 =====
// 这里是修复原版记忆压缩 bug 的关键。
// 原版错误地 INSERT messages { id, visible:false }。
// 现在正确使用 PATCH 修改已有消息。
async function supabaseUpdate(table, params = {}, data) {
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

// ===== 记忆压缩 =====
// 超过 200 条可见消息时：
// 1. 取最早的消息
// 2. 保留最近 40 条
// 3. 调用模型生成长期记忆摘要
// 4. 写入 memories
// 5. 将已经压缩的 messages 标记 visible=false
async function compressMemories(sessionId, messages) {
    try {
        const toCompress = messages.slice(0, -40);

        if (toCompress.length < 20) {
            return null;
        }

        const text = toCompress
            .map(m =>
                `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
            )
            .join('\n');

        console.log(
            `📦 开始压缩 ${toCompress.length} 条消息...`
        );

        const response = await fetch(
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

        const data = await response.json();

        const summary =
            data.choices?.[0]?.message?.content ||
            data.reply ||
            data.result ||
            data.content ||
            null;

        if (!summary) {
            console.log('⚠️ 没有得到记忆摘要');
            return null;
        }

        // 先写入长期记忆
        const memoryResponse = await supabaseInsert(
            'memories',
            {
                session_id: sessionId,
                summary: summary.trim()
            }
        );

        if (!memoryResponse || !memoryResponse.ok) {
            console.log(
                '❌ 长期记忆写入失败，旧消息不会隐藏'
            );
            return null;
        }

        // 摘要成功写入后，再隐藏旧消息
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

// ===== 首页 =====
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'Kelivo 后端运行中 💖'
    });
});

// ===== 核心聊天接口 =====
app.post('/api/chat', async (req, res) => {
    try {
        console.log(
            '📩 收到请求体:',
            JSON.stringify(req.body).substring(0, 300)
        );

        // ===== 提取用户消息 =====
        let message =
            req.body.message ||
            req.body.content ||
            req.body.prompt ||
            req.body.text ||
            req.body.msg;

        if (
            !message &&
            req.body.messages &&
            Array.isArray(req.body.messages)
        ) {
            const lastUser =
                req.body.messages
                    .filter(m => m.role === 'user')
                    .pop();

            if (lastUser) {
                message =
                    typeof lastUser.content === 'string'
                        ? lastUser.content
                        : JSON.stringify(lastUser.content);
            }
        }

        const sid =
            req.body.sessionId ||
            req.body.session_id ||
            1;

        if (!message) {
            return res.status(400).json({
                error: '消息不能为空'
            });
        }

        if (!SUPABASE_URL || !SUPABASE_KEY) {
            return res.status(500).json({
                error: 'Supabase 未配置'
            });
        }

        if (!TRANSFER_API_URL || !TRANSFER_API_KEY) {
            return res.status(500).json({
                error: '中转 API 未配置'
            });
        }

        console.log(
            `📩 session=${sid} 消息:`,
            String(message).substring(0, 100)
        );

        // ===== 1. 保存用户消息 =====
        await supabaseInsert(
            'messages',
            {
                session_id: sid,
                role: 'user',
                content: message,
                visible: true
            }
        );

        // ===== 2. 保存用户 timeline =====
        await supabaseInsert(
            'timeline',
            {
                session_id: sid,
                role: 'user',
                content: message
            }
        );

        // ===== 3. 获取所有可见消息 =====
        const allResult =
            await supabaseSelect(
                'messages',
                {
                    select: 'id,role,content,created_at',
                    session_id: `eq.${sid}`,
                    visible: 'eq.true',
                    order: 'created_at.asc'
                }
            );

        const allMessages =
            allResult.data || [];
        console.log(
    '📏 最大消息长度:',
    Math.max(
        0,
        ...allMessages.map(m => String(m.content || '').length)
    )
);

console.log(
    '📏 总消息字符数:',
    allMessages.reduce(
        (sum, m) => sum + String(m.content || '').length,
        0
    )
);

        console.log(
            `📚 当前可见消息数: ${allMessages.length}`
        );

        // ===== 4. 超过200条，进行记忆压缩 =====
        if (allMessages.length > 200) {
            await compressMemories(
                sid,
                allMessages
            );
        }

        // ===== 5. 获取最近40条 =====
        const recentResult =
            await supabaseSelect(
                'messages',
                {
                    select: 'role,content',
                    session_id: `eq.${sid}`,
                    visible: 'eq.true',
                    order: 'created_at.desc',
                    limit: '40'
                }
            );

        const recent =
            (recentResult.data || [])
                .reverse();
        console.log(
    '📏 最近40条总字符数:',
    recent.reduce(
        (sum, m) => sum + String(m.content || '').length,
        0
    )
);

        const context =
            recent
                .map(m =>
                    `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
                )
                .join('\n');

        console.log(
            `💬 加载最近 ${recent.length} 条消息`
        );

        // ===== 6. 获取长期记忆 =====
        const memResult =
            await supabaseSelect(
                'memories',
                {
                    select: 'summary',
                    session_id: `eq.${sid}`,
                    order: 'created_at.asc'
                }
            );

        const memories =
            memResult.data || [];

        const memoryText =
            memories.length > 0
                ? memories
                    .map(m => `- ${m.summary}`)
                    .join('\n')
                : '（暂无长期记忆）';

        console.log(
            `🧠 加载 ${memories.length} 条长期记忆`
        );

        // ===== 7. 构造系统提示词 =====
        const systemPrompt = `
你是沈凛，温柔体贴的男友。

请参考下面的长期记忆和近期对话，在不编造事实的情况下自然地回复用户。

〖长期记忆〗
${memoryText}

〖近期对话〗
${context || '（这是第一次对话）'}

根据记忆和近期对话，自然地回复用户。
`;

        // ===== 8. 调用中转 API =====
        console.log('🚀 调用中转 API...');

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
                                content: message
                            }
                        ],
                        stream: false,
                        temperature: 0.8,
                        max_tokens: 2048
                    })
                }
            );

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

        const data =
            await response.json();

        // ===== 9. 提取 AI 回复 =====
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

        // ===== 10. 保存 AI 回复 =====
        await supabaseInsert(
            'messages',
            {
                session_id: sid,
                role: 'assistant',
                content: reply,
                visible: true
            }
        );

        // ===== 11. 保存 AI timeline =====
        await supabaseInsert(
            'timeline',
            {
                session_id: sid,
                role: 'assistant',
                content: reply
            }
        );

        // ===== 12. 返回 Kelivo 能识别的格式 =====
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

// ===== 启动 =====
app.listen(
    PORT,
    '0.0.0.0',
    () => {
        console.log(
            `🚀 服务已启动，端口: ${PORT}`
        );
    }
);

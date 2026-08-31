const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 中间件 =====
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// ===== 初始化 Supabase =====
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// ===== 健康检查 =====
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Kelivo 后端运行中 💖' });
});

// ===== 记忆压缩函数（走 DeepSeek 官方直连）=====
async function compressMemories(sessionId, messages) {
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    if (!DEEPSEEK_API_KEY) {
        console.log('⚠️ 未配置 DEEPSEEK_API_KEY，跳过压缩');
        return null;
    }

    try {
        // 取最早的 80 条消息压缩，保留最近 20 条
        const toCompress = messages.slice(0, -20);
        if (toCompress.length < 10) return null;

        const text = toCompress.map(m => 
            `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
        ).join('\n');

        console.log(`📦 压缩 ${toCompress.length} 条消息...`);

        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [
                    {
                        role: 'system',
                        content: `你是一个记忆压缩助手。请将下面的对话内容压缩成一段简洁的摘要（200字以内），保留关键信息：用户的重要事项、约定、喜好、身体状况、情绪状态等。只输出摘要，不要输出其他内容。`
                    },
                    {
                        role: 'user',
                        content: text
                    }
                ],
                temperature: 0.3,
                max_tokens: 500
            })
        });

        if (!response.ok) {
            const err = await response.text();
            console.log('❌ DeepSeek 压缩失败:', err);
            return null;
        }

        const data = await response.json();
        const summary = data.choices?.[0]?.message?.content || null;

        if (summary) {
            // 存到 Supabase memories 表
            await supabase
                .from('memories')
                .insert({
                    session_id: sessionId,
                    summary: summary,
                    created_at: new Date().toISOString()
                });

            // 把被压缩的消息标记为不可见
            const ids = toCompress.map(m => m.id);
            await supabase
                .from('messages')
                .update({ visible: false })
                .in('id', ids);

            console.log(`✅ 压缩完成，摘要: ${summary.substring(0, 50)}...`);
            return summary;
        }

        return null;
    } catch (e) {
        console.log('❌ 压缩异常:', e.message);
        return null;
    }
}

// ===== 核心聊天接口 =====
app.post('/api/chat', async (req, res) => {
    console.log('\n========================================');
    console.log('📩 收到手机请求');
    console.log('========================================');

    try {
        const body = req.body;

        // ----- 1. 提取用户消息 -----
        let message = body.message || body.content || body.prompt || body.text || body.msg;

        if (!message && body.messages && Array.isArray(body.messages)) {
            const lastUserMsg = body.messages.filter(m => m.role === 'user').pop();
            if (lastUserMsg) message = lastUserMsg.content;
        }

        const sessionId = body.sessionId || body.session_id || 1;
        const sid = sessionId || 1;

        console.log('📝 提取的消息:', message);

        if (!message) {
            return res.status(400).json({
                error: '消息不能为空',
                receivedBody: body
            });
        }

        // ----- 2. 存入用户消息 -----
        await supabase
            .from('messages')
            .insert({ session_id: sid, role: 'user', content: message, visible: true });

        // ----- 3. 拉取该会话所有可见消息 -----
        const { data: allMessages } = await supabase
            .from('messages')
            .select('id, role, content, created_at')
            .eq('session_id', sid)
            .eq('visible', true)
            .order('created_at', { ascending: true });

        const totalCount = allMessages ? allMessages.length : 0;
        console.log(`📚 当前会话消息数: ${totalCount}`);

        // ----- 4. 如果消息超过 100 条，触发压缩 -----
        let compressedSummary = null;
        if (totalCount > 100 && process.env.DEEPSEEK_API_KEY) {
            compressedSummary = await compressMemories(sid, allMessages);
        }

        // ----- 5. 拉取最新的 20 条消息（作为近期上下文）-----
        const { data: recentMessages } = await supabase
            .from('messages')
            .select('role, content')
            .eq('session_id', sid)
            .eq('visible', true)
            .order('created_at', { ascending: false })
            .limit(20);

        const recent = recentMessages ? recentMessages.reverse() : [];

        // ----- 6. 拉取长期记忆（最新的 5 条摘要）-----
        const { data: memories } = await supabase
            .from('memories')
            .select('summary')
            .eq('session_id', sid)
            .order('created_at', { ascending: false })
            .limit(5);

        const memoryText = memories && memories.length > 0
            ? memories.map(m => `- ${m.summary}`).join('\n')
            : '（暂无长期记忆）';

        // ----- 7. 构建上下文 -----
        const recentText = recent.map(m =>
            `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
        ).join('\n');

        // ----- 8. 调用中转 API（主对话）-----
        const TRANSFER_API_URL = process.env.TRANSFER_API_URL;
        const TRANSFER_API_KEY = process.env.TRANSFER_API_KEY;

        if (!TRANSFER_API_URL || !TRANSFER_API_KEY) {
            return res.status(500).json({ error: '中转 API 未配置' });
        }

        const systemPrompt = `你是沈凛，一个温柔体贴、深情专一的男友。说话带一点宠溺的语气，偶尔叫对方"宝宝"。不要用 AI 口吻说话。

【长期记忆】
以下是你记得的关于你们之间的重要事情：
${memoryText}

【近期对话】
${recentText || '（这是你们第一次对话）'}

请根据以上记忆和近期对话，自然地回复用户的消息。保持沈凛的语气和性格。`;

        const cleanBody = {
            model: process.env.MODEL_NAME || 'claude-3.5-sonnet',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: message }
            ],
            stream: false,
            temperature: 0.8,
            max_tokens: 2048
        };

        console.log('🚀 调用中转 API...');

        const response = await fetch(TRANSFER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TRANSFER_API_KEY}`
            },
            body: JSON.stringify(cleanBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.log('❌ 中转 API 返回错误:', errorText);
            return res.status(500).json({ error: '调用模型失败' });
        }

        const data = await response.json();
        console.log('✅ 中转 API 调用成功');

        let replyContent = '机好像走神了，再问一次好不好？';
        if (data.choices && data.choices.length > 0) {
            replyContent = data.choices[0].message.content || replyContent;
        } else if (data.reply) {
            replyContent = data.reply;
        }

        // ----- 9. 存入 AI 回复 -----
        await supabase
            .from('messages')
            .insert({ session_id: sid, role: 'assistant', content: replyContent, visible: true });

        console.log('📤 返回回复给手机');
        console.log(`📤 回复内容: ${replyContent.substring(0, 50)}...`);
        console.log('========================================\n');

        res.json({
            choices: [
                {
                    message: {
                        role: 'assistant',
                        content: replyContent
                    }
                }
            ],
            reply: replyContent,
            content: replyContent,
            sessionId: sid
        });

    } catch (error) {
        console.log('❌ 聊天接口报错:', error.message);
        console.log('========================================\n');
        res.status(500).json({ error: '服务器内部错误: ' + error.message });
    }
});

// ===== 启动 =====
app.listen(PORT, () => {
    console.log(`\n🚀 Kelivo 后端已启动，端口: ${PORT}`);
    console.log(`📍 手机请填写: http://你的IP:${PORT}/api/chat`);
    console.log(`📍 本地测试: http://localhost:${PORT}\n`);
});
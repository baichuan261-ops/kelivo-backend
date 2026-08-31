const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
console.log('🔍 当前 PORT 值:', PORT);

// 中间件
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Supabase 客户端
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// 健康检查
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Kelivo 后端运行中 💖' });
});

// 记忆压缩函数
async function compressMemories(sessionId, messages) {
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    if (!DEEPSEEK_API_KEY) {
        console.log('⚠️ 未配置 DEEPSEEK_API_KEY，跳过压缩');
        return null;
    }

    try {
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
                        content: '你是一个记忆压缩助手。请将下面的对话内容压缩成一段简洁的摘要（200字以内），保留关键信息。只输出摘要。'
                    },
                    { role: 'user', content: text }
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
            await supabase
                .from('memories')
                .insert({
                    session_id: sessionId,
                    summary: summary,
                    created_at: new Date().toISOString()
                });

            const ids = toCompress.map(m => m.id);
            await supabase
                .from('messages')
                .update({ visible: false })
                .in('id', ids);

            console.log(`✅ 压缩完成: ${summary.substring(0, 50)}...`);
            return summary;
        }
        return null;
    } catch (e) {
        console.log('❌ 压缩异常:', e.message);
        return null;
    }
}

// 核心聊天接口
app.post('/api/chat', async (req, res) => {
    console.log('📩 收到请求');
    try {
        const body = req.body;
        let message = body.message || body.content || body.prompt || body.text || body.msg;

        if (!message && body.messages && Array.isArray(body.messages)) {
            const lastUserMsg = body.messages.filter(m => m.role === 'user').pop();
            if (lastUserMsg) message = lastUserMsg.content;
        }

        const sid = body.sessionId || body.session_id || 1;

        if (!message) {
            return res.status(400).json({ error: '消息不能为空' });
        }

        await supabase
            .from('messages')
            .insert({ session_id: sid, role: 'user', content: message, visible: true });

        const { data: allMessages } = await supabase
            .from('messages')
            .select('id, role, content, created_at')
            .eq('session_id', sid)
            .eq('visible', true)
            .order('created_at', { ascending: true });

        const totalCount = allMessages ? allMessages.length : 0;
        console.log(`📚 当前消息数: ${totalCount}`);

        if (totalCount > 100 && process.env.DEEPSEEK_API_KEY) {
            await compressMemories(sid, allMessages);
        }

        const { data: recentMessages } = await supabase
            .from('messages')
            .select('role, content')
            .eq('session_id', sid)
            .eq('visible', true)
            .order('created_at', { ascending: false })
            .limit(20);

        const recent = recentMessages ? recentMessages.reverse() : [];

        const { data: memories } = await supabase
            .from('memories')
            .select('summary')
            .eq('session_id', sid)
            .order('created_at', { ascending: false })
            .limit(5);

        const memoryText = memories && memories.length > 0
            ? memories.map(m => `- ${m.summary}`).join('\n')
            : '（暂无长期记忆）';

        const recentText = recent.map(m =>
            `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
        ).join('\n');

        const TRANSFER_API_URL = process.env.TRANSFER_API_URL;
        const TRANSFER_API_KEY = process.env.TRANSFER_API_KEY;

        if (!TRANSFER_API_URL || !TRANSFER_API_KEY) {
            return res.status(500).json({ error: '中转 API 未配置' });
        }

        const systemPrompt = `你是沈凛，一个温柔体贴、深情专一的男友。说话带一点宠溺的语气，偶尔叫对方"宝宝"。

【长期记忆】
${memoryText}

【近期对话】
${recentText || '（这是你们第一次对话）'}

请根据以上记忆和近期对话，自然地回复用户的消息。`;

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
            console.log('❌ 中转 API 错误:', errorText);
            return res.status(500).json({ error: '调用模型失败' });
        }

        const data = await response.json();
        let replyContent = data.choices?.[0]?.message?.content || '机好像走神了，再问一次好不好？';

        await supabase
            .from('messages')
            .insert({ session_id: sid, role: 'assistant', content: replyContent, visible: true });

        res.json({
            choices: [{ message: { role: 'assistant', content: replyContent } }],
            reply: replyContent,
            sessionId: sid
        });

    } catch (error) {
        console.log('❌ 聊天接口报错:', error.message);
        res.status(500).json({ error: '服务器内部错误: ' + error.message });
    }
});

// 启动服务
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Kelivo 后端已启动，端口: ${PORT}`);
    console.log(`✅ 服务正在监听 0.0.0.0:${PORT}`);
});
    console.log(`📍 本地测试: http://localhost:${PORT}\n`);
});

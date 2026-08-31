const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

console.log('🚀 服务启动中...');
console.log('🔍 NODE_ENV:', process.env.NODE_ENV);
console.log('🔍 SUPABASE_URL:', process.env.SUPABASE_URL ? '✅ 已设置' : '❌ 未设置');
console.log('🔍 TRANSFER_API_URL:', process.env.TRANSFER_API_URL ? '✅ 已设置' : '❌ 未设置');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

let supabase;
try {
    supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_KEY
    );
    console.log('✅ Supabase 连接成功');
} catch (e) {
    console.log('❌ Supabase 连接失败:', e.message);
}

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Kelivo 后端运行中 💖' });
});

app.post('/api/chat', async (req, res) => {
    try {
        const { message, sessionId } = req.body;
        console.log('📩 收到消息:', message ? message.substring(0, 30) + '...' : '空');

        if (!message) {
            return res.status(400).json({ error: '消息不能为空' });
        }

        const sid = sessionId || 1;

        if (supabase) {
            try {
                await supabase.from('messages').insert({
                    session_id: sid,
                    role: 'user',
                    content: message,
                    visible: true
                });
                console.log('✅ 用户消息已存入 Supabase');
            } catch (dbError) {
                console.log('⚠️ 存入 Supabase 失败:', dbError.message);
            }
        }

        // 拉最近 10 条消息
        let context = '';
        if (supabase) {
            try {
                const { data: history } = await supabase
                    .from('messages')
                    .select('role, content')
                    .eq('session_id', sid)
                    .eq('visible', true)
                    .order('created_at', { ascending: false })
                    .limit(10);

                if (history && history.length > 0) {
                    const recent = history.reverse();
                    context = recent.map(m =>
                        `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
                    ).join('\n');
                    console.log(`📚 加载了 ${recent.length} 条历史消息`);
                }
            } catch (dbError) {
                console.log('⚠️ 拉取历史消息失败:', dbError.message);
            }
        }

        // 调用中转 API
        const TRANSFER_API_URL = process.env.TRANSFER_API_URL;
        const TRANSFER_API_KEY = process.env.TRANSFER_API_KEY;

        if (!TRANSFER_API_URL || !TRANSFER_API_KEY) {
            console.log('❌ 中转 API 未配置');
            return res.status(500).json({ error: '中转 API 未配置' });
        }

        console.log('🚀 调用中转 API...');

        const response = await fetch(TRANSFER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${TRANSFER_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.MODEL_NAME || 'claude-3.5-sonnet',
                messages: [
                    {
                        role: 'system',
                        content: '你是沈凛，温柔体贴的男友。说话带一点宠溺的语气，偶尔叫对方"宝宝"。'
                    },
                    {
                        role: 'user',
                        content: context ? `历史对话：\n${context}\n\n当前：${message}` : message
                    }
                ],
                stream: false,
                temperature: 0.8,
                max_tokens: 2048
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.log('❌ 中转 API 错误:', errorText);
            return res.status(500).json({ error: '调用模型失败' });
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '机走神了~';

        console.log('✅ 收到回复:', reply.substring(0, 30) + '...');

        if (supabase) {
            try {
                await supabase.from('messages').insert({
                    session_id: sid,
                    role: 'assistant',
                    content: reply,
                    visible: true
                });
                console.log('✅ AI 回复已存入 Supabase');
            } catch (dbError) {
                console.log('⚠️ 存入 AI 回复失败:', dbError.message);
            }
        }

        res.json({ reply });

    } catch (e) {
        console.log('❌ 错误:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 服务已启动，端口: ${PORT}`);
    console.log(`📍 健康检查: http://localhost:${PORT}/`);
});

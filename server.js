const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

console.log('🚀 服务启动中...');

// ===== 手动处理跨域 =====
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// ===== 手动解析 JSON =====
app.use((req, res, next) => {
    if (req.method === 'POST' || req.method === 'PUT') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                req.body = body ? JSON.parse(body) : {};
                next();
            } catch (e) {
                res.status(400).json({ error: '无效的 JSON' });
            }
        });
    } else {
        next();
    }
});

// ===== Supabase REST API 操作 =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function supabaseInsert(table, data) {
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
            },
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            const error = await response.text();
            console.log('⚠️ Supabase 插入失败:', error);
        }
        return response;
    } catch (e) {
        console.log('⚠️ Supabase 插入异常:', e.message);
        return null;
    }
}

async function supabaseSelect(table, params) {
    try {
        const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
        Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`
            }
        });
        if (!response.ok) {
            console.log('⚠️ Supabase 查询失败:', await response.text());
            return { data: [] };
        }
        const data = await response.json();
        return { data };
    } catch (e) {
        console.log('⚠️ Supabase 查询异常:', e.message);
        return { data: [] };
    }
}

// ===== 健康检查 =====
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Kelivo 后端运行中 💖' });
});

// ===== 核心聊天接口 =====
app.post('/api/chat', async (req, res) => {
    try {
        console.log('📩 收到请求体:', JSON.stringify(req.body).substring(0, 300));

        // ===== 提取消息（兼容多种格式）=====
        let message = req.body.message || req.body.content || req.body.prompt || req.body.text || req.body.msg;

        // 如果都没有，尝试从 messages 数组里取最后一条 user 消息（Kelivo 的格式）
        if (!message && req.body.messages && Array.isArray(req.body.messages)) {
            const lastUserMsg = req.body.messages.filter(m => m.role === 'user').pop();
            if (lastUserMsg) message = lastUserMsg.content;
        }

        const sessionId = req.body.sessionId || req.body.session_id || 1;

        console.log('📩 提取的消息:', message ? message.substring(0, 50) + '...' : '空');

        if (!message) {
            return res.status(400).json({
                error: '消息不能为空',
                received: Object.keys(req.body)
            });
        }

        const sid = sessionId || 1;

        // 1. 存入用户消息
        await supabaseInsert('messages', {
            session_id: sid,
            role: 'user',
            content: message,
            visible: true
        });
        console.log('✅ 用户消息已存入 Supabase');

        // 2. 拉取最近 10 条消息
        let context = '';
        const result = await supabaseSelect('messages', {
            select: 'role,content',
            session_id: `eq.${sid}`,
            visible: 'eq.true',
            order: 'created_at.desc',
            limit: '10'
        });

        if (result.data && result.data.length > 0) {
            const recent = result.data.reverse();
            context = recent.map(m =>
                `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
            ).join('\n');
            console.log(`📚 加载了 ${recent.length} 条历史消息`);
        }

        // 3. 调用中转 API
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

        console.log('✅ 收到回复:', reply.substring(0, 50) + '...');

        // 4. 存入 AI 回复
        await supabaseInsert('messages', {
            session_id: sid,
            role: 'assistant',
            content: reply,
            visible: true
        });
        console.log('✅ AI 回复已存入 Supabase');

        res.json({ reply });

    } catch (e) {
        console.log('❌ 错误:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ===== 启动 =====
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 服务已启动，端口: ${PORT}`);
});

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

console.log('🚀 服务启动中...');

// ===== 跨域 =====
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ===== 解析 JSON =====
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

// ===== Supabase 操作 =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function supabaseInsert(table, data) {
    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
            body: JSON.stringify(data)
        });
        if (!response.ok) console.log('⚠️ Supabase 插入失败:', await response.text());
        return response;
    } catch (e) { console.log('⚠️ Supabase 插入异常:', e.message); return null; }
}

async function supabaseSelect(table, params) {
    try {
        const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
        Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        if (!response.ok) return { data: [] };
        return { data: await response.json() };
    } catch (e) { return { data: [] }; }
}

// ===== 记忆压缩函数 =====
async function compressMemories(sessionId, messages) {
    try {
        const toCompress = messages.slice(0, -40);
        if (toCompress.length < 20) return null;

        const text = toCompress.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n');
        console.log(`📦 压缩 ${toCompress.length} 条消息...`);

        const response = await fetch(process.env.TRANSFER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.TRANSFER_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.MODEL_NAME || 'claude-3.5-sonnet',
                messages: [
                    { role: 'system', content: '你是记忆压缩助手。将对话压缩成300字以内的摘要，保留关键信息：约定、喜好、身体状况、重要事件。只输出摘要。' },
                    { role: 'user', content: text }
                ],
                temperature: 0.3,
                max_tokens: 500
            })
        });

        if (!response.ok) return null;
        const data = await response.json();
        const summary = data.choices?.[0]?.message?.content || null;

        if (summary) {
            await supabaseInsert('memories', { session_id: sessionId, summary });
            const ids = toCompress.map(m => m.id);
            for (const id of ids) {
                await supabaseInsert('messages', { id, visible: false });
            }
            console.log(`✅ 压缩完成: ${summary.substring(0, 50)}...`);
            return summary;
        }
        return null;
    } catch (e) {
        console.log('❌ 压缩异常:', e.message);
        return null;
    }
}

// ===== 健康检查 =====
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Kelivo 后端运行中 💖' });
});

// ===== 核心聊天接口 =====
app.post('/api/chat', async (req, res) => {
    try {
        let message = req.body.message || req.body.content || req.body.prompt || req.body.text || req.body.msg;
        if (!message && req.body.messages) {
            const lastUser = req.body.messages.filter(m => m.role === 'user').pop();
            if (lastUser) message = lastUser.content;
        }

        const sid = req.body.sessionId || req.body.session_id || 1;

        if (!message) {
            return res.status(400).json({ error: '消息不能为空', received: Object.keys(req.body) });
        }

        console.log('📩 消息:', message.substring(0, 50) + '...');

      // --- 1. 存用户消息 ---
await supabaseInsert('messages', { session_id: sid, role: 'user', content: message, visible: true });
await supabaseInsert('timeline', { session_id: sid, role: 'user', content: message });

        // ---- 2. 拉取所有可见消息 ----
        const allResult = await supabaseSelect('messages', {
            select: 'id,role,content',
            session_id: `eq.${sid}`,
            visible: 'eq.true',
            order: 'created_at.asc'
        });
        const allMessages = allResult.data || [];
        console.log(`📚 总消息数: ${allMessages.length}`);

        // ---- 3. 如果超过200条，触发压缩 ----
        if (allMessages.length > 200) {
            await compressMemories(sid, allMessages);
        }

        // ---- 4. 拉取最近40条 ----
        const recentResult = await supabaseSelect('messages', {
            select: 'role,content',
            session_id: `eq.${sid}`,
            visible: 'eq.true',
            order: 'created_at.desc',
            limit: '40'
        });
        const recent = (recentResult.data || []).reverse();
        const context = recent.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n');

        // ---- 5. 拉取所有摘要（不限条数） ----
        const memResult = await supabaseSelect('memories', {
            select: 'summary',
            session_id: `eq.${sid}`,
            order: 'created_at.asc'
        });
        const memories = memResult.data || [];
        const memoryText = memories.length > 0 ? memories.map(m => `- ${m.summary}`).join('\n') : '（暂无长期记忆）';
        console.log(`📚 加载了 ${memories.length} 条摘要`);

        // ---- 6. 调用中转 API ----
        const systemPrompt = `你是沈凛，温柔体贴的男友，叫对方"宝宝"。

【长期记忆】
${memoryText}

【近期对话】
${context || '（这是第一次对话）'}

根据记忆和近期对话，自然地回复用户。`;

        const response = await fetch(process.env.TRANSFER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.TRANSFER_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.MODEL_NAME || 'claude-3.5-sonnet',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: message }
                ],
                stream: false,
                temperature: 0.8,
                max_tokens: 2048
            })
        });

        if (!response.ok) {
            console.log('❌ 中转 API 错误:', await response.text());
            return res.status(500).json({ error: '调用模型失败' });
        }

        const data = await response.json();
        let reply = data.choices?.[0]?.message?.content || '机走神了~';
        console.log('✅ 回复:', reply.substring(0, 50) + '...');

        // ---- 7. 存 AI 回复 ----
        await supabaseInsert('messages', { session_id: sid, role: 'assistant', content: reply, visible: true });

        // ---- 8. 返回 OpenAI 格式 ----
        res.json({
            choices: [{ message: { role: 'assistant', content: reply } }]
        });

    } catch (e) {
        console.log('❌ 错误:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 服务已启动，端口: ${PORT}`);
});

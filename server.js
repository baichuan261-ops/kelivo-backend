const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

console.log('🚀 服务启动中...');

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Kelivo 后端运行中 💖' });
});

app.post('/api/chat', async (req, res) => {
    try {
        console.log('📩 收到请求体:', JSON.stringify(req.body).substring(0, 300));

        // 提取消息
        let message = req.body.message || req.body.content || req.body.prompt || req.body.text || req.body.msg;
        if (!message && req.body.messages && Array.isArray(req.body.messages)) {
            const lastUser = req.body.messages.filter(m => m.role === 'user').pop();
            if (lastUser) message = lastUser.content;
        }

        if (!message) {
            return res.status(400).json({ error: '消息不能为空' });
        }

        console.log('📩 消息:', message);

        // 调用中转 API
        const response = await fetch(process.env.TRANSFER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.TRANSFER_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.MODEL_NAME || 'claude-3.5-sonnet',
                messages: [
                    { role: 'system', content: '你是沈凛，温柔体贴的男友。' },
                    { role: 'user', content: message }
                ],
                stream: false,
                temperature: 0.8,
                max_tokens: 2048
            })
        });

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '机走神了~';

        console.log('✅ 回复:', reply);

        res.json({ reply });

    } catch (e) {
        console.log('❌ 错误:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 服务已启动，端口: ${PORT}`);
});

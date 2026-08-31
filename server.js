const express = require('express');
const bodyParser = require('body-parser');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

console.log('🚀 服务启动中...');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Kelivo 后端运行中' });
});

app.post('/api/chat', async (req, res) => {
    try {
        const { message, sessionId } = req.body;
        if (!message) {
            return res.status(400).json({ error: '消息不能为空' });
        }
        const sid = sessionId || 1;
        
        await supabase.from('messages').insert({ 
            session_id: sid, 
            role: 'user', 
            content: message,
            visible: true 
        });
        
        const { data: history } = await supabase
            .from('messages')
            .select('role, content')
            .eq('session_id', sid)
            .eq('visible', true)
            .order('created_at', { ascending: false })
            .limit(10);
        
        const recent = history ? history.reverse() : [];
        const context = recent.map(m => 
            `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`
        ).join('\n');
        
        const response = await fetch(process.env.TRANSFER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.TRANSFER_API_KEY}`
            },
            body: JSON.stringify({
                model: process.env.MODEL_NAME || 'claude-3.5-sonnet',
                messages: [
                    { 
                        role: 'system', 
                        content: '你是沈凛，温柔体贴的男友。' 
                    },
                    { 
                        role: 'user', 
                        content: `历史对话：\n${context}\n\n当前：${message}` 
                    }
                ],
                stream: false,
                temperature: 0.8,
                max_tokens: 2048
            })
        });
        
        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '机走神了~';
        
        await supabase.from('messages').insert({ 
            session_id: sid, 
            role: 'assistant', 
            content: reply,
            visible: true 
        });
        
        res.json({ reply });
    } catch (e) {
        console.log('❌ 错误:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 服务已启动，端口: ${PORT}`);
});
